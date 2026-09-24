// 違反フィクスチャ（W3）。状態ランクを経由せず status を直接 'paid' に進めている。

export interface InvoiceRow {
  status: string;
}

export function markPaid(invoice: InvoiceRow): void {
  invoice.status = "paid";
}
