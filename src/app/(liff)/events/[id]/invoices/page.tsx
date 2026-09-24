"use client";

/**
 * O-6 請求発行（§8-1 / task_015）。
 *
 * 「参加者 × 金額」を一覧し、O-6.5 の確認画面（`./invoices/confirm`）へ渡す。既に請求がある
 * 参加者は発行時にスキップされる（DB の UNIQUE で構造的に二重発行しない）。
 *
 * 招待リンクの状態もここで扱う。**生の招待トークンはサーバーに残っていない**ため、
 * 「現在のリンクを表示する」ことはできない。リンクを配り直すには再発行する（旧リンクは無効）。
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { InvoiceRow, type ConfirmationMethod, type RosterStatus } from "@/components/InvoiceRow";
import { StateView } from "@/components/StateView";
import { bootLiff, liffPermanentLink, readLiffIdFromDocument } from "@/lib/liff/client";

type Phase = "loading" | "ready" | "outside_line" | "auth_unavailable" | "forbidden" | "error";

interface SummaryBody {
  readonly event: { readonly id: string; readonly title: string; readonly defaultAmountMinor: number | null };
  readonly participantCount: number;
  readonly breakdown: { readonly unpaid: number };
}

interface ParticipantItem {
  readonly id: string;
  readonly displayLabel: string | null;
  readonly status: RosterStatus;
  readonly amountMinor: number | null;
  readonly autoDetected: boolean;
  readonly confirmationMethod: ConfirmationMethod | null;
  readonly needsAttention: boolean;
}

interface JoinTokenBody {
  readonly joinTokenExpiresAt: string | null;
  readonly joinTokenVersion: number;
  readonly expired: boolean;
}

function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function formatYen(amountMinor: number | null): string {
  if (amountMinor === null) return "未設定";
  return `¥${amountMinor.toLocaleString("ja-JP")}`;
}

export default function InvoicesPage(): ReactNode {
  const params = useParams<{ id: string }>();
  const eventId = params.id;

  const [phase, setPhase] = useState<Phase>("loading");
  const [summary, setSummary] = useState<SummaryBody | null>(null);
  const [participants, setParticipants] = useState<readonly ParticipantItem[]>([]);
  const [joinTokenStatus, setJoinTokenStatus] = useState<JoinTokenBody | null>(null);
  const [issuedLink, setIssuedLink] = useState<string | null>(null);
  const [permanentLink, setPermanentLink] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const csrfTokenRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run(): Promise<void> {
      const liffId = readLiffIdFromDocument();
      if (liffId === null) {
        if (!cancelled) setPhase("error");
        return;
      }
      if (!cancelled) setPermanentLink(liffPermanentLink(liffId));

      const boot = await bootLiff(liffId);
      if (cancelled) return;
      if (boot.state === "outside_line") {
        setPhase("outside_line");
        return;
      }
      if (boot.state !== "ready") {
        setPhase("auth_unavailable");
        return;
      }

      let authResponse: Response;
      try {
        authResponse = await fetch("/api/auth/line", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ idToken: boot.idToken }),
        });
      } catch {
        if (!cancelled) setPhase("error");
        return;
      }
      if (cancelled) return;
      if (!authResponse.ok) {
        setPhase("auth_unavailable");
        return;
      }
      const authBody = (await authResponse.json()) as { csrfToken?: unknown };
      if (typeof authBody.csrfToken !== "string") {
        setPhase("error");
        return;
      }
      csrfTokenRef.current = authBody.csrfToken;

      let summaryResponse: Response;
      try {
        summaryResponse = await fetch(`/api/events/${eventId}`, { method: "GET" });
      } catch {
        if (!cancelled) setPhase("error");
        return;
      }
      if (cancelled) return;
      if (!summaryResponse.ok) {
        setPhase(
          summaryResponse.status === 403 || summaryResponse.status === 404 ? "forbidden" : "error",
        );
        return;
      }
      setSummary((await summaryResponse.json()) as SummaryBody);

      try {
        const listResponse = await fetch(`/api/events/${eventId}/participants?filter=all&limit=100`, {
          method: "GET",
        });
        if (listResponse.ok && !cancelled) {
          const listBody = (await listResponse.json()) as {
            participants: readonly ParticipantItem[];
          };
          setParticipants(listBody.participants);
        }
      } catch {
        // 一覧が取れなくても発行導線自体は成立させる。
      }

      try {
        const tokenResponse = await fetch(`/api/events/${eventId}/join-token`, { method: "GET" });
        if (tokenResponse.ok && !cancelled) {
          setJoinTokenStatus((await tokenResponse.json()) as JoinTokenBody);
        }
      } catch {
        // 招待リンクの状態は付加情報。
      }

      if (!cancelled) setPhase("ready");
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  const rotate = useCallback(async () => {
    if (csrfTokenRef.current === null) return;
    setRotating(true);
    setMessage(null);
    let response: Response;
    try {
      response = await fetch(`/api/events/${eventId}/rotate-join-token`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-CSRF-Token": csrfTokenRef.current,
          "Idempotency-Key": newIdempotencyKey(),
        },
        body: JSON.stringify({}),
      });
    } catch {
      setRotating(false);
      setMessage("通信に失敗しました。もう一度お試しください。");
      return;
    }
    setRotating(false);

    if (!response.ok) {
      const failure = (await response.json().catch(() => ({}))) as {
        message?: unknown;
        requestId?: unknown;
      };
      if (typeof failure.requestId === "string") setRequestId(failure.requestId);
      setMessage(
        typeof failure.message === "string" ? failure.message : "招待リンクを作り直せませんでした。",
      );
      return;
    }

    const body = (await response.json()) as {
      joinToken?: unknown;
      joinTokenExpiresAt?: unknown;
      joinTokenVersion?: unknown;
    };
    if (typeof body.joinToken === "string" && permanentLink !== null) {
      setIssuedLink(`${permanentLink}/e?t=${encodeURIComponent(body.joinToken)}`);
    } else {
      setMessage("招待リンクを作り直しましたが、リンクを表示できませんでした。もう一度お試しください。");
    }
    if (typeof body.joinTokenExpiresAt === "string" && typeof body.joinTokenVersion === "number") {
      setJoinTokenStatus({
        joinTokenExpiresAt: body.joinTokenExpiresAt,
        joinTokenVersion: body.joinTokenVersion,
        expired: false,
      });
    }
  }, [eventId, permanentLink]);

  if (phase === "loading") return <StateView state="loading" />;
  if (phase === "outside_line") {
    return <StateView state="outside_line" permanentLink={permanentLink ?? undefined} />;
  }
  if (phase === "auth_unavailable") {
    return (
      <StateView
        state="auth_unavailable"
        permanentLink={permanentLink ?? undefined}
        requestId={requestId}
      />
    );
  }
  if (phase === "forbidden") return <StateView state="forbidden" requestId={requestId} />;
  if (phase === "error" || summary === null) return <StateView state="error" requestId={requestId} />;

  return (
    <section aria-labelledby="invoices-heading">
      <h1 id="invoices-heading">請求の発行</h1>

      {message !== null ? (
        <p role="alert" className="invoices__message">
          {message}
        </p>
      ) : null}

      <p className="invoices__formula tabular">
        {summary.breakdown.unpaid} 名 × {formatYen(summary.event.defaultAmountMinor)}
      </p>
      <p className="invoices__note">
        すでに請求がある参加者はそのままになります（同じ人に二重に発行されることはありません）。
      </p>

      <p>
        <Link href={`/events/${eventId}/invoices/confirm`} className="tap-target">
          内容を確認して発行する
        </Link>
      </p>

      {participants.length === 0 ? (
        <StateView state="empty" description="まだ参加者が登録されていません。" />
      ) : (
        <ul className="invoices__roster">
          {participants.map((item) => (
            <InvoiceRow
              key={item.id}
              displayLabel={item.displayLabel}
              amountMinor={item.amountMinor}
              status={item.status}
              autoDetected={item.autoDetected}
              confirmationMethod={item.confirmationMethod}
              needsAttention={item.needsAttention}
            />
          ))}
        </ul>
      )}

      <h2>招待リンク</h2>
      <p className="invoices__join-token-note">
        安全のため、招待リンクはサーバーに残していません。作り直すと新しいリンクが 1 度だけ表示され、
        それまでのリンクは使えなくなります。
      </p>
      {joinTokenStatus === null ? null : (
        <p className="invoices__join-token-status">
          現在のリンク: 第 {joinTokenStatus.joinTokenVersion} 版
          {joinTokenStatus.expired ? "（期限切れ）" : ""}
        </p>
      )}
      <button
        type="button"
        className="tap-target"
        disabled={rotating}
        aria-busy={rotating}
        onClick={() => {
          void rotate();
        }}
      >
        招待リンクを作り直す
      </button>
      {issuedLink === null ? null : (
        <p className="invoices__issued-link" role="status">
          {issuedLink}
        </p>
      )}
    </section>
  );
}
