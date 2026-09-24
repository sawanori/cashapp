/**
 * 管理面の認証・二人承認（§8-1 O-13 / §9 `/api/admin/*` / task_021 scope）。
 *
 * ★ **別 IdP**（幹事の LINE セッションとは完全に独立した経路）。
 *   幹事のセッション Cookie（`__Host-session`、issuer `cashapp` / audience `cashapp-session`）
 *   は一切検証しない・受け付けない。管理者は毎リクエスト `Authorization: Bearer <token>`
 *   でその場の GitHub 資格情報を提示し、本モジュールが GitHub の
 *   `GET /user`（一次資料: `docs/vendor-docs/github/user-api.md`）を都度呼んで実在確認する。
 *   Cookie を持たない＝CSRF の対象にならない（ブラウザが自動添付しない）ため、
 *   `/api/admin/*` は CSRF トークンを要求しない。
 *
 * ★ 許可リストは `ADMIN_ALLOWLIST`（カンマ区切りの GitHub login。大小無視）。
 *   **未設定・空は「誰も管理者ではない」に倒す**（fail-closed）。読めなければ開くのではなく、
 *   設定不備を 500 `CONFIG_INVALID` として運用者に返す（`isFeatureFlagEnabled` と同じ思想。
 *   `src/lib/db/repositories/gates.ts`）。
 *
 * ★ 二人承認（A23 縮退つき）:
 *   1. **提案**（`proposeAdminAction`）: 管理者 1 が `audit_log` に 1 行（`<kind>.propose`）を書く。
 *      返り値の `proposalId` は `audit_log.id`（bigint 文字列）。
 *   2. **承認**（`approveAdminAction`）: 別の管理者が `proposalId` を指定して承認すると、
 *      `audit_log` にもう 1 行（`<kind>.approve`）を書く。**申請者と承認者が同一人物のときは
 *      提案から 24 時間経過していなければ拒否する**（scope の A23 縮退: 第二承認者が確保できない
 *      間の単独承認＋24 時間クーリング）。二重承認（同じ `proposalId` を 2 度承認）は拒否する。
 *   実際の副作用（feature_flag の更新・幹事の停止）は呼び出し側のルートが承認成功後に
 *   同一トランザクションで行う。
 *
 * ★ `audit_log.detail` に**自由記述を入れない**（premortem P-07: `detail` はキー許可リストを
 *   持たず、`§7-5`「監査ログは ID・enum・金額・タイムスタンプのみ」を機械で守るものが無い）。
 *   本モジュールが書く `detail` は `{ key, value }` や `{ proposalId, twoPerson }` のような
 *   ID・enum・真偽値だけで、理由等の自由記述フィールドは受け取らない。
 */

import "server-only";

import type postgres from "postgres";

import { appendAuditLog } from "@/lib/audit";
import { AppError, ERROR_CODES, type ErrorCode } from "@/lib/errors";

// ============================================================================
// エラー
// ============================================================================

const CODE_FORBIDDEN = "FORBIDDEN" as ErrorCode;
const CODE_ADMIN_PROPOSAL_NOT_FOUND = "ADMIN_PROPOSAL_NOT_FOUND" as ErrorCode;
const CODE_ADMIN_PROPOSAL_CONFLICT = "ADMIN_PROPOSAL_CONFLICT" as ErrorCode;
const CODE_ADMIN_COOLDOWN_ACTIVE = "ADMIN_COOLDOWN_ACTIVE" as ErrorCode;

/** 401。`Authorization` ヘッダが無い・形が不正・GitHub 側でトークンが拒否された。 */
export function adminUnauthorized(detail?: string): AppError {
  return new AppError(
    ERROR_CODES.UNAUTHORIZED,
    401,
    "管理者としての認証情報を確認できませんでした。",
    detail === undefined ? {} : { detail },
  );
}

/** 403。GitHub の認証自体は成功したが、許可リストに載っていない。 */
export function adminForbidden(detail?: string): AppError {
  return new AppError(
    CODE_FORBIDDEN,
    403,
    "この操作を行う権限がありません。",
    detail === undefined ? {} : { detail },
  );
}

/** 500。`ADMIN_ALLOWLIST` が未設定・空。「誰でも通す」ではなく起動不備として扱う。 */
export function adminConfigInvalid(detail?: string): AppError {
  return new AppError(
    ERROR_CODES.CONFIG_INVALID,
    500,
    "管理者認証の設定が不正です。",
    detail === undefined ? {} : { detail },
  );
}

/** 404。指定された提案（`proposalId`）が無い、または種別が一致しない。 */
export function adminProposalNotFound(detail?: string): AppError {
  return new AppError(
    CODE_ADMIN_PROPOSAL_NOT_FOUND,
    404,
    "指定された申請が見つかりません。",
    detail === undefined ? {} : { detail },
  );
}

/** 409。既に承認済み。 */
export function adminProposalConflict(detail?: string): AppError {
  return new AppError(
    CODE_ADMIN_PROPOSAL_CONFLICT,
    409,
    "この申請は既に処理されています。",
    detail === undefined ? {} : { detail },
  );
}

/** 409。単独承認（A23 縮退）のクーリング期間中。 */
export function adminCooldownActive(detail?: string): AppError {
  return new AppError(
    CODE_ADMIN_COOLDOWN_ACTIVE,
    409,
    "同一の管理者による承認は、申請から24時間経過するまで行えません。別の管理者による承認をお待ちください。",
    detail === undefined ? {} : { detail },
  );
}

// ============================================================================
// GitHub 別 IdP 検証
// ============================================================================

/** 一次資料: `docs/vendor-docs/github/user-api.md`。 */
export const GITHUB_USER_ENDPOINT = "https://api.github.com/user";
export const GITHUB_API_VERSION = "2022-11-28";
const MAX_BEARER_TOKEN_LENGTH = 512;
const MAX_LOGIN_LENGTH = 128;

export interface AdminEnv {
  /** カンマ区切りの GitHub login 許可リスト。大文字小文字は無視する。 */
  readonly ADMIN_ALLOWLIST?: string | undefined;
}

export interface AdminIdentity {
  /** `audit_log.actor_ref` に入れる不透明 ID（`"gh:" + login`）。生の資格情報は含まない。 */
  readonly adminId: string;
  readonly login: string;
}

export interface VerifyAdminOptions {
  readonly request: Request;
  readonly env: AdminEnv;
  /** テスト用の差し替え。既定は `fetch`。 */
  readonly fetchImpl?: typeof fetch;
}

function parseAllowlist(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined) return new Set();
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

function extractBearerToken(request: Request): string {
  const header = request.headers.get("authorization");
  if (header === null) throw adminUnauthorized("missing Authorization header");
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (match === null) throw adminUnauthorized("Authorization header is not a Bearer token");
  const token = match[1] ?? "";
  if (token.length === 0 || token.length > MAX_BEARER_TOKEN_LENGTH) {
    throw adminUnauthorized("bearer token has an invalid length");
  }
  return token;
}

/**
 * `Authorization: Bearer <token>` を GitHub の `GET /user` で検証し、許可リストと突き合わせる。
 *
 * 失敗理由は応答に出さない（`detail` はログにのみ残る。`toErrorResponse` の規約）。
 * トークンの値そのものはログにも例外にも載せない。
 */
export async function verifyAdmin(options: VerifyAdminOptions): Promise<AdminIdentity> {
  const token = extractBearerToken(options.request);

  const allowlist = parseAllowlist(options.env.ADMIN_ALLOWLIST);
  if (allowlist.size === 0) {
    throw adminConfigInvalid("ADMIN_ALLOWLIST is not set or empty");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(GITHUB_USER_ENDPOINT, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": GITHUB_API_VERSION,
        "user-agent": "cashapp-admin-auth",
      },
    });
  } catch {
    throw adminUnauthorized("could not reach the identity provider");
  }
  if (!response.ok) {
    throw adminUnauthorized(`identity provider rejected the token (status ${response.status})`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw adminUnauthorized("identity provider response was not JSON");
  }
  const login =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)["login"]
      : undefined;
  if (typeof login !== "string" || login.length === 0 || login.length > MAX_LOGIN_LENGTH) {
    throw adminUnauthorized("identity provider response has no login");
  }

  if (!allowlist.has(login.toLowerCase())) {
    throw adminForbidden(`login not in allowlist: ${login}`);
  }

  return { adminId: `gh:${login}`, login };
}

// ============================================================================
// 二人承認（提案 → 承認）
// ============================================================================

/** クーリング期間（A23 縮退）。 */
export const ADMIN_SINGLE_APPROVER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * `docs/gates/legal-clearance.json` の `cleared` の写し（scope: 「PAYMENTS_ENABLED の true 化は
 * legal-clearance.cleared==true を前提」）。
 *
 * ★ **正本はそのファイル自身**（`docs/gates/README.md`: 変更は PO のみ。`scripts/deny-*.sh` が
 *   Edit / Write / Bash 経由の書き換えをブロックする）。ここに実体を持つ値を置いてビルドへ
 *   バンドルするのは、Cloudflare Workers ランタイムがリポジトリのファイルを直接読めないため
 *   （`src/lib/payments/gates.ts` の `CANONICAL_GATES` と同じ理由・同じ手当て）。
 *   正本との一致は `tests/integration/admin.test.ts` が JSON を読んで機械検査する。
 *   PO が `cleared` を `true` にしたら、このファイルの値も同じコミットで更新すること
 *   （更新自体は PO の変更に追従する人間の作業であり、ここを AI が単独で `true` にしない）。
 */
export const LEGAL_CLEARANCE_CLEARED = false as boolean;

export type AdminActionKind = "admin.flag" | "admin.suspend";

export interface ProposeAdminActionInput {
  readonly kind: AdminActionKind;
  readonly admin: AdminIdentity;
  readonly subjectType: string;
  readonly subjectId: string;
  /** ID・enum・真偽値だけ。自由記述を含めないこと（上のモジュール docstring）。 */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  readonly requestId: string;
  readonly now?: Date;
}

export interface AdminProposal {
  readonly proposalId: string;
  readonly proposedBy: string;
  readonly proposedAt: Date;
}

/** 提案を 1 行、`audit_log` に追記する。呼び出し側は既にトランザクションの中にいること。 */
export async function proposeAdminAction(
  tx: postgres.TransactionSql,
  input: ProposeAdminActionInput,
): Promise<AdminProposal> {
  const now = input.now ?? new Date();
  const appended = await appendAuditLog(tx, {
    actorType: "admin",
    actorRef: Buffer.from(input.admin.adminId, "utf8"),
    action: `${input.kind}.propose`,
    targetType: input.subjectType,
    targetId: input.subjectId,
    requestId: input.requestId,
    detail: { ...input.detail },
    now,
  });
  return { proposalId: appended.id, proposedBy: input.admin.adminId, proposedAt: now };
}

export interface ApproveAdminActionInput {
  readonly kind: AdminActionKind;
  readonly admin: AdminIdentity;
  readonly proposalId: string;
  readonly requestId: string;
  readonly now?: Date;
}

export interface ApprovedAdminAction {
  readonly proposalId: string;
  readonly subjectType: string;
  readonly subjectId: string;
  /** 提案時に記録した detail（`{key,value}` 等）。呼び出し側が再検証してから適用する。 */
  readonly detail: Readonly<Record<string, unknown>>;
  readonly proposedBy: string;
  readonly approvedBy: string;
  /** 申請者と承認者が別人であれば true（本来の二人承認）。同一人物なら false（A23 縮退）。 */
  readonly twoPerson: boolean;
}

interface ProposalRow {
  readonly id: string;
  readonly actor_ref: Buffer | null;
  readonly occurred_at: Date;
  readonly target_type: string;
  readonly target_id: string;
  readonly detail: Record<string, unknown>;
}

/** `proposalId` の形（`audit_log.id` は bigint）。 */
export const ADMIN_PROPOSAL_ID_RE = /^[0-9]{1,19}$/;

/**
 * 提案を承認し、`audit_log` に 2 行目（`<kind>.approve`）を追記する。
 *
 * - 種別（`kind`）が一致する `propose` 行のみを対象にする。
 * - 既に `approve` 行があれば 409（二重承認を拒否）。
 * - 申請者と承認者が同一人物なら、提案から `ADMIN_SINGLE_APPROVER_COOLDOWN_MS` 未満は 409
 *   （A23 縮退のクーリング）。
 *
 * 実際の副作用（`feature_flag` の更新・`app_user` の停止）はここでは行わない。
 * 呼び出し側が返り値の `detail` を検証してから、同一トランザクションで適用すること。
 */
export async function approveAdminAction(
  tx: postgres.TransactionSql,
  input: ApproveAdminActionInput,
): Promise<ApprovedAdminAction> {
  if (!ADMIN_PROPOSAL_ID_RE.test(input.proposalId)) {
    throw adminProposalNotFound("proposalId has an invalid shape");
  }
  const now = input.now ?? new Date();
  const proposeAction = `${input.kind}.propose`;
  const approveAction = `${input.kind}.approve`;

  const rows = await tx<ProposalRow[]>`
    SELECT id, actor_ref, occurred_at, target_type, target_id, detail
    FROM audit_log
    WHERE id = ${input.proposalId}::bigint AND action = ${proposeAction}
  `;
  const proposal = rows[0];
  if (proposal === undefined) throw adminProposalNotFound(`no ${proposeAction} row for id`);

  const already = await tx<{ id: string }[]>`
    SELECT id FROM audit_log
    WHERE action = ${approveAction} AND detail->>'proposalId' = ${input.proposalId}
    LIMIT 1
  `;
  if (already.length > 0) throw adminProposalConflict("proposal already approved");

  const proposedBy = proposal.actor_ref === null ? "" : proposal.actor_ref.toString("utf8");
  const twoPerson = proposedBy !== input.admin.adminId;
  if (!twoPerson) {
    const elapsedMs = now.getTime() - proposal.occurred_at.getTime();
    if (elapsedMs < ADMIN_SINGLE_APPROVER_COOLDOWN_MS) {
      throw adminCooldownActive(
        `single-approver cooldown: elapsed ${elapsedMs}ms of ${ADMIN_SINGLE_APPROVER_COOLDOWN_MS}ms`,
      );
    }
  }

  await appendAuditLog(tx, {
    actorType: "admin",
    actorRef: Buffer.from(input.admin.adminId, "utf8"),
    action: approveAction,
    targetType: proposal.target_type,
    targetId: proposal.target_id,
    requestId: input.requestId,
    detail: { proposalId: input.proposalId, twoPerson },
    now,
  });

  return {
    proposalId: input.proposalId,
    subjectType: proposal.target_type,
    subjectId: proposal.target_id,
    detail: proposal.detail,
    proposedBy,
    approvedBy: input.admin.adminId,
    twoPerson,
  };
}
