"use client";

/**
 * O-7 配布（§8-1 / task_016）。
 *
 * ★ 起動順序・認証は他の幹事画面（O-4〜O-6）と同じ形（`bootLiff` → `/api/auth/line` →
 *   本体データ取得）。招待リンクは**サーバーに残っていない**ため、この画面を開いた直後は
 *   `joinLink === null` から始まる。`POST /api/events/:id/rotate-join-token` を呼ぶまで
 *   コピー・個別リンク・Flex・QR のどれも出せない（`ShareSheet` 側の方針、C-015-2）。
 *
 * ★ `shareTargetPicker` の可用性は `ready` になった後に一度だけ判定する
 *   （`src/lib/liff/share.ts`）。判定不能・失敗は「使えない」に倒す（fail-closed）。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";

import { ShareSheet, type ShareSheetParticipant } from "@/components/ShareSheet";
import { StateView } from "@/components/StateView";
import { bootLiff, liffPermanentLink, readLiffIdFromDocument } from "@/lib/liff/client";
import { isShareTargetPickerAvailable, openShareTargetPicker, type ShareTargetPickerOutcome } from "@/lib/liff/share";
import { buildFlexShareMessage, buildJoinLink } from "@/lib/share-templates";

type Phase = "loading" | "ready" | "outside_line" | "auth_unavailable" | "forbidden" | "error";

interface SummaryBody {
  readonly event: {
    readonly title: string;
    readonly organizerLabel: string;
    readonly defaultAmountMinor: number | null;
    readonly collectByAt: string | null;
  };
}

interface ParticipantItem {
  readonly id: string;
  readonly displayLabel: string | null;
  readonly status: string;
  readonly amountMinor: number | null;
}

function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function SharePage(): ReactNode {
  const params = useParams<{ id: string }>();
  const eventId = params.id;

  const [phase, setPhase] = useState<Phase>("loading");
  const [permanentLink, setPermanentLink] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>(undefined);
  const [summary, setSummary] = useState<SummaryBody | null>(null);
  const [participants, setParticipants] = useState<readonly ParticipantItem[]>([]);
  const [joinLink, setJoinLink] = useState<string | null>(null);
  const [creatingLink, setCreatingLink] = useState(false);
  const [linkMessage, setLinkMessage] = useState<string | null>(null);
  const [isPickerApiAvailable, setIsPickerApiAvailable] = useState(false);
  const csrfTokenRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run(): Promise<void> {
      const liffId = readLiffIdFromDocument();
      if (liffId === null) {
        if (!cancelled) setPhase("error");
        return;
      }
      const base = liffPermanentLink(liffId);
      if (!cancelled) setPermanentLink(base);

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
        setPhase(summaryResponse.status === 403 || summaryResponse.status === 404 ? "forbidden" : "error");
        return;
      }
      setSummary((await summaryResponse.json()) as SummaryBody);

      try {
        const listResponse = await fetch(`/api/events/${eventId}/participants?filter=all&limit=100`, {
          method: "GET",
        });
        if (listResponse.ok && !cancelled) {
          const listBody = (await listResponse.json()) as { participants: readonly ParticipantItem[] };
          setParticipants(listBody.participants);
        }
      } catch {
        // 一覧が取れなくても配布導線自体は成立させる（催促文・リンク作成は participants に依存しない）。
      }

      // 主導線に必須ではない補助判定なので、失敗しても画面は進める（fail-closed で false のまま）。
      try {
        const available = await isShareTargetPickerAvailable();
        if (!cancelled) setIsPickerApiAvailable(available);
      } catch {
        // 既定値 false のまま。
      }

      if (!cancelled) setPhase("ready");
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  const createLink = useCallback(async () => {
    if (csrfTokenRef.current === null || permanentLink === null) return;
    setCreatingLink(true);
    setLinkMessage(null);
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
      setCreatingLink(false);
      setLinkMessage("通信に失敗しました。もう一度お試しください。");
      return;
    }
    setCreatingLink(false);

    if (!response.ok) {
      const failure = (await response.json().catch(() => ({}))) as { message?: unknown; requestId?: unknown };
      if (typeof failure.requestId === "string") setRequestId(failure.requestId);
      setLinkMessage(typeof failure.message === "string" ? failure.message : "リンクを作れませんでした。");
      return;
    }

    const body = (await response.json()) as { joinToken?: unknown };
    if (typeof body.joinToken === "string") {
      setJoinLink(buildJoinLink(permanentLink, body.joinToken));
    } else {
      setLinkMessage("リンクを作りましたが、表示できませんでした。もう一度お試しください。");
    }
  }, [eventId, permanentLink]);

  const shareViaPicker = useCallback(async (): Promise<ShareTargetPickerOutcome> => {
    if (joinLink === null || summary === null) return "unavailable";
    const message = buildFlexShareMessage({
      event: {
        organizerLabel: summary.event.organizerLabel,
        eventTitle: summary.event.title,
        collectByAt: summary.event.collectByAt,
      },
      amountMinor: summary.event.defaultAmountMinor,
      link: joinLink,
    });
    return openShareTargetPicker([message]);
  }, [joinLink, summary]);

  if (phase === "loading") return <StateView state="loading" />;
  if (phase === "outside_line") return <StateView state="outside_line" permanentLink={permanentLink ?? undefined} />;
  if (phase === "auth_unavailable") {
    return <StateView state="auth_unavailable" permanentLink={permanentLink ?? undefined} requestId={requestId} />;
  }
  if (phase === "forbidden") return <StateView state="forbidden" requestId={requestId} />;
  if (phase === "error" || summary === null) return <StateView state="error" requestId={requestId} />;

  const shareSheetParticipants: readonly ShareSheetParticipant[] = participants.map((p) => ({
    id: p.id,
    displayLabel: p.displayLabel,
    amountMinor: p.amountMinor,
    unpaid: p.status === "unpaid",
  }));

  return (
    <section aria-labelledby="share-heading">
      <h1 id="share-heading">{summary.event.title} を配布する</h1>

      {linkMessage !== null ? (
        <p role="alert" className="share-page__message">
          {linkMessage}
        </p>
      ) : null}

      <ShareSheet
        organizerLabel={summary.event.organizerLabel}
        eventTitle={summary.event.title}
        collectByAt={summary.event.collectByAt}
        defaultAmountMinor={summary.event.defaultAmountMinor}
        joinLink={joinLink}
        onCreateLink={() => {
          void createLink();
        }}
        creatingLink={creatingLink}
        participants={shareSheetParticipants}
        isApiAvailable={isPickerApiAvailable}
        onShareViaPicker={shareViaPicker}
      />
    </section>
  );
}
