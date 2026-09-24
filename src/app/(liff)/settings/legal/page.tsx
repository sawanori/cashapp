"use client";

/**
 * O-13 設定・法務（§8-1 / §7-5 / L7 / task_021 scope）。
 *
 * 運営者名・所在地・連絡先を Phase 1 から掲示する（L7）。規約・プライバシーの全文は
 * `src/content/terms.md` / `src/content/privacy.md`（本ページはその所在を案内する）。
 * データ削除請求は擬似匿名化であり、実行は運営者（管理者）が
 * `POST /api/admin/anonymize` で行う。参加者・幹事自身が直接呼べる経路ではないため、
 * このページは請求の**連絡導線**（LINE のトーク）だけを示す。
 * 一括エクスポートは `GET /api/me/export.zip` への通常のリンクで足りる（ブラウザの標準ダウンロード）。
 */

import { useEffect, useState, type ReactNode } from "react";

import { StateView } from "@/components/StateView";
import { bootLiff, liffPermanentLink, readLiffIdFromDocument } from "@/lib/liff/client";

type Phase = "loading" | "ready" | "outside_line" | "auth_unavailable" | "error";

export const OPERATOR_NAME = "NonTurn LLC";
export const OPERATOR_ADDRESS = "東京・横浜エリア";
export const OPERATOR_CONTACT = "https://non-turn.com/";

export default function LegalSettingsPage(): ReactNode {
  const [phase, setPhase] = useState<Phase>("loading");
  const [permanentLink, setPermanentLink] = useState<string | null>(null);

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
      setPhase("ready");
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase !== "ready") {
    return <StateView state={phase} permanentLink={permanentLink ?? undefined} />;
  }

  return (
    <section className="legal-settings" aria-labelledby="legal-settings-title">
      <h1 id="legal-settings-title">設定・法務</h1>

      <div className="legal-settings__block">
        <h2>運営者情報</h2>
        <dl>
          <dt>運営者名</dt>
          <dd>{OPERATOR_NAME}</dd>
          <dt>所在地</dt>
          <dd>{OPERATOR_ADDRESS}</dd>
          <dt>連絡先</dt>
          <dd>
            <a href={OPERATOR_CONTACT} target="_blank" rel="noreferrer">
              {OPERATOR_CONTACT}
            </a>
          </dd>
        </dl>
      </div>

      <div className="legal-settings__block">
        <h2>規約・プライバシー</h2>
        <p>
          利用規約とプライバシーポリシーの全文は、運営者（{OPERATOR_NAME}）へお問い合わせ
          いただくか、同意画面（初回起動時）で表示される全文をご確認ください。要旨は以下の
          とおりです。
        </p>
        <ul>
          <li>参加者が決済事業者に支払いを完了した時点で、参加者の幹事に対する会費の支払債務は消滅します。</li>
          <li>本アプリは幹事が管理する精算・集金の台帳であり、運営者は資金を経由しません。</li>
          <li>未成年が含まれるイベントでは自動での決済連携を提供しません。</li>
          <li>反社会的勢力に該当する方の利用はお断りします。</li>
          <li>データの削除請求は擬似匿名化（識別情報の置き換え）で対応し、記録自体の物理削除ではありません。</li>
        </ul>
      </div>

      <div className="legal-settings__block">
        <h2>データの削除請求</h2>
        <p>
          ご自身に関するデータの削除（擬似匿名化）をご希望の場合は、LINE のトークで運営者へ
          ご連絡ください。請求・支払・監査の記録は法令で定める期間、金額と ID のみの形で
          保持されます（削除は名前などの識別情報を対象とした処理であり、記録そのものを消す
          物理削除ではありません）。
        </p>
      </div>

      <div className="legal-settings__block">
        <h2>データの一括エクスポート</h2>
        <p>
          <a href="/api/me/export.zip">ご自身のデータを ZIP でダウンロード</a>
        </p>
      </div>
    </section>
  );
}
