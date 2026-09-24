"use client";

/**
 * 同意ゲート（O-1 / 制約 L6 / R-LAW-06）。
 *
 * ★ 幹事も参加者も、**支払状況が幹事に開示されること**への同意を初回導線で取る（L6）。
 *   同意の「事実」だけを `POST /api/consent` に記録する。文言そのものはここに持たない
 *   （文言は `src/content/terms.md` / `privacy.md`＝task_021 の担当で、ここが持つのは
 *   `textVersion` という**版の文字列**だけ）。
 *
 * ★ 3 種すべてにチェックが入るまで送信ボタンを押せない。「まとめて同意」の 1 個のチェックに
 *   しないのは、どの文言に同意したかが `consent_log` の行として別々に残る必要があるためである。
 *
 * ★ `X-CSRF-Token` はヘッダで送る（Cookie に入れない。R-SEC-12）。値は呼び出し側が
 *   `POST /api/auth/line` の応答ボディから受け取って props で渡す。
 *   `src/lib/auth/csrf.ts` は `import "server-only"` なので、クライアントからは参照できない。
 *   ヘッダ名だけをここに写してある（両者がずれたら `tests/unit/components/ConsentGate.test.tsx`
 *   が落ちる）。
 *
 * ★ 同意状態をブラウザの永続ストレージに持たない（制約 N7 が名指しで禁じている置き場）。
 *   同意の真実はサーバーの `consent_log` だけである。
 */

import { useCallback, useMemo, useState, type ReactNode } from "react";

import { StateView } from "./StateView";

/** `src/lib/auth/csrf.ts` の `CSRF_HEADER` と同じ値。 */
export const CSRF_HEADER_NAME = "X-CSRF-Token";

/** `POST /api/consent` の送信先。 */
export const CONSENT_ENDPOINT = "/api/consent";

/**
 * 取得する同意の種類と、画面に出すラベル。
 * `kind` は `consent_log.consent_kind` の CHECK 制約と同じ集合（supabase/migrations/0001_init.sql）。
 */
export const CONSENT_ITEMS = [
  {
    kind: "tos",
    label: "利用規約に同意します",
  },
  {
    kind: "privacy",
    label: "プライバシーポリシーに同意します",
  },
  {
    kind: "organizer_disclosure",
    label: "支払状況が幹事に表示されることに同意します",
  },
] as const;

export type ConsentKind = (typeof CONSENT_ITEMS)[number]["kind"];

export interface ConsentGateProps {
  /** `POST /api/auth/line` の応答ボディで受け取った CSRF トークン。 */
  readonly csrfToken: string;
  /** 同意対象の文言の版。3 種に同じ版を使う運用（task_021 で版管理を入れる）。 */
  readonly textVersion: string;
  /** 3 種すべての記録に成功したときに呼ばれる。 */
  readonly onConsented?: (() => void) | undefined;
}

type Phase = "idle" | "submitting" | "failed";

interface ErrorBodyLike {
  readonly requestId?: unknown;
}

export function ConsentGate({
  csrfToken,
  textVersion,
  onConsented,
}: ConsentGateProps): ReactNode {
  const [checked, setChecked] = useState<Readonly<Record<string, boolean>>>({});
  const [phase, setPhase] = useState<Phase>("idle");
  const [requestId, setRequestId] = useState<string | undefined>(undefined);

  const allChecked = useMemo(
    () => CONSENT_ITEMS.every((item) => checked[item.kind] === true),
    [checked],
  );

  const toggle = useCallback((kind: ConsentKind) => {
    setChecked((previous) => ({ ...previous, [kind]: previous[kind] !== true }));
  }, []);

  const submit = useCallback(async () => {
    setPhase("submitting");
    setRequestId(undefined);

    // 直列に送る。並列にすると、途中で失敗したときにどこまで記録されたかが分かりにくい。
    for (const item of CONSENT_ITEMS) {
      let response: Response;
      try {
        response = await fetch(CONSENT_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [CSRF_HEADER_NAME]: csrfToken,
          },
          body: JSON.stringify({ consentKind: item.kind, textVersion }),
        });
      } catch {
        setPhase("failed");
        return;
      }

      if (!response.ok) {
        try {
          const body = (await response.json()) as ErrorBodyLike;
          if (typeof body.requestId === "string") setRequestId(body.requestId);
        } catch {
          // 応答が JSON でないこともある。requestId 無しでエラー表示する。
        }
        setPhase("failed");
        return;
      }
    }

    setPhase("idle");
    onConsented?.();
  }, [csrfToken, textVersion, onConsented]);

  return (
    <section className="consent-gate" aria-labelledby="consent-gate-heading">
      <h2 id="consent-gate-heading">ご確認とご同意</h2>

      {phase === "failed" ? <StateView state="error" requestId={requestId} /> : null}

      <ul className="consent-gate__list">
        {CONSENT_ITEMS.map((item) => (
          <li className="consent-gate__item" key={item.kind}>
            <input
              type="checkbox"
              id={`consent-${item.kind}`}
              checked={checked[item.kind] === true}
              onChange={() => {
                toggle(item.kind);
              }}
            />
            <label htmlFor={`consent-${item.kind}`}>{item.label}</label>
          </li>
        ))}
      </ul>

      <button
        type="button"
        className="consent-gate__submit"
        disabled={!allChecked || phase === "submitting"}
        aria-busy={phase === "submitting"}
        onClick={() => {
          void submit();
        }}
      >
        同意して進む
      </button>
    </section>
  );
}

export default ConsentGate;
