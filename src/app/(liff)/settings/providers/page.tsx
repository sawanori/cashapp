"use client";

/**
 * O-11 決済事業者の接続（§8-1 / task_021 scope）。
 *
 * 審査の進捗ステップ表示、接続前の手数料提示、ゲート未通過 → 接続ボタン非表示＋説明。
 *
 * ★ Phase 1 の出荷アダプタは `manual_confirm` のみで、自動アダプタの `provider_binding` 作成は
 *   `docs/gates/compliance-gates.json` の Phase 2 ゲート（`GATE-LEGAL-FUNDS` 等）が全件
 *   `unknown` のあいだ構造的に閉じている（`src/lib/payments/gates.ts`）。したがってこの画面は
 *   Phase 1 では**常に `gate_blocked`** として、接続ボタンを出さず、いまの状態と目安の進捗
 *   ステップだけを示す。ゲートの実値は `/api/admin/gates`（管理者専用）にあり、この画面
 *   （幹事向け）は個別のゲート状態を取得しない — 幹事に見せてよい粒度は「まだ利用できません」
 *   という結論だけである（`docs/gates/README.md`: ゲートの可否判断そのものは PO のみ）。
 */

import { useEffect, useState, type ReactNode } from "react";

import { StateView } from "@/components/StateView";
import { bootLiff, liffPermanentLink, readLiffIdFromDocument } from "@/lib/liff/client";

type Phase = "loading" | "ready" | "outside_line" | "auth_unavailable" | "error";

const ONBOARDING_STEPS: readonly string[] = [
  "① 手動確認版（いますぐ利用可能）で会費の集金を開始する",
  "② 運営者が決済事業者との契約・審査状況を確認する（現在ここ）",
  "③ 審査完了後、自動検知版への切り替えをご案内する",
];

export default function ProviderSettingsPage(): ReactNode {
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
    <section className="provider-settings" aria-labelledby="provider-settings-title">
      <h1 id="provider-settings-title">決済事業者の接続</h1>

      <StateView
        state="gate_blocked"
        description="決済事業者との自動連携は、審査・契約の確認が完了するまでご利用いただけません。いまは手動確認版で会費の集金を進められます。"
      />

      <ol className="provider-settings__steps">
        {ONBOARDING_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>

      <p className="provider-settings__fee-note">
        接続後の手数料は決済事業者との契約が確定してからご案内します。手動確認版に手数料は
        かかりません。
      </p>
    </section>
  );
}
