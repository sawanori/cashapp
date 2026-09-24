/**
 * `scripts/gate-env-scope.mjs` の検査 (7)（片側混入型の検出）のためのフィクスチャ。
 *
 * 実リポジトリの `src/lib/config/env.ts` は実 ref が未採番でプレースホルダのままなので、
 * そのままでは「実 ref が入ったあとに片側混入を捕まえられるか」を検査できない。
 * ここでは**採番済みの世界**を模して、ソース固定の宣言に実在しそうな ref を置く。
 *
 * ★ このファイルはゲートに読まれるだけで、アプリからは import されない。
 *   ゲートは正規表現で `EXPECTED_SUPABASE_PROJECT_REF` の object literal だけを切り出す。
 */

export const EXPECTED_SUPABASE_PROJECT_REF: Readonly<Record<string, string | null>> = {
  development: null,
  staging: "stagingprojectrefabc",
  production: "productionprojectref",
};
