/**
 * `src/lib/payments/money.ts`（§7-6「金額」/ check_093 / C30）。
 *
 * done_definition:
 *   - JPY はゼロデシマルなので minor == major
 *   - 均等割り（最大剰余法）の合計が原資と一致する
 *   - `yen()` 以外のコンストラクタはコンパイルエラー（`@ts-expect-error` で固定し、
 *     `npm run typecheck` が「エラーが出ないこと」を逆に落とす）
 *
 * プロパティテストは外部ライブラリを足さず、決定的な線形合同法（LCG）で作った疑似乱数を
 * 使う。乱数種を固定するので失敗は必ず再現する（fast-check 等の依存追加は並列作業中の
 * `npm i` を避けるためにしない）。
 */

import { describe, expect, it } from "vitest";

import {
  MAX_AMOUNT_MINOR,
  MIN_AMOUNT_MINOR,
  MoneyError,
  formatMoney,
  moneyEquals,
  splitEvenly,
  sumMoney,
  toProviderAmount,
  yen,
} from "@/lib/payments/money";
import type { Money } from "@/lib/payments/types";

/** 決定的な疑似乱数（Numerical Recipes の LCG）。種を固定するので失敗は再現する。 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomInt(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

describe("yen(): 唯一のコンストラクタ", () => {
  it("整数の円をそのまま minor として持つ（JPY はゼロデシマル）", () => {
    const money = yen(5000);
    expect(money.amountMinor).toBe(5000);
    expect(money.currency).toBe("JPY");
  });

  it("小数は作れない", () => {
    expect(() => yen(1000.5)).toThrow(MoneyError);
  });

  it("0 円・負数は作れない（DB の CHECK と同じ下限）", () => {
    expect(() => yen(0)).toThrow(MoneyError);
    expect(() => yen(-1)).toThrow(MoneyError);
    expect(yen(MIN_AMOUNT_MINOR).amountMinor).toBe(1);
  });

  it("上限（1,000,000）を超える額は作れない（R-PAY-10）", () => {
    expect(yen(MAX_AMOUNT_MINOR).amountMinor).toBe(MAX_AMOUNT_MINOR);
    expect(() => yen(MAX_AMOUNT_MINOR + 1)).toThrow(MoneyError);
  });

  it("オブジェクトリテラルは Money に代入できない（check_093: コンパイルエラー）", () => {
    // @ts-expect-error ブランドが無いので Money ではない。ここが通るようになったら型の穴。
    const forged: Money = { amountMinor: 5000, currency: "JPY" };
    // 実行時には素のオブジェクトなので、型の穴が空いたことだけを検査する。
    expect(forged.amountMinor).toBe(5000);
  });
});

describe("toProviderAmount(): アダプタ境界の唯一の出口", () => {
  it("JPY は minor == major をそのまま返す（プロパティ）", () => {
    const random = makeRandom(20260925);
    for (let i = 0; i < 500; i += 1) {
      const amount = randomInt(random, MIN_AMOUNT_MINOR, MAX_AMOUNT_MINOR);
      expect(toProviderAmount(yen(amount))).toBe(amount);
    }
  });

  it("JPY 以外は通さない", () => {
    const notJpy = { amountMinor: 100, currency: "USD" } as unknown as Money;
    expect(() => toProviderAmount(notJpy)).toThrow(MoneyError);
  });
});

describe("splitEvenly(): 最大剰余法", () => {
  it("合計は必ず原資と一致し、差は 1 円以内（プロパティ・500 ケース）", () => {
    const random = makeRandom(4242);
    for (let i = 0; i < 500; i += 1) {
      const total = randomInt(random, 1, 200_000);
      const count = randomInt(random, 1, Math.min(total, 120));
      const shares = splitEvenly(yen(total), count);

      expect(shares).toHaveLength(count);
      expect(sumMoney(shares).amountMinor).toBe(total);

      const values = shares.map((share) => share.amountMinor);
      expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
      for (const value of values) expect(value).toBeGreaterThanOrEqual(1);
    }
  });

  it("端数は先頭から 1 円ずつ配る（10,000 円を 3 人）", () => {
    const shares = splitEvenly(yen(10_000), 3).map((share) => share.amountMinor);
    expect(shares).toEqual([3334, 3333, 3333]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  it("1 人あたり 1 円未満になる割り方は拒否する", () => {
    expect(() => splitEvenly(yen(3), 4)).toThrow(MoneyError);
  });

  it("人数が整数でない・0 以下なら拒否する", () => {
    expect(() => splitEvenly(yen(1000), 0)).toThrow(MoneyError);
    expect(() => splitEvenly(yen(1000), 2.5)).toThrow(MoneyError);
  });
});

describe("補助", () => {
  it("moneyEquals は金額と通貨の両方を見る", () => {
    expect(moneyEquals(yen(3000), yen(3000))).toBe(true);
    expect(moneyEquals(yen(3000), yen(3001))).toBe(false);
  });

  it("formatMoney は 3 桁区切りの円表記", () => {
    expect(formatMoney(yen(123_456))).toBe("¥123,456");
  });

  it("sumMoney は空配列を拒否する（0 円の Money は存在しない）", () => {
    expect(() => sumMoney([])).toThrow(MoneyError);
  });
});
