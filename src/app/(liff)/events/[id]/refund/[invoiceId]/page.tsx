"use client";

/**
 * O-10 返金（§8-1 / task_021 scope）。
 *
 * `full_once` の事前警告と、`refund='none'`（Phase 1 の `manual_confirm` は常にこれ）のときの
 * 固定文言をここで表示する。確定前に 2 段階（O-8 と同じ考え方）。
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { StateView } from "@/components/StateView";
import { bootLiff, liffPermanentLink, readLiffIdFromDocument } from "@/lib/liff/client";

type Phase = "loading" | "ready" | "outside_line" | "auth_unavailable" | "error";

function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface ErrorBodyLike {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly requestId?: unknown;
}

export default function RefundPage(): ReactNode {
  const params = useParams<{ id: string; invoiceId: string }>();
  const eventId = params.id;
  const invoiceId = params.invoiceId;

  const [phase, setPhase] = useState<Phase>("loading");
  const [permanentLink, setPermanentLink] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>(undefined);
  const csrfTokenRef = useRef<string | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);

  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<"idle" | "done" | "not_supported" | "failed">("idle");
  const [outcomeMessage, setOutcomeMessage] = useState<string | null>(null);

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

  async function submit(): Promise<void> {
    if (csrfTokenRef.current === null || submitting) return;
    idempotencyKeyRef.current ??= newIdempotencyKey();
    setSubmitting(true);
    try {
      const response = await fetch(`/api/invoices/${invoiceId}/refund`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-CSRF-Token": csrfTokenRef.current,
          "Idempotency-Key": idempotencyKeyRef.current,
        },
        body: JSON.stringify({ confirmed: true }),
      });
      const body = (await response.json().catch(() => ({}))) as ErrorBodyLike;
      if (typeof body.requestId === "string") setRequestId(body.requestId);
      if (!response.ok) {
        if (body.code === "NOT_SUPPORTED") {
          setOutcome("not_supported");
          return;
        }
        setOutcome("failed");
        setOutcomeMessage(typeof body.message === "string" ? body.message : "返金できませんでした。");
        return;
      }
      setOutcome("done");
    } catch {
      setOutcome("failed");
      setOutcomeMessage("通信に失敗しました。時間をおいてお試しください。");
    } finally {
      setSubmitting(false);
    }
  }

  if (phase !== "ready") {
    return (
      <StateView state={phase} requestId={requestId} permanentLink={permanentLink ?? undefined} />
    );
  }

  if (outcome === "not_supported") {
    return (
      <section className="refund refund--not-supported" aria-labelledby="refund-not-supported-title">
        <h1 id="refund-not-supported-title">この決済手段はアプリからの返金に対応していません</h1>
        <p>幹事から参加者へ、LINE のトークで直接ご連絡ください。</p>
        <p>
          <Link href={`/events/${eventId}`}>名簿に戻る</Link>
        </p>
      </section>
    );
  }

  if (outcome === "done") {
    return (
      <section className="refund refund--done" aria-labelledby="refund-done-title">
        <h1 id="refund-done-title">返金の手続きを開始しました</h1>
        <p>
          <Link href={`/events/${eventId}`}>名簿に戻る</Link>
        </p>
      </section>
    );
  }

  return (
    <section className="refund" aria-labelledby="refund-title">
      <h1 id="refund-title">この会費を返金する</h1>
      <p className="refund__warning">
        一部の決済手段では、1 件の請求につき返金を 1 回しか行えません（`full_once`）。
        取り消すと元に戻せません。
      </p>

      {!confirming ? (
        <button type="button" onClick={() => setConfirming(true)}>
          返金へ進む
        </button>
      ) : (
        <div className="refund__confirm" role="alertdialog" aria-labelledby="refund-confirm-title">
          <h2 id="refund-confirm-title">この内容で返金しますか</h2>
          <button type="button" onClick={() => setConfirming(false)} disabled={submitting}>
            戻る
          </button>
          <button
            type="button"
            onClick={() => {
              void submit();
            }}
            disabled={submitting}
          >
            返金を実行する
          </button>
        </div>
      )}

      {outcome === "failed" ? (
        <p className="refund__error" role="alert">
          {outcomeMessage ?? "返金できませんでした。"}
          {requestId === undefined ? null : <span className="tabular"> (ID: {requestId})</span>}
        </p>
      ) : null}
    </section>
  );
}
