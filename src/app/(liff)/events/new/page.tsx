"use client";

/**
 * O-3 イベント作成（§8-1 / task_014）。
 *
 * ★ 必須: 表示名（`organizerLabel`）・タイトル・未成年申告（`minorsIncluded`）・
 *   手数料提示への同意（`FeeEstimate` が持つ）。
 * ★ `joinToken` は作成応答で**一度だけ**返る。ここで見せてから遷移する。
 * ★ 二重送信抑止: `Idempotency-Key` を送信のたびに新しく発行する（1 送信 = 1 キー）。
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

function parseDefaultAmountMinor(raw: string): number | null {
  if (raw.trim().length === 0) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

export default function NewEventPage(): ReactNode {
  const [phase, setPhase] = useState<Phase>("loading");
  const [permanentLink, setPermanentLink] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>(undefined);
  const csrfTokenRef = useRef<string | null>(null);

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

    let response: Response;
    try {
      response = await fetch("/api/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-CSRF-Token": csrfTokenRef.current,
          "Idempotency-Key": newIdempotencyKey(),
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
