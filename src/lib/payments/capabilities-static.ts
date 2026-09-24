/**
 * 決済手段の静的能力表（O-3 の手数料提示・FeeEstimate 用。task_014 scope）。
 *
 * ★ Phase 1 の出荷アダプタは `manual_confirm` の 1 つだけである
 *   （`docs/implementation-plan.md` §7-6「非自動ラベル 8 層」）。ここに書く値は
 *   `provider_binding.capabilities` のような実行時データではなく、**画面表示のための
 *   静的な最小表**である。task_017 の `src/lib/payments/types.ts`（アダプタ IF v2）は
 *   この静的表を取り込んで正式な `PaymentProvider.capabilities` と突き合わせる予定であり、
 *   本ファイルの形（`providerKey` / `feeModel`）はその前提に合わせてある。
 *
 * ★ `docs/wording-policy.md` の `W-FEE-FIXED` は「手数料」と具体的な率・金額・無料表現を
 *   同一文内に並べることを禁じる（決済事業者との契約が未確定のため）。したがって本ファイルの
 *   文言・ラベルは、`手数料` の近くに数字（%・円）や「無料」「0円」「ゼロ」を**一切置かない**
 *   （`手数料なし` のような数字を伴わない定性表現のみ許容される）。
 *
 * ★ O-3（イベント作成）の時点では参加者数も確定しておらず、`集金総額・手数料概算・
 *   受取見込額・入金予定時期` はすべて**推定**である（check_080）。`estimateFeeForEvent`
 *   は常に `isEstimate: true` を返す。
 */

export const DEFAULT_PROVIDER_KEY = "manual_confirm";

export type FeeModelKind = "none" | "undetermined";

export interface FeeModelStatic {
  readonly kind: FeeModelKind;
  /** 利用者向けの定性説明。数字を含めない（W-FEE-FIXED 対策）。 */
  readonly note: string;
}

export interface ProviderCapabilitiesStatic {
  readonly providerKey: string;
  readonly label: string;
  readonly feeModel: FeeModelStatic;
  /** 入金予定時期の定性説明。数字を含めない。 */
  readonly settlementEta: string;
}

export const STATIC_PROVIDER_CAPABILITIES: readonly ProviderCapabilitiesStatic[] = [
  {
    providerKey: "manual_confirm",
    label: "手動確認（幹事が直接受け取る）",
    feeModel: {
      kind: "none",
      note: "手数料なし。幹事が参加者から直接受け取ります。",
    },
    settlementEta: "幹事が受け取りを確認した時点で、会費受領記録に反映されます（即時）。",
  },
];

export function getStaticProviderCapabilities(
  providerKey: string,
): ProviderCapabilitiesStatic | undefined {
  return STATIC_PROVIDER_CAPABILITIES.find((entry) => entry.providerKey === providerKey);
}

/**
 * 静的表から必ず 1 件取り出す（task_017 の `PaymentProvider.capabilities` 用）。
 *
 * `getStaticProviderCapabilities` は「表に無い＝未定」を `undefined` で表すが、
 * **アダプタ自身の能力宣言**は未定であってはならない（`ProviderCapabilities.feeModel.note` は
 * 必須で、空文字や「未定」をアダプタが自分で名乗ると O-3 の手数料提示が壊れる）。
 * 実装済みのアダプタが静的表に載っていないのは配線ミスなので、起動時に落とす。
 */
export function requireStaticProviderCapabilities(
  providerKey: string,
): ProviderCapabilitiesStatic {
  const entry = getStaticProviderCapabilities(providerKey);
  if (entry === undefined) {
    throw new Error(`no static capabilities entry for provider: ${providerKey}`);
  }
  return entry;
}

export interface FeeEstimateInput {
  readonly providerKey: string;
  /** イベントの既定金額（1 人あたり）。未入力なら `null`。 */
  readonly defaultAmountMinor: number | null;
  /** 参加者数の見込み。O-3（作成前）では未定なので `null` を渡してよい。 */
  readonly participantCountEstimate?: number | null;
}

export interface FeeEstimateResult {
  /** 見込みの集金総額（`defaultAmountMinor × participantCountEstimate`）。算出できなければ `null`。 */
  readonly totalMinor: number | null;
  /** 見込みの手数料。`feeModel.kind === "none"` なら常に 0（`totalMinor` が確定しているときのみ）。 */
  readonly feeMinorEstimate: number | null;
  /** 見込みの受取額（`totalMinor - feeMinorEstimate`）。 */
  readonly netMinorEstimate: number | null;
  /** O-3 の文脈では常に true（参加者数未確定・手数料契約未確定のため）。 */
  readonly isEstimate: true;
  readonly feeNote: string;
  readonly settlementEta: string;
}

export function estimateFeeForEvent(input: FeeEstimateInput): FeeEstimateResult {
  // 敵対レビュー GPT F-4: `input.providerKey` が静的表に無いとき `DEFAULT_PROVIDER_KEY`
  // （manual_confirm）へフォールバックしていたため、`getStaticProviderCapabilities` は
  // ほぼ常に何かを見つけてしまい、直後の「表に無ければ『未定』」分岐が実質デッドコードだった
  // （未確定の決済手段でも manual_confirm の「手数料なし・即時」がそのまま出ていた）。
  // `providerKey` が未指定（null/undefined 相当）で呼ぶ場合は、呼び出し側
  // （`src/lib/db/repositories/events.ts` の `event.provider_key ?? DEFAULT_PROVIDER_KEY`）で
  // 既に解決してから渡すこと。ここではフォールバックしない。
  const capabilities = getStaticProviderCapabilities(input.providerKey);

  if (capabilities === undefined) {
    // 静的表に載っていない provider_key（未確定の決済手段）。確定値を捏造せず「未定」に倒す。
    return {
      totalMinor: null,
      feeMinorEstimate: null,
      netMinorEstimate: null,
      isEstimate: true,
      feeNote: "手数料は未定です。",
      settlementEta: "入金予定時期は未定です。",
    };
  }

  const participantCount = input.participantCountEstimate ?? null;
  const totalMinor =
    input.defaultAmountMinor === null
      ? null
      : participantCount === null
        ? input.defaultAmountMinor
        : input.defaultAmountMinor * participantCount;

  if (capabilities.feeModel.kind === "none") {
    return {
      totalMinor,
      feeMinorEstimate: totalMinor === null ? null : 0,
      netMinorEstimate: totalMinor,
      isEstimate: true,
      feeNote: capabilities.feeModel.note,
      settlementEta: capabilities.settlementEta,
    };
  }

  return {
    totalMinor,
    feeMinorEstimate: null,
    netMinorEstimate: null,
    isEstimate: true,
    feeNote: capabilities.feeModel.note,
    settlementEta: capabilities.settlementEta,
  };
}
