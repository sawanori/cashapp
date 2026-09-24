"use client";

/**
 * P-1 招待リンク着地（§8-2 / L6 / check_086 / task_015）。
 *
 * 順番を変えないこと: **preview（同意の前）→ 同意 → LINE ログイン**。
 *   - preview はセッション不要で、イベント名・幹事の表示名・締切・人数・金額レンジだけを出す。
 *     氏名も個別金額も出さない（サーバー側の `EventPreview` がその境界を持つ）。
 *   - 同意（支払状況を幹事へ開示することへの同意）を取ってから、初めて LINE ログインへ進む。
 *
 * ★ 招待トークンは**招待リンクのクエリから 1 度だけ読み取り**、以後は
 *   `X-Join-Token` ヘッダで送る（パスに置かない。制約 X-ID / §7-4）。
 *   Cookie にもブラウザの保存領域にも残さない（制約 N7 / §8-3。React の状態だけで持つ）。
 * ★ 外部リンクには `rel="noreferrer"` を付ける（Referrer-Policy: no-referrer と二重にする）。
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { StateView } from "@/components/StateView";
import { bootLiff, liffPermanentLink, readLiffIdFromDocument } from "@/lib/liff/client";

/** サーバーの `PARTICIPANT_CONSENT_TEXT_VERSION` と同じ値（クライアントからは import できない）。 */
const CONSENT_TEXT_VERSION = "participant-disclosure:v1";
const CONSENT_KIND = "organizer_disclosure";

type Phase =
  | "loading"
  | "preview"
  | "joining"
  | "outside_line"
  | "auth_unavailable"
  | "invalid_link"
  | "error";

interface PreviewBody {
  readonly preview: {
    readonly title: string;
    readonly organizerLabel: string;
    readonly collectByAt: string | null;
    readonly participantCount: number;
    readonly amountRangeMinor: { readonly min: number; readonly max: number } | null;
    readonly allowCash: boolean;
  };
}

function formatYen(amountMinor: number): string {
  return `¥${amountMinor.toLocaleString("ja-JP")}`;
}

function formatRange(range: PreviewBody["preview"]["amountRangeMinor"]): string {
  if (range === null) return "金額未設定";
  if (range.min === range.max) return formatYen(range.min);
  return `${formatYen(range.min)} 〜 ${formatYen(range.max)}`;
}

function formatDate(iso: string | null): string {
  if (iso === null) return "未設定";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "未設定";
  return date.toLocaleDateString("ja-JP");
}

/** 招待リンクのクエリを 1 度だけ読む（`t` = イベントの招待トークン、`c` = 個別 claim トークン）。 */
function readQuery(name: string): string | null {
  if (typeof window === "undefined") return null;
  const value = new URL(window.location.href).searchParams.get(name);
  if (value === null || value.trim().length === 0) return null;
  return value.trim();
}

export default function ParticipantLandingPage(): ReactNode {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [preview, setPreview] = useState<PreviewBody["preview"] | null>(null);
  const [joinToken, setJoinToken] = useState<string | null>(null);
  const [claimToken, setClaimToken] = useState<string | null>(null);
  const [permanentLink, setPermanentLink] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>(undefined);
  const [agreed, setAgreed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run(): Promise<void> {
      const liffId = readLiffIdFromDocument();
      if (liffId !== null && !cancelled) setPermanentLink(liffPermanentLink(liffId));

      const token = readQuery("t");
      if (token === null) {
        if (!cancelled) setPhase("invalid_link");
        return;
      }
      if (!cancelled) {
        setJoinToken(token);
        // 個別リンク（`c`）は P-2 へ引き継ぐ。落とすと個別リンクでの自動確定が成立しない
        // （敵対レビュー round1 GPT F-3）。
        setClaimToken(readQuery("c"));
      }

      let response: Response;
      try {
        response = await fetch("/api/e/preview", {
          method: "GET",
          headers: { "X-Join-Token": token },
        });
      } catch {
        if (!cancelled) setPhase("error");
        return;
      }
      if (cancelled) return;

      if (response.status === 404 || response.status === 410) {
        setPhase("invalid_link");
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { requestId?: unknown };
        if (typeof body.requestId === "string") setRequestId(body.requestId);
        setPhase("error");
        return;
      }

      const body = (await response.json()) as PreviewBody;
      if (!cancelled) {
        setPreview(body.preview);
        setPhase("preview");
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const proceed = useCallback(async () => {
    if (joinToken === null || !agreed) return;
    setPhase("joining");
    setMessage(null);

    const liffId = readLiffIdFromDocument();
    if (liffId === null) {
      setPhase("error");
      return;
    }

    const boot = await bootLiff(liffId);
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
      setPhase("error");
      return;
    }
    if (!authResponse.ok) {
      setPhase("auth_unavailable");
      return;
    }
    const authBody = (await authResponse.json()) as { csrfToken?: unknown };
    if (typeof authBody.csrfToken !== "string") {
      setPhase("error");
      return;
    }

    let consentResponse: Response;
    try {
      consentResponse = await fetch("/api/consent", {
        method: "POST",
        headers: { "content-type": "application/json", "X-CSRF-Token": authBody.csrfToken },
        body: JSON.stringify({ consentKind: CONSENT_KIND, textVersion: CONSENT_TEXT_VERSION }),
      });
    } catch {
      setPhase("error");
      return;
    }
    if (!consentResponse.ok) {
      const body = (await consentResponse.json().catch(() => ({}))) as { requestId?: unknown };
      if (typeof body.requestId === "string") setRequestId(body.requestId);
      setPhase("preview");
      setMessage("同意を記録できませんでした。もう一度お試しください。");
      return;
    }

    const next =
      claimToken === null
        ? `/e/claim?t=${encodeURIComponent(joinToken)}`
        : `/e/claim?t=${encodeURIComponent(joinToken)}&c=${encodeURIComponent(claimToken)}`;
    router.push(next);
  }, [agreed, claimToken, joinToken, router]);

  if (phase === "loading" || phase === "joining") return <StateView state="loading" />;
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
  if (phase === "error" || preview === null) return <StateView state="error" requestId={requestId} />;

  return (
    <section aria-labelledby="participant-landing-heading">
      <h1 id="participant-landing-heading">{preview.title}</h1>

      {message !== null ? (
        <p role="alert" className="participant-landing__message">
          {message}
        </p>
      ) : null}

      <dl className="participant-landing__summary">
        <dt>集金する人</dt>
        <dd>{preview.organizerLabel}</dd>
        <dt>締切</dt>
        <dd>{formatDate(preview.collectByAt)}</dd>
        <dt>対象人数</dt>
        <dd className="tabular">{preview.participantCount} 名</dd>
        <dt>金額</dt>
        <dd className="tabular">{formatRange(preview.amountRangeMinor)}</dd>
      </dl>

      <p className="participant-landing__note">
        お金は幹事の決済アカウントへ直接お支払いいただきます。このアプリがお金を預かることはありません。
      </p>

      <label className="participant-landing__consent tap-target">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(event) => {
            setAgreed(event.target.checked);
          }}
        />
        あなたのお支払い状況を幹事に表示することに同意します。
      </label>

      <button
        type="button"
        className="tap-target"
        disabled={!agreed}
        onClick={() => {
          void proceed();
        }}
      >
        同意して進む
      </button>

      {permanentLink === null ? null : (
        <p className="participant-landing__permanent-link">
          <a href={permanentLink} rel="noreferrer" target="_blank">
            LINE で開く
          </a>
        </p>
      )}
    </section>
  );
}
