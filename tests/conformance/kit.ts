/**
 * ProviderConformanceKit（`docs/implementation-plan.md` §14-4 / `docs/research/design-synthesis.md`
 * §9-2 / `docs/research/premortem-risks.md` §3-4）。
 *
 * アダプタを1本書いたら `registerProvider()` に `key` を登録するだけで、C1〜C31（+C4b）の
 * ケースが自動で回る……という設計の**土台**。task_019 の時点では task_018（台帳適用・
 * 冪等基盤・Webhook ルート・fixture_provider 契約テストヘルパー）が未着手のため、DB /
 * Webhook ルートを要するケースは各アダプタの `*.conformance.test.ts` 側で `n/a` として
 * 明示記録する（`docs/concerns/task_019.md`）。task_018 完了後に当該ケースを実行するように
 * なっても、このファイルを書き換える必要は無い — `*.conformance.test.ts` 側が
 * `ConformanceCaseResult` を `"pass"` で積むだけでよい。
 *
 * ★ `registerProvider` は fixture の `captured_from` 欠落を拒否し（`provenance.ts`）、
 *   `synthesized` のみのアダプタが `autoDetect: true` を名乗るのも拒否する
 *   （`src/lib/payments/registry.ts` の実行時ガードと同じ規則を登録時にも効かせる）。
 */

import type { PaymentProvider } from "@/lib/payments/types";

import {
  assertFixtureProvenance,
  isAutoDetectJustifiedByFixtures,
  type FixtureCapturedFrom,
  type FixtureProvenanceMeta,
} from "./provenance";

// ============================================================================
// ケースカタログ（C1〜C31 + C4b。design-synthesis.md §9-2 / premortem-risks.md §3-4 の転記）
// ============================================================================

export type ConformanceCaseId =
  | "C1"
  | "C2"
  | "C3"
  | "C4"
  | "C4b"
  | "C5"
  | "C6"
  | "C7"
  | "C8"
  | "C9"
  | "C10"
  | "C11"
  | "C12"
  | "C13"
  | "C14"
  | "C15"
  | "C16"
  | "C17"
  | "C18"
  | "C19"
  | "C20"
  | "C21"
  | "C22"
  | "C23"
  | "C24"
  | "C25"
  | "C26"
  | "C27"
  | "C28"
  | "C29"
  | "C30"
  | "C31";

export interface ConformanceCaseSpec {
  readonly id: ConformanceCaseId;
  readonly title: string;
}

/** 全 32 ケースの一覧。順序は design-synthesis.md §9-2 → premortem-risks.md §3-4 の掲載順。 */
export const CASE_CATALOG: readonly ConformanceCaseSpec[] = [
  { id: "C1", title: "重複配信3回で台帳が1件だけ" },
  { id: "C2", title: "順序逆転（succeeded→expired）でも paid が維持される" },
  { id: "C3", title: "署名不一致で400・sig_ok=false" },
  { id: "C4", title: "別 providerEventId の重複でも台帳1件（ledgerDedupeKey 一致）" },
  { id: "C4b", title: "正当な2回目の部分返金が2件目として台帳に載る" },
  { id: "C5", title: "金額不一致で adjustment 1件・rank 不変・needs_attention" },
  { id: "C6", title: "未知の externalRef（孤児イベント）で 200 を返しつつ台帳を汚さない" },
  { id: "C7", title: "再照会一致（trust='unverified'）で台帳に載る" },
  { id: "C8", title: "再照会不一致で台帳に書かない" },
  { id: "C9", title: "能力宣言の遵守（capabilities.refund='none' → NotSupportedError）" },
  { id: "C10", title: "非自動ラベル（autoDetect=false のアダプタの案内が非自動を示す）" },
  { id: "C11", title: "取消（void）後の入金で paid へ前進・void 維持・needs_attention" },
  { id: "C12", title: "必須ゲート未通過で createCheckout が ProviderNotEnabledError（→409）" },
  { id: "C13", title: "2 binding 同時決済でそれぞれ正しい資格情報が使われる" },
  { id: "C14", title: "ゲート off でも既存 external_ref の succeeded が保存される" },
  { id: "C15", title: "expired 確定後に届いた succeeded が台帳に載る" },
  { id: "C16", title: "紛争 fixture で settlement_status が charged_back へ前進する" },
  { id: "C17", title: "全 settlement_status 値が少なくとも1つのイベント種別から到達可能" },
  { id: "C18", title: "部分返金後の残高が正しく settlement_status が refunded にならない" },
  { id: "C19", title: "返金後の再支払いが台帳と表示の両方に反映される" },
  { id: "C20", title: "提示額より少額の支払いで paid にならない" },
  { id: "C21", title: "削除済み参加者の請求への succeeded が orphan にならず要対応記録" },
  { id: "C22", title: "イベント中止後の succeeded が要対応記録＋返金タスクが outbox に積まれる" },
  { id: "C23", title: "同一請求への同時 checkout 要求でも生きた attempt は1つ" },
  { id: "C24", title: "手動確認済み請求に自動入金が届いても手動確認バッジが消えない（過払い検知）" },
  { id: "C25", title: "createCheckout タイムアウト後に届いた succeeded が orphan にならない" },
  { id: "C26", title: "保存後・適用前にクラッシュしても再送/cronで最終的に台帳へ載る" },
  { id: "C27", title: "許可外ホストの deepLink が拒否される" },
  { id: "C28", title: "許可外 IP からの Webhook が DB に1行も残さず 403" },
  { id: "C29", title: "返金可能期間を過ぎた返金が NotSupportedError になる" },
  { id: "C30", title: "createCheckout の金額と事業者 API リクエストの金額が同値" },
  { id: "C31", title: "未知の settlement_status を投入すると DB が拒否する" },
];

// ============================================================================
// 登録
// ============================================================================

/** キットへの登録が拒否されたときの例外（fixture provenance 以外の登録時ルール違反）。 */
export class ConformanceRegistrationError extends Error {
  public readonly providerKey: string;

  public constructor(providerKey: string, message: string) {
    super(`conformance registration rejected (${providerKey}): ${message}`);
    this.name = "ConformanceRegistrationError";
    this.providerKey = providerKey;
  }
}

/**
 * `registerProvider` に渡す fixture の生表現。JSON からそのまま読み込んだ形を想定する
 * （`tests/fixtures/**\/*.json` の実際のキーに合わせ snake_case）。
 */
export interface RawConformanceFixture {
  /** レポート・エラーメッセージに出す短いラベル（ファイル名など）。 */
  readonly label: string;
  readonly captured_from?: unknown;
  readonly captured_at?: unknown;
  readonly source_ref?: unknown;
}

export interface ConformanceEntry {
  readonly key: string;
  readonly provider: PaymentProvider;
  readonly fixtures: readonly FixtureProvenanceMeta[];
}

/**
 * アダプタをキットに登録する。
 *
 * 拒否する条件（いずれも例外）:
 *   - fixture のいずれかで `captured_from` / `captured_at` が欠落・不正
 *   - `provider.capabilities.autoDetect === true` なのに、登録された fixture が
 *     すべて `synthesized`（または fixture が 0 件）
 */
export function registerProvider(
  key: string,
  provider: PaymentProvider,
  rawFixtures: readonly RawConformanceFixture[],
): ConformanceEntry {
  const fixtures = rawFixtures.map((raw) => assertFixtureProvenance(raw, `${key}/${raw.label}`));

  if (provider.capabilities.autoDetect && !isAutoDetectJustifiedByFixtures(fixtures)) {
    throw new ConformanceRegistrationError(
      key,
      "capabilities.autoDetect=true だが、事業者の実レスポンスを捕獲した fixture " +
        "（captured_from が synthesized 以外）が1件もありません",
    );
  }

  return { key, provider, fixtures };
}

// ============================================================================
// レポート
// ============================================================================

export type ConformanceCaseStatus = "pass" | "n/a";

export interface ConformanceCaseResult {
  readonly id: ConformanceCaseId;
  readonly status: ConformanceCaseStatus;
  /** `status === "n/a"` のときは必須（capabilities に応じた n/a の理由を明示記録する）。 */
  readonly reason?: string;
}

export interface ConformanceReport {
  readonly providerKey: string;
  readonly fixtureProvenance: {
    readonly total: number;
    readonly byCapturedFrom: Readonly<Record<FixtureCapturedFrom, number>>;
  };
  readonly results: readonly ConformanceCaseResult[];
}

/** 32 ケースすべてが `results` に含まれていることを検査する（記録漏れの防止）。 */
export function assertCatalogComplete(results: readonly ConformanceCaseResult[]): void {
  const seen = new Set(results.map((r) => r.id));
  const missing = CASE_CATALOG.filter((c) => !seen.has(c.id)).map((c) => c.id);
  if (missing.length > 0) {
    throw new Error(`ConformanceKit: 未記録のケースがあります: ${missing.join(", ")}`);
  }
  const duplicated = results.map((r) => r.id).filter((id, i, arr) => arr.indexOf(id) !== i);
  if (duplicated.length > 0) {
    throw new Error(`ConformanceKit: 同じケースが複数回記録されています: ${duplicated.join(", ")}`);
  }
  for (const r of results) {
    if (r.status === "n/a" && (r.reason === undefined || r.reason.trim().length === 0)) {
      throw new Error(`ConformanceKit: ${r.id} は n/a ですが reason がありません`);
    }
  }
}

/** provenance の内訳を含むレポートを組み立てる（実装計画 §14-4 implementation_steps）。 */
export function buildReport(
  entry: ConformanceEntry,
  results: readonly ConformanceCaseResult[],
): ConformanceReport {
  assertCatalogComplete(results);
  const byCapturedFrom: Record<FixtureCapturedFrom, number> = {
    staging: 0,
    production: 0,
    vendor_doc_verbatim: 0,
    synthesized: 0,
  };
  for (const f of entry.fixtures) byCapturedFrom[f.capturedFrom] += 1;
  return {
    providerKey: entry.key,
    fixtureProvenance: { total: entry.fixtures.length, byCapturedFrom },
    results,
  };
}
