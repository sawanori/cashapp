"use client";

/**
 * O-4 イベント詳細（サマリ部分）（§8-1 / task_014）。
 *
 * `GET /api/events/:id` はサマリ専用（内訳・要対応件数・手数料見込み）。名簿本体は
 * `/events/:id/participants` に分離してある（R-UX-03。100 名規模でも一括取得しない設計）。
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { SummaryBar } from "@/components/SummaryBar";
import { StateView } from "@/components/StateView";
import { bootLiff, liffPermanentLink, readLiffIdFromDocument } from "@/lib/liff/client";

type Phase = "loading" | "ready" | "outside_line" | "auth_unavailable" | "error" | "forbidden";

interface EventSummaryBody {
  readonly event: {
    readonly id: string;
    readonly title: string;
    readonly organizerLabel: string;
    readonly status: string;
    readonly collectByAt: string | null;
  };
  readonly participantCount: number;
  readonly breakdown: {
    readonly unpaid: number;
    readonly paidAutomatic: number;
    readonly paidManual: number;
    readonly paidMixed: number;
    readonly needsAttention: number;
  };
  readonly feeEstimate: {
    readonly feeMinorEstimate: number | null;
    readonly netMinorEstimate: number | null;
  };
}

interface ErrorBodyLike {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly requestId?: unknown;
}

export default function EventDetailPage(): ReactNode {
  const params = useParams<{ id: string }>();
  const eventId = params.id;

  const [phase, setPhase] = useState<Phase>("loading");
  const [permanentLink, setPermanentLink] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>(undefined);
  const [summary, setSummary] = useState<EventSummaryBody | null>(null);

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

      let summaryResponse: Response;
      try {
        summaryResponse = await fetch(`/api/events/${eventId}`, { method: "GET" });
      } catch {
        setPhase("error");
        return;
      }
      if (cancelled) return;
      if (!summaryResponse.ok) {
        const body = (await summaryResponse.json().catch(() => ({}))) as ErrorBodyLike;
        if (typeof body.requestId === "string") setRequestId(body.requestId);
        setPhase(summaryResponse.status === 403 || summaryResponse.status === 404 ? "forbidden" : "error");
        return;
      }
      const body = (await summaryResponse.json()) as EventSummaryBody;
      setSummary(body);
      setPhase("ready");
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (phase === "loading") return <StateView state="loading" />;
  if (phase === "outside_line") return <StateView state="outside_line" permanentLink={permanentLink ?? undefined} />;
  if (phase === "auth_unavailable") {
    return <StateView state="auth_unavailable" permanentLink={permanentLink ?? undefined} requestId={requestId} />;
  }
  if (phase === "forbidden") return <StateView state="forbidden" requestId={requestId} />;
  if (phase === "error" || summary === null) return <StateView state="error" requestId={requestId} />;

  return (
    <section aria-labelledby="event-detail-heading">
      <h1 id="event-detail-heading">{summary.event.title}</h1>
      <p>集金者: {summary.event.organizerLabel}</p>

      <SummaryBar
        participantCount={summary.participantCount}
        paidAutomaticCount={summary.breakdown.paidAutomatic}
        paidManualCount={summary.breakdown.paidManual}
        mixedCount={summary.breakdown.paidMixed}
        unpaidCount={summary.breakdown.unpaid}
        needsAttentionCount={summary.breakdown.needsAttention}
        feeMinorEstimate={summary.feeEstimate.feeMinorEstimate}
        netMinorEstimate={summary.feeEstimate.netMinorEstimate}
      />

      <nav aria-label="イベント内の操作">
        <ul className="event-detail__actions">
          <li>
            <Link className="tap-target" href={`/events/${eventId}/participants`}>
              名簿を見る・参加者を登録する
            </Link>
          </li>
          <li>
            <Link className="tap-target" href={`/events/${eventId}/invoices/confirm`}>
              請求内容を確認して発行する
            </Link>
          </li>
        </ul>
      </nav>
    </section>
  );
}
