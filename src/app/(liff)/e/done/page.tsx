"use client";

/**
 * P-7 完了（§8-2 / task_017 scope）。
 *
 * ★ 出す証憑は **「会費受領記録」** である（`docs/wording-policy.md` の許可文言）。
 *   運営者は資金を経由しないため、運営者名義の証憑は発行できない（制約 L1 / §18-4）。
 *   発行者は幹事であり、税法上の証憑ではないことを画面に明記する。
 *
 * ★ 幹事への連絡は固定文言（§8-2 P-7）。アプリから幹事へ通知は送らない。
 *
 * ★ 手動確認の会費は、幹事が記録するまで「支払済み」にならない。ここでも
 *   「アプリが入金を検知した」と読める書き方をしない。
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, type ReactNode } from "react";

import { StateView } from "@/components/StateView";

function DonePageBody(): ReactNode {
  const searchParams = useSearchParams();
  const invoiceId = searchParams.get("invoice");

  if (invoiceId === null) {
    return <StateView state="error" />;
  }

  return (
    <section className="done" aria-labelledby="done-title">
      <h1 id="done-title">会費受領記録</h1>
      <p>
        この記録は幹事が発行するものです。運営者はお金を預かっていないため、
        運営者名義の証憑は発行できません。税務上の証憑としてはお使いいただけません。
      </p>
      <p data-testid="done-manual-note">
        手動確認の会費は、幹事が受け取りを記録した時点で「支払済み（手動確認・自動照合ではありません）」
        になります。
      </p>
      <p className="done__contact">
        金額や状態に行き違いがあるときは、LINE のトークで幹事へご連絡ください。
      </p>
      <p>
        <Link href={`/e/return?invoice=${encodeURIComponent(invoiceId)}`}>状態をもう一度見る</Link>
      </p>
    </section>
  );
}

export default function DonePage(): ReactNode {
  return (
    <Suspense fallback={<StateView state="loading" />}>
      <DonePageBody />
    </Suspense>
  );
}
