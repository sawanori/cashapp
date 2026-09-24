"use client";

/**
 * 管理面（§8-1 O-13 / §9 `/api/admin/*` / task_021 scope）。
 *
 * ★ `(web)` ルートグループ（ADR-013）。`@line/liff` は import しない
 *   （`scripts/build-web-only.mjs` が静的に検査する）。
 *
 * ★ 認証は幹事の LINE セッションと完全に別（`src/lib/admin-auth.ts`）。ここでは GitHub の
 *   個人アクセストークンを**画面に保持するだけ**（`sessionStorage` 等へ永続化しない）で、
 *   毎リクエスト `Authorization: Bearer <token>` として送る。リロードすれば入力し直しになる。
 *
 * ★ 読み取り専用の調査（ゲート・照会）と、二人承認が要る操作（フラグ変更・幹事停止）を
 *   同じ画面にまとめる。二人承認は「提案」→（別の管理者が）「承認」の 2 ステップで、
 *   `proposalId` を運用者どうしで受け渡す（社内チャット等。アプリの外）。
 */

import { useState, type FormEvent, type ReactNode } from "react";

function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface ApiResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

async function callAdminApi(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<ApiResult> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
    },
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

function ResultView({ result }: { readonly result: ApiResult | null }): ReactNode {
  if (result === null) return null;
  return (
    <pre className="admin__result" data-ok={result.ok}>
      {`HTTP ${result.status}\n${JSON.stringify(result.body, null, 2)}`}
    </pre>
  );
}

export default function AdminPage(): ReactNode {
  const [token, setToken] = useState("");
  const [gatesResult, setGatesResult] = useState<ApiResult | null>(null);
  const [lookupResult, setLookupResult] = useState<ApiResult | null>(null);
  const [flagResult, setFlagResult] = useState<ApiResult | null>(null);
  const [suspendResult, setSuspendResult] = useState<ApiResult | null>(null);
  const [anonymizeResult, setAnonymizeResult] = useState<ApiResult | null>(null);

  async function loadGates(): Promise<void> {
    setGatesResult(await callAdminApi(token, "/api/admin/gates"));
  }

  async function submitLookup(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const params = new URLSearchParams();
    for (const key of ["invoiceId", "externalRef", "requestId"]) {
      const value = formData.get(key);
      if (typeof value === "string" && value.trim().length > 0) {
        params.set(key, value.trim());
        break;
      }
    }
    setLookupResult(await callAdminApi(token, `/api/admin/lookup?${params.toString()}`));
  }

  async function submitFlag(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const action = formData.get("action");
    const body =
      action === "propose"
        ? { action: "propose", key: formData.get("key"), value: formData.get("value") }
        : { action: "approve", proposalId: formData.get("proposalId") };
    setFlagResult(
      await callAdminApi(token, "/api/admin/flags", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": newIdempotencyKey() },
        body: JSON.stringify(body),
      }),
    );
  }

  async function submitSuspend(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const action = formData.get("action");
    const body =
      action === "propose"
        ? { action: "propose", organizerUserId: formData.get("organizerUserId") }
        : { action: "approve", proposalId: formData.get("proposalId") };
    setSuspendResult(
      await callAdminApi(token, "/api/admin/suspend", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": newIdempotencyKey() },
        body: JSON.stringify(body),
      }),
    );
  }

  async function submitAnonymize(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const body = { target: formData.get("target"), targetId: formData.get("targetId") };
    setAnonymizeResult(
      await callAdminApi(token, "/api/admin/anonymize", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": newIdempotencyKey() },
        body: JSON.stringify(body),
      }),
    );
  }

  return (
    <div className="admin">
      <h1>管理面</h1>

      <section className="admin__auth">
        <label>
          GitHub アクセストークン
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <p className="admin__auth-note">
          このページを閉じる・再読み込みすると入力し直しになります（保存しません）。
        </p>
      </section>

      <section className="admin__section">
        <h2>ゲート・フラグ（読み取り専用）</h2>
        <button type="button" onClick={() => void loadGates()}>
          読み込む
        </button>
        <ResultView result={gatesResult} />
      </section>

      <section className="admin__section">
        <h2>照会（lookup）</h2>
        <form onSubmit={(event) => void submitLookup(event)}>
          <label>
            invoiceId
            <input type="text" name="invoiceId" />
          </label>
          <label>
            externalRef
            <input type="text" name="externalRef" />
          </label>
          <label>
            requestId
            <input type="text" name="requestId" />
          </label>
          <button type="submit">照会する</button>
        </form>
        <ResultView result={lookupResult} />
      </section>

      <section className="admin__section">
        <h2>フラグ変更（二人承認）</h2>
        <form onSubmit={(event) => void submitFlag(event)}>
          <label>
            action
            <select name="action" defaultValue="propose">
              <option value="propose">propose</option>
              <option value="approve">approve</option>
            </select>
          </label>
          <label>
            key（propose 用）
            <input type="text" name="key" placeholder="PAYMENTS_ENABLED" />
          </label>
          <label>
            value（propose 用）
            <input type="text" name="value" placeholder="true / false / on / off" />
          </label>
          <label>
            proposalId（approve 用）
            <input type="text" name="proposalId" />
          </label>
          <button type="submit">送信</button>
        </form>
        <ResultView result={flagResult} />
      </section>

      <section className="admin__section">
        <h2>幹事の停止（二人承認）</h2>
        <form onSubmit={(event) => void submitSuspend(event)}>
          <label>
            action
            <select name="action" defaultValue="propose">
              <option value="propose">propose</option>
              <option value="approve">approve</option>
            </select>
          </label>
          <label>
            organizerUserId（propose 用）
            <input type="text" name="organizerUserId" />
          </label>
          <label>
            proposalId（approve 用）
            <input type="text" name="proposalId" />
          </label>
          <button type="submit">送信</button>
        </form>
        <ResultView result={suspendResult} />
      </section>

      <section className="admin__section">
        <h2>擬似匿名化（削除請求対応）</h2>
        <form onSubmit={(event) => void submitAnonymize(event)}>
          <label>
            target
            <select name="target" defaultValue="participant">
              <option value="organizer">organizer</option>
              <option value="participant">participant</option>
            </select>
          </label>
          <label>
            targetId
            <input type="text" name="targetId" />
          </label>
          <button type="submit">実行する</button>
        </form>
        <ResultView result={anonymizeResult} />
      </section>
    </div>
  );
}
