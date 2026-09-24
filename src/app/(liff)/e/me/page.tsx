"use client";

/**
 * P-3 自分の請求（§8-2 / check_087 / task_015）。
 *
 * ★ 状態は 8 つ（幹事の確認待ち / 請求の発行待ち / 未払い / 手続き中 / 申告済み（幹事の確認待ち）/
 *   支払済み / 期限切れ / 取消済み）。**申告済みを支払済みと同じ見た目にしない**
 *   （`ParticipantStatus` が tone・文言・アイコンを分けている。R-UX-02）。
 * ★ 固定文言「LINE のトークで幹事へ連絡」と「このリンクを自分に送る」を常設する（§8-2）。
 * ★ 決済そのもの（P-4〜P-7）は task_017 の scope。ここでは自己申告と
 *   「この方法では払えない」の 2 つだけを置く。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { ParticipantStatus, type ParticipantViewState } from "@/components/InvoiceRow";
import { StateView } from "@/components/StateView";
import { bootLiff, liffPermanentLink, readLiffIdFromDocument } from "@/lib/liff/client";

type Phase =
  | "loading"
  | "ready"
  | "outside_line"
  | "auth_unavailable"
  | "invalid_link"
  | "not_claimed"
  | "error";

interface MeBody {
  readonly event: {
    readonly title: string;
    readonly organizerLabel: string;
    readonly collectByAt: string | null;
  };
  readonly participant: { readonly id: string; readonly displayLabel: string | null };
  readonly invoice: {
    readonly id: string;
    readonly amountMinor: number | null;
    readonly currency: string | null;
    readonly autoDetected: boolean;
    readonly confirmationMethod: "automatic" | "manual_by_organizer" | "mixed" | null;
    readonly selfReportedAt: string | null;
  } | null;
  readonly state: ParticipantViewState;
}

function readJoinToken(): string | null {
  if (typeof window === "undefined") return null;
  const value = new URL(window.location.href).searchParams.get("t");
  if (value === null || value.trim().length === 0) return null;
  return value.trim();
}

export default function ParticipantInvoicePage(): ReactNode {
  const [phase, setPhase] = useState<Phase>("loading");
  const [me, setMe] = useState<MeBody | null>(null);
  const [joinToken, setJoinToken] = useState<string | null>(null);
  const [permanentLink, setPermanentLink] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const csrfTokenRef = useRef<string | null>(null);

  const load = useCallback(async (token: string): Promise<void> => {
    let response: Response;
    try {
      response = await fetch("/api/e/me", { method: "GET", headers: { "X-Join-Token": token } });
    } catch {
      setPhase("error");
      return;
    }
    if (response.status === 404) {
      setPhase("invalid_link");
      return;
    }
    if (response.status === 403) {
      setPhase("not_claimed");
      return;
    }
    if (!response.ok) {
      const failure = (await response.json().catch(() => ({}))) as { requestId?: unknown };
      if (typeof failure.requestId === "string") setRequestId(failure.requestId);
      setPhase("error");
      return;
    }
    setMe((await response.json()) as MeBody);
    setPhase("ready");
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run(): Promise<void> {
      const liffId = readLiffIdFromDocument();
      if (liffId === null) {
        if (!cancelled) setPhase("error");
        return;
      }
      if (!cancelled) setPermanentLink(liffPermanentLink(liffId));

      const token = readJoinToken();
      if (token === null) {
        if (!cancelled) setPhase("invalid_link");
        return;
      }
      if (!cancelled) setJoinToken(token);

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

      await load(token);
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const post = useCallback(
    async (path: string, body: Record<string, unknown> | null): Promise<void> => {
      if (joinToken === null || csrfTokenRef.current === null) return;
      setSubmitting(true);
      setMessage(null);
      let response: Response;
      try {
        response = await fetch(path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-CSRF-Token": csrfTokenRef.current,
            "X-Join-Token": joinToken,
          },
          body: JSON.stringify(body ?? {}),
        });
      } catch {
        setSubmitting(false);
        setMessage("通信に失敗しました。もう一度お試しください。");
        return;
      }
      setSubmitting(false);
      if (!response.ok) {
        const failure = (await response.json().catch(() => ({}))) as {
          message?: unknown;
          requestId?: unknown;
        };
        if (typeof failure.requestId === "string") setRequestId(failure.requestId);
        setMessage(
          typeof failure.message === "string" ? failure.message : "受け付けられませんでした。",
        );
        return;
      }
      await load(joinToken);
    },
    [joinToken, load],
  );

  const copyPermanentLink = useCallback(async () => {
    if (permanentLink === null) return;
    try {
      await navigator.clipboard.writeText(permanentLink);
      setCopied(true);
    } catch {
      setMessage("コピーできませんでした。リンクを長押しして選択してください。");
    }
  }, [permanentLink]);

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
  if (phase === "invalid_link") {
    return (
      <StateView
        state="forbidden"
        description="この招待リンクは使えません。幹事に新しいリンクを送ってもらってください。"
      />
    );
  }
  if (phase === "not_claimed") {
    return (
      <StateView
        state="forbidden"
        description="まだあなたのお名前が選ばれていません。招待リンクから選び直してください。"
      />
    );
  }
  if (phase === "error" || me === null) return <StateView state="error" requestId={requestId} />;

  const canSelfReport = me.state === "unpaid" || me.state === "expired";

  return (
    <section aria-labelledby="participant-invoice-heading">
      <h1 id="participant-invoice-heading">{me.event.title}</h1>
      <p className="participant-invoice__organizer">集金する人: {me.event.organizerLabel}</p>

      {message !== null ? (
        <p role="alert" className="participant-invoice__message">
          {message}
        </p>
      ) : null}

      <ParticipantStatus
        state={me.state}
        amountMinor={me.invoice?.amountMinor ?? null}
        autoDetected={me.invoice?.autoDetected ?? false}
        confirmationMethod={me.invoice?.confirmationMethod ?? null}
      />

      {canSelfReport ? (
        <div className="participant-invoice__actions">
          <button
            type="button"
            className="tap-target"
            disabled={submitting}
            aria-busy={submitting}
            onClick={() => {
              void post("/api/e/self-report", { method: "other" });
            }}
          >
            幹事が受け取ったと申告する
          </button>
          <button
            type="button"
            className="tap-target"
            disabled={submitting}
            aria-busy={submitting}
            onClick={() => {
              void post("/api/e/cannot-pay", null);
            }}
          >
            この方法では払えない
          </button>
        </div>
      ) : null}

      <p className="participant-invoice__contact">LINE のトークで幹事へ連絡</p>

      <div className="participant-invoice__self-send">
        <button
          type="button"
          className="tap-target"
          disabled={permanentLink === null}
          onClick={() => {
            void copyPermanentLink();
          }}
        >
          このリンクを自分に送る
        </button>
        {copied ? (
          <p role="status">リンクをコピーしました。LINE のトークに貼り付けて自分に送れます。</p>
        ) : null}
        {permanentLink === null ? null : (
          <p className="participant-invoice__permanent-link">
            <a href={permanentLink} rel="noreferrer" target="_blank">
              LINE で開く
            </a>
          </p>
        )}
      </div>
    </section>
  );
}
