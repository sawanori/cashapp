/**
 * ルートハンドラの**前段ガード**（クロスサイト送信・Content-Type・本文の形）。
 *
 * ★ なぜ要るか（敵対レビュー F-1, 2026-09-24 / R-SEC-12）
 *   `POST /api/auth/line` は **セッションを作る**エンドポイントである。CSRF トークンを
 *   要求できない（まだセッションが無い）ので、`src/lib/auth/csrf.ts` の免除リストに載っている。
 *   ここを Origin も Content-Type も見ずに開けておくと、攻撃者は自分の未使用 ID トークンを
 *   埋めたフォームを別オリジンに置き、被害者のブラウザからトップレベル送信させられる:
 *
 *     <form method="POST" action="https://app.example/api/auth/line" enctype="text/plain">
 *       <input name='{"idToken":"<攻撃者のトークン>","padding":"' value='"}'>
 *     </form>
 *
 *   `enctype="text/plain"` のフォーム本文は `{"idToken":"…","padding":"="}` という
 *   **有効な JSON** になる。認証が通れば応答が**攻撃者の**セッション Cookie を被害者の
 *   ブラウザへ入れてしまい、以後の操作（同意・イベント作成・請求の確定）が攻撃者の
 *   アカウントに記録される（ログイン CSRF / セッション固定）。ID トークンの単回使用も
 *   IP レート制限も、この**初回の 1 通**は拒否しない。
 *
 * ★ 塞ぎ方は 3 枚重ねにする。どれか 1 つでも攻撃を止められる形にしておく。
 *   1. `Origin` / `Sec-Fetch-Site` が自サイトでなければ **403**。
 *   2. `Content-Type` が `application/json` でなければ **415**
 *      （HTML フォームが送れるのは `application/x-www-form-urlencoded` /
 *        `multipart/form-data` / `text/plain` の 3 つだけなので、これだけでも
 *        フォーム経由の送信は成立しなくなる）。
 *   3. 本文の未知フィールドを **400** で拒否（上記の `padding` のような詰め物を通さない）。
 *
 * ★ `Origin` も `Sec-Fetch-Site` も無いリクエストは **拒否する（fail-closed）**。
 *   ブラウザは POST に必ず `Origin` を付ける（Fetch 標準: GET/HEAD 以外のリクエストは
 *   `Origin` を持つ）ので、正規の LIFF 経路が誤って落ちることはない。判断の根拠は
 *   docs/concerns/task_012.md に記録する。
 *
 * ★ 自サイトの判定に環境変数を増やさない。`Host` ヘッダと `request.url` から導く。
 *   どちらもブラウザ側から別サイトに偽装できない（攻撃者のページが `Host` を選べない）。
 *   LIFF アプリの実体はこのアプリ自身のエンドポイント URL で開かれるため、正規の
 *   `fetch("/api/auth/line")` は常に同一オリジンである。**`https://liff.line.me` は
 *   許可しない**: あのオリジンは全 LIFF アプリの共有物で、誰でも自分の LIFF を置ける。
 */

import "server-only";

import { AppError, ERROR_CODES, badRequest, csrfInvalid } from "@/lib/errors";

/** 受け付ける本文のメディアタイプ。 */
export const JSON_MEDIA_TYPE = "application/json";

/** `POST /api/auth/line` の本文に置いてよいキー（制約 N2: 受け取るのは idToken だけ）。 */
export const AUTH_LINE_BODY_KEYS: readonly string[] = ["idToken"];

/** `host` ヘッダとして受け付ける形（ホスト名 or IPv6 リテラル、任意でポート）。 */
const HOST_RE = /^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/** ローカル開発のホスト。ここだけ `http:` も自サイトとして認める。 */
const LOOPBACK_HOST_RE = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

/**
 * このリクエストにとっての「自サイト」のオリジン一覧。
 *
 * `request.url`（Workers では `Host` + パスから組まれる）と `Host` ヘッダの両方を見る。
 * プロキシやランタイムの差でスキームが落ちても正規リクエストを誤って弾かないように
 * `https://<host>` を必ず候補に入れ、`http://<host>` はループバックのときだけ入れる。
 */
export function allowedSelfOrigins(request: Request): readonly string[] {
  const origins = new Set<string>();

  try {
    const url = new URL(request.url);
    if (url.protocol === "https:" || url.protocol === "http:") {
      origins.add(url.origin);
    }
  } catch {
    // `request.url` が URL として読めない環境ではヘッダ側だけを使う。
  }

  const host = request.headers.get("host");
  if (host !== null && HOST_RE.test(host)) {
    origins.add(`https://${host}`);
    if (LOOPBACK_HOST_RE.test(host)) {
      origins.add(`http://${host}`);
    }
  }

  return [...origins];
}

/**
 * クロスサイトからの送信を 403 で止める。
 *
 * 判定は次の順で行う。
 *   - `Origin` があるなら、自サイトのオリジンと**完全一致**すること
 *     （`null` オリジン＝サンドボックス化された iframe / `data:` 由来も拒否される）。
 *     加えて `Sec-Fetch-Site` が明示的に他サイトを名乗っていないこと。
 *   - `Origin` が無いなら、`Sec-Fetch-Site: same-origin` があること。
 *   - どちらも無ければ拒否（fail-closed）。
 */
export function assertSameOriginRequest(request: Request): void {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");

  if (origin !== null && origin.length > 0) {
    if (!allowedSelfOrigins(request).includes(origin)) {
      throw csrfInvalid("origin is not this site");
    }
    if (site !== null && site !== "same-origin") {
      throw csrfInvalid("sec-fetch-site contradicts origin");
    }
    return;
  }

  if (site === "same-origin") {
    return;
  }

  throw csrfInvalid("no same-origin evidence on the request");
}

/**
 * `Content-Type` が JSON でなければ 415。
 *
 * HTML フォームは JSON を送れないので、この 1 枚だけでもフォーム経由のクロスサイト送信は
 * 成立しなくなる（`fetch` でクロスオリジンに JSON を送ると preflight が必要になり、
 * このアプリは CORS を許可していないため preflight が通らない）。
 */
export function assertJsonContentType(request: Request): void {
  const raw = request.headers.get("content-type");
  const mediaType = (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== JSON_MEDIA_TYPE) {
    throw new AppError(
      ERROR_CODES.BAD_REQUEST,
      415,
      "リクエストの形式が正しくありません。",
      { detail: `content-type must be ${JSON_MEDIA_TYPE}` },
    );
  }
}

/**
 * 本文が JSON オブジェクトで、**許可したキーしか持たない**ことを確かめる（未知フィールドは 400）。
 *
 * `detail` にキー名そのものを載せない（本文は攻撃者が決められるため、ログに任意文字列を
 * 流し込ませない。R-SEC-04）。
 */
export function assertOnlyKnownBodyKeys(body: unknown, allowedKeys: readonly string[]): void {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("request body must be a JSON object");
  }
  for (const key of Object.keys(body as Record<string, unknown>)) {
    if (!allowedKeys.includes(key)) {
      throw badRequest("request body has unexpected fields");
    }
  }
}
