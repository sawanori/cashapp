"use client";

/**
 * O-3 イベント作成（§8-1 / task_014）。
 *
 * ★ 必須: 表示名（`organizerLabel`）・タイトル・未成年申告（`minorsIncluded`）・
 *   手数料提示への同意（`FeeEstimate` が持つ）。
 * ★ `joinToken` は作成応答で**一度だけ**返る。ここで見せてから遷移する。
 * ★ 二重送信抑止: `Idempotency-Key` は**論理的な 1 回の送信の試行**につき 1 つ（ボタン連打を
 *   防ぐ）。ただし通信断・応答受信前のタイムアウト等で失敗した再試行は**同じキーを使い回す**
 *   （敵対レビュー GPT F-3 是正）。以前は送信のたびに新しいキーを発行していたため、サーバー側で
 *   コミットが成立した直後に応答だけを失った場合、ユーザーが再度「作成」を押すと別のキーとして
 *   扱われ `createEvent` が再実行され、同一内容のイベントが重複作成され得た。キーを使い回しても
 *   内容が変わらない限り安全（`runIdempotent` が同一キー・同一内容の再送を検知して応答を
 *   再生するだけで再実行しない）。キーは**成功したときだけ**使い切り、次の作成では新しいキーを
 *   発行する。
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { FeeEstimate } from "@/components/FeeEstimate";
import { StateView } from "@/components/StateView";
import { bootLiff, liffPermanentLink, readLiffIdFromDocument } from "@/lib/liff/client";

type Phase = "loading" | "ready" | "outside_line" | "auth_unavailable" | "error";

interface ErrorBodyLike {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly requestId?: unknown;
}

interface CreatedEventBody {
  readonly event: { readonly id: string; readonly title: string };
  readonly joinToken: string;
}

function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** テスト用に export（`tests/unit/components/EventCreateAmountParsing.test.ts` GPT F-7）。 */
export function parseDefaultAmountMinor(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // 敵対レビュー GPT F-7: `Number.parseInt` は文字列の先頭だけを読み進め、末尾の余りは
  // 無視して捨てる。`type="number"` の input は指数表記（"5e2" 等）をブラウザ側で妥当な値として
  // 受け付けるため、"5e2" を「500」のつもりで入力すると `parseInt("5e2", 10)` は 5 を返し、
  // ユーザーの意図と異なる金額が静かに保存されていた。`Number()` は文字列全体を解釈し、指数表記
  // は数値として正しく展開し、余分な文字が混じっていれば NaN を返す（"5,000" のような桁区切りも
  // 同じ理由で弾かれるようになった）。
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : null;
}

export default function NewEventPage(): ReactNode {
  const [phase, setPhase] = useState<Phase>("loading");
  const [permanentLink, setPermanentLink] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>(undefined);
  const csrfTokenRef = useRef<string | null>(null);
  // 敵対レビュー GPT F-3 是正: 失敗した送信の再試行で同じキーを使い回すための保持先。
  // 成功したときだけ null に戻し、次の新規作成で新しいキーを発行させる。
  const idempotencyKeyRef = useRef<string | null>(null);

  const [title, setTitle] = useState("");
  const [organizerLabel, setOrganizerLabel] = useState("");
  const [eventAt, setEventAt] = useState("");
  const [venue, setVenue] = useState("");
  const [offering, setOffering] = useState("");
  const [defaultAmount, setDefaultAmount] = useState("");
  const [collectByAt, setCollectByAt] = useState("");
  const [minorsIncluded, setMinorsIncluded] = useState<"unset" | "yes" | "no">("unset");
  const [allowCash, setAllowCash] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedEventBody | null>(null);

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
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = useCallback(async () => {
    if (csrfTokenRef.current === null) return;
    if (title.trim().length === 0 || organizerLabel.trim().length === 0 || minorsIncluded === "unset") {
      setSubmitError("タイトル・集金者としての表示名・未成年の有無は必須です。");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    const payload = {
      title: title.trim(),
      organizerLabel: organizerLabel.trim(),
      eventAt: eventAt.length === 0 ? null : new Date(eventAt).toISOString(),
      venue: venue.trim().length === 0 ? null : venue.trim(),
      offering: offering.trim().length === 0 ? null : offering.trim(),
      defaultAmountMinor: parseDefaultAmountMinor(defaultAmount),
      collectByAt: collectByAt.length === 0 ? null : new Date(collectByAt).toISOString(),
      minorsIncluded: minorsIncluded === "yes",
      allowCash,
      feeDisclosureAccepted: true,
    };

    // 同じ論理送信の再試行では既存のキーを使い回す（初回だけ新規発行）。
    if (idempotencyKeyRef.current === null) {
      idempotencyKeyRef.current = newIdempotencyKey();
    }
    const idempotencyKey = idempotencyKeyRef.current;

    let response: Response;
    try {
      response = await fetch("/api/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-CSRF-Token": csrfTokenRef.current,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
    } catch {
      setSubmitting(false);
      setSubmitError("通信に失敗しました。もう一度お試しください。");
      return;
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ErrorBodyLike;
      if (typeof body.requestId === "string") setRequestId(body.requestId);
      setSubmitting(false);
      setSubmitError(typeof body.message === "string" ? body.message : "作成できませんでした。");
      return;
    }

    const body = (await response.json()) as CreatedEventBody;
    // 成功した論理送信は使い切る。次の作成操作は新しいキーで始める。
    idempotencyKeyRef.current = null;
    setSubmitting(false);
    setCreated(body);
  }, [
    title,
    organizerLabel,
    eventAt,
    venue,
    offering,
    defaultAmount,
    collectByAt,
    minorsIncluded,
    allowCash,
  ]);

  if (phase === "loading") return <StateView state="loading" />;
  if (phase === "outside_line") return <StateView state="outside_line" permanentLink={permanentLink ?? undefined} />;
  if (phase === "auth_unavailable") {
    return <StateView state="auth_unavailable" permanentLink={permanentLink ?? undefined} requestId={requestId} />;
  }
  if (phase === "error") return <StateView state="error" requestId={requestId} />;

  if (created !== null) {
    return (
      <section aria-labelledby="event-created-heading">
        <h1 id="event-created-heading">イベントを作成しました</h1>
        <p>{created.event.title}</p>
        <p>
          招待用のリンクはこの画面でのみ表示されます。参加者の登録・配布は次の画面から行えます。
        </p>
        <p className="event-created__token">
          <code>{created.joinToken}</code>
        </p>
        <p>
          <Link className="tap-target" href={`/events/${created.event.id}/participants`}>
            参加者を登録する
          </Link>
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="new-event-heading">
      <h1 id="new-event-heading">イベントを作る</h1>

      {submitError !== null ? <StateView state="error" description={submitError} requestId={requestId} /> : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <div className="form-field">
          <label htmlFor="event-title">タイトル（必須）</label>
          <input
            id="event-title"
            type="text"
            maxLength={100}
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
            required
          />
        </div>

        <div className="form-field">
          <label htmlFor="event-organizer-label">集金者としての表示名（必須）</label>
          <input
            id="event-organizer-label"
            type="text"
            maxLength={40}
            value={organizerLabel}
            onChange={(event) => {
              setOrganizerLabel(event.target.value);
            }}
            required
          />
        </div>

        <fieldset className="form-field">
          <legend>未成年の参加者は含まれますか（必須）</legend>
          <label>
            <input
              type="radio"
              name="minors-included"
              checked={minorsIncluded === "yes"}
              onChange={() => {
                setMinorsIncluded("yes");
              }}
            />
            含まれる
          </label>
          <label>
            <input
              type="radio"
              name="minors-included"
              checked={minorsIncluded === "no"}
              onChange={() => {
                setMinorsIncluded("no");
              }}
            />
            含まれない
          </label>
        </fieldset>

        <div className="form-field">
          <label htmlFor="event-at">開催日時</label>
          <input
            id="event-at"
            type="datetime-local"
            value={eventAt}
            onChange={(event) => {
              setEventAt(event.target.value);
            }}
          />
        </div>

        <div className="form-field">
          <label htmlFor="event-venue">会場</label>
          <input
            id="event-venue"
            type="text"
            maxLength={200}
            value={venue}
            onChange={(event) => {
              setVenue(event.target.value);
            }}
          />
        </div>

        <div className="form-field">
          <label htmlFor="event-offering">提供内容</label>
          <input
            id="event-offering"
            type="text"
            maxLength={400}
            value={offering}
            onChange={(event) => {
              setOffering(event.target.value);
            }}
          />
        </div>

        <div className="form-field">
          <label htmlFor="event-default-amount">既定金額（1 人あたり・円）</label>
          <input
            id="event-default-amount"
            type="number"
            min={1}
            max={1_000_000}
            value={defaultAmount}
            onChange={(event) => {
              setDefaultAmount(event.target.value);
            }}
          />
        </div>

        <div className="form-field">
          <label htmlFor="event-collect-by">集金締切</label>
          <input
            id="event-collect-by"
            type="datetime-local"
            value={collectByAt}
            onChange={(event) => {
              setCollectByAt(event.target.value);
            }}
          />
        </div>

        <div className="form-field">
          <label>
            <input
              type="checkbox"
              checked={allowCash}
              onChange={(event) => {
                setAllowCash(event.target.checked);
              }}
            />
            現金での受け取りも認める
          </label>
        </div>

        <FeeEstimate
          providerKey="manual_confirm"
          defaultAmountMinor={parseDefaultAmountMinor(defaultAmount)}
          submitting={submitting}
          onConfirm={() => {
            void submit();
          }}
        />
      </form>
    </section>
  );
}
