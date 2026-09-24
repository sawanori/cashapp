/**
 * 金額（`docs/implementation-plan.md` §7-6 / §7-8「金額」）。
 *
 * ★ `Money` を作れるのは `yen()` **だけ**。オブジェクトリテラルは `Money` のブランド
 *   （`src/lib/payments/types.ts` の `declare const MONEY_BRAND`）を満たせないため代入できず、
 *   「どこかで生の number を通貨として扱ってしまう」経路が型で塞がれる（check_093 / C30）。
 *
 * ★ アダプタ境界へ数値を渡すのは `toProviderAmount()` 1 関数だけ（§7-6）。事業者 API の
 *   リクエストに載る数値がここを必ず通ることで、「渡した金額」と「事業者に届いた金額」の
 *   同値性が 1 か所の検査で保証できる。
 *
 * ★ JPY はゼロデシマル通貨なので minor == major（1 円 = 1）。小数・負数・非整数は作れない。
 *   上限は DB の CHECK（`amount_minor BETWEEN 1 AND 1000000`）と同じ 1,000,000 にそろえる。
 *
 * ★ 均等割りは**最大剰余法**（`splitEvenly`）。端数を 1 人に寄せず、先頭から 1 円ずつ配る。
 *   合計は必ず原資と一致する（`money.test.ts` のプロパティテスト）。
 */

import { type Money } from "./types";

/** `invoice.amount_minor` / `payment_attempt.amount_minor` の DB 側 CHECK と同じ下限・上限。 */
export const MIN_AMOUNT_MINOR = 1;
export const MAX_AMOUNT_MINOR = 1_000_000;

export class MoneyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/**
 * `Money` の唯一のコンストラクタ。
 *
 * `as unknown as Money` はこのファイルのこの 1 か所だけに置く。ブランドは型だけの存在なので
 * 実行時の値は `{ amountMinor, currency }` の 2 キーのままである。
 */
export function yen(amountMinor: number): Money {
  assertAmountInvariant(amountMinor);
  return { amountMinor, currency: "JPY" } as unknown as Money;
}

/**
 * アダプタ境界（事業者 API のリクエスト組み立て）へ数値を渡す唯一の関数。
 * JPY はゼロデシマルなので minor をそのまま返すが、**通貨の取り違えをここで 1 度だけ検査する**。
 */
export function toProviderAmount(money: Money): number {
  if (money.currency !== "JPY") {
    throw new MoneyError(`unsupported currency: ${String(money.currency)}`);
  }
  // G5 round1 GPT F-3 是正: ブランドは**構造的**なので `{ ...yen(3000), amountMinor: 3000.5 }` は
  // 型アサーション無しで `Money` に化ける（スプレッドがブランドごと引き継ぐ）。`yen()` の検査を
  // 通らない値がここへ来る経路が実在するため、境界でもう一度だけ同じ不変条件を確かめる。
  assertAmountInvariant(money.amountMinor);
  return money.amountMinor;
}

/** `yen()` と `toProviderAmount()` が共有する不変条件（整数・範囲内）。 */
function assertAmountInvariant(amountMinor: number): void {
  if (!Number.isInteger(amountMinor)) {
    throw new MoneyError(`amount must be an integer (JPY is zero-decimal): ${String(amountMinor)}`);
  }
  if (amountMinor < MIN_AMOUNT_MINOR || amountMinor > MAX_AMOUNT_MINOR) {
    throw new MoneyError(
      `amount out of range [${MIN_AMOUNT_MINOR}, ${MAX_AMOUNT_MINOR}]: ${String(amountMinor)}`,
    );
  }
}

/** 同値判定。`Money` は構造体なので `===` では比較しない。 */
export function moneyEquals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

/** 表示用。`¥3,000` の形。数字を「手数料」と同一文に並べないこと（W-FEE-FIXED）。 */
export function formatMoney(money: Money): string {
  return `¥${money.amountMinor.toLocaleString("ja-JP")}`;
}

/**
 * 均等割り（最大剰余法 / largest remainder）。
 *
 * `total` を `count` 人に割る。商を全員に配り、余り `r` を**先頭から 1 円ずつ**配る。
 * 返る配列の長さは `count`、合計は必ず `total.amountMinor` と一致し、
 * 最大値と最小値の差は 1 円以内になる。
 */
export function splitEvenly(total: Money, count: number): readonly Money[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new MoneyError(`split count must be a positive integer: ${String(count)}`);
  }
  if (count > total.amountMinor) {
    throw new MoneyError(
      `cannot split ${String(total.amountMinor)} into ${String(count)} shares of at least 1`,
    );
  }
  const base = Math.floor(total.amountMinor / count);
  const remainder = total.amountMinor - base * count;
  const shares: Money[] = [];
  for (let i = 0; i < count; i += 1) {
    shares.push(yen(base + (i < remainder ? 1 : 0)));
  }
  return shares;
}

/** 合計。空配列は `MoneyError`（0 円の `Money` は作れないため）。 */
export function sumMoney(parts: readonly Money[]): Money {
  if (parts.length === 0) throw new MoneyError("cannot sum an empty list");
  let acc = 0;
  for (const part of parts) {
    if (part.currency !== "JPY") throw new MoneyError(`unsupported currency: ${part.currency}`);
    acc += part.amountMinor;
  }
  return yen(acc);
}
