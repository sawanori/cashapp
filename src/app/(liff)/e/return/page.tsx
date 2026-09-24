"use client";

/**
 * P-6 決済からの復帰（§8-2 / task_017 scope）。
 *
 * ★ **リダイレクト到達を支払い確定の根拠にしない**（制約 P3）。この画面は
 *   「戻ってきた」という事実だけを扱い、状態はサーバーの記録に従う。
 *
 * ★ Phase 1 の出荷アダプタは `manual_confirm`（`autoDetect: false`）なので、
 *   戻ってきた時点の表示は必ず **「幹事の確認待ち」** である。
 *   「確認中（最大 5 分で自動反映）」のような自動確定の含みを持つ文言は使わない。
 *
 * ★ `GET /api/return/:returnToken`（Cookie 非依存の復帰経路）と `getPaymentStatus` の
 *   初回照会は自動アダプタが入る task_027 の scope。手動確認には照会先が無い
 *   （`capabilities.statusQuery === false`）ため、ここでは外部照会を一切行わない。
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, type ReactNode } from "react";

import { StateView } from "@/components/StateView";

function ReturnPageBody(): ReactNode {
  const searchParams = useSearchParams();
  const invoiceId = searchParams.get("invoice");

  if (invoiceId === null) {
    return <StateView state="error" />;
  }

  return (
    <section className="return" aria-labelledby="return-title">
      <h1 id="return-title">幹事の確認待ちです</h1>
      <p data-testid="return-manual-note">
        お支払いの確認は幹事が手動で確認します。アプリは入金を検知しません（自動照合ではありません）。
      </p>
      <p>
        幹事が受け取りを記録すると、あなたの会費の状態が「支払済み（手動確認）」に変わります。
        時間がかかることがありますので、しばらくおいてからご確認ください。
      </p>
      <p>
        <Link href={`/e/done?invoice=${encodeURIComponent(invoiceId)}`}>会費受領記録を見る</Link>
      </p>
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
