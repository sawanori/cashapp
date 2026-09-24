"use client";

/**
 * O-2 イベント一覧（§8-1 / task_014）。
 *
 * 起動順序は `src/lib/liff/client.ts` の `bootLiff()` に従う（§7-3）。ID トークンが
 * 取れたら `POST /api/auth/line` でセッションを作り、`GET /api/events` で一覧を取る。
 *
 * ★ 要対応件数バッジを常設する（R-OPS-01 の暫定策。§8-1 O-2）。
 */

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { StateView } from "@/components/StateView";
import { bootLiff, liffPermanentLink, readLiffIdFromDocument } from "@/lib/liff/client";

type Phase = "loading" | "ready" | "outside_line" | "auth_unavailable" | "error";

interface EventListItem {
  readonly id: string;
  readonly title: string;
  readonly organizerLabel: string;
  readonly status: string;
  readonly eventAt: string | null;
  readonly collectByAt: string | null;
  readonly participantCount: number;
  readonly unpaidCount: number;
  readonly needsAttentionCount: number;
}

interface ErrorBodyLike {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly requestId?: unknown;
}

const STATUS_LABEL: Readonly<Record<string, string>> = {
  draft: "下書き",
  collecting: "集金中",
  closed: "締切済み",
  canceled: "中止",
};

export default function EventsPage(): ReactNode {
  const [phase, setPhase] = useState<Phase>("loading");
  const [permanentLink, setPermanentLink] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>(undefined);
  const [events, setEvents] = useState<EventListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const loadEvents = useCallback(async (): Promise<void> => {
    setListError(null);
    let response: Response;
    try {
      response = await fetch("/api/events", { method: "GET" });
    } catch {
      setListError("一覧を取得できませんでした。通信状況をご確認のうえ、もう一度お試しください。");
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ErrorBodyLike;
      if (typeof body.requestId === "string") setRequestId(body.requestId);
      setListError(typeof body.message === "string" ? body.message : "一覧を取得できませんでした。");
      return;
    }
    const body = (await response.json()) as { events: EventListItem[] };
    setEvents(body.events);
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
        const body = (await authResponse.json().catch(() => ({}))) as ErrorBodyLike;
        if (typeof body.requestId === "string") setRequestId(body.requestId);
        setPhase("auth_unavailable");
        return;
      }

      setPhase("ready");
      await loadEvents();
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [loadEvents]);

  if (phase === "loading") return <StateView state="loading" />;
  if (phase === "outside_line") return <StateView state="outside_line" permanentLink={permanentLink ?? undefined} />;
  if (phase === "auth_unavailable") {
    return <StateView state="auth_unavailable" permanentLink={permanentLink ?? undefined} requestId={requestId} />;
  }
  if (phase === "error") return <StateView state="error" requestId={requestId} />;

  return (
    <section aria-labelledby="events-heading">
      <h1 id="events-heading">イベント一覧</h1>

      <p>
        <Link className="tap-target" href="/events/new">
          新しいイベントを作る
        </Link>
      </p>

      {listError !== null ? <StateView state="error" description={listError} requestId={requestId} /> : null}

      {events === null ? null : events.length === 0 ? (
        <StateView state="empty" description="まだイベントがありません。" />
      ) : (
        <ul className="event-list">
          {events.map((event) => (
            <li key={event.id} className="event-list__item">
              <Link className="event-list__link" href={`/events/${event.id}`}>
                <span className="event-list__title">{event.title}</span>
                <span className="event-list__status">{STATUS_LABEL[event.status] ?? event.status}</span>
                <span className="event-list__meta tabular">
                  未払い {event.unpaidCount} / {event.participantCount} 名
                </span>
                {event.needsAttentionCount > 0 ? (
                  <span className="event-list__attention-badge" role="status">
                    要対応 {event.needsAttentionCount}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
