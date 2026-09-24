"use client";

/**
 * O-8 手動確認（§8-1 / task_017 scope / check_001）。
 *
 * ★ 確定の前に「これは自動照合ではありません」ダイアログを必ず挟む（2 段階）。
 *   ここを飛ばして 1 タップで確定できる導線を作らない。
 *
 * ★ 理由（`reason`）は必須。空白のみはサーバーが 400 で落とし、`manual_attestation` の行も
 *   作られない（check_009）。画面側の必須表示は補助で、正はサーバーである。
 *
 * ★ 文言は `docs/wording-policy.md` に従う。入金を検知したかのような断定は書かない
 *   （`gate:wording` の W-AUTO が落とす）。書いてよいのは「幹事が受け取ったと申告」
 *   「自動照合ではありません」などの許可文言だけである。
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { StateView } from "@/components/StateView";
import { bootLiff, liffPermanentLink, readLiffIdFromDocument } from "@/lib/liff/client";

type Phase = "loading" | "ready" | "outside_line" | "auth_unavailable" | "error";

type Method = "paypay_p2p" | "bank_transfer" | "cash" | "other";

const METHOD_LABELS: Readonly<Record<Method, string>> = {
  paypay_p2p: "PayPay で受け取った",
  bank_transfer: "銀行振込で受け取った",
  cash: "現金で受け取った",
  other: "その他の方法で受け取った",
};

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

export default function ManualAttestPage(): ReactNode {
  const params = useParams<{ id: string; invoiceId: string }>();
  const eventId = params.id;
  const invoiceId = params.invoiceId;

  const [phase, setPhase] = useState<Phase>("loading");
  const [permanentLink, setPermanentLink] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>(undefined);
  const csrfTokenRef = useRef<string | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);

  const [method, setMethod] = useState<Method>("paypay_p2p");
  const [reason, setReason] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [step, setStep] = useState<1 | 2>(1);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<"idle" | "done" | "failed">("idle");
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
    if (reason.trim().length === 0) {
      setOutcome("failed");
      setOutcomeMessage("受け取った状況の記録は必須です。");
      return;
    }
    // 1 回の論理的な送信につき 1 つ。連打しても同じキーで送る（二重計上を作らない）。
    idempotencyKeyRef.current ??= newIdempotencyKey();
    setSubmitting(true);
    try {
      const response = await fetch(`/api/invoices/${invoiceId}/manual-attest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-CSRF-Token": csrfTokenRef.current,
          "Idempotency-Key": idempotencyKeyRef.current,
        },
        body: JSON.stringify({
          method,
          reason: reason.trim(),
          evidenceNote: evidenceNote.trim().length > 0 ? evidenceNote.trim() : null,
          confirmed: true,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ErrorBodyLike;
        if (typeof body.requestId === "string") setRequestId(body.requestId);
        setOutcome("failed");
        setOutcomeMessage(
          typeof body.message === "string" ? body.message : "記録できませんでした。",
        );
        return;
      }
      setOutcome("done");
      setOutcomeMessage(null);
    } catch {
      setOutcome("failed");
      setOutcomeMessage("通信に失敗しました。時間をおいてお試しください。");
    } finally {
      setSubmitting(false);
    }
  }

  if (phase !== "ready") {
    return (
      <StateView
        state={phase === "loading" ? "loading" : phase}
        requestId={requestId}
        permanentLink={permanentLink ?? undefined}
      />
    );
  }

  if (outcome === "done") {
    return (
      <section className="attest attest--done" aria-labelledby="attest-done-title">
        <h1 id="attest-done-title">幹事が受け取ったと申告しました</h1>
        <p>
          名簿には「手動確認（自動照合ではありません）」として反映されます。
        </p>
        <p>
          <Link href={`/events/${eventId}`}>名簿に戻る</Link>
        </p>
      </section>
    );
  }

  return (
    <section className="attest" aria-labelledby="attest-title">
      <h1 id="attest-title">受け取りを記録する</h1>
      <p className="attest__lead">
        この記録は幹事による申告です。アプリは入金を検知しません（自動照合ではありません）。
      </p>

      <fieldset className="attest__methods" disabled={step === 2}>
        <legend>受け取った方法</legend>
        {(Object.keys(METHOD_LABELS) as Method[]).map((value) => (
          <label className="attest__method" key={value}>
            <input
              type="radio"
              name="attest-method"
              value={value}
              checked={method === value}
              onChange={() => {
                setMethod(value);
              }}
            />
            {METHOD_LABELS[value]}
          </label>
        ))}
      </fieldset>

      <label className="attest__field">
        <span>
          受け取った状況（必須）
        </span>
        <textarea
          value={reason}
          maxLength={200}
          required
          disabled={step === 2}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </label>

      <label className="attest__field">
        <span>メモ（任意・画像は保存しません）</span>
        <textarea
          value={evidenceNote}
          maxLength={200}
          disabled={step === 2}
          onChange={(event) => {
            setEvidenceNote(event.target.value);
          }}
        />
      </label>

      {step === 1 ? (
        <button
          type="button"
          className="attest__next"
          disabled={reason.trim().length === 0}
          onClick={() => {
            setStep(2);
          }}
        >
          確認へ進む
        </button>
      ) : (
        <div className="attest__confirm" role="alertdialog" aria-labelledby="attest-confirm-title">
          <h2 id="attest-confirm-title">これは自動照合ではありません</h2>
          <p>
            アプリが入金を検知したわけではなく、幹事が手動で確認した内容として記録します。
            名簿と会費受領記録には「手動確認」と表示されます。
          </p>
          <p className="tabular">方法: {METHOD_LABELS[method]}</p>
          <button type="button" onClick={() => { setStep(1); }} disabled={submitting}>
            戻って直す
          </button>
          <button
            type="button"
            onClick={() => {
              void submit();
            }}
            disabled={submitting}
          >
            この内容で記録する
          </button>
        </div>
      )}

      {outcome === "failed" ? (
        <p className="attest__error" role="alert">
          {outcomeMessage ?? "記録できませんでした。"}
          {requestId === undefined ? null : <span className="tabular"> (ID: {requestId})</span>}
        </p>
      ) : null}
    </section>
  );
}
