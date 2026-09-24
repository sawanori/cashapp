// 違反フィクスチャ（L1）。運営者の口座を資金が経由する構成を素直に書いたもの。
// このファイルは tests/gates/fixtures/** にあり、実アプリのビルドには入らないが、
// リポジトリ全体の typecheck / lint は通る本物の TypeScript として書いてある。

export interface PayoutRequest {
  readonly operatorAccount: string;
  readonly amountMinor: number;
}

export function payoutToOperator(request: PayoutRequest): string {
  return `${request.operatorAccount}/${String(request.amountMinor)}`;
}
