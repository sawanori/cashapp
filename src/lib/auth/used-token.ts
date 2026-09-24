/**
 * LINE ID トークンの単回使用（R-SEC-08 / ADR-009）。
 *
 * ★ **生の ID トークンは保存しない。** 保存するのは `jti`（LINE のペイロードには現状無い）
 *   または `sha256(idToken)` の hex だけである。
 *
 * ★ 判定は「INSERT が行を作れたか」だけで行う。SELECT してから INSERT すると、
 *   同一トークンの 2 本の同時リクエストが両方とも「未使用」と判断しうる
 *   （2 回目を弾くという目的がちょうど競合で破れる）。
 *   `INSERT ... ON CONFLICT DO NOTHING RETURNING` は 1 文で原子的に決着する。
 *
 * ★ TTL はトークンの `exp`。期限切れ行の削除は `/api/cron/idempotency-cleanup`（task_020）。
 */

import "server-only";

import type postgres from "postgres";

/** 単回使用の記録先。テストは in-memory 実装を差し込む（本番経路は DB 実装のみ）。 */
export interface UsedIdTokenStore {
  /**
   * 使用済みとして記録する。
   * @returns 記録できた（＝**初回**）なら true、既に記録済み（＝**再利用**）なら false。
   */
  markUsed(key: string, expiresAt: Date): Promise<boolean>;
}

/** `used_id_token` テーブルを使う実装。 */
export function createDbUsedIdTokenStore(sql: postgres.Sql): UsedIdTokenStore {
  return {
    async markUsed(key: string, expiresAt: Date): Promise<boolean> {
      const rows = await sql<{ jti_or_hash: string }[]>`
        INSERT INTO used_id_token (jti_or_hash, expires_at)
        VALUES (${key}, ${expiresAt})
        ON CONFLICT (jti_or_hash) DO NOTHING
        RETURNING jti_or_hash
      `;
      return rows.length === 1;
    },
  };
}

/**
 * 単回使用キーを作る。
 *
 * `jti` があればそれを使う（`jti:` で前置してハッシュ側と衝突しないようにする）。
 * LINE の verify レスポンスに `jti` は無い [実測 2026-09-24]ので、実運用では
 * 常に `sha256(idToken)` 側になる。将来 `jti` が増えたら自動でそちらに切り替わる。
 */
export async function idTokenUsageKey(
  idToken: string,
  jti: string | undefined,
): Promise<string> {
  if (typeof jti === "string" && jti.length > 0) {
    return `jti:${jti}`;
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(idToken));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}
