/**
 * ProviderConformanceKit — fixture の出自（provenance）検証。
 *
 * `docs/implementation-plan.md` §14-4 / `docs/research/design-synthesis.md` §9-2 /
 * task_019 の scope「fixture の captured_from（staging|production|vendor_doc_verbatim|
 * synthesized）と取得日を必須にし、synthesized のみのアダプタは autoDetect=true を登録
 * できない」/ done_definition「captured_from 欠落の fixture でキットが登録を拒否することを
 * テスト」。
 *
 * ★ ここでの provenance は「1 fixture ファイルの出自」（4 値）。
 *   `src/lib/payments/registry.ts` の `FixtureProvenance`（`"captured" | "synthesized" |
 *   "none"` — アダプタ単位の実行時ゲート判定用）とは別物で、混同しないこと。
 *   後者は前者から `synthesized` かどうかだけを見て導出できる関係にある
 *   （`isAutoDetectJustifiedByFixtures` がその判定そのもの）。
 */

export const FIXTURE_CAPTURED_FROM_VALUES = [
  "staging",
  "production",
  "vendor_doc_verbatim",
  "synthesized",
] as const;

export type FixtureCapturedFrom = (typeof FIXTURE_CAPTURED_FROM_VALUES)[number];

export interface FixtureProvenanceMeta {
  readonly capturedFrom: FixtureCapturedFrom;
  /** 取得日。`YYYY-MM-DD`。 */
  readonly capturedAt: string;
  /** 一次資料・キャプチャ元の説明（任意）。 */
  readonly sourceRef?: string;
}

/** キットが fixture の登録を拒否したときの例外。 */
export class FixtureProvenanceError extends Error {
  public readonly fixtureLabel: string;

  public constructor(fixtureLabel: string, message: string) {
    super(`fixture provenance rejected (${fixtureLabel}): ${message}`);
    this.name = "FixtureProvenanceError";
    this.fixtureLabel = fixtureLabel;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isFixtureCapturedFrom(value: unknown): value is FixtureCapturedFrom {
  return (
    typeof value === "string" &&
    (FIXTURE_CAPTURED_FROM_VALUES as readonly string[]).includes(value)
  );
}

/**
 * fixture のメタデータを検査する。`captured_from` 欠落・不正な値、`captured_at` 欠落・
 * 不正な書式は例外を投げる（＝キットは登録を拒否する）。
 *
 * ★ 入力は JSON 由来の生オブジェクトを想定するため、キーは `captured_from` / `captured_at`
 *   の snake_case（`tests/fixtures/**\/*.json` の実際の書式）。パース後の内部表現
 *   （`FixtureProvenanceMeta`）は TypeScript の慣例に合わせ camelCase にする。
 */
export function assertFixtureProvenance(
  meta: unknown,
  fixtureLabel: string,
): FixtureProvenanceMeta {
  if (typeof meta !== "object" || meta === null) {
    throw new FixtureProvenanceError(fixtureLabel, "captured_from が欠落しています");
  }
  const record = meta as Record<string, unknown>;

  if (!isFixtureCapturedFrom(record.captured_from)) {
    throw new FixtureProvenanceError(
      fixtureLabel,
      `captured_from が欠落または不正です（${FIXTURE_CAPTURED_FROM_VALUES.join(" | ")} のいずれか必須）`,
    );
  }
  if (typeof record.captured_at !== "string" || !DATE_RE.test(record.captured_at)) {
    throw new FixtureProvenanceError(
      fixtureLabel,
      "captured_at が欠落しているか YYYY-MM-DD 形式ではありません",
    );
  }
  const sourceRef = record.source_ref;
  return {
    capturedFrom: record.captured_from,
    capturedAt: record.captured_at,
    sourceRef: typeof sourceRef === "string" ? sourceRef : undefined,
  };
}

/**
 * `synthesized`（人が手で書いた想定レスポンス）のみの fixture 集合は自動検知を名乗れない
 * （G12 / `src/lib/payments/registry.ts` の `entry.fixtureProvenance !== "captured"` ガードと
 * 同じ規則を、fixture 1 件ずつの出自から判定する）。fixture が 0 件の場合も同様に「正当化
 * できない」扱いにする（実測を1件も持たない自動検知は名乗れない）。
 */
export function isAutoDetectJustifiedByFixtures(
  fixtures: readonly FixtureProvenanceMeta[],
): boolean {
  return fixtures.some((f) => f.capturedFrom !== "synthesized");
}
