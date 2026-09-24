"use client";

/**
 * P-4 支払い方法の選択 ＋ P-5 遷移先の表示（§8-2 / task_017 scope / check_091）。
 *
 * ★ Phase 1 で有効なのは手動確認だけである。画面には「幹事が手動で確認します」と明示し、
 *   アプリが入金を検知するかのような書き方をしない（`docs/wording-policy.md`）。
 *
 * ★ 外部サイトへ遷移するリンクには**必ずホスト名を併記**する（P-5 / check_091）。
 *   リンクはサーバー側テンプレートから組み立てられた `deepLink` のみで、幹事が入力した
 *   URL がここに出ることはない。テンプレートが未検証のときは `deepLink` が `null` になり、
 *   「幹事に受け取り方を聞く」案内に倒れる。
 *
 * ★ 「この方法では払えない」を常設する（§8-2 P-4）。押した場合の受け皿
 *   （`POST /api/e/cannot-pay` → 要対応キュー）は task_021 の scope なので、
 *   ここでは幹事へ連絡する固定文言を出す。
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { StateView } from "@/components/StateView";
import { bootLiff, liffPermanentLink, readLiffIdFromDocument } from "@/lib/liff/client";

type Phase =
  | "loading"
  | "ready"
  | "outside_line"
  | "auth_unavailable"
  | "error"
  | "forbidden"
  | "gate_blocked";

interface ManualInstructionBody {
  readonly automatic: false;
  readonly channel: "paypay_p2p" | "bank_transfer" | "cash" | "other";
  readonly deepLink: string | null;
  readonly deepLinkHost: string | null;
  readonly note: string;
  readonly disclaimer: string;
}

interface CheckoutBody {
  readonly ticket:
    | { readonly kind: "manual"; readonly instruction: ManualInstructionBody }
    | { readonly kind: "redirect"; readonly checkoutUrl: string };
  readonly autoDetected: boolean;
  readonly confirmationMethod: string;
}

interface ErrorBodyLike {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly requestId?: unknown;
}

const CHANNEL_LABELS: Readonly<Record<ManualInstructionBody["channel"], string>> = {
  paypay_p2p: "PayPay で幹事に送る",
  bank_transfer: "銀行振込で幹事に送る",
  cash: "現金で幹事に直接渡す",
  other: "幹事に確認した方法で渡す",
};

function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function PayPageBody(): ReactNode {
  const searchParams = useSearchParams();
  const invoiceId = searchParams.get("invoice");
  // 招待トークン。P-6（復帰）が `GET /api/e/me` で実際の状態を引くために持ち回す
  // （G5 round1 GPT F-4 是正）。無ければ P-6 は状態を断定せず P-3 へ誘導する。
  const joinToken = searchParams.get("t");

  const [phase, setPhase] = useState<Phase>("loading");
  const [permanentLink, setPermanentLink] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>(undefined);
  const [checkout, setCheckout] = useState<CheckoutBody | null>(null);
  const [cannotPayOpen, setCannotPayOpen] = useState(false);
  const idempotencyKeyRef = useRef<string | null>(null);

  const start = useCallback(
    async (csrfToken: string, id: string): Promise<void> => {
      idempotencyKeyRef.current ??= newIdempotencyKey();
      let response: Response;
      try {
        response = await fetch("/api/e/checkout", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-CSRF-Token": csrfToken,
            "Idempotency-Key": idempotencyKeyRef.current,
          },
          body: JSON.stringify({ invoiceId: id }),
        });
      } catch {
        setPhase("error");
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ErrorBodyLike;
        if (typeof body.requestId === "string") setRequestId(body.requestId);
        if (response.status === 403) {
          setPhase("forbidden");
        } else if (response.status === 409) {
          setPhase("gate_blocked");
        } else {
          setPhase("error");
        }
        return;
      }
      setCheckout((await response.json()) as CheckoutBody);
      setPhase("ready");
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;

    async function run(): Promise<void> {
      if (invoiceId === null) {
        if (!cancelled) setPhase("error");
        return;
      }
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
      await start(authBody.csrfToken, invoiceId);
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [invoiceId, start]);

  if (phase !== "ready") {
    return (
      <StateView
        state={phase === "loading" ? "loading" : phase}
        requestId={requestId}
        permanentLink={permanentLink ?? undefined}
        description={
          phase === "gate_blocked"
            ? "いまこの方法ではお支払いいただけません。幹事にご連絡ください。"
            : undefined
        }
      />
    );
  }

  if (checkout === null) {
    return <StateView state="error" requestId={requestId} permanentLink={permanentLink ?? undefined} />;
  }

  const ticket = checkout.ticket;

  return (
    <section className="pay" aria-labelledby="pay-title">
      <h1 id="pay-title">お支払い方法</h1>

      {ticket.kind === "manual" ? (
        <div className="pay__method" data-channel={ticket.instruction.channel}>
          <h2>{CHANNEL_LABELS[ticket.instruction.channel]}</h2>
          <p className="pay__manual-note" data-testid="manual-disclaimer">
            {ticket.instruction.disclaimer}
          </p>
          <p>{ticket.instruction.note}</p>
          {ticket.instruction.deepLink === null ? (
            <p className="pay__no-link">
              お支払い先のリンクはありません。受け取り方は幹事にご確認ください。
            </p>
          ) : (
            <p className="pay__link">
              <a
                href={ticket.instruction.deepLink}
                rel="noreferrer noopener"
                target="_blank"
                data-testid="deeplink"
              >
                お支払いに進む
              </a>
              {/* P-5: 遷移先ホスト名の併記（check_091）。リンク文言だけにしない。 */}
              <span className="pay__host" data-testid="deeplink-host">
                遷移先: {ticket.instruction.deepLinkHost}
              </span>
            </p>
          )}
        </div>
      ) : (
        <div className="pay__method" data-channel="redirect">
          <p className="pay__link">
            <a href={ticket.checkoutUrl} rel="noreferrer noopener" target="_blank">
              お支払いに進む
            </a>
          </p>
        </div>
      )}

      <div className="pay__cash">
        <h2>現金で渡す</h2>
        <p>
          幹事が現金を受け付けている場合は、当日に直接お渡しいただけます。
          受け取りの記録は幹事が行います。
        </p>
      </div>

      <div className="pay__cannot">
        <button
          type="button"
          onClick={() => {
            setCannotPayOpen((open) => !open);
          }}
          aria-expanded={cannotPayOpen}
        >
          この方法では払えない
        </button>
        {cannotPayOpen ? (
          <p role="status">
            LINE のトークで幹事へご連絡ください。別のお支払い方法を幹事が案内します。
          </p>
        ) : null}
      </div>

      <p className="pay__after">
        お支払いが済んだら
        <Link
          href={`/e/return?invoice=${encodeURIComponent(invoiceId ?? "")}${
            joinToken === null ? "" : `&t=${encodeURIComponent(joinToken)}`
          }`}
        >
          この画面に戻って状況を確認
        </Link>
        してください。
      </p>
    </section>
  );
}

export default function PayPage(): ReactNode {
  // `useSearchParams` は Suspense 境界の内側でしか使えない（Next.js App Router）。
  return (
    <Suspense fallback={<StateView state="loading" />}>
      <PayPageBody />
    </Suspense>
  );
}
