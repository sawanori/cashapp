import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * task_008: `.claude/workflows/*.ts` の 3 本を、Workflow ランタイムと同じ形
 * （AsyncFunction にグローバルを注入して本体を実行する）で駆動し、制御フローを実測する。
 *
 * なぜ実ランタイムではなくここで測るのか: 本セッションに Workflow ツールが無いため
 * （docs/concerns/task_008.md の 1）。スクリプト本体は素の JavaScript なので、
 * ランタイムと同じラップで走らせれば「3 周上限で BLOCKED を返す」「欠票を欠票として
 * 記録する」といった判定は実際に走らせて確かめられる。エージェントの応答だけを
 * 差し替えており、判定ロジックには一切手を入れていない。
 */

const ROOT = path.resolve(__dirname, "../../..");
const SCRIPTS = {
  taskLoop: ".claude/workflows/task-loop.ts",
  premortem: ".claude/workflows/premortem.ts",
  releaseAudit: ".claude/workflows/release-audit.ts",
} as const;

interface AgentOpts {
  label?: string;
  schema?: unknown;
  model?: string;
  agentType?: string;
  phase?: string;
  effort?: string;
  isolation?: string;
}

interface AgentCall {
  prompt: string;
  opts: AgentOpts;
}

type Responder = (call: AgentCall, index: number) => unknown;

type ScriptFn = (
  agent: (prompt: string, opts?: AgentOpts) => Promise<unknown>,
  parallel: (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>,
  pipeline: (...rest: unknown[]) => Promise<unknown[]>,
  phase: (title: string) => void,
  log: (message: string) => void,
  scriptArgs: unknown,
  budget: { total: number | null; spent: () => number; remaining: () => number },
  workflow: (...rest: unknown[]) => Promise<unknown>,
) => Promise<unknown>;

const AsyncFunctionCtor = Object.getPrototypeOf(async function noop() {
  /* shape probe */
}).constructor as { new (...argNames: string[]): ScriptFn };

function readScript(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

/** Workflow ランタイムと同じく、本体を関数にラップして実行できる形にする。 */
function compile(rel: string): ScriptFn {
  const src = readScript(rel);
  const body = src.replace(/^export const meta =/m, "const meta =");
  return new AsyncFunctionCtor(
    "agent",
    "parallel",
    "pipeline",
    "phase",
    "log",
    "args",
    "budget",
    "workflow",
    body,
  );
}

interface RunOutcome {
  result: unknown;
  calls: AgentCall[];
  phases: string[];
  logs: string[];
}

async function run(rel: string, scriptArgs: unknown, responder: Responder): Promise<RunOutcome> {
  const fn = compile(rel);
  const calls: AgentCall[] = [];
  const phases: string[] = [];
  const logs: string[] = [];
  let spent = 0;

  const agent = async (prompt: string, opts: AgentOpts = {}): Promise<unknown> => {
    const call: AgentCall = { prompt, opts };
    calls.push(call);
    spent += 1000;
    return responder(call, calls.length - 1);
  };
  const parallel = async (thunks: Array<() => Promise<unknown>>): Promise<unknown[]> =>
    Promise.all(
      thunks.map(async (thunk) => {
        try {
          return await thunk();
        } catch {
          return null;
        }
      }),
    );
  const pipeline = async (): Promise<unknown[]> => {
    throw new Error("pipeline() は本スクリプト群では使っていない");
  };
  const budget = {
    total: null,
    spent: () => spent,
    remaining: () => Number.POSITIVE_INFINITY,
  };
  const workflow = async (): Promise<unknown> => {
    throw new Error("workflow() は本スクリプト群では使っていない");
  };

  const result = await fn(
    agent,
    parallel,
    pipeline,
    (title: string) => {
      phases.push(title);
    },
    (message: string) => {
      logs.push(message);
    },
    scriptArgs,
    budget,
    workflow,
  );
  return { result, calls, phases, logs };
}

function labelOf(call: AgentCall): string {
  return typeof call.opts.label === "string" ? call.opts.label : "";
}

function callsLabelled(calls: AgentCall[], fragment: string): AgentCall[] {
  return calls.filter((c) => labelOf(c).includes(fragment));
}

function metaLiteral(rel: string): string {
  const src = readScript(rel);
  const start = src.indexOf("export const meta =");
  expect(start, `${rel}: export const meta が先頭に無い`).toBe(0);
  const end = src.indexOf("\n};\n");
  expect(end, `${rel}: meta の終端 "};" が見つからない`).toBeGreaterThan(0);
  return src.slice(start + "export const meta =".length, end + 2).trim();
}

interface MetaShape {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: Array<{ title: string; detail?: string; model?: string }>;
}

function readMeta(rel: string): MetaShape {
  const literal = metaLiteral(rel);
  const factory = new Function(`"use strict"; return (${literal});`) as () => MetaShape;
  return factory();
}

// --------------------------------------------------------------- 静的な規律

describe("workflow スクリプトの静的な規律", () => {
  const all = Object.values(SCRIPTS);

  it.each(all)("%s: meta が純リテラルである（変数・呼び出し・テンプレート・spread を含まない）", (rel) => {
    const literal = metaLiteral(rel);
    // 文字列リテラルを外してから、識別子・呼び出し・補間の痕跡を探す。
    const withoutStrings = literal.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    expect(withoutStrings).not.toContain("`");
    expect(withoutStrings).not.toContain("...");
    expect(withoutStrings).not.toMatch(/\(|\)/);
    const identifiers = withoutStrings.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
    const allowed = new Set([
      "name",
      "description",
      "whenToUse",
      "phases",
      "title",
      "detail",
      "model",
      "true",
      "false",
      "null",
    ]);
    const unexpected = identifiers.filter((id) => !allowed.has(id));
    expect(unexpected, `${rel}: meta にリテラル以外の識別子が混じっている`).toEqual([]);
  });

  it.each(all)("%s: resume を壊す Date.now / new Date / Math.random を使っていない", (rel) => {
    const src = readScript(rel);
    expect(src).not.toMatch(/Date\.now\s*\(/);
    expect(src).not.toMatch(/new\s+Date\s*\(/);
    expect(src).not.toMatch(/Math\.random\s*\(/);
  });

  it.each(all)("%s: スクリプトから直接 fs / import を触っていない", (rel) => {
    const src = readScript(rel);
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/require\s*\(/);
  });

  it.each(all)("%s: meta に name / description / phases がある", (rel) => {
    const meta = readMeta(rel);
    expect(meta.name.length).toBeGreaterThan(0);
    expect(meta.description.length).toBeGreaterThan(0);
    expect(Array.isArray(meta.phases)).toBe(true);
    expect((meta.phases ?? []).length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------- task-loop

interface LoopResult {
  task_id: string | null;
  status: string;
  reason: string;
  rounds_used?: number;
  spec_tests_regenerated_in_rounds?: number[];
  effective_high_remaining?: number;
  abstentions?: Array<{
    round: number;
    reviewer: string;
    vendor: string;
    reviewer_route: string;
    reason: string;
  }>;
  costs?: Array<{ round: number; output_tokens_delta: number }>;
  rounds?: Array<{
    round: number;
    spec_tests_regenerated: boolean;
    voting_vendors: string[];
    audited?: boolean;
    carried_high?: Array<{ reviewer: string; summary: string }>;
    unresolved_high_after?: number;
  }>;
  unresolved_high?: Array<{
    reviewer: string;
    vendor: string;
    summary: string;
    first_seen_round: number;
    last_seen_round: number;
  }>;
  audited_rounds?: number[];
}

const PREFLIGHT_OK = {
  verdict: "proceed",
  reasons: [],
  g11_blocked: false,
  touches_funds: false,
  sensitive_surface: false,
};

const SPEC_TESTS_RED = {
  test_files: ["tests/unit/example.test.ts"],
  red_confirmed: true,
  red_evidence: "vitest run tests/unit/example.test.ts → 3 件 fail",
};

const WORK_OK = { changed_files: ["src/example.ts"], summary: "実装した" };

function envelope(
  reviewer: string,
  vendor: string,
  route: string,
  findings: Array<{ severity: string; summary: string }>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { reviewer, vendor, reviewer_route: route, findings, ...extra };
}

/** 3 周とも gemini が high を出し、gpt 経路は毎周不達、という応答表。 */
function alwaysHighResponder(call: AgentCall): unknown {
  const label = labelOf(call);
  if (label.startsWith("preflight")) return PREFLIGHT_OK;
  if (label.startsWith("spec-first tests")) return SPEC_TESTS_RED;
  if (label.startsWith("implement") || label.startsWith("self-quality") || label.startsWith("fix "))
    return WORK_OK;
  if (label.startsWith("a) code-reviewer")) return envelope("code-reviewer", "claude", "ok", []);
  if (label.startsWith("b) adversarial-reviewer-gemini"))
    return envelope("adversarial-reviewer-gemini", "gemini", "ok", [
      { severity: "high", summary: "冪等キーが再送で衝突する" },
    ]);
  if (label.startsWith("c) adversarial-reviewer-gpt"))
    return envelope("adversarial-reviewer-gpt", "gpt", "unavailable", [], {
      attempted_command: "codex exec --model gpt-6-astra",
      unreachable_reason: "codex 側フックが非 Claude モデルを遮断している",
    });
  if (label.startsWith("d) payment-contract-guard"))
    return envelope("payment-contract-guard", "claude", "ok", []);
  if (label.startsWith("final verify"))
    return {
      all_verify_commands_green: true,
      five_step_gate_passed: true,
      proposed_status: "DONE",
    };
  if (label.startsWith("status"))
    // わざと甘いステータスを返させ、スクリプト側が上書きされないことを見る。
    return { recorded_status: "DONE_WITH_CONCERNS" };
  throw new Error(`想定外のエージェント呼び出し: ${label}`);
}

describe("task-loop.ts", () => {
  it("high が残り続けると 3 周で打ち切り、DONE_WITH_CONCERNS ではなく BLOCKED を返す", async () => {
    const { result, calls, phases } = await run(
      SCRIPTS.taskLoop,
      { taskId: "task_003", dryRun: true },
      alwaysHighResponder,
    );
    const loop = result as LoopResult;

    expect(loop.status).toBe("BLOCKED");
    expect(loop.rounds_used).toBe(3);
    expect(loop.effective_high_remaining).toBeGreaterThan(0);
    expect(loop.reason).toContain("3 周");
    // step 8 のエージェントは DONE_WITH_CONCERNS を返したが、採用されていないこと。
    expect(loop.status).not.toBe("DONE_WITH_CONCERNS");
    // 3 周を使い切ったので最終検証は回らない。
    expect(callsLabelled(calls, "final verify")).toHaveLength(0);
    // step 8 は BLOCKED でも回り、確定ステータスを渡している。
    const statusCalls = callsLabelled(calls, "status task_003");
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0]?.prompt).toContain("確定済みのステータスは BLOCKED");
    expect(statusCalls[0]?.prompt).toContain("DONE_WITH_CONCERNS に読み替えない");
    // journal に step 0〜8 が残ること（step 7 は打ち切りにより非実行）。
    expect(phases).toContain("step 0 preflight");
    expect(phases).toContain("step 1 spec-first tests");
    expect(phases).toContain("step 2 implement");
    expect(phases).toContain("step 3 self-quality");
    expect(phases).toContain("step 4 review");
    expect(phases).toContain("step 5 merge-verdict");
    expect(phases).toContain("step 6 fix");
    expect(phases).toContain("step 8 status");
  });

  it("不達の経路を票の無効ではなく欠票として 1 周ごとに記録する", async () => {
    const { result } = await run(
      SCRIPTS.taskLoop,
      { taskId: "task_003", dryRun: true },
      alwaysHighResponder,
    );
    const loop = result as LoopResult;
    const abstentions = loop.abstentions ?? [];

    expect(abstentions).toHaveLength(3);
    for (const a of abstentions) {
      expect(a.reviewer).toBe("adversarial-gpt");
      expect(a.vendor).toBe("gpt");
      expect(a.reviewer_route).toBe("unavailable");
      expect(a.reason).toContain("codex");
    }
    expect(abstentions.map((a) => a.round)).toEqual([1, 2, 3]);
    // 欠票があっても gemini の票は有効票として数えられている。
    for (const round of loop.rounds ?? []) {
      expect(round.voting_vendors).toContain("gemini");
      // 作者ベンダー（claude）は有効票に数えない。
      expect(round.voting_vendors).not.toContain("claude");
    }
  });

  it("2 周目以降は受入テストを再生成しない", async () => {
    const { result, calls } = await run(
      SCRIPTS.taskLoop,
      { taskId: "task_003", dryRun: true },
      alwaysHighResponder,
    );
    const loop = result as LoopResult;

    expect(callsLabelled(calls, "spec-first tests")).toHaveLength(1);
    expect(loop.spec_tests_regenerated_in_rounds).toEqual([1]);
    expect(callsLabelled(calls, "fix round 2")).toHaveLength(1);
    expect(callsLabelled(calls, "fix round 3")).toHaveLength(1);
  });

  it("コストを 1 周ごとに記録する", async () => {
    const { result } = await run(
      SCRIPTS.taskLoop,
      { taskId: "task_003", dryRun: true },
      alwaysHighResponder,
    );
    const loop = result as LoopResult;
    const costs = loop.costs ?? [];
    expect(costs.map((c) => c.round)).toEqual([1, 2, 3]);
    for (const c of costs) expect(c.output_tokens_delta).toBeGreaterThan(0);
  });

  it("high を出したレビュア経路が途中で不達へ転じても、その high は消えず BLOCKED で閉じる", async () => {
    // 1〜2 周目は gemini が high を出し、3 周目だけ経路が落ちる（欠票）。
    // 直近 1 周分しか見ていないと、この 3 周目で high が 0 件になり DONE で閉じてしまう。
    let geminiRound = 0;
    const { result, calls } = await run(SCRIPTS.taskLoop, { taskId: "task_003" }, (call) => {
      const label = labelOf(call);
      if (label.startsWith("b) adversarial-reviewer-gemini")) {
        geminiRound += 1;
        if (geminiRound <= 2) {
          return envelope("adversarial-reviewer-gemini", "gemini", "ok", [
            { severity: "high", summary: "冪等キーが再送で衝突する" },
          ]);
        }
        return envelope("adversarial-reviewer-gemini", "gemini", "unavailable", [], {
          attempted_command: "scripts/gemini-safe.sh -m gemini-3.8-flash",
          unreachable_reason: "gemini CLI がタイムアウトした",
        });
      }
      if (label.startsWith("status")) return { recorded_status: "DONE" };
      return alwaysHighResponder(call);
    });
    const loop = result as LoopResult;

    expect(loop.status).toBe("BLOCKED");
    expect(loop.rounds_used).toBe(3);
    expect(loop.effective_high_remaining).toBe(1);
    // 3 周目は gemini が何も返していないので、その周の実効 high は 0 件である。
    expect((loop.rounds ?? [])[2]?.unresolved_high_after).toBe(1);
    expect((loop.rounds ?? [])[2]?.carried_high?.[0]?.reviewer).toBe("adversarial-gemini");
    // 持ち越された high は 1 周目に出たものである。
    const unresolved = loop.unresolved_high ?? [];
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.vendor).toBe("gemini");
    expect(unresolved[0]?.first_seen_round).toBe(1);
    expect(unresolved[0]?.last_seen_round).toBe(2);
    // high が残ったままなので最終検証には進まない。
    expect(callsLabelled(calls, "final verify")).toHaveLength(0);
  });

  it("有効票を返した独立ベンダーが 0 件の周は、指摘なしでも DONE にしない", async () => {
    // gemini も gpt も最初から不達。claude 系のレーンだけが「指摘なし」を返す。
    const { result, calls } = await run(SCRIPTS.taskLoop, { taskId: "task_003" }, (call) => {
      const label = labelOf(call);
      if (label.startsWith("b) adversarial-reviewer-gemini"))
        return envelope("adversarial-reviewer-gemini", "gemini", "unavailable", [], {
          attempted_command: "scripts/gemini-safe.sh -m gemini-3.8-flash",
          unreachable_reason: "gemini CLI がタイムアウトした",
        });
      if (label.startsWith("status")) return { recorded_status: "DONE" };
      return alwaysHighResponder(call);
    });
    const loop = result as LoopResult;

    expect(loop.status).toBe("BLOCKED");
    expect(loop.rounds_used).toBe(1);
    expect(loop.effective_high_remaining).toBe(0);
    expect(loop.reason).toContain("監査されていない");
    expect((loop.rounds ?? [])[0]?.audited).toBe(false);
    expect((loop.rounds ?? [])[0]?.voting_vendors).toEqual([]);
    expect(loop.audited_rounds).toEqual([]);
    expect(callsLabelled(calls, "final verify")).toHaveLength(0);
  });

  it("high が消えれば周回を打ち切って最終検証へ進み DONE を返す", async () => {
    let round = 0;
    const { result, calls } = await run(SCRIPTS.taskLoop, { taskId: "task_003" }, (call) => {
      const label = labelOf(call);
      if (label.startsWith("b) adversarial-reviewer-gemini")) {
        round += 1;
        return envelope(
          "adversarial-reviewer-gemini",
          "gemini",
          "ok",
          round === 1 ? [{ severity: "high", summary: "初回の指摘" }] : [],
        );
      }
      if (label.startsWith("status")) return { recorded_status: "DONE" };
      return alwaysHighResponder(call);
    });
    const loop = result as LoopResult;

    expect(loop.status).toBe("DONE");
    expect(loop.rounds_used).toBe(2);
    expect(loop.effective_high_remaining).toBe(0);
    expect(callsLabelled(calls, "spec-first tests")).toHaveLength(1);
    expect(callsLabelled(calls, "final verify")).toHaveLength(1);
  });

  it("verify_commands が緑でなければ DONE にしない", async () => {
    const { result } = await run(SCRIPTS.taskLoop, { taskId: "task_003" }, (call) => {
      const label = labelOf(call);
      if (label.startsWith("b) adversarial-reviewer-gemini"))
        return envelope("adversarial-reviewer-gemini", "gemini", "ok", []);
      if (label.startsWith("final verify"))
        return {
          all_verify_commands_green: false,
          five_step_gate_passed: true,
          proposed_status: "DONE",
          failures: ["npm run test:unit が exit 1"],
        };
      if (label.startsWith("status")) return { recorded_status: "DONE" };
      return alwaysHighResponder(call);
    });
    const loop = result as LoopResult;
    expect(loop.status).toBe("DONE_WITH_CONCERNS");
    expect(loop.reason).toContain("test:unit");
  });

  it("compliance-gatekeeper が blocking を返したら即終了する", async () => {
    const { result, calls } = await run(SCRIPTS.taskLoop, { taskId: "task_017" }, (call) => {
      const label = labelOf(call);
      if (label.startsWith("preflight"))
        return { ...PREFLIGHT_OK, touches_funds: true, sensitive_surface: true };
      if (label.startsWith("e) compliance-gatekeeper"))
        return envelope("compliance-gatekeeper", "claude", "ok", [], { blocking: true });
      if (label.startsWith("b) adversarial-reviewer-gemini"))
        return envelope("adversarial-reviewer-gemini", "gemini", "ok", []);
      if (label.startsWith("status")) return { recorded_status: "DONE" };
      return alwaysHighResponder(call);
    });
    const loop = result as LoopResult;

    expect(loop.status).toBe("BLOCKED");
    expect(loop.reason).toContain("compliance-gatekeeper");
    expect(loop.rounds_used).toBe(1);
    expect(callsLabelled(calls, "final verify")).toHaveLength(0);
    // 資金フローに触れる周だけ 5 レーン目が回る。
    expect(callsLabelled(calls, "e) compliance-gatekeeper")).toHaveLength(1);
    // 要 opus 面なので実装は opus に振られる。
    expect(callsLabelled(calls, "implement task_017")[0]?.opts.model).toBe("opus");
  });

  it("資金フローに触れないタスクでは compliance-gatekeeper を回さない", async () => {
    const { calls } = await run(
      SCRIPTS.taskLoop,
      { taskId: "task_003", dryRun: true },
      alwaysHighResponder,
    );
    expect(callsLabelled(calls, "e) compliance-gatekeeper")).toHaveLength(0);
    expect(callsLabelled(calls, "implement task_003")[0]?.opts.model).toBe("sonnet");
  });

  it("UNKNOWN の比率が 2 割を超えたレーンは同じ周で 1 回だけ引き直す", async () => {
    let geminiCalls = 0;
    const { calls } = await run(SCRIPTS.taskLoop, { taskId: "task_003" }, (call) => {
      const label = labelOf(call);
      if (label.startsWith("b) adversarial-reviewer-gemini")) {
        geminiCalls += 1;
        if (geminiCalls === 1) {
          return envelope("adversarial-reviewer-gemini", "gemini", "ok", [], { unknown_ratio: 0.5 });
        }
        return envelope("adversarial-reviewer-gemini", "gemini", "ok", [], { unknown_ratio: 0 });
      }
      if (label.startsWith("status")) return { recorded_status: "DONE" };
      return alwaysHighResponder(call);
    });
    expect(callsLabelled(calls, "引き直し")).toHaveLength(1);
  });

  it("maxRounds は上限 3 を超えて延長できない", async () => {
    const { result } = await run(
      SCRIPTS.taskLoop,
      { taskId: "task_003", dryRun: true, maxRounds: 99 },
      alwaysHighResponder,
    );
    const loop = result as LoopResult;
    expect(loop.rounds_used).toBe(3);
    expect(loop.status).toBe("BLOCKED");
  });

  it("preflight が proceed を返さなければ実装へ進まない", async () => {
    const { result, calls } = await run(SCRIPTS.taskLoop, { taskId: "task_017" }, (call) => {
      if (labelOf(call).startsWith("preflight")) {
        return {
          verdict: "BLOCKED",
          reasons: ["severity: high の未解決 concerns が 3 件（G11）"],
          g11_blocked: true,
          touches_funds: true,
          sensitive_surface: true,
        };
      }
      return alwaysHighResponder(call);
    });
    const loop = result as LoopResult;
    expect(loop.status).toBe("BLOCKED");
    expect(loop.reason).toContain("G11");
    expect(calls).toHaveLength(1);
  });

  it("受入テストが赤でなければ差し戻す", async () => {
    const { result, calls } = await run(SCRIPTS.taskLoop, { taskId: "task_003" }, (call) => {
      if (labelOf(call).startsWith("spec-first tests")) {
        return {
          test_files: ["tests/unit/example.test.ts"],
          red_confirmed: false,
          red_evidence: "初回実行から緑だった",
        };
      }
      return alwaysHighResponder(call);
    });
    const loop = result as LoopResult;
    expect(loop.status).toBe("NEEDS_CONTEXT");
    expect(loop.reason).toContain("赤であることを確認できなかった");
    expect(callsLabelled(calls, "implement")).toHaveLength(0);
  });

  it("taskId が無ければ NEEDS_CONTEXT を返し、エージェントを 1 つも起動しない", async () => {
    const { result, calls } = await run(SCRIPTS.taskLoop, {}, alwaysHighResponder);
    const loop = result as LoopResult;
    expect(loop.status).toBe("NEEDS_CONTEXT");
    expect(calls).toHaveLength(0);
  });

  it("phase() のタイトルが meta.phases に宣言されている", async () => {
    const meta = readMeta(SCRIPTS.taskLoop);
    const declared = new Set((meta.phases ?? []).map((p) => p.title));
    const { phases } = await run(
      SCRIPTS.taskLoop,
      { taskId: "task_003", dryRun: true },
      alwaysHighResponder,
    );
    for (const title of phases) expect(declared.has(title), `未宣言の phase: ${title}`).toBe(true);
  });
});

// --------------------------------------------------------------- premortem

interface PremortemResult {
  status: string;
  date?: string;
  output_path?: string;
  raw_new_count?: number;
  missing_lenses?: string[];
  g11_blocked?: boolean;
  unaddressed_high?: string[];
}

function lensEnvelope(lens: string, newItems: number, unaddressed: string[] = []): unknown {
  const item = {
    failure_mode: `${lens} の失敗`,
    trigger_moment: "承認直後",
    what_happens: "台帳と実残高がずれる",
    detection_signal: "ledger_entry の合計と invoice の合計の差分",
    countermeasure: "日次で差分を出す",
    degraded_mode: "手入力に切り替える",
    severity: "S1",
    confidence: "high",
  };
  return {
    lens,
    baseline_read: true,
    baseline_count: 86,
    new_items: Array.from({ length: newItems }, () => item),
    restated: [],
    unaddressed_high_from_last_round: unaddressed,
  };
}

describe("premortem.ts", () => {
  it("args.date があれば日付エージェントを起動せず、4 レンズを並列で回す", async () => {
    const { result, calls, phases } = await run(
      SCRIPTS.premortem,
      { date: "2026-09-24", phase: "Phase 1" },
      (call) => {
        const label = labelOf(call);
        if (label.startsWith("lens ")) return lensEnvelope(label.slice("lens ".length), 2);
        if (label.startsWith("consolidate"))
          return {
            output_path: "docs/premortem/2026-09-24.json",
            written: true,
            new_count: 5,
            g11_blocked: false,
            headline: "新規 5 件（S1 5 / S2 0 / S3 0）、既出の再掲 0 件、G11 非抵触",
          };
        throw new Error(`想定外の呼び出し: ${label}`);
      },
    );
    const pre = result as PremortemResult;

    expect(callsLabelled(calls, "date -u")).toHaveLength(0);
    const lensCalls = callsLabelled(calls, "lens ");
    expect(lensCalls.map((c) => labelOf(c))).toEqual([
      "lens legal",
      "lens payment",
      "lens platform",
      "lens harness",
    ]);
    for (const c of lensCalls) expect(c.opts.agentType).toBe("premortem-facilitator");
    expect(pre.status).toBe("DONE");
    expect(pre.output_path).toBe("docs/premortem/2026-09-24.json");
    expect(pre.raw_new_count).toBe(8);
    expect(phases).toEqual(["date", "lenses", "consolidate"]);
  });

  it("args.date が無ければ date -u で日付を確定してから回す", async () => {
    const { result, calls } = await run(SCRIPTS.premortem, {}, (call) => {
      const label = labelOf(call);
      if (label === "date -u") return { date: "2026-09-25" };
      if (label.startsWith("lens ")) return lensEnvelope(label.slice("lens ".length), 0);
      return {
        output_path: "docs/premortem/2026-09-25.json",
        written: true,
        new_count: 0,
        g11_blocked: false,
        headline: "新規 0 件",
      };
    });
    const pre = result as PremortemResult;
    expect(callsLabelled(calls, "date -u")).toHaveLength(1);
    expect(pre.date).toBe("2026-09-25");
    expect(pre.output_path).toBe("docs/premortem/2026-09-25.json");
  });

  it("日付を確定できなければ NEEDS_CONTEXT で止まり、レンズを回さない", async () => {
    const { result, calls } = await run(SCRIPTS.premortem, {}, (call) =>
      labelOf(call) === "date -u" ? { date: "きのう" } : null,
    );
    const pre = result as PremortemResult;
    expect(pre.status).toBe("NEEDS_CONTEXT");
    expect(callsLabelled(calls, "lens ")).toHaveLength(0);
  });

  it("欠測したレンズを missing_lenses として残す", async () => {
    const { result } = await run(SCRIPTS.premortem, { date: "2026-09-24" }, (call) => {
      const label = labelOf(call);
      if (label === "lens platform") return null;
      if (label.startsWith("lens ")) return lensEnvelope(label.slice("lens ".length), 1);
      return {
        output_path: "docs/premortem/2026-09-24.json",
        written: true,
        new_count: 3,
        g11_blocked: false,
        headline: "新規 3 件",
      };
    });
    const pre = result as PremortemResult;
    expect(pre.missing_lenses).toEqual(["platform"]);
    expect(pre.raw_new_count).toBe(3);
  });

  it("前回 high の未対応が 3 件以上なら G11 抵触として返す", async () => {
    const { result } = await run(SCRIPTS.premortem, { date: "2026-09-24" }, (call) => {
      const label = labelOf(call);
      if (label === "lens legal") return lensEnvelope("legal", 0, ["R-LAW-03", "R-LAW-12"]);
      if (label === "lens payment") return lensEnvelope("payment", 0, ["R-PAY-14", "R-LAW-03"]);
      if (label.startsWith("lens ")) return lensEnvelope(label.slice("lens ".length), 0);
      return {
        output_path: "docs/premortem/2026-09-24.json",
        written: true,
        new_count: 0,
        g11_blocked: true,
        headline: "新規着手の停止（G11）",
      };
    });
    const pre = result as PremortemResult;
    expect(pre.g11_blocked).toBe(true);
    // 重複を除いた 3 件で判定している。
    expect(pre.unaddressed_high).toEqual(["R-LAW-03", "R-LAW-12", "R-PAY-14"]);
  });
});

// ------------------------------------------------------------ release-audit

interface Condition {
  id: number;
  pass: boolean;
  detail: string;
}

interface AuditResult {
  verdict: string;
  reason: string;
  conditions?: Condition[];
  go_vendors?: string[];
  independent_go_vendors?: string[];
  no_go_vendors?: string[];
  unavailable_vendors?: string[];
  unapproved_unavailable_vendors?: string[];
  approval_path?: string;
}

const EVIDENCE_CLEAN = {
  envelopes: [],
  voted_vendors: ["claude", "gemini"],
  unavailable_vendors: [],
  approval_file_exists: true,
  approved_unavailable_vendors: [],
  release_mode_exists: true,
  payments_enabled: false,
  payments_flag_false_evidence: "supabase/migrations/0002_seed_gates.sql:12 PAYMENTS_ENABLED='false'",
  payment_sdk_absent: true,
  legal_clearance_cleared: true,
  gate_check_exit_code: 0,
  gate_check_violations: 0,
  unreadable: [],
};

function auditResponder(
  evidence: Record<string, unknown>,
  verdicts: Record<string, Record<string, unknown>>,
): Responder {
  return (call) => {
    const label = labelOf(call);
    if (label.startsWith("evidence")) return evidence;
    if (label.startsWith("audit ")) {
      const key = label.slice("audit ".length);
      return verdicts[key] ?? null;
    }
    throw new Error(`想定外の呼び出し: ${label}`);
  };
}

describe("release-audit.ts", () => {
  it("独立 2 ベンダー以上の go かつ no-go ゼロで go を出す", async () => {
    const { result } = await run(
      SCRIPTS.releaseAudit,
      { version: "v0.1.0" },
      auditResponder(EVIDENCE_CLEAN, {
        "release-auditor": { vendor: "claude", reviewer_route: "ok", verdict: "go", reasons: [] },
        gemini: { vendor: "gemini", reviewer_route: "ok", verdict: "go", reasons: [] },
        gpt: { vendor: "gpt", reviewer_route: "ok", verdict: "go", reasons: [] },
      }),
    );
    const audit = result as AuditResult;
    expect(audit.verdict).toBe("go");
    expect(audit.go_vendors).toEqual(["claude", "gemini", "gpt"]);
    expect(audit.independent_go_vendors).toEqual(["gemini", "gpt"]);
  });

  it("Claude 系だけの go では成立しない", async () => {
    const { result } = await run(
      SCRIPTS.releaseAudit,
      { version: "v0.1.0" },
      auditResponder(EVIDENCE_CLEAN, {
        "release-auditor": { vendor: "claude", reviewer_route: "ok", verdict: "go", reasons: [] },
        gemini: {
          vendor: "gemini",
          reviewer_route: "unavailable",
          verdict: "UNKNOWN",
          reasons: ["CLI 不達"],
          unreachable_reason: "gemini CLI がタイムアウト",
        },
        gpt: {
          vendor: "gpt",
          reviewer_route: "unavailable",
          verdict: "UNKNOWN",
          reasons: ["経路遮断"],
          unreachable_reason: "codex 側フックが遮断",
        },
      }),
    );
    const audit = result as AuditResult;
    expect(audit.verdict).not.toBe("go");
    const first = (audit.conditions ?? []).find((c) => c.id === 1);
    expect(first?.pass).toBe(false);
    expect(audit.unavailable_vendors).toEqual(["gemini", "gpt"]);
  });

  it("不達ベンダーに PO の明示承認が無ければ go を出さない", async () => {
    const { result } = await run(
      SCRIPTS.releaseAudit,
      { version: "v0.1.0" },
      auditResponder({ ...EVIDENCE_CLEAN, voted_vendors: ["claude", "gemini"] }, {
        "release-auditor": { vendor: "claude", reviewer_route: "ok", verdict: "go", reasons: [] },
        gemini: { vendor: "gemini", reviewer_route: "ok", verdict: "go", reasons: [] },
        gpt: {
          vendor: "gpt",
          reviewer_route: "unavailable",
          verdict: "UNKNOWN",
          reasons: [],
          unreachable_reason: "codex 側フックが遮断",
        },
      }),
    );
    const audit = result as AuditResult;
    expect(audit.verdict).not.toBe("go");
    expect(audit.unapproved_unavailable_vendors).toEqual(["gpt"]);
    expect((audit.conditions ?? []).find((c) => c.id === 3)?.pass).toBe(false);
    expect(audit.approval_path).toBe("docs/gates/release-v0.1.0.json");
  });

  it("不達が PO 承認済みでも、独立 go が 1 ベンダーだけなら go を出さない", async () => {
    const { result } = await run(
      SCRIPTS.releaseAudit,
      { version: "v0.1.0" },
      auditResponder({ ...EVIDENCE_CLEAN, approved_unavailable_vendors: ["gpt"] }, {
        "release-auditor": { vendor: "claude", reviewer_route: "ok", verdict: "go", reasons: [] },
        gemini: { vendor: "gemini", reviewer_route: "ok", verdict: "go", reasons: [] },
        gpt: {
          vendor: "gpt",
          reviewer_route: "unavailable",
          verdict: "UNKNOWN",
          reasons: [],
          unreachable_reason: "codex 側フックが遮断",
        },
      }),
    );
    const audit = result as AuditResult;
    // 不達の PO 承認は効いている（条件 3 は YES）。
    expect((audit.conditions ?? []).find((c) => c.id === 3)?.pass).toBe(true);
    // それでも go は出ない。作者ベンダー（claude）+ 独立 1 件では条件 1 を満たさない。
    expect(audit.verdict).not.toBe("go");
    expect((audit.conditions ?? []).find((c) => c.id === 1)?.pass).toBe(false);
    expect(audit.go_vendors).toEqual(["claude", "gemini"]);
    expect(audit.independent_go_vendors).toEqual(["gemini"]);
  });

  it("不達が作者ベンダー側でも、独立 2 ベンダーが go で PO 承認があれば go", async () => {
    const { result } = await run(
      SCRIPTS.releaseAudit,
      { version: "v0.1.0" },
      auditResponder({ ...EVIDENCE_CLEAN, approved_unavailable_vendors: ["claude"] }, {
        "release-auditor": {
          vendor: "claude",
          reviewer_route: "unavailable",
          verdict: "UNKNOWN",
          reasons: [],
          unreachable_reason: "サブエージェントが封筒を返さなかった",
        },
        gemini: { vendor: "gemini", reviewer_route: "ok", verdict: "go", reasons: [] },
        gpt: { vendor: "gpt", reviewer_route: "ok", verdict: "go", reasons: [] },
      }),
    );
    const audit = result as AuditResult;
    expect(audit.verdict).toBe("go");
    expect((audit.conditions ?? []).find((c) => c.id === 1)?.pass).toBe(true);
    expect((audit.conditions ?? []).find((c) => c.id === 3)?.pass).toBe(true);
    expect(audit.independent_go_vendors).toEqual(["gemini", "gpt"]);
    expect(audit.unavailable_vendors).toEqual(["claude"]);
  });

  it("no-go が 1 件でもあれば no-go", async () => {
    const { result } = await run(
      SCRIPTS.releaseAudit,
      { version: "v0.1.0" },
      auditResponder(EVIDENCE_CLEAN, {
        "release-auditor": { vendor: "claude", reviewer_route: "ok", verdict: "go", reasons: [] },
        gemini: { vendor: "gemini", reviewer_route: "ok", verdict: "go", reasons: [] },
        gpt: {
          vendor: "gpt",
          reviewer_route: "ok",
          verdict: "no-go",
          reasons: ["Webhook の順序逆転で二重請求の repro がある"],
        },
      }),
    );
    const audit = result as AuditResult;
    expect(audit.verdict).toBe("no-go");
    expect(audit.no_go_vendors).toEqual(["gpt"]);
  });

  it("legal-clearance の cleared が false なら無条件 no-go", async () => {
    const { result } = await run(
      SCRIPTS.releaseAudit,
      { version: "v0.1.0" },
      auditResponder({ ...EVIDENCE_CLEAN, legal_clearance_cleared: false }, {
        "release-auditor": { vendor: "claude", reviewer_route: "ok", verdict: "go", reasons: [] },
        gemini: { vendor: "gemini", reviewer_route: "ok", verdict: "go", reasons: [] },
        gpt: { vendor: "gpt", reviewer_route: "ok", verdict: "go", reasons: [] },
      }),
    );
    const audit = result as AuditResult;
    expect(audit.verdict).toBe("no-go");
    expect((audit.conditions ?? []).find((c) => c.id === 6)?.pass).toBe(false);
  });

  it("release-mode.json が無ければ 2 段ゲートを満たさない（fail-closed）", async () => {
    const { result } = await run(
      SCRIPTS.releaseAudit,
      { version: "v0.1.0" },
      auditResponder({ ...EVIDENCE_CLEAN, release_mode_exists: false }, {
        "release-auditor": { vendor: "claude", reviewer_route: "ok", verdict: "go", reasons: [] },
        gemini: { vendor: "gemini", reviewer_route: "ok", verdict: "go", reasons: [] },
        gpt: { vendor: "gpt", reviewer_route: "ok", verdict: "go", reasons: [] },
      }),
    );
    const audit = result as AuditResult;
    expect(audit.verdict).toBe("no-go");
    const stage = (audit.conditions ?? []).find((c) => c.id === 4);
    expect(stage?.pass).toBe(false);
    expect(stage?.detail).toContain("release-mode.json");
  });

  it("gate:check が非 0 なら go を出さない", async () => {
    const { result } = await run(
      SCRIPTS.releaseAudit,
      { version: "v0.1.0" },
      auditResponder({ ...EVIDENCE_CLEAN, gate_check_exit_code: 1, gate_check_violations: 2 }, {
        "release-auditor": { vendor: "claude", reviewer_route: "ok", verdict: "go", reasons: [] },
        gemini: { vendor: "gemini", reviewer_route: "ok", verdict: "go", reasons: [] },
        gpt: { vendor: "gpt", reviewer_route: "ok", verdict: "go", reasons: [] },
      }),
    );
    const audit = result as AuditResult;
    expect(audit.verdict).toBe("no-go");
    expect((audit.conditions ?? []).find((c) => c.id === 5)?.pass).toBe(false);
  });

  it("読めなかった材料があるときは go でも no-go でもなく UNKNOWN", async () => {
    const { result } = await run(
      SCRIPTS.releaseAudit,
      { version: "v0.1.0" },
      auditResponder({ ...EVIDENCE_CLEAN, unreadable: ["docs/gates/release-mode.json"] }, {
        "release-auditor": { vendor: "claude", reviewer_route: "ok", verdict: "go", reasons: [] },
        gemini: { vendor: "gemini", reviewer_route: "ok", verdict: "go", reasons: [] },
        gpt: { vendor: "gpt", reviewer_route: "ok", verdict: "go", reasons: [] },
      }),
    );
    const audit = result as AuditResult;
    expect(audit.verdict).toBe("UNKNOWN");
  });

  it("version が無ければ材料を集めずに UNKNOWN を返す", async () => {
    const { result, calls } = await run(SCRIPTS.releaseAudit, {}, () => null);
    const audit = result as AuditResult;
    expect(audit.verdict).toBe("UNKNOWN");
    expect(calls).toHaveLength(0);
  });
});
