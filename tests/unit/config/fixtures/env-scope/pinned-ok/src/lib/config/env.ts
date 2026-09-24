/**
 * `scripts/gate-env-scope.mjs` の検査 (7) が**誤検知しない**ことを示すフィクスチャ。
 *
 * `one-sided-leak` と同じ「採番済みの世界」の宣言を持つが、
 * 隣の wrangler.toml では各 ref が正しい environment にだけ置かれている。
 */

export const EXPECTED_SUPABASE_PROJECT_REF: Readonly<Record<string, string | null>> = {
  development: null,
  staging: "stagingprojectrefabc",
  production: "productionprojectref",
};
