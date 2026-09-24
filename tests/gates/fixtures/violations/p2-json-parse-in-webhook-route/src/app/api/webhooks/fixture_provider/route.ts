// 違反フィクスチャ（P2）。Webhook ルートがアダプタに渡す前に本文を JSON.parse している。
// parseWebhook は raw 文字列と Headers を受け取る契約なので、この時点で構造化すると
// 署名検証の対象バイト列が失われる。

export function handleWebhook(rawBody: string): { readonly id: unknown } {
  const parsed = JSON.parse(rawBody) as { id: unknown };
  return { id: parsed.id };
}
