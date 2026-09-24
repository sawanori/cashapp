"use client";

/**
 * O-4 名簿（一覧）＋ O-5 参加者登録（§8-1 / task_014）。
 *
 * ★ 既定フィルタは「未払いのみ」（R-UX-03）。検索・並べ替え・カーソルページングに対応する。
 * ★ 登録は 1 行 1 名のテキストエリア（一括貼り付け）。発行された `claimToken` は
 *   **この応答でのみ**返る。参加者ごとの個別リンクの組み立ては配布導線（task_016）の担当。
 * ★ 削除は論理削除。生きた決済試行があれば 409（`HAS_OPEN_ATTEMPT`）としてそのまま表示する。
 */

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { InvoiceRow, type ConfirmationMethod, type RosterStatus } from "@/components/InvoiceRow";
import { StateView } from "@/components/StateView";
import { bootLiff, liffPermanentLink, readLiffIdFromDocument } from "@/lib/liff/client";

type Phase = "loading" | "ready" | "outside_line" | "auth_unavailable" | "error" | "forbidden";
type Filter = "unpaid" | "all";

interface ParticipantItem {
  readonly id: string;
  readonly displayLabel: string | null;
  readonly status: RosterStatus;
  readonly amountMinor: number | null;
  readonly autoDetected: boolean;
  readonly confirmationMethod: ConfirmationMethod | null;
  readonly needsAttention: boolean;
}

interface ErrorBodyLike {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly requestId?: unknown;
}

function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function ParticipantsPage(): ReactNode {
  const params = useParams<{ id: string }>();
  const eventId = params.id;

  const [phase, setPhase] = useState<Phase>("loading");
  const [permanentLink, setPermanentLink] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>(undefined);
  const csrfTokenRef = useRef<string | null>(null);

  const [filter, setFilter] = useState<Filter>("unpaid");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<ParticipantItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [bulkText, setBulkText] = useState("");
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  // 敵対レビュー GPT F-3 是正: 失敗した登録の再試行で同じキーを使い回すための保持先
  // （成功したときだけ null に戻す。new/page.tsx と同じ方針）。
  const registerIdempotencyKeyRef = useRef<string | null>(null);
  // 敵対レビュー GPT F-9 是正: 「もっと見る」の連打で同一ページを二重取得しない guard。
  const [loadingMore, setLoadingMore] = useState(false);
  const [issuedTokens, setIssuedTokens] = useState<
    readonly { readonly displayLabel: string | null; readonly claimToken: string }[] | null
  >(null);
  // 敵対レビュー GPT F-4（round2）: loadingMore は「もっと見る」の連打だけを抑止し、取得中の
  // 絞り込み操作（フィルタ切替・検索）は妨げていなかった。「もっと見る」の応答が保留されている
  // 間に絞り込みを実行すると、後から届く古い（絞り込み前の条件の）応答がそのまま新しい一覧へ
  // 追加され、検索条件に一致しない行が混入し得た。呼び出しのたびに払い出す一意な連番を持たせ、
  // 応答が戻った時点で「最後に開始した呼び出しと同じか」を確認し、違えば（＝この呼び出しの後に
  // 別の loadParticipants が始まっていれば）画面へ反映しない。
  const loadSeqRef = useRef(0);

  const loadParticipants = useCallback(
    async (targetFilter: Filter, query: string, targetCursor: string | null, append: boolean) => {
      const seq = (loadSeqRef.current += 1);
      setListError(null);
      const url = new URL(`/api/events/${eventId}/participants`, window.location.origin);
      url.searchParams.set("filter", targetFilter);
      if (query.trim().length > 0) url.searchParams.set("q", query.trim());
      if (targetCursor !== null) url.searchParams.set("cursor", targetCursor);

      let response: Response;
      try {
        response = await fetch(url.toString(), { method: "GET" });
      } catch {
        if (loadSeqRef.current === seq) {
          setListError("名簿を取得できませんでした。通信状況をご確認のうえ、もう一度お試しください。");
        }
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ErrorBodyLike;
        if (loadSeqRef.current !== seq) return;
        if (typeof body.requestId === "string") setRequestId(body.requestId);
        setListError(typeof body.message === "string" ? body.message : "名簿を取得できませんでした。");
        return;
      }
      const body = (await response.json()) as { participants: ParticipantItem[]; nextCursor: string | null };
      // この呼び出しの後に別の loadParticipants が始まっていれば（＝自分が最新でなければ）、
      // 古い条件の結果なので反映しない。
      if (loadSeqRef.current !== seq) return;
      setItems((prev) => (append ? [...prev, ...body.participants] : body.participants));
      setNextCursor(body.nextCursor);
    },
    [eventId],
  );

  useEffect(() => {
    let cancelled = false;

    async function run(): Promise<void> {
      const liffId = readLiffIdFromDocument();
      if (liffId === null) {
        if (!cancelled) setPhase("error");
        return;
      }
      if (!cancelled) setPermanentLink(liffPermanentLink(liffId));

      const boot = await bootLiff(liffId);
      if (cancelled) return;
      if (boot.state === "outside_line") {
        setPhase("outside_line");
        return;
      }
      if (boot.state !== "ready") {
        setPhase("auth_unavailable");
        return;
      }

      let authResponse: Response;
      try {
        authResponse = await fetch("/api/auth/line", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ idToken: boot.idToken }),
        });
      } catch {
        if (!cancelled) setPhase("error");
        return;
      }
      if (cancelled) return;
      if (!authResponse.ok) {
        setPhase("auth_unavailable");
        return;
      }
      const authBody = (await authResponse.json()) as { csrfToken: string };
      csrfTokenRef.current = authBody.csrfToken;

      setPhase("ready");
      await loadParticipants("unpaid", "", null, false);
    }

    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 初回マウント時にのみ実行する
  }, []);

  const applyFilters = useCallback(async () => {
    await loadParticipants(filter, q, null, false);
  }, [filter, q, loadParticipants]);

  const loadMore = useCallback(async () => {
    // `nextCursor` state の更新はフェッチ完了後まで反映されないため、連打すると同じ
    // cursor で複数回 append され、同じ参加者が名簿に重複表示されていた（GPT F-9）。
    // fetch 中は guard で弾き、ボタンも disabled にする（下の render）。
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      await loadParticipants(filter, q, nextCursor, true);
    } finally {
      setLoadingMore(false);
    }
  }, [filter, q, nextCursor, loadingMore, loadParticipants]);

  const remove = useCallback(
    async (participantId: string) => {
      if (csrfTokenRef.current === null) return;
      let response: Response;
      try {
        response = await fetch(`/api/events/${eventId}/participants/${participantId}`, {
          method: "DELETE",
          headers: { "X-CSRF-Token": csrfTokenRef.current },
        });
      } catch {
        setListError("削除できませんでした。もう一度お試しください。");
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ErrorBodyLike;
        setListError(typeof body.message === "string" ? body.message : "削除できませんでした。");
        return;
      }
      setItems((prev) => prev.filter((item) => item.id !== participantId));
    },
    [eventId],
  );

  const register = useCallback(async () => {
    if (csrfTokenRef.current === null) return;
    const labels = bulkText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (labels.length === 0) {
      setRegisterError("1 行に 1 名、表示名を入力してください。");
      return;
    }

    setRegistering(true);
    setRegisterError(null);

    // 同じ論理登録の再試行では既存のキーを使い回す（初回だけ新規発行。new/page.tsx と同じ方針）。
    if (registerIdempotencyKeyRef.current === null) {
      registerIdempotencyKeyRef.current = newIdempotencyKey();
    }
    const idempotencyKey = registerIdempotencyKeyRef.current;

    let response: Response;
    try {
      response = await fetch(`/api/events/${eventId}/participants`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-CSRF-Token": csrfTokenRef.current,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ participants: labels.map((displayLabel) => ({ displayLabel })) }),
      });
    } catch {
      setRegistering(false);
      setRegisterError("通信に失敗しました。もう一度お試しください。");
      return;
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ErrorBodyLike;
      if (typeof body.requestId === "string") setRequestId(body.requestId);
      setRegistering(false);
      setRegisterError(typeof body.message === "string" ? body.message : "登録できませんでした。");
      return;
    }

    // 敵対レビュー GPT F-3（round2）。new/page.tsx の submit と同じ理由・同じ方針:
    // response.json() をこの節だけ try/catch で包み、本文の受信に失敗しても registering が
    // 解除されないまま固まらないようにする。サーバーは既にコミット済みのため
    // registerIdempotencyKeyRef はここでは使い切らない（再試行は同じ操作の再送＝replay に
    // なる）。ただし replay 応答は claimToken を含まない設計（GPT F-2。id / displayLabel だけ
    // 返る）なので、この経路に入ると個別リンクの表示機会を失う（C-014-6）。
    let body: {
      participants: readonly { readonly id: string; readonly displayLabel: string | null; readonly claimToken: string }[];
    };
    try {
      body = (await response.json()) as {
        participants: readonly { readonly id: string; readonly displayLabel: string | null; readonly claimToken: string }[];
      };
    } catch {
      setRegistering(false);
      setRegisterError(
        "登録は完了している可能性がありますが、応答を受信できませんでした。もう一度お試しください。",
      );
      return;
    }
    setIssuedTokens(body.participants.map((p) => ({ displayLabel: p.displayLabel, claimToken: p.claimToken })));
    // 成功した論理登録は使い切る。次の登録操作は新しいキーで始める。
    registerIdempotencyKeyRef.current = null;
    setBulkText("");
    setRegistering(false);
    await loadParticipants(filter, q, null, false);
  }, [bulkText, eventId, filter, q, loadParticipants]);

  if (phase === "loading") return <StateView state="loading" />;
  if (phase === "outside_line") return <StateView state="outside_line" permanentLink={permanentLink ?? undefined} />;
  if (phase === "auth_unavailable") {
    return <StateView state="auth_unavailable" permanentLink={permanentLink ?? undefined} requestId={requestId} />;
  }
  if (phase === "forbidden") return <StateView state="forbidden" requestId={requestId} />;
  if (phase === "error") return <StateView state="error" requestId={requestId} />;

  return (
    <section aria-labelledby="participants-heading">
      <h1 id="participants-heading">名簿</h1>

      <details className="participants-register">
        <summary>参加者を登録する</summary>

        {registerError !== null ? (
          <StateView state="error" description={registerError} requestId={requestId} />
        ) : null}

        {issuedTokens !== null ? (
          <div className="participants-register__result" role="status">
            <p>{issuedTokens.length} 名を登録しました。個別リンクはこの画面でのみ表示されます。</p>
            <ul>
              {issuedTokens.map((entry) => (
                <li key={entry.claimToken}>
                  {entry.displayLabel ?? "（表示名未設定）"}: <code>{entry.claimToken}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <label htmlFor="bulk-labels">表示名（1 行に 1 名）</label>
        <textarea
          id="bulk-labels"
          rows={5}
          value={bulkText}
          onChange={(event) => {
            setBulkText(event.target.value);
          }}
        />
        <button
          type="button"
          className="tap-target"
          disabled={registering}
          aria-busy={registering}
          onClick={() => {
            void register();
          }}
        >
          登録する
        </button>
      </details>

      <div className="participants-filters">
        <label>
          <input
            type="radio"
            name="participant-filter"
            checked={filter === "unpaid"}
            onChange={() => {
              setFilter("unpaid");
            }}
          />
          未払いのみ
        </label>
        <label>
          <input
            type="radio"
            name="participant-filter"
            checked={filter === "all"}
            onChange={() => {
              setFilter("all");
            }}
          />
          すべて
        </label>
        <label htmlFor="participant-search">名前で検索</label>
        <input
          id="participant-search"
          type="search"
          value={q}
          onChange={(event) => {
            setQ(event.target.value);
          }}
        />
        <button
          type="button"
          className="tap-target"
          onClick={() => {
            void applyFilters();
          }}
        >
          絞り込む
        </button>
      </div>

      {listError !== null ? <StateView state="error" description={listError} requestId={requestId} /> : null}

      {items.length === 0 ? (
        <StateView state="empty" description="表示できる参加者がいません。" />
      ) : (
        <ul className="invoice-row-list">
          {items.map((item) => (
            <li key={item.id} className="invoice-row-wrap">
              <InvoiceRow
                displayLabel={item.displayLabel}
                amountMinor={item.amountMinor}
                status={item.status}
                autoDetected={item.autoDetected}
                confirmationMethod={item.confirmationMethod}
                needsAttention={item.needsAttention}
              />
              <button
                type="button"
                className="tap-target"
                onClick={() => {
                  void remove(item.id);
                }}
              >
                削除
              </button>
            </li>
          ))}
        </ul>
      )}

      {nextCursor !== null ? (
        <button
          type="button"
          className="tap-target"
          disabled={loadingMore}
          onClick={() => {
            void loadMore();
          }}
        >
          {loadingMore ? "読み込み中…" : "もっと見る"}
        </button>
      ) : null}
    </section>
  );
}
