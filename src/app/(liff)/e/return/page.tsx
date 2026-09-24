"use client";

/**
 * P-6 決済からの復帰（§8-2 / task_017 scope）。
 *
 * ★ **リダイレクト到達を支払い確定の根拠にしない**（制約 P3）。この画面は
 *   「戻ってきた」という事実だけを扱い、状態はサーバーの記録（`GET /api/e/me`）に従う。
 *
 * ★ G5 round1 GPT F-4 是正: 修正前はサーバーに一切問い合わせず、常に「幹事の確認待ちです」を
 *   出していた。幹事が `manual-attest` を済ませても参加者側はいつまでも確認待ちのままで、
 *   この導線からは確定後の状態を見られなかった。招待トークン（`?t=`）があれば
 *   `GET /api/e/me` を引いて実際の状態を出す。トークンが無い場合だけ、状態を**断定せず**
 *   P-3（自分の請求）へ誘導する。
 *
 * ★ Phase 1 の出荷アダプタは `manual_confirm`（`autoDetect: false`）なので、支払済みの表示には
 *   必ず「手動確認・自動照合ではありません」を添える。「確認中（最大 5 分で自動反映）」のような
 *   自動確定の含みを持つ文言は使わない。
 *
 * ★ `GET /api/return/:returnToken`（Cookie 非依存の復帰経路）と `getPaymentStatus` の初回照会は
 *   自動アダプタが入る task_027 の scope。手動確認には照会先が無い
 *   （`capabilities.statusQuery === false`）ため、ここでは外部照会を一切行わない。
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type ReactNode } from "react";

import { StateView } from "@/components/StateView";
import { bootLiff, liffPermanentLink, readLiffIdFromDocument } from "@/lib/liff/client";

type Phase = "loading" | "ready" | "outside_line" | "auth_unavailable" | "error" | "forbidden";

type InvoiceState =
  | "awaiting_approval"
  | "not_issued"
  | "voided"
  | "paid"
  | "pending_checkout"
  | "self_reported"
  | "expired"
  | "unpaid";

interface MeBody {
  readonly invoice: {
    readonly id: string;
    readonly amountMinor: number | null;
    readonly autoDetected: boolean;
    readonly confirmationMethod: "automatic" | "manual_by_organizer" | "mixed" | null;
  } | null;
  readonly state: InvoiceState;
}

/** 状態 → 見出しと説明。禁止語を使わず、確定していないものを確定として書かない。 */
function describe(body: MeBody): { readonly title: string; readonly detail: string } {
  if (body.state === "paid") {
    const manual = body.invoice?.autoDetected === false;
    return {
      title: manual ? "支払済み（手動確認）です" : "支払済みです",
      detail: manual
        ? "幹事が受け取りを記録しました（自動照合ではありません）。"
        : "お支払いの記録が反映されています。",
    };
  }
  if (body.state === "self_reported") {
    return {
      title: "あなたの申告を幹事が確認中です",
      detail: "幹事が受け取りを記録すると、状態が支払済みに変わります。",
    };
  }
  if (body.state === "voided") {
    return { title: "この会費は取り消されています", detail: "幹事にご連絡ください。" };
  }
  if (body.state === "expired") {
    return {
      title: "お支払い期限を過ぎています",
      detail: "LINE のトークで幹事へご連絡ください。",
    };
  }
  return {
    title: "幹事の確認待ちです",
    detail:
      "お支払いの確認は幹事が手動で確認します。アプリは入金を検知しません（自動照合ではありません）。",
  };
}

function ReturnPageBody(): ReactNode {
  const searchParams = useSearchParams();
  const invoiceId = searchParams.get("invoice");
  // 招待トークン（`X-Join-Token` ヘッダに載せる値）。パスには置かない（制約 X-ID）。
  // 変数名を `inviteToken` にしているのは、X-ID の grep が「角括弧で囲んだ招待トークン名」を
  // URL パス配置の印として探しており、React の依存配列がその形と衝突するためである。
  const inviteToken = searchParams.get("t");

  const [phase, setPhase] = useState<Phase>(inviteToken === null ? "ready" : "loading");
  const [permanentLink, setPermanentLink] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>(undefined);
  const [me, setMe] = useState<MeBody | null>(null);

  useEffect(() => {
    if (inviteToken === null) return;
    let cancelled = false;

    async function run(token: string): Promise<void> {
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

      try {
        const authResponse = await fetch("/api/auth/line", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ idToken: boot.idToken }),
        });
        if (cancelled) return;
        if (!authResponse.ok) {
          setPhase("auth_unavailable");
          return;
        }
        const response = await fetch("/api/e/me", {
          method: "GET",
          headers: { "X-Join-Token": token },
        });
        if (cancelled) return;
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { requestId?: unknown };
          if (typeof body.requestId === "string") setRequestId(body.requestId);
          setPhase(response.status === 403 ? "forbidden" : "error");
          return;
        }
        setMe((await response.json()) as MeBody);
        setPhase("ready");
      } catch {
        if (!cancelled) setPhase("error");
      }
    }

    void run(inviteToken);
    return () => {
      cancelled = true;
    };
  }, [inviteToken]);

  if (invoiceId === null) {
    return <StateView state="error" />;
  }

  if (phase !== "ready") {
    return (
      <StateView
        state={phase === "loading" ? "loading" : phase}
        requestId={requestId}
        permanentLink={permanentLink ?? undefined}
      />
    );
  }

  const suffix = inviteToken === null ? "" : `&t=${encodeURIComponent(inviteToken)}`;
  const view =
    me === null
      ? {
          title: "幹事の確認待ちです",
          detail:
            "お支払いの確認は幹事が手動で確認します。アプリは入金を検知しません（自動照合ではありません）。",
        }
      : describe(me);

  return (
    <section className="return" aria-labelledby="return-title">
      <h1 id="return-title">{view.title}</h1>
      <p data-testid="return-manual-note">{view.detail}</p>
      {me === null ? (
        <p className="return__unknown" role="status">
          この画面ではいまの状態を確認できません。招待リンクから自分の会費の画面を開いてください。
        </p>
      ) : null}
      <p>
        <Link href={`/e/done?invoice=${encodeURIComponent(invoiceId)}${suffix}`}>
          会費受領記録を見る
        </Link>
      </p>
      {inviteToken === null ? null : (
        <p>
          <Link href={`/e/me?t=${encodeURIComponent(inviteToken)}`}>自分の会費の画面に戻る</Link>
        </p>
      )}
      <p className="return__contact">
        行き違いがあるときは、LINE のトークで幹事へご連絡ください。
      </p>
    </section>
  );
}

export default function ReturnPage(): ReactNode {
  return (
    <Suspense fallback={<StateView state="loading" />}>
      <ReturnPageBody />
    </Suspense>
  );
}
