"use client";

/**
 * O-6.5 請求内容の確認（§8-1 / R-OPS-05 / task_014）。
 *
 * 「人数 N 名 × 金額 X 円 = 合計 Y 円」を大きく表示し、2 段階確認を必須にする。
 * 過去単価との乖離が大きいときは追加警告を出す（R-OPS-05: 幹事の誤操作対策）。
 *
 * ★ **請求の発行そのもの（`POST /api/events/:id/invoices`）は task_015 の scope**
 *   （`docs/task-list.json` task_015 `files_to_create`）。この画面は O-6.5 の確認 UI を
 *   先に完成させておくものであり、実際の発行操作は task_015 が実装するエンドポイントに
 *   接続するまで `gate_blocked` として案内する（404 応答を「準備中」として扱う）。
 */

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { StateView } from "@/components/StateView";
import { bootLiff, liffPermanentLink, readLiffIdFromDocument } from "@/lib/liff/client";

type Phase = "loading" | "ready" | "outside_line" | "auth_unavailable" | "error" | "forbidden";

interface EventSummaryBody {
  readonly event: { readonly id: string; readonly title: string; readonly defaultAmountMinor: number | null };
  readonly participantCount: number;
  readonly breakdown: { readonly unpaid: number };
}

interface EventListItem {
  readonly id: string;
  readonly participantCount: number;
}

function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function formatYen(amountMinor: number | null): string {
  if (amountMinor === null) return "未定";
  return `¥${amountMinor.toLocaleString("ja-JP")}`;
}

export default function InvoicesConfirmPage(): ReactNode {
  const params = useParams<{ id: string }>();
  const eventId = params.id;

  const [phase, setPhase] = useState<Phase>("loading");
  const [permanentLink, setPermanentLink] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>(undefined);
  const csrfTokenRef = useRef<string | null>(null);

  const [summary, setSummary] = useState<EventSummaryBody | null>(null);
  const [pastAverageAmountMinor, setPastAverageAmountMinor] = useState<number | null>(null);

  const [step, setStep] = useState<1 | 2>(1);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<"idle" | "not_yet_available" | "failed" | "done">("idle");
  const [outcomeMessage, setOutcomeMessage] = useState<string | null>(null);

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
      const authBody = (await authResponse.json()) as { csrfToken: string };
      csrfTokenRef.current = authBody.csrfToken;

      let summaryResponse: Response;
      try {
        summaryResponse = await fetch(`/api/events/${eventId}`, { method: "GET" });
      } catch {
        setPhase("error");
        return;
      }
      if (cancelled) return;
      if (!summaryResponse.ok) {
        setPhase(summaryResponse.status === 403 || summaryResponse.status === 404 ? "forbidden" : "error");
        return;
      }
      const summaryBody = (await summaryResponse.json()) as EventSummaryBody;
      if (!cancelled) setSummary(summaryBody);

      // 過去単価との乖離警告（R-OPS-05）: 自分の他イベントの既定金額の平均と比較する。
      // `GET /api/events` は一覧向けの軽量な射影のため既定金額を含まない
      // （`src/lib/db/repositories/events.ts` の `ListedEvent`）。他イベントの ID を取ったうえで
      // サマリ（既定金額を含む）を個別に取得する。幹事あたりのイベント数上限（20 件）が
      // あるため N+1 でも実用上問題にならない。
      try {
        const eventsResponse = await fetch("/api/events", { method: "GET" });
        if (eventsResponse.ok && !cancelled) {
          const eventsBody = (await eventsResponse.json()) as { events: readonly EventListItem[] };
          const otherIds = eventsBody.events.map((e) => e.id).filter((otherId) => otherId !== eventId);
          const amounts = await Promise.all(
            otherIds.map(async (otherId): Promise<number | null> => {
              try {
                const res = await fetch(`/api/events/${otherId}`, { method: "GET" });
                if (!res.ok) return null;
                const body = (await res.json()) as EventSummaryBody;
                return body.event.defaultAmountMinor;
              } catch {
                return null;
              }
            }),
          );
          const known = amounts.filter((amount): amount is number => amount !== null);
          if (!cancelled && known.length > 0) {
            setPastAverageAmountMinor(Math.round(known.reduce((sum, a) => sum + a, 0) / known.length));
          }
        }
      } catch {
        // 乖離警告は付加情報。取れなくても確認画面自体は成立させる。
      }

      if (!cancelled) setPhase("ready");
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  const confirmStep1 = useCallback(() => {
    setStep(2);
  }, []);

  const confirmStep2 = useCallback(async () => {
    if (csrfTokenRef.current === null || summary === null) return;
    setSubmitting(true);
    setOutcome("idle");
    setOutcomeMessage(null);

    let response: Response;
    try {
      response = await fetch(`/api/events/${eventId}/invoices`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-CSRF-Token": csrfTokenRef.current,
          "Idempotency-Key": newIdempotencyKey(),
        },
        body: JSON.stringify({ confirmed: true }),
      });
    } catch {
      setSubmitting(false);
      setOutcome("failed");
      setOutcomeMessage("通信に失敗しました。もう一度お試しください。");
      return;
    }

    setSubmitting(false);
    if (response.status === 404) {
      setOutcome("not_yet_available");
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: unknown; requestId?: unknown };
      if (typeof body.requestId === "string") setRequestId(body.requestId);
      setOutcome("failed");
      setOutcomeMessage(typeof body.message === "string" ? body.message : "請求を発行できませんでした。");
      return;
    }
    setOutcome("done");
  }, [csrfTokenRef, eventId, summary]);

  if (phase === "loading") return <StateView state="loading" />;
  if (phase === "outside_line") return <StateView state="outside_line" permanentLink={permanentLink ?? undefined} />;
  if (phase === "auth_unavailable") {
    return <StateView state="auth_unavailable" permanentLink={permanentLink ?? undefined} requestId={requestId} />;
  }
  if (phase === "forbidden") return <StateView state="forbidden" requestId={requestId} />;
  if (phase === "error" || summary === null) return <StateView state="error" requestId={requestId} />;

  const count = summary.breakdown.unpaid;
  const unitAmount = summary.event.defaultAmountMinor;
  const total = unitAmount === null ? null : unitAmount * count;
  const deviationWarning =
    pastAverageAmountMinor !== null &&
    unitAmount !== null &&
    Math.abs(unitAmount - pastAverageAmountMinor) / pastAverageAmountMinor > 0.5;

  if (outcome === "not_yet_available") {
    return <StateView state="gate_blocked" description="請求の発行はまもなく利用できるようになります。" />;
  }
  if (outcome === "done") {
    return (
      <StateView
        state="empty"
        description="請求を発行しました。配布は配布導線の画面から行ってください。"
      />
    );
  }

  return (
    <section aria-labelledby="invoices-confirm-heading">
      <h1 id="invoices-confirm-heading">請求内容の確認</h1>

      {outcomeMessage !== null ? (
        <StateView state="error" description={outcomeMessage} requestId={requestId} />
      ) : null}

      {deviationWarning ? (
        <p role="alert" className="invoices-confirm__deviation-warning">
          既定金額が過去のイベントの単価と大きく異なります。金額をご確認ください。
        </p>
      ) : null}

      <p className="invoices-confirm__formula tabular">
        {count} 名 × {formatYen(unitAmount)} = {formatYen(total)}
      </p>

      <p className="invoices-confirm__note">
        請求を発行すると、原則として金額は変更できません。内容をよくご確認のうえ進めてください。
      </p>

      {step === 1 ? (
        <button
          type="button"
          className="tap-target"
          onClick={confirmStep1}
        >
          内容を確認した（次へ）
        </button>
      ) : (
        <>
          <p role="alert">本当にこの内容で請求を発行しますか。この操作は取り消せません。</p>
          <button
            type="button"
            className="tap-target"
            disabled={submitting}
            aria-busy={submitting}
            onClick={() => {
              void confirmStep2();
            }}
          >
            発行する
          </button>
          <button
            type="button"
            className="tap-target"
            onClick={() => {
              setStep(1);
            }}
          >
            戻る
          </button>
        </>
      )}
    </section>
  );
}
