// 違反フィクスチャ（P1）。アダプタ層の外から決済事業者 SDK を取り込む行。
// 実際の import 文にすると未インストールのパッケージを解決できず typecheck が落ちるため、
// gate:constraints が走査する行テキストそのものを定数として置いている。

export const forbiddenImportLine = 'import Stripe from "stripe";';

export function describeViolation(): string {
  return `P1 違反: ${forbiddenImportLine}`;
}
