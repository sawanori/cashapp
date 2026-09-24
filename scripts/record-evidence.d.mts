// 型宣言: tests/unit/record-evidence.test.ts から scripts/record-evidence.mjs の純関数だけを import するため
// （tsconfig は allowJs=false。実行本体は CLI として spawn して検証する）。
export function scriptNameOf(method: unknown): string | null;
export function maskSecrets(text: unknown): string;
