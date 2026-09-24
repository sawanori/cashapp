/**
 * `line_user_ref` の算出と `app_user` の解決（サーバー専用）。
 *
 * ★ **LINE の生 `sub`（userId）はどこにも保存しない。** 保存するのは
 *   `line_user_ref = HMAC-SHA256(sub, PEPPER[version])` の 32 バイトだけである（§7-5 / L7）。
 *   提示された userId をハッシュして一致検索はできるが、逆引きはできない。
 *
 * ★ PEPPER は**単独ではローテーションできない**（R-SEC-09）。回すのではなく
 *   `pepper_version` を増やして**二重運用**する:
 *     - 新規ログインは常に現行バージョン（最大の version）で参照値を作る。
 *     - 旧バージョンの行を見つけたら、その場で新バージョンへ書き換える（移行）。
 *     - 移行では `app_user.line_user_ref` と `participant_claim.line_user_ref` の
 *       **両方**を更新する。片方だけ直すと claim が切れる（check_074 の「claim が維持される」）。
 *
 * ★ 移行できないもの: `audit_log.actor_ref`。追記専用テーブルで UPDATE 権限が無く
 *   （task_011 の GRANT）、トリガでも止められている。旧バージョンの `actor_ref` は
 *   旧 PEPPER でしか再計算できないため、**旧 PEPPER を捨てると過去の監査ログの
 *   主体が辿れなくなる**。PEPPER の旧バージョンは `docs/ops/key-rotation-drill.md`
 *   （task_024）の手順で保管期間を決めるまで消さないこと。
 */

import "server-only";

import type postgres from "postgres";

import type { AppConfig, PepperVersion } from "@/lib/config/env";
import { currentPepper } from "@/lib/config/env";
import { AppError, ERROR_CODES } from "@/lib/errors";

/**
 * LINE の userId はプロバイダー単位で共通・移動不可（R-LINE-07）。
 * プロバイダーを変えた場合は同じ人でも別 ID になるため、別スコープとして共存させる。
 *
 * ID トークンからはプロバイダー ID を取れない（`docs/vendor-docs/line/verify.md` のペイロード一覧に無い）。
 * したがってスコープは**運用側の宣言**として持つ。プロバイダーを移設したら、
 * この定数を `line-provider-v2` に上げる（既存行はそのまま残り、新旧が共存する）。
 */
export const IDENTITY_SCOPE = "line-provider-v1";

/** LINE の userId の形（`U` + 32 桁 hex）。 */
export const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/;

/**
 * `app_user` の**作成・移行**だけを直列化する助言ロックの鍵（固定値）。
 *
 * ★ 人ごとの鍵にはできない。鍵を `line_user_ref` から作ると、PEPPER が違う処理系どうしで
 *   鍵も変わってしまい（それが参照値の設計そのものである）、まさに守りたい競合
 *   「v1 の処理系と v2 の処理系が同じ人を同時に作る」を直列化できない。生の `sub` を
 *   鍵にするのは L7（生 userId を DB へ渡さない）に反する。したがって**全体で 1 本**にする。
 *
 * ★ 代わりに、通常ログイン（現行版の行が見つかる経路）ではロックを取らない。
 *   ロックが要るのは初回ログインと pepper_version 移行だけで、どちらも 1 人につき数えるほどしか
 *   起きない。トランザクション終了で自動解放される（`pg_advisory_xact_lock`）。
 */
export const APP_USER_WRITE_LOCK_KEY = 1_012_070_500;

/** `line_user_ref = HMAC-SHA256(sub, PEPPER[version])`。戻り値は 32 バイト。 */
export async function computeLineUserRef(sub: string, pepper: PepperVersion): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper.value),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sub));
  return new Uint8Array(mac);
}

/** `line_user_ref` の fingerprint（先頭 16 hex）。ログに出してよいのはこちらだけ。 */
export function userRefFingerprint(userRef: Uint8Array): string {
  return [...userRef.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface AppUserRow {
  readonly id: string;
  readonly sessionEpoch: number;
  readonly status: "active" | "suspended";
  readonly pepperVersion: number;
  readonly identityScope: string;
  readonly lineEnv: string;
}

interface AppUserDbRow {
  readonly id: string;
  readonly session_epoch: number;
  readonly status: string;
  readonly pepper_version: number;
  readonly identity_scope: string;
  readonly line_env: string;
}

function toAppUserRow(row: AppUserDbRow): AppUserRow {
  return {
    id: row.id,
    sessionEpoch: row.session_epoch,
    status: row.status === "suspended" ? "suspended" : "active",
    pepperVersion: row.pepper_version,
    identityScope: row.identity_scope,
    lineEnv: row.line_env,
  };
}

/**
 * トランザクションの中で `fn` を走らせる。
 *
 * postgres.js では、**すでにトランザクションの中にいる接続（`TransactionSql`）には
 * `begin()` が無く、入れ子は `savepoint()` で表す**。ランタイムの経路は素の `Sql` を
 * 渡してくるので `begin()` で十分だが、統合テストは `withRollback` の中から
 * `TransactionSql` を渡す（テスト同士がデータを汚さないための隔離手段）。
 * 呼び分けをここ 1 か所に閉じ込める。
 */
async function runInTransaction<T>(
  sql: postgres.Sql,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const maybeTransaction = sql as unknown as Partial<postgres.TransactionSql>;
  if (typeof maybeTransaction.savepoint === "function") {
    return (await maybeTransaction.savepoint(fn as never)) as T;
  }
  return (await sql.begin(fn as never)) as T;
}

export interface ResolveAppUserResult {
  readonly user: AppUserRow;
  /** 旧 `pepper_version` から移行したなら、その移行元バージョン。移行していなければ null。 */
  readonly migratedFromPepperVersion: number | null;
  /** 初回ログイン（行を新規作成した）なら true。 */
  readonly created: boolean;
}

/**
 * `sub` から `app_user` を解決する。必要なら旧 `pepper_version` から移行し、
 * 行が無ければ作る。**1 トランザクションで行う**（同時ログインで重複行を作らない）。
 *
 * 手順:
 *   1. 現行 PEPPER で参照値を作り、その行を探す。あればそれ（**ここまでにロックは取らない**）。
 *   2. 無ければ `pg_advisory_xact_lock` を取り、**現行版をもう一度引く**。
 *      ロックを待っているあいだに別トランザクションが作っていれば、それを返す。
 *   3. それでも無ければ、古いバージョンの PEPPER を新しい順に試して行を探す。
 *      見つかったら `app_user` と `participant_claim` を現行バージョンへ書き換える。
 *   4. 作る前に、**DB に自分の設定に無い `pepper_version` の行が無いか**を確かめる。
 *      あればこの処理系の設定が DB と食い違っている（下記）。
 *   5. それでも無ければ新規作成（`ON CONFLICT DO UPDATE` で同時実行に耐える）。
 *
 * ★ 手順 2 の理由（2 周目の敵対レビュー F-1, 2026-09-24）
 *   行がまだ無い状態では `FOR UPDATE` は何も守らず、一意制約 `(identity_scope,
 *   pepper_version, line_user_ref)` にも `pepper_version` が入っている。したがって
 *   **v1 の処理系と v2 の処理系が同じ人の初回ログインを同時に処理すると、両方とも
 *   「見つからない」と判断して別々の行を作れてしまう**（手順 4 の検査も、相手がまだ
 *   commit していなければ空を返す）。作成・移行の経路だけを助言ロックで直列化し、
 *   ロック取得後に必ず引き直すことで、後から入った側は相手が作った行を見つける。
 *
 * ★ 手順 4 の理由（敵対レビュー F-4, 2026-09-24）
 *   移行は `line_user_ref` を**上書き**する（旧参照値は残らない）。そのため PEPPER 切替の
 *   最中に、その版の PEPPER を持っていない処理系（新しい版を持たない古いデプロイ・
 *   巻き戻したデプロイ・secret の投入漏れ／逆に古い版を捨てたデプロイ）へログインが届くと、
 *   その処理系は該当の行を発見できず、**同じ人の app_user をもう 1 つ作ってしまう**。
 *   以後、発行されるセッションの userId が処理系ごとに変わり、
 *   請求・claim・監査ログが 2 つのアカウントに割れる。
 *   割れたアカウントは事後に自動では併合できない（旧参照値が残っていない）ので、
 *   **新規作成の側を止める**（fail-closed）。旧設定の処理系で既存ユーザーがログインできない
 *   状態は 503 として表に出し、運用（secret の投入・デプロイのやり直し）で解消する。
 */
export async function resolveAppUser(
  sql: postgres.Sql,
  config: AppConfig,
  sub: string,
): Promise<ResolveAppUserResult> {
  const current = currentPepper(config);
  const currentRef = await computeLineUserRef(sub, current);

  // 旧バージョンの参照値を先に全部計算しておく（トランザクション内で await しないで済むように）。
  const legacyRefs: { readonly version: number; readonly ref: Uint8Array }[] = [];
  for (const pepper of config.peppers) {
    if (pepper.version === current.version) continue;
    legacyRefs.push({ version: pepper.version, ref: await computeLineUserRef(sub, pepper) });
  }

  const configuredVersions = config.peppers.map((pepper) => pepper.version);

  return runInTransaction(sql, async (tx) => {
    const findCurrent = async (): Promise<AppUserDbRow | undefined> => {
      const rows = await tx<AppUserDbRow[]>`
        SELECT id, session_epoch, status, pepper_version, identity_scope, line_env
        FROM app_user
        WHERE identity_scope = ${IDENTITY_SCOPE}
          AND pepper_version = ${current.version}
          AND line_user_ref = ${currentRef}
        FOR UPDATE
      `;
      return rows[0];
    };

    const currentRow = await findCurrent();
    if (currentRow !== undefined) {
      // 既存ユーザーの通常ログイン。ここでは助言ロックを取らない（全ログインを直列化しない）。
      return { user: toAppUserRow(currentRow), migratedFromPepperVersion: null, created: false };
    }

    // ★ ここから先は「移行」か「新規作成」であり、**行がまだ無い**。行が無いので
    //   `FOR UPDATE` は何も守らず、`ON CONFLICT` の一意制約にも `pepper_version` が
    //   入っているため、**別々の pepper_version を持つ 2 つの処理系が同時に走ると
    //   同じ人の行を両方作れてしまう**（2 周目の敵対レビュー F-1）。
    //   作成・移行の経路だけを助言ロックで直列化する。ロックはトランザクション終了で
    //   自動的に解放される（`pg_advisory_xact_lock`）。
    await tx`SELECT pg_advisory_xact_lock(${APP_USER_WRITE_LOCK_KEY})`;

    // ★ ロックを待っているあいだに、別のトランザクションがこの人の行を作って commit した
    //   可能性がある。取り直してから判断する（取り直さないと 2 つ目を作ってしまう）。
    const afterLock = await findCurrent();
    if (afterLock !== undefined) {
      return { user: toAppUserRow(afterLock), migratedFromPepperVersion: null, created: false };
    }

    for (const legacy of legacyRefs) {
      const found = await tx<AppUserDbRow[]>`
        SELECT id, session_epoch, status, pepper_version, identity_scope, line_env
        FROM app_user
        WHERE identity_scope = ${IDENTITY_SCOPE}
          AND pepper_version = ${legacy.version}
          AND line_user_ref = ${legacy.ref}
        FOR UPDATE
      `;
      const legacyRow = found[0];
      if (legacyRow === undefined) continue;

      // ★ claim を先に移す。app_user だけ移して claim を取り残すと
      //   「ログインはできるが自分の請求が見えない」状態になる。
      await tx`
        UPDATE participant_claim
        SET line_user_ref = ${currentRef}, pepper_version = ${current.version}
        WHERE line_user_ref = ${legacy.ref} AND pepper_version = ${legacy.version}
      `;
      const migrated = await tx<AppUserDbRow[]>`
        UPDATE app_user
        SET line_user_ref = ${currentRef}, pepper_version = ${current.version}
        WHERE id = ${legacyRow.id}
        RETURNING id, session_epoch, status, pepper_version, identity_scope, line_env
      `;
      const migratedRow = migrated[0];
      if (migratedRow === undefined) {
        throw new Error("app_user migration updated no row");
      }
      return {
        user: toAppUserRow(migratedRow),
        migratedFromPepperVersion: legacy.version,
        created: false,
      };
    }

    // ★ 新規作成の直前に「自分の設定に無い pepper_version の行」を探す（F-4）。
    //   1 行でも見つかれば、この処理系の PEPPER 設定は DB の中身と食い違っている
    //   （新しい版を持っていない＝設定が古い／古い版を捨てた＝移行元を引けない）。
    //   どちらの向きでも、その版の行はこの処理系からは**見つけられない**ので、
    //   ここで作ると同じ人のアカウントが割れる。作らずに落とす。
    const unknownVersion = await tx<{ pepper_version: number }[]>`
      SELECT pepper_version
      FROM app_user
      WHERE identity_scope = ${IDENTITY_SCOPE}
        AND pepper_version <> ALL (${configuredVersions}::int[])
      LIMIT 1
    `;
    if (unknownVersion.length > 0) {
      throw new AppError(
        ERROR_CODES.CONFIG_INVALID,
        503,
        "ただいま受け付けできません。時間をおいてお試しください。",
        {
          detail:
            `app_user has rows at pepper_version ${unknownVersion[0]?.pepper_version} which this ` +
            `runtime cannot compute (configured versions: ${configuredVersions.join(",")}): ` +
            "refusing to create a second account for the same person " +
            "(give this runtime the missing PEPPER version)",
        },
      );
    }

    const inserted = await tx<(AppUserDbRow & { inserted: boolean })[]>`
      INSERT INTO app_user (line_user_ref, pepper_version, identity_scope, line_env)
      VALUES (${currentRef}, ${current.version}, ${IDENTITY_SCOPE}, ${config.appEnv})
      ON CONFLICT (identity_scope, pepper_version, line_user_ref)
        DO UPDATE SET updated_at = now()
      RETURNING id, session_epoch, status, pepper_version, identity_scope, line_env,
                (xmax = 0) AS inserted
    `;
    const insertedRow = inserted[0];
    if (insertedRow === undefined) {
      throw new Error("app_user upsert returned no row");
    }
    return {
      user: toAppUserRow(insertedRow),
      migratedFromPepperVersion: null,
      created: insertedRow.inserted === true,
    };
  });
}
