// 違反フィクスチャ（G12）。合成 fixture しか持たない provider が autoDetect を宣言している。
// 実 Webhook の写しが 1 本も無いまま自動検知を名乗ると、幻覚 API の上に自動照合を積むことになる。

export const providerKey = "synth_provider";

export const capabilities = {
  autoDetect: true,
  refund: false,
};
