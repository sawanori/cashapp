"use client";

/**
 * O-0 オンボーディング分岐（§8-1 / task_017 scope / check_092）。
 *
 * ★ 出荷しているのは **(A) 手動確認版だけ**である。(B) 自動検知版は決済事業者の
 *   加盟店審査と法務ゲートの通過が前提で、Phase 2 まで選べない。ここで (B) を
 *   「もうすぐ使える」かのように見せない（R-LAW-03 / R-UX-06）。
 *
 * ★ 適格性チェック（A26 / check_092）:
 *     - 継続的な主催者であること（単発の幹事には自動決済を提示しない）
 *     - 特商法表記（氏名・住所・電話、または法が認める代替手段）を公開できること
 *   どちらかが満たせない場合、(B) は選べない。**サーバー側でも同じ判定をする**
 *   （`src/lib/payments/registry.ts` のガード。UI の非表示は補助にすぎない）。
 *
 * ★ 未成年を含むイベントには自動決済を提示しない（`event.minors_included`）。
 *   ここでの申告は案内であり、実際の拒否は `resolveProvider` の `MINORS_INCLUDED` ガードが行う。
 *
 * ★ この画面はネットワークに触れない（選択の結果はイベント作成 O-3 に持ち越す）。
 *   したがって `loading` / `error` の状態を持たず、LIFF の起動も要求しない。
 */

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";

/** 自動検知版に進むための適格性（すべて true が必要）。 */
interface Eligibility {
  readonly recurringOrganizer: boolean;
  readonly canPublishSellerInfo: boolean;
  readonly noMinors: boolean;
}

const INITIAL_ELIGIBILITY: Eligibility = {
  recurringOrganizer: false,
  canPublishSellerInfo: false,
  noMinors: false,
};

export function isEligibleForAutomatic(eligibility: Eligibility): boolean {
  return (
    eligibility.recurringOrganizer && eligibility.canPublishSellerInfo && eligibility.noMinors
  );
}

export default function OnboardingPage(): ReactNode {
  const [eligibility, setEligibility] = useState<Eligibility>(INITIAL_ELIGIBILITY);
  const [choice, setChoice] = useState<"manual" | "automatic" | null>(null);

  const eligible = useMemo(() => isEligibleForAutomatic(eligibility), [eligibility]);

  function toggle(key: keyof Eligibility): void {
    setEligibility((current) => ({ ...current, [key]: !current[key] }));
    if (key !== "noMinors" && choice === "automatic") setChoice(null);
  }

  return (
    <section className="onboarding" aria-labelledby="onboarding-title">
      <h1 id="onboarding-title">集金のはじめ方を選ぶ</h1>

      <fieldset className="onboarding__eligibility">
        <legend>はじめに確認してください</legend>
        <label className="onboarding__check">
          <input
            type="checkbox"
            checked={eligibility.recurringOrganizer}
            onChange={() => {
              toggle("recurringOrganizer");
            }}
          />
          くり返し集金する主催者として続ける予定がある
        </label>
        <label className="onboarding__check">
          <input
            type="checkbox"
            checked={eligibility.canPublishSellerInfo}
            onChange={() => {
              toggle("canPublishSellerInfo");
            }}
          />
          氏名・住所・電話番号（または法律が認める代わりの連絡方法）を参加者に公開できる
        </label>
        <label className="onboarding__check">
          <input
            type="checkbox"
            checked={eligibility.noMinors}
            onChange={() => {
              toggle("noMinors");
            }}
          />
          このイベントに未成年の参加者は含まれない
        </label>
      </fieldset>

      <ol className="onboarding__options">
        <li className="onboarding__option" data-recommended="true">
          <h2>(A) 手動確認版</h2>
          <p className="onboarding__eta">いますぐ使えます（手続きは不要です）。</p>
          <ul>
            <li>幹事が参加者から直接受け取ります。</li>
            <li>
              アプリは入金を検知しません。受け取りの記録は幹事が名簿から付けます（自動照合ではありません）。
            </li>
            <li>まずはこちらで 1 イベントを最後まで通すことをおすすめします。</li>
          </ul>
          <label className="onboarding__choice">
            <input
              type="radio"
              name="onboarding-choice"
              value="manual"
              checked={choice === "manual"}
              onChange={() => {
                setChoice("manual");
              }}
            />
            手動確認版ではじめる
          </label>
        </li>

        <li className="onboarding__option" data-locked={eligible ? "false" : "true"}>
          <h2>(B) 自動検知版</h2>
          <p className="onboarding__eta">
            決済事業者の加盟店審査が必要です。申込から利用開始までの目安は事業者の審査次第で、
            数週間かかることがあります（当社では短縮できません）。
          </p>
          <ul>
            <li>参加者は決済事業者の画面でお支払いになります。</li>
            <li>お金は幹事名義の加盟店アカウントへ直接入ります。アプリはお金を預かりません。</li>
            <li>提供開始時期は未定です（法務確認と事業者との契約が終わっていません）。</li>
          </ul>
          {eligible ? null : (
            <p className="onboarding__locked-note" role="status">
              上の確認がすべて満たされていないため、いまはお選びいただけません。
              未成年の参加者が含まれるイベントでは自動検知版をご利用いただけません。
            </p>
          )}
          <label className="onboarding__choice">
            <input
              type="radio"
              name="onboarding-choice"
              value="automatic"
              disabled={!eligible}
              checked={choice === "automatic"}
              onChange={() => {
                setChoice("automatic");
              }}
            />
            自動検知版の案内を見る
          </label>
        </li>
      </ol>

      {choice === "manual" ? (
        <p className="onboarding__next">
          <Link href="/events/new">イベントを作成する</Link>
        </p>
      ) : null}
      {choice === "automatic" ? (
        <p className="onboarding__next" role="status">
          自動検知版はまだ受け付けを開始していません。まずは手動確認版で 1 イベントを通してください。
        </p>
      ) : null}
    </section>
  );
}
