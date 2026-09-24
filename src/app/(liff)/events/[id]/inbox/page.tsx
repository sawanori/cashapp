"use client";

/**
 * O-9 要対応インボックス（§8-1 / task_021 scope）。
 *
 * ★ データ源は既存の `GET /api/events/:id/participants?filter=all`（task_015 の所有・
 *   本タスクの files_to_modify に含まれないため変更しない）。`ParticipantRow` が持つのは
 *   `needsAttention` / `confirmationMethod` / `rosterStatus` / `autoDetected` までで、
 *   O-9 が挙げる 10 種別（金額不一致・二重払い・取消後入金・孤児・支払手段なし・手動と自動の
 *   混在・紛争・二重送金の可能性・返金期限が近い・代理払いの可能性）を機械的に判別するための
 *   内訳フィールド（台帳残高・void 理由・紛争フラグ等）は返さない。
 *
 *   このページは取得できる範囲でだけ種別を推定する（`confirmationMethod==='mixed'` →
 *   「手動と自動の混在」、`rosterStatus==='canceled'` かつ `needsAttention` →
 *   「取消後入金」）。それ以外は「要確認（詳細は請求詳細で確認）」に丸める。
 *   完全な自動分類は `docs/concerns/task_021.md` に対応予定タスクとして記録している。
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { StateView } from "@/components/StateView";
import { bootLiff, liffPermanentLink, readLiffIdFromDocument } from "@/lib/liff/client";

type Phase = "loading" | "ready" | "outside_line" | "auth_unavailable" | "error" | "forbidden";

interface ParticipantRowView {
  readonly id: string;
  readonly displayLabel: string | null;
  readonly rosterStatus: string;
  readonly amountMinor: number | null;
  readonly autoDetected: boolean;
  readonly confirmationMethod: string | null;
  readonly needsAttention: boolean;
}

/** O-9 の 10 種別（参考表示。自動分類できるのは一部のみ。上のモジュール docstring）。 */
const O9_CATEGORY_LEGEND: readonly string[] = [
  "金額不一致",
  "二重払い",
  "取消後入金",
  "孤児（試行に紐づく請求が無い）",
  "支払手段なし",
  "手動と自動の混在",
  "紛争",
  "二重送金の可能性（自己申告）",
  "返金期限が近い",
  "代理払いの可能性",
];

function classify(row: ParticipantRowView): string {
  if (row.confirmationMethod === "mixed") return "手動と自動の混在";
  if (row.rosterStatus === "canceled") return "取消後入金";
  if (row.rosterStatus === "unpaid" && row.amountMinor === null) return "支払手段なし";
  return "要確認（詳細は名簿で確認）";
}

export default function InboxPage(): ReactNode {
  const params = useParams<{ id: string }>();
  const eventId = params.id;

  const [phase, setPhase] = useState<Phase>("loading");
  const [permanentLink, setPermanentLink] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<readonly ParticipantRowView[]>([]);

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

      let listResponse: Response;
      try {
        listResponse = await fetch(
          `/api/events/${eventId}/participants?filter=all&limit=100`,
          { method: "GET" },
        );
      } catch {
        if (!cancelled) setPhase("error");
        return;
      }
      if (cancelled) return;
      if (listResponse.status === 403) {
        setPhase("forbidden");
        return;
      }
      if (!listResponse.ok) {
        const body = (await listResponse.json().catch(() => ({}))) as { requestId?: unknown };
        if (typeof body.requestId === "string") setRequestId(body.requestId);
        setPhase("error");
        return;
      }
      const body = (await listResponse.json()) as { items?: readonly ParticipantRowView[] };
      const needsAttention = (body.items ?? []).filter((item) => item.needsAttention);
      setItems(needsAttention);
      setPhase("ready");
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (phase !== "ready") {
    return (
      <StateView state={phase} requestId={requestId} permanentLink={permanentLink ?? undefined} />
    );
  }

  if (items.length === 0) {
    return (
      <StateView
        state="empty"
        description="いま要対応の項目はありません。"
        permanentLink={permanentLink ?? undefined}
      />
    );
  }

  return (
    <section className="inbox" aria-labelledby="inbox-title">
      <h1 id="inbox-title">要対応（{items.length} 件）</h1>
      <details className="inbox__legend">
        <summary>種別の一覧</summary>
        <ul>
          {O9_CATEGORY_LEGEND.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
      </details>
      <ul className="inbox__list">
        {items.map((item) => (
          <li key={item.id} className="inbox__row">
            <span className="inbox__label">{item.displayLabel ?? "(未設定)"}</span>
            <span className="inbox__category">{classify(item)}</span>
            <span className="inbox__status">{item.rosterStatus}</span>
            <Link href={`/events/${eventId}/participants`}>名簿で確認</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
