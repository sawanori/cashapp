// 違反フィクスチャ（N2）。クライアントが自称した本人情報をそのままサーバーへ送る経路。
// @line/liff の実行時 API に依存させると型検査がブラウザ環境前提になるため、
// gate:constraints が走査する呼び出し名そのものを定数として置いている。

export const clientIdentitySource = "liff.getDecodedIDToken()";

export function buildIdentityPayload(sub: string): { readonly userId: string; readonly source: string } {
  return { userId: sub, source: clientIdentitySource };
}
