"use client";

/**
 * P-2 自己申告（claim）（§8-2 / check_002・check_088 / task_015）。
 *
 * - 個別リンク（クエリ `c`）で来た場合は**自動確定**する。
 * - 名簿から選ぶ場合は「あなたは〈山田〉さんですか」の**確認ダイアログを必須**にする
 *   （確認を通したことを `confirmed: true` としてサーバーへ送る。サーバー側も必須にしている）。
 * - 候補が 0 件なら「名簿への追加をリクエスト」（幹事承認制）。
 *
 * ★ 招待トークンはクエリから読み、以後は `X-Join-Token` ヘッダで送る（パスに置かない）。
 * ★ 候補一覧には金額も支払状況も含まれない（サーバーが返さない）。
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { StateView } from "@/components/StateView";
import { bootLiff, liffPermanentLink, readLiffIdFromDocument } from "@/lib/liff/client";

type Phase =
  | "loading"
  | "ready"
  | "outside_line"
  | "auth_unavailable"
  | "invalid_link"
  | "forbidden"
  | "error";

interface Candidate {
  readonly id: string;
  readonly displayLabel: string | null;
}

function readQuery(name: string): string | null {
  if (typeof window === "undefined") return null;
  const value = new URL(window.location.href).searchParams.get(name);
  if (value === null || value.trim().length === 0) return null;
  return value.trim();
}

export default function ParticipantClaimPage(): ReactNode {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [candidates, setCandidates] = useState<readonly Candidate[]>([]);
  const [joinToken, setJoinToken] = useState<string | null>(null);
  const [permanentLink, setPermanentLink] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingCandidate, setPendingCandidate] = useState<Candidate | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [requestedLabel, setRequestedLabel] = useState("");
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const csrfTokenRef = useRef<string | null>(null);

  const claim = useCallback(
    async (token: string, body: Record<string, unknown>): Promise<boolean> => {
      if (csrfTokenRef.current === null) return false;
      setSubmitting(true);
      let response: Response;
      try {
        response = await fetch("/api/e/claim", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-CSRF-Token": csrfTokenRef.current,
            "X-Join-Token": token,
          },
          body: JSON.stringify(body),
        });
      } catch {
        setSubmitting(false);
        setMessage("通信に失敗しました。もう一度お試しください。");
        return false;
      }
      setSubmitting(false);

      if (response.ok) {
        router.push(`/e/me?t=${encodeURIComponent(token)}`);
        return true;
      }

      const failure = (await response.json().catch(() => ({}))) as {
        code?: unknown;
        message?: unknown;
        requestId?: unknown;
      };
      if (typeof failure.requestId === "string") setRequestId(failure.requestId);
      if (failure.code === "ALREADY_CLAIMED") {
        setMessage("この方はすでに選ばれています。別の名前を選ぶか、幹事に連絡してください。");
      } else if (failure.code === "AWAITING_APPROVAL") {
        setMessage("幹事の確認をお待ちください。");
      } else {
        setMessage(
          typeof failure.message === "string" ? failure.message : "受け付けられませんでした。",
        );
      }
      return false;
    },
    [router],
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

      const token = readQuery("t");
      if (token === null) {
        if (!cancelled) setPhase("invalid_link");
        return;
      }
      if (!cancelled) setJoinToken(token);

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
      const authBody = (await authResponse.json()) as { csrfToken?: unknown };
      if (typeof authBody.csrfToken !== "string") {
        setPhase("error");
        return;
      }
      csrfTokenRef.current = authBody.csrfToken;

      // 個別リンク（claim トークン）なら確認ダイアログ無しで確定する。
      const claimToken = readQuery("c");
      if (claimToken !== null) {
        const done = await claim(token, { claimToken });
        if (done || cancelled) return;
      }

      let candidatesResponse: Response;
      try {
        candidatesResponse = await fetch("/api/e/candidates", {
          method: "GET",
          headers: { "X-Join-Token": token },
        });
      } catch {
        if (!cancelled) setPhase("error");
        return;
      }
      if (cancelled) return;
      if (candidatesResponse.status === 404) {
        setPhase("invalid_link");
        return;
      }
      if (candidatesResponse.status === 403) {
        setPhase("forbidden");
        return;
      }
      if (!candidatesResponse.ok) {
        setPhase("error");
        return;
      }
      const body = (await candidatesResponse.json()) as { candidates: readonly Candidate[] };
      if (!cancelled) {
        setCandidates(body.candidates);
        setPhase("ready");
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [claim]);

  const requestAdd = useCallback(async () => {
    if (joinToken === null || csrfTokenRef.current === null) return;
    if (requestedLabel.trim().length === 0) {
      setMessage("お名前を入力してください。");
      return;
    }
    setSubmitting(true);
    let response: Response;
    try {
      response = await fetch("/api/e/request-add", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-CSRF-Token": csrfTokenRef.current,
          "X-Join-Token": joinToken,
        },
        body: JSON.stringify({ displayLabel: requestedLabel.trim() }),
      });
    } catch {
      setSubmitting(false);
      setMessage("通信に失敗しました。もう一度お試しください。");
      return;
    }
    setSubmitting(false);

    if (response.ok) {
      setAwaitingApproval(true);
      setMessage(null);
      return;
    }
    const failure = (await response.json().catch(() => ({}))) as {
      message?: unknown;
      requestId?: unknown;
    };
    if (typeof failure.requestId === "string") setRequestId(failure.requestId);
    setMessage(
      typeof failure.message === "string" ? failure.message : "受け付けられませんでした。",
    );
  }, [joinToken, requestedLabel]);

  if (phase === "loading") return <StateView state="loading" />;
  if (phase === "outside_line") {
    return <StateView state="outside_line" permanentLink={permanentLink ?? undefined} />;
  }
  if (phase === "auth_unavailable") {
    return (
      <StateView
        state="auth_unavailable"
        permanentLink={permanentLink ?? undefined}
        requestId={requestId}
      />
    );
  }
  if (phase === "invalid_link") {
    return (
      <StateView
        state="forbidden"
        description="この招待リンクは使えません。幹事に新しいリンクを送ってもらってください。"
      />
    );
  }
  if (phase === "forbidden") {
    return (
      <StateView
        state="forbidden"
        description="先に招待リンクの最初の画面でご同意ください。"
        requestId={requestId}
      />
    );
  }
  if (phase === "error" || joinToken === null) return <StateView state="error" requestId={requestId} />;

  if (awaitingApproval) {
    return (
      <StateView
        state="empty"
        description="名簿への追加をリクエストしました。幹事の確認をお待ちください。"
      />
    );
  }

  return (
    <section aria-labelledby="participant-claim-heading">
      <h1 id="participant-claim-heading">あなたのお名前を選んでください</h1>

      {message !== null ? (
        <p role="alert" className="participant-claim__message">
          {message}
        </p>
      ) : null}

      {pendingCandidate !== null ? (
        <div role="alertdialog" aria-labelledby="participant-claim-confirm" className="participant-claim__dialog">
          <p id="participant-claim-confirm">
            あなたは「{pendingCandidate.displayLabel ?? "（表示名未設定）"}」さんですか。
          </p>
          <button
            type="button"
            className="tap-target"
            disabled={submitting}
            aria-busy={submitting}
            onClick={() => {
              void claim(joinToken, { participantId: pendingCandidate.id, confirmed: true });
            }}
          >
            はい、わたしです
          </button>
          <button
            type="button"
            className="tap-target"
            onClick={() => {
              setPendingCandidate(null);
            }}
          >
            いいえ、戻る
          </button>
        </div>
      ) : candidates.length > 0 ? (
        <ul className="participant-claim__candidates">
          {candidates.map((candidate) => (
            <li key={candidate.id}>
              <button
                type="button"
                className="tap-target"
                onClick={() => {
                  setMessage(null);
                  setPendingCandidate(candidate);
                }}
              >
                {candidate.displayLabel ?? "（表示名未設定）"}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="participant-claim__request-add">
          <p>あなたのお名前が名簿にありません。幹事に追加をリクエストできます。</p>
          <label htmlFor="participant-claim-label">お名前</label>
          <input
            id="participant-claim-label"
            type="text"
            maxLength={40}
            value={requestedLabel}
            onChange={(event) => {
              setRequestedLabel(event.target.value);
            }}
          />
          <button
            type="button"
            className="tap-target"
            disabled={submitting}
            aria-busy={submitting}
            onClick={() => {
              void requestAdd();
            }}
          >
            名簿への追加をリクエストする
          </button>
        </div>
      )}
    </section>
  );
}
