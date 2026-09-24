/**
 * 統合テストの土台。ローカル（`supabase start`）または CI の実 Postgres につなぐ。
 *
 * 接続は 2 本:
 *   - **特権接続**（`postgres`）: マイグレーション実行・フィクスチャ投入・権限スナップショットの読み取り。
 *   - **ランタイム接続**（`app_rw`）: アプリが本番で使うのと同じ最小権限ロール。
 *     追記専用テーブルの UPDATE / DELETE がここで例外になることを証明する（R-SEC-03）。
 *
 * `app_rw` のパスワードはマイグレーションに書かない（本番は秘密ストアから投入する）。
 * ローカル / CI ではこのファイルが起動時にローカル専用の値を設定する。
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";

const execFileAsync = promisify(execFile);

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `supabase start` の既定値。CI では DATABASE_URL_MIGRATOR で上書きする。 */
const DEFAULT_MIGRATOR_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * ローカル / CI 専用の app_rw パスワード。本番・staging では使わない
 * （本番は task_024 / task_035 が秘密ストアから `ALTER ROLE app_rw PASSWORD ...` で投入する）。
 */
const LOCAL_APP_RW_PASSWORD = process.env["APP_RW_PASSWORD"] ?? "app_rw_local_dev_only";

export function migratorConnectionString(): string {
  return process.env["DATABASE_URL_MIGRATOR"] ?? DEFAULT_MIGRATOR_URL;
}

/** ランタイム（app_rw）の直接接続文字列。特権接続のホスト・DB をそのまま使い、ロールだけ差し替える。 */
export function appRwConnectionString(): string {
  const url = new URL(migratorConnectionString());
  url.username = "app_rw";
  url.password = LOCAL_APP_RW_PASSWORD;
  return url.toString();
}

export function createMigratorSql(): postgres.Sql {
  return postgres(migratorConnectionString(), { max: 2, prepare: false, onnotice: () => {} });
}

export function createAppRwSql(): postgres.Sql {
  return postgres(appRwConnectionString(), { max: 2, prepare: false, onnotice: () => {} });
}

/**
 * `ALTER ROLE app_rw` を直列化するためのアドバイザリロックの鍵。
 *
 * vitest はテストファイルを別ワーカーで並列に走らせるため、複数ファイルの `beforeAll` が
 * 同じ `pg_authid` の行を同時に UPDATE すると Postgres が `tuple concurrently updated`
 * （XX000）を投げ、スイート全体が起動前に落ちる。実測: 2 本の psql から同時に
 * `ALTER ROLE app_rw LOGIN PASSWORD ...` を撃つと 3/3 回この失敗が出る。
 *
 * ロックはトランザクションスコープ（`pg_advisory_xact_lock`）のみを使う。セッションスコープの
 * `pg_advisory_lock` は接続がプールに戻っても解放されず、別のテストを巻き込むため使わない
 * （task_011 scope の「セッションスコープの pg_try_advisory_lock は使わない」と同じ方針）。
 *
 * 鍵は「task_011 / app_rw のログイン情報」を表す固定の bigint。他の用途と衝突しないよう
 * 使用箇所はこの関数だけに限る。
 */
const APP_RW_LOGIN_LOCK_KEY = 1101100001;

/**
 * app_rw にローカル専用パスワードを設定する。マイグレーションはロールを作るだけで
 * パスワードを設定しないため（秘密値を SQL に埋めない）、テスト側で毎回設定する。
 *
 * 並列に走る別テストファイルと同時に呼ばれても安全なように、アドバイザリロックを
 * 張ったトランザクション内で 1 文だけを実行する（上のコメントの根拠を参照）。
 */
export async function ensureAppRwLoginPassword(sql: postgres.Sql): Promise<void> {
  // パスワードはプレースホルダに出来ない（ALTER ROLE はパラメータを取らない）。
  // 値はローカル専用の定数であり、シングルクォートのみエスケープする。
  const escaped = LOCAL_APP_RW_PASSWORD.replace(/'/g, "''");
  await sql.begin(async (tx) => {
    // ロックの取得と ALTER ROLE は同一トランザクション・同一接続でなければ直列化されない。
    await tx`SELECT pg_advisory_xact_lock(${APP_RW_LOGIN_LOCK_KEY}::bigint)`;
    await tx.unsafe(`ALTER ROLE app_rw LOGIN PASSWORD '${escaped}'`);
  });
}

/** ロールバック専用の番兵。`withRollback` 以外では投げない。 */
class RollbackSignal extends Error {
  public constructor() {
    super("rollback");
    this.name = "RollbackSignal";
  }
}

/**
 * フィクスチャをトランザクション内で作り、必ずロールバックする。
 * 並列に走る他タスクのデータを汚さないための隔離手段（統合テストの共通規約）。
 */
export async function withRollback<T>(
  sql: postgres.Sql,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  let captured: { value: T } | undefined;
  try {
    await sql.begin(async (tx) => {
      captured = { value: await fn(tx) };
      throw new RollbackSignal();
    });
  } catch (error) {
    if (!(error instanceof RollbackSignal)) throw error;
  }
  if (captured === undefined) {
    throw new Error("withRollback: callback did not complete");
  }
  return captured.value;
}

/**
 * 失敗が想定される 1 文をセーブポイントで包んで実行し、送出された例外を返す。
 * 例外で外側のトランザクションが巻き添えで中断するのを防ぐ。
 * 文が成功してしまった場合は、そのこと自体を失敗として扱えるよう `undefined` を返す。
 */
export async function expectFailure(
  tx: postgres.TransactionSql,
  run: (sp: postgres.TransactionSql) => Promise<unknown>,
): Promise<unknown | undefined> {
  try {
    await tx.savepoint(async (sp) => {
      await run(sp);
    });
    return undefined;
  } catch (error) {
    return error;
  }
}

export interface PostgresErrorLike {
  readonly code?: string;
  readonly message?: string;
}

export function asPgError(error: unknown): PostgresErrorLike {
  if (typeof error === "object" && error !== null) {
    const e = error as { code?: unknown; message?: unknown };
    return {
      code: typeof e.code === "string" ? e.code : undefined,
      message: typeof e.message === "string" ? e.message : undefined,
    };
  }
  return {};
}

export interface FixtureIds {
  readonly userId: string;
  readonly bindingId: string;
  readonly eventId: string;
  readonly participantId: string;
  readonly invoiceId: string;
}

/** 最小の一式（幹事 → binding → イベント → 参加者 → 請求）をトランザクション内に作る。 */
export async function insertBaseFixture(
  tx: postgres.TransactionSql,
  suffix: string,
): Promise<FixtureIds> {
  const [user] = await tx<{ id: string }[]>`
    INSERT INTO app_user (line_user_ref, identity_scope, line_env)
    VALUES (${Buffer.from(`user-${suffix}`)}, ${`test:${suffix}`}, 'development')
    RETURNING id
  `;
  const [binding] = await tx<{ id: string }[]>`
    INSERT INTO provider_binding (organizer_user_id, provider_key, capabilities)
    VALUES (${user!.id}, 'manual_confirm', '{}'::jsonb)
    RETURNING id
  `;
  const [event] = await tx<{ id: string }[]>`
    INSERT INTO event (organizer_user_id, title, organizer_label, join_token_hash,
                       minors_included, provider_binding_id)
    VALUES (${user!.id}, ${`event-${suffix}`}, 'organizer', ${Buffer.from(`join-${suffix}`)},
            false, ${binding!.id})
    RETURNING id
  `;
  const [participant] = await tx<{ id: string }[]>`
    INSERT INTO participant (event_id, display_label)
    VALUES (${event!.id}, ${`p-${suffix}`})
    RETURNING id
  `;
  const [invoice] = await tx<{ id: string }[]>`
    INSERT INTO invoice (event_id, participant_id, amount_minor)
    VALUES (${event!.id}, ${participant!.id}, 3000)
    RETURNING id
  `;
  return {
    userId: user!.id,
    bindingId: binding!.id,
    eventId: event!.id,
    participantId: participant!.id,
    invoiceId: invoice!.id,
  };
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * `supabase db diff` を実行する。マイグレーションを shadow DB に再生し、
 * 実 DB との差分を出す（正本が supabase/migrations であることの機械検査。check_071）。
 */
export async function runSupabaseDbDiff(): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync("supabase", ["db", "diff"], {
      cwd: REPO_ROOT,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(error),
    };
  }
}
