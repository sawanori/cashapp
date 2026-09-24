export const meta = {
  name: "task-loop",
  description:
    "docs/task-list.json の 1 タスクを、実装 → 4 者並列レビュー → 修正 → 検証の最大 3 周で 4 値ステータスまで通す",
  whenToUse:
    "1 タスクを着手から完了ステータスまで回すとき。args: { taskId: string, dryRun?: boolean, maxRounds?: number }。docs/implementation-plan.md §15-3 の step 0〜8 をそのまま実装している",
  phases: [
    {
      title: "step 0 preflight",
      detail: "depends_on 未完 / ADR 未決 / constraint_ids 空 / G11 抵触を見て着手可否を決める",
      model: "opus",
    },
    {
      title: "step 1 spec-first tests",
      detail: "受入基準だけから受入テストを書き、赤であることを確認する（1 周目のみ・src/** 読み取り不可）",
      model: "sonnet",
    },
    {
      title: "step 2 implement",
      detail: "実装。決済アダプタ・Webhook・状態機械・鍵に触れる周は opus",
      model: "sonnet",
    },
    { title: "step 3 self-quality", detail: "自己品質修正", model: "sonnet" },
    {
      title: "step 4 review",
      detail:
        "code-reviewer / adversarial-reviewer-gemini / adversarial-reviewer-gpt / payment-contract-guard（＋資金フロー時は compliance-gatekeeper）を並列",
    },
    {
      title: "step 5 merge-verdict",
      detail: "成立条件で差し戻し可否を決める。欠票は票の無効ではなく欠票として記録する",
      model: "opus",
    },
    { title: "step 6 fix", detail: "反例を先にテストケース化してから直す", model: "sonnet" },
    { title: "step 7 final verify", detail: "完了前 5 ステップゲート", model: "opus" },
    {
      title: "step 8 status",
      detail: "4 値ステータス・PROGRESS.md / HANDOFF.md 追記・1 周ごとのコストの記録",
      model: "opus",
    },
  ],
};

// ---------------------------------------------------------------- 入力と定数

// §15-3 step 5: 差し戻しは最大 3 周。3 周後も high が残れば BLOCKED（R-TH-13）。
// ここを args で緩められると規則の当日書き換えになるので、上限そのものは定数で固定し、
// args.maxRounds は「短く切る」方向にしか効かない。
const MAX_ROUNDS_HARD = 3;
// §15-3 step 5: UNKNOWN が 2 割を超えたレビュアは同じ周で 1 回だけ引き直す。
const UNKNOWN_RERUN_THRESHOLD = 0.2;
// §16-1 の 2「検出者と作者は別ベンダー」。作者ベンダーの票は有効票に数えない。
const AUTHOR_VENDOR = "claude";

const input = args && typeof args === "object" ? args : {};
const TASK_ID = typeof input.taskId === "string" ? input.taskId.trim() : "";
const DRY_RUN = input.dryRun === true;
const REQUESTED_ROUNDS =
  typeof input.maxRounds === "number" && Number.isFinite(input.maxRounds)
    ? Math.floor(input.maxRounds)
    : MAX_ROUNDS_HARD;
const MAX_ROUNDS = Math.max(1, Math.min(MAX_ROUNDS_HARD, REQUESTED_ROUNDS));

const DRY = DRY_RUN
  ? [
      "DRY RUN。ファイルを 1 行も変更してはならず、git の状態も変えてはならない。",
      "実行する代わりに、(a) 何をどの順で実行するか、(b) 既存の成果物から実際に読み取れた事実、",
      "の 2 つだけを返すこと。読み取れなかったことは「未確認」と書く。推測で埋めない。",
      "",
    ].join("\n")
  : "";

const REPO_RULES = [
  "共通規律（全ステップ）:",
  "- 捏造は最悪の失敗。実行していないコマンドの結果を書かない。未検証は「未検証」と書く。",
  "- 検証コマンドは scripts/record-run.sh <task_id> <command...> 経由で実行する。",
  "- 禁止: wrangler deploy / wrangler secret put / supabase db push / git push / npm publish / git add -A。",
  "- docs/gates/** は PO 専管。AI は書き換えない（F13）。",
  "- TypeScript strict。any 禁止。エラー応答は { code, message, requestId }。",
  "- 秘密値・生の userId・IP・joinToken をログに出さない。",
].join("\n");

const FINAL_SCHEMA_NOTE =
  "返り値は人間向けの文章ではなく、次のステップが読むデータである。";

// ---------------------------------------------------------------------- 型

const PREFLIGHT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["proceed", "BLOCKED", "NEEDS_CONTEXT"] },
    reasons: { type: "array", items: { type: "string" } },
    incomplete_dependencies: { type: "array", items: { type: "string" } },
    undecided_adrs: { type: "array", items: { type: "string" } },
    constraint_ids_empty: { type: "boolean" },
    g11_blocked: { type: "boolean" },
    open_high_concerns: { type: "number" },
    touches_funds: { type: "boolean" },
    sensitive_surface: { type: "boolean" },
    acceptance_check_ids: { type: "array", items: { type: "string" } },
    verify_commands: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "reasons", "g11_blocked", "touches_funds", "sensitive_surface"],
};

const SPEC_TESTS_SCHEMA = {
  type: "object",
  properties: {
    test_files: { type: "array", items: { type: "string" } },
    case_count: { type: "number" },
    red_confirmed: { type: "boolean" },
    red_evidence: { type: "string" },
    uncovered_criteria: { type: "array", items: { type: "string" } },
  },
  required: ["test_files", "red_confirmed", "red_evidence"],
};

const WORK_SCHEMA = {
  type: "object",
  properties: {
    changed_files: { type: "array", items: { type: "string" } },
    commands_run: { type: "array", items: { type: "string" } },
    unresolved: { type: "array", items: { type: "string" } },
    needs_context: { type: "boolean" },
    summary: { type: "string" },
  },
  required: ["changed_files", "summary"],
};

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    reviewer: { type: "string" },
    vendor: { type: "string" },
    reviewer_route: {
      type: "string",
      enum: ["ok", "unavailable", "model_mismatch", "invalid_envelope"],
    },
    model_id_actual: { type: "string" },
    cli_version: { type: "string" },
    backend: { type: "string" },
    attempted_command: { type: "string" },
    unreachable_reason: { type: "string" },
    unknown_ratio: { type: "number" },
    blocking: { type: "boolean" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low", "info", "unknown"] },
          summary: { type: "string" },
          file: { type: "string" },
          repro: { type: "string" },
          quote: { type: "string" },
          duplicate_of: { type: "string" },
        },
        required: ["severity", "summary"],
      },
    },
  },
  required: ["reviewer", "vendor", "reviewer_route", "findings"],
};

const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    all_verify_commands_green: { type: "boolean" },
    commands: {
      type: "array",
      items: {
        type: "object",
        properties: { command: { type: "string" }, exit_code: { type: "number" } },
        required: ["command", "exit_code"],
      },
    },
    five_step_gate_passed: { type: "boolean" },
    failures: { type: "array", items: { type: "string" } },
    proposed_status: {
      type: "string",
      enum: ["DONE", "DONE_WITH_CONCERNS", "BLOCKED", "NEEDS_CONTEXT"],
    },
  },
  required: ["all_verify_commands_green", "five_step_gate_passed", "proposed_status"],
};

const STATUS_SCHEMA = {
  type: "object",
  properties: {
    recorded_status: {
      type: "string",
      enum: ["DONE", "DONE_WITH_CONCERNS", "BLOCKED", "NEEDS_CONTEXT"],
    },
    progress_line: { type: "string" },
    handoff_appended: { type: "boolean" },
    cost_recorded: { type: "boolean" },
    commits: { type: "array", items: { type: "string" } },
  },
  required: ["recorded_status"],
};

// ------------------------------------------------------------------ 補助関数

/** 欠票 1 件を作る。レビューが無効なのではなく「投票が届かなかった事実」を残す。 */
function abstentionOf(round, reviewer, vendor, envelope) {
  return {
    round: round,
    reviewer: reviewer,
    vendor: vendor,
    reviewer_route: envelope && envelope.reviewer_route ? envelope.reviewer_route : "unavailable",
    attempted_command: envelope && envelope.attempted_command ? envelope.attempted_command : "",
    reason:
      envelope && envelope.unreachable_reason
        ? envelope.unreachable_reason
        : "エージェントが封筒を返さなかった（skip / 終端エラー）",
  };
}

/**
 * 票として成立しない封筒の理由を返す（成立していれば null）。reviewer_route が "ok" の
 * 封筒だけを見る。
 *
 * ここが独立性の関門である。レーンがどのベンダーかはスクリプト側の定数（lane.vendor）で
 * 決まっており、封筒の vendor は自己申告にすぎない。自己申告を会計に使うと、作者ベンダーの
 * レーンが vendor: "gemini" と書くだけで独立票に化けられる（R-TH-11 / F6）。よって
 * 「自己申告がレーン定数と一致すること」だけを確かめ、数える値には lane.vendor を使う。
 * model_id_actual の無い封筒を数えないのは §16-2 と R-TH-11、findings 配列を要求するのは
 * 壊れた封筒を「レビューして指摘 0 件」と同義にしないためである。
 */
function invalidEnvelopeReasonOf(lane, envelope) {
  const declared = typeof envelope.vendor === "string" ? envelope.vendor.trim() : "";
  if (declared !== lane.vendor) {
    return (
      "封筒の自己申告 vendor がレーン定数と一致しない（lane=" +
      lane.vendor +
      " / envelope=" +
      (declared || "（空）") +
      "）。独立性の会計はレーン定数で行う（R-TH-11）"
    );
  }
  const modelId =
    typeof envelope.model_id_actual === "string" ? envelope.model_id_actual.trim() : "";
  if (!modelId) {
    return "封筒に model_id_actual が無い。どのモデルが答えたか分からない票は数えない（§16-2 / R-TH-11）";
  }
  if (!Array.isArray(envelope.findings)) {
    return "封筒に findings 配列が無い。壊れた封筒を『指摘 0 件』として数えない（REVIEW_SCHEMA の required）";
  }
  return null;
}

/** 形が不正な封筒を欠票 1 件にする。route は invalid_envelope で固定する。 */
function invalidEnvelopeAbstentionOf(round, lane, envelope, reason) {
  return {
    round: round,
    reviewer: lane.key,
    vendor: lane.vendor,
    reviewer_route: "invalid_envelope",
    attempted_command: envelope && envelope.attempted_command ? envelope.attempted_command : "",
    reason: reason,
  };
}

function highFindingsOf(envelope) {
  if (!envelope || !Array.isArray(envelope.findings)) return [];
  return envelope.findings.filter(function (f) {
    return f && f.severity === "high";
  });
}

/**
 * 実効 high の同一性キー。周をまたいで「同じ指摘か」を判定するために使う。
 * id があればそれを、無ければ file + summary を見る。レーンをまたいだ同一視はしない
 * （別のレビュアが出した同じ内容の指摘は、それぞれのレビュアが取り下げるまで残す）。
 */
function highKeyOf(reviewer, finding) {
  const id = finding && typeof finding.id === "string" ? finding.id.trim() : "";
  if (id) return reviewer + "|id:" + id;
  const file = finding && typeof finding.file === "string" ? finding.file : "";
  const summary = finding && typeof finding.summary === "string" ? finding.summary : "";
  return reviewer + "|" + file + "::" + summary;
}

/** 持ち越し中の同じ指摘が最初に出た周。無ければ今周。 */
function firstSeenRoundOf(carried, key, round) {
  for (let i = 0; i < carried.length; i++) {
    if (carried[i].key === key) return carried[i].first_seen_round;
  }
  return round;
}

function unknownRatioOf(envelope) {
  if (!envelope) return 0;
  if (typeof envelope.unknown_ratio === "number" && Number.isFinite(envelope.unknown_ratio)) {
    return envelope.unknown_ratio;
  }
  const findings = Array.isArray(envelope.findings) ? envelope.findings : [];
  if (findings.length === 0) return 0;
  const unknown = findings.filter(function (f) {
    return f && f.severity === "unknown";
  }).length;
  return unknown / findings.length;
}

function reviewerPrompt(spec, round, work) {
  return [
    DRY,
    "タスク " + TASK_ID + " の実装をレビューする。周回: " + round + " / " + MAX_ROUNDS + "。",
    "",
    "レビュー対象: 作業ツリーの未コミット差分と、直前の周で触れたファイル。",
    "直前の周の作業要約: " + (work && work.summary ? work.summary : "（要約なし）"),
    "",
    spec.brief,
    "",
    "返す封筒の規律:",
    "- reviewer_route は実際の経路の結果を書く。経路が通らなかったら 'unavailable' とし、",
    "  attempted_command と unreachable_reason を必ず埋める。通らなかったことを findings 0 件の",
    "  'ok' に見せかけてはならない（F6 / R-TH-06）。",
    "- vendor は実際に応答したベンダー名（claude / gemini / gpt）。このレーンは '" +
      spec.vendor +
      "' レーンである。",
    "  自己申告がレーン定数と食い違う封筒、model_id_actual が空の封筒、findings 配列の無い封筒は、",
    "  invalid_envelope として欠票に落とす（票には数えない）。model_id_actual / cli_version /",
    "  backend を必ず埋めること（§16-2 / R-TH-11）。",
    "- 断定できない指摘は severity: 'unknown' にし、unknown_ratio を実数で返す。",
    "",
    FINAL_SCHEMA_NOTE,
  ].join("\n");
}

// -------------------------------------------------------- step 0: preflight

if (!TASK_ID) {
  return {
    task_id: null,
    status: "NEEDS_CONTEXT",
    reason: "args.taskId が渡されていない。{ taskId: 'task_0NN' } を指定すること",
    rounds: [],
    abstentions: [],
    costs: [],
  };
}

phase("step 0 preflight");

const preflight = await agent(
  [
    DRY,
    "タスク " + TASK_ID + " の着手可否を判定する（docs/implementation-plan.md §15-3 step 0）。",
    "",
    "読むもの: docs/task-list.json の当該エントリ、depends_on / dependencies の各タスクの",
    "completion_status、docs/decisions/ 配下の関連 ADR の status、docs/concerns/*.md の",
    "severity: high の未解決件数、docs/PROGRESS.md。",
    "",
    "BLOCKED にする条件:",
    "- dependencies のいずれかが DONE / DONE_WITH_CONCERNS でない",
    "- 依存する ADR が accepted でない（[設計] / [不明] 依存の ADR は accepted にできない = G10）",
    "- severity: high の未解決 concerns が 3 件以上（G11。新規機能タスクを in_progress にできない）",
    "NEEDS_CONTEXT にする条件:",
    "- 受入基準が YES / NO に分解できない、または constraint_ids が空で何を守るのか決まっていない",
    "",
    "touches_funds は「このタスクが資金フロー（決済・請求・台帳・返金）に触れるか」。",
    "sensitive_surface は「決済アダプタ・Webhook・状態機械・鍵運用のいずれかに触れるか」。",
    "",
    REPO_RULES,
    FINAL_SCHEMA_NOTE,
  ].join("\n"),
  { schema: PREFLIGHT_SCHEMA, model: "opus", label: "preflight " + TASK_ID },
);

if (!preflight) {
  return {
    task_id: TASK_ID,
    status: "NEEDS_CONTEXT",
    reason: "preflight エージェントが結果を返さなかった",
    rounds: [],
    abstentions: [],
    costs: [],
  };
}

if (preflight.verdict !== "proceed") {
  return {
    task_id: TASK_ID,
    status: preflight.verdict,
    reason: (preflight.reasons || []).join(" / ") || "preflight が proceed を返さなかった",
    preflight: preflight,
    rounds: [],
    abstentions: [],
    costs: [],
  };
}

log(
  "preflight: proceed（資金フロー " +
    (preflight.touches_funds ? "あり" : "なし") +
    " / 要 opus 面 " +
    (preflight.sensitive_surface ? "あり" : "なし") +
    "）",
);

// ------------------------------------------------ step 1: spec-first tests

phase("step 1 spec-first tests");

const specTests = await agent(
  [
    DRY,
    "タスク " + TASK_ID + " の受入テストを、受入基準だけから書く（§15-3 step 1）。",
    "",
    "禁止: src/** を読まない。実装を見てからテストを書くと、実装の写経になって受入基準を守らない。",
    "読んでよいもの: docs/acceptance-checks.json の該当 check、docs/task-list.json の当該エントリ、",
    "docs/implementation-plan.md の該当節、docs/constraints.json。",
    "",
    "書き終えたら実際にテストを走らせ、**赤であること**を確認する。",
    "緑なら受入基準を満たしていない（何も検査していない）ので差し戻しであり、",
    "red_confirmed を false にして uncovered_criteria に理由を書く。",
    "red_evidence には実際に走らせたコマンドと、落ちたケース名・エラー行をそのまま入れる。",
    "",
    REPO_RULES,
    FINAL_SCHEMA_NOTE,
  ].join("\n"),
  {
    schema: SPEC_TESTS_SCHEMA,
    agentType: "acceptance-test-generator-restricted",
    label: "spec-first tests " + TASK_ID,
  },
);

if (!specTests) {
  return {
    task_id: TASK_ID,
    status: "NEEDS_CONTEXT",
    reason: "受入テスト生成エージェントが結果を返さなかった",
    preflight: preflight,
    rounds: [],
    abstentions: [],
    costs: [],
  };
}

if (specTests.red_confirmed !== true && !DRY_RUN) {
  return {
    task_id: TASK_ID,
    status: "NEEDS_CONTEXT",
    reason:
      "受入テストが赤であることを確認できなかったため差し戻す（§15-3 step 1）: " + specTests.red_evidence,
    preflight: preflight,
    spec_tests: specTests,
    rounds: [],
    abstentions: [],
    costs: [],
  };
}

// --------------------------------------------- step 2〜6: 最大 3 周のループ

const implementModel = preflight.sensitive_surface ? "opus" : "sonnet";

const REVIEW_LANES = [
  {
    key: "code-reviewer",
    vendor: "claude",
    label: "a) code-reviewer",
    agentType: null,
    model: "opus",
    brief: [
      "役割: 設計適合レビュー（§16-2）。docs/implementation-plan.md と docs/constraints.json に",
      "照らして、実装が設計とずれていないかを見る。「〜はず」で書かれた主張は差し戻す。",
      "作者と同じベンダーなので、この票は有効票に数えられない。ただしここが出した high は",
      "差し戻しに数える（票にしないことと、指摘を無視することは別）。",
    ].join("\n"),
  },
  {
    key: "adversarial-gemini",
    vendor: "gemini",
    label: "b) adversarial-reviewer-gemini",
    agentType: "adversarial-reviewer-gemini",
    model: null,
    brief: "役割: 規約・一次資料に対する敵対レビュー。逐語引用のない指摘は severity を unknown にする。",
  },
  {
    key: "adversarial-gpt",
    vendor: "gpt",
    label: "c) adversarial-reviewer-gpt",
    agentType: "adversarial-reviewer-gpt",
    model: null,
    brief: "役割: 反例提示型の敵対レビュー。repro の書けない指摘は severity を info に下げる。",
  },
  {
    key: "payment-contract-guard",
    vendor: "claude",
    label: "d) payment-contract-guard",
    agentType: "payment-contract-guard",
    model: null,
    brief: "役割: 契約ガード。1 件でも fail ならマージ不可。",
  },
];

const rounds = [];
const abstentions = [];
const costs = [];
let lastWork = null;
let terminal = null;
// 未解消の実効 high。**周をまたいで持ち越す**（§15-3 step 5 / R-TH-13）。
// 直近 1 周分だけを見ていると、high を出したレビュア経路が次の周で不達（欠票）になった
// だけでその high が消え、誰も直していないのに DONE で閉じられる。
let unresolvedHigh = [];
let highRemaining = 0;
let lastHighFindings = [];

for (let round = 1; round <= MAX_ROUNDS && terminal === null; round++) {
  const costAtRoundStart = budget.spent();

  // ---- step 2（1 周目） / step 6（2 周目以降）
  if (round === 1) {
    phase("step 2 implement");
    lastWork = await agent(
      [
        DRY,
        "タスク " + TASK_ID + " を実装する（§15-3 step 2）。",
        "",
        "step 1 で書かれた受入テスト: " + JSON.stringify(specTests.test_files || []),
        "このテストを緑にすることが目的である。**テストを編集・削除・skip・only してはならない。**",
        "テストが誤っていると判断したら、直さずに needs_context: true で報告する。",
        "",
        "タスクの files_to_create / files_to_modify に列挙された範囲だけを触る。",
        "要求以上の機能追加・リファクタ・将来要件の先回りをしない。",
        "",
        REPO_RULES,
        FINAL_SCHEMA_NOTE,
      ].join("\n"),
      { schema: WORK_SCHEMA, model: implementModel, label: "implement " + TASK_ID },
    );

    phase("step 3 self-quality");
    const quality = await agent(
      [
        DRY,
        "タスク " + TASK_ID + " の実装を自己品質修正する（§15-3 step 3）。",
        "",
        "見るもの: typecheck / lint / 命名 / エラー応答の形 { code, message, requestId } /",
        "docs/wording-policy.md の禁止語 / ログに秘密値・生の userId・IP・joinToken が出ていないか。",
        "テストの意味を変える修正はしない。",
        "",
        REPO_RULES,
        FINAL_SCHEMA_NOTE,
      ].join("\n"),
      { schema: WORK_SCHEMA, model: "sonnet", label: "self-quality " + TASK_ID },
    );
    if (quality && Array.isArray(quality.changed_files)) {
      lastWork = {
        changed_files: (lastWork && lastWork.changed_files ? lastWork.changed_files : []).concat(
          quality.changed_files,
        ),
        summary:
          (lastWork && lastWork.summary ? lastWork.summary : "") + " / 品質修正: " + quality.summary,
      };
    }
  } else {
    phase("step 6 fix");
    lastWork = await agent(
      [
        DRY,
        "タスク " + TASK_ID + " のレビュー指摘を直す（§15-3 step 6）。周回: " + round + " / " + MAX_ROUNDS + "。",
        "",
        "残っている実効 high: " + JSON.stringify(lastHighFindings),
        "",
        "手順は固定である。**反例を先にテストケース化してから直す。**",
        "1. 指摘ごとに、現在の実装で落ちるテストを書く（落ちることを実際に確認する）",
        "2. そのテストが緑になるように直す",
        "3. 既存テストを 1 件も減らさずに全体を走らせる",
        "テストを通すためのハードコード・特殊分岐・テスト改変をしない。",
        "指摘が誤っていると判断したら、直さずに unresolved に理由を書いて返す。",
        "",
        REPO_RULES,
        FINAL_SCHEMA_NOTE,
      ].join("\n"),
      { schema: WORK_SCHEMA, model: implementModel, label: "fix round " + round },
    );
  }

  // ---- step 4: 並列レビュー
  phase("step 4 review");

  const lanes = REVIEW_LANES.slice();
  if (preflight.touches_funds) {
    lanes.push({
      key: "compliance-gatekeeper",
      vendor: "claude",
      label: "e) compliance-gatekeeper",
      agentType: "compliance-gatekeeper",
      model: null,
      brief: [
        "役割: コンプライアンス・ゲートキーパー。資金フローに触れる周だけ回る。",
        "リリース不可と判断したら blocking: true を返す。この票が blocking のときループは即終了する。",
      ].join("\n"),
    });
  }

  const envelopes = await parallel(
    lanes.map(function (lane) {
      return function () {
        const opts = {
          schema: REVIEW_SCHEMA,
          phase: "step 4 review",
          label: lane.label + " r" + round,
        };
        if (lane.agentType) opts.agentType = lane.agentType;
        if (lane.model) opts.model = lane.model;
        return agent(reviewerPrompt(lane, round, lastWork), opts);
      };
    }),
  );

  // UNKNOWN が閾値を超えたレーンは同じ周で 1 回だけ引き直す（§15-3 step 5）。
  const rerunIndexes = [];
  for (let i = 0; i < envelopes.length; i++) {
    if (envelopes[i] && unknownRatioOf(envelopes[i]) > UNKNOWN_RERUN_THRESHOLD) {
      rerunIndexes.push(i);
    }
  }
  if (rerunIndexes.length > 0) {
    log(
      "round " +
        round +
        ": UNKNOWN が " +
        Math.round(UNKNOWN_RERUN_THRESHOLD * 100) +
        "% を超えたレーンを 1 回だけ引き直す — " +
        rerunIndexes
          .map(function (i) {
            return lanes[i].key;
          })
          .join(", "),
    );
    const reruns = await parallel(
      rerunIndexes.map(function (i) {
        const lane = lanes[i];
        return function () {
          const opts = {
            schema: REVIEW_SCHEMA,
            phase: "step 4 review",
            label: lane.label + " r" + round + " 引き直し",
          };
          if (lane.agentType) opts.agentType = lane.agentType;
          if (lane.model) opts.model = lane.model;
          return agent(
            reviewerPrompt(lane, round, lastWork) +
              "\n\n前回の返答は UNKNOWN の比率が高すぎた。断定できる根拠（逐語引用または repro）を" +
              "取りに行ってから返すこと。それでも断定できない項目は unknown のままでよい。",
            opts,
          );
        };
      }),
    );
    for (let k = 0; k < rerunIndexes.length; k++) {
      if (reruns[k]) envelopes[rerunIndexes[k]] = reruns[k];
    }
  }

  // ---- step 5: merge-verdict（成立条件。票数の多数決では決めない）
  phase("step 5 merge-verdict");

  const roundAbstentions = [];
  const votingVendors = [];
  // 有効票（reviewer_route === "ok"）を返したレーン。作者ベンダーのレーンも含む。
  // 自分が前の周に出した high を取り下げられるのは、この周に実際に応答したレーンだけである。
  const votingLanes = [];
  const roundHigh = [];
  let complianceBlocked = false;

  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i];
    const env = envelopes[i];
    if (!env || env.reviewer_route !== "ok") {
      roundAbstentions.push(abstentionOf(round, lane.key, lane.vendor, env));
      continue;
    }
    const invalidReason = invalidEnvelopeReasonOf(lane, env);
    if (invalidReason) {
      roundAbstentions.push(invalidEnvelopeAbstentionOf(round, lane, env, invalidReason));
      log(
        "round " +
          round +
          ": " +
          lane.key +
          " の封筒を invalid_envelope として欠票に落とした — " +
          invalidReason,
      );
      continue;
    }
    if (votingLanes.indexOf(lane.key) === -1) votingLanes.push(lane.key);
    // 独立性の会計はレーン定数で行う。env.vendor は上で一致を確かめただけで、数える値には使わない。
    const vendor = lane.vendor;
    if (vendor !== AUTHOR_VENDOR && votingVendors.indexOf(vendor) === -1) {
      votingVendors.push(vendor);
    }
    const highs = highFindingsOf(env);
    for (let j = 0; j < highs.length; j++) {
      roundHigh.push({
        key: highKeyOf(lane.key, highs[j]),
        reviewer: lane.key,
        vendor: vendor,
        self_review: vendor === AUTHOR_VENDOR,
        severity: highs[j].severity,
        summary: highs[j].summary,
        file: highs[j].file || "",
        repro: highs[j].repro || "",
        first_seen_round: firstSeenRoundOf(unresolvedHigh, highKeyOf(lane.key, highs[j]), round),
        last_seen_round: round,
      });
    }
    if (lane.key === "compliance-gatekeeper" && env.blocking === true) {
      complianceBlocked = true;
    }
  }

  for (let i = 0; i < roundAbstentions.length; i++) abstentions.push(roundAbstentions[i]);

  // 持ち越しの判定。取り下げられるのは「この周に有効票を返したレーンが、もう挙げていない指摘」
  // だけである。欠票したレーンの指摘は残す（欠票はレビュー無効でもなければ監査済みでもない）。
  const roundHighKeys = roundHigh.map(function (h) {
    return h.key;
  });
  const carriedHigh = unresolvedHigh.filter(function (h) {
    if (roundHighKeys.indexOf(h.key) !== -1) return false; // 今周も出ているので下で積み直す
    return votingLanes.indexOf(h.reviewer) === -1; // 出したレーンが欠票 → 解消を確認できていない
  });
  unresolvedHigh = carriedHigh.concat(roundHigh);
  highRemaining = unresolvedHigh.length;
  lastHighFindings = unresolvedHigh;

  // この周に独立ベンダーの有効票が 1 件も無ければ、実装は監査されていない。
  const roundAudited = votingVendors.length > 0;

  const costAtRoundEnd = budget.spent();
  costs.push({
    round: round,
    output_tokens_at_round_start: costAtRoundStart,
    output_tokens_at_round_end: costAtRoundEnd,
    output_tokens_delta: costAtRoundEnd - costAtRoundStart,
  });

  rounds.push({
    round: round,
    spec_tests_regenerated: round === 1,
    reviewers: lanes.map(function (l) {
      return l.key;
    }),
    voting_vendors: votingVendors,
    voting_lanes: votingLanes,
    audited: roundAudited,
    abstentions: roundAbstentions,
    effective_high: roundHigh,
    carried_high: carriedHigh,
    unresolved_high_after: unresolvedHigh.length,
    compliance_blocked: complianceBlocked,
  });

  log(
    "round " +
      round +
      ": 今周の実効 high " +
      roundHigh.length +
      " 件 / 前の周からの持ち越し " +
      carriedHigh.length +
      " 件 / 未解消 " +
      unresolvedHigh.length +
      " 件 / 有効票ベンダー " +
      (votingVendors.length > 0 ? votingVendors.join(",") : "なし") +
      " / 欠票 " +
      roundAbstentions.length +
      " 件",
  );

  if (complianceBlocked) {
    terminal = {
      status: "BLOCKED",
      reason: "compliance-gatekeeper が blocking を返したため即終了した（§15-3 step 5）",
    };
    break;
  }

  if (highRemaining === 0) {
    // 直す対象は無い。ただし監査されていない周で打ち切ると「誰も見ていない」を
    // 「指摘なし」と読み替えることになるので、その場合は DONE 系で閉じない（F6 / R-TH-06）。
    if (!roundAudited) {
      terminal = {
        status: "BLOCKED",
        reason:
          "round " +
          round +
          " は有効票を返した独立ベンダーが 0 件（欠票 " +
          roundAbstentions.length +
          " 件）で、実装が監査されていない。欠票を「指摘なし」と読み替えない（§15-3 step 5 / F6）",
      };
    }
    break;
  }

  if (round === MAX_ROUNDS) {
    terminal = {
      status: "BLOCKED",
      reason:
        MAX_ROUNDS +
        " 周しても実効 high が " +
        highRemaining +
        " 件残ったため BLOCKED とし、PO 裁定へ回す（§15-3 step 5。DONE_WITH_CONCERNS で通すことは禁止）" +
        (roundAudited
          ? ""
          : "。最終周は有効票を返した独立ベンダーが 0 件で、残った high の解消も確認できていない"),
    };
  }
}

// --------------------------------------------------- step 7: final verify

let verify = null;
if (terminal === null) {
  phase("step 7 final verify");
  verify = await agent(
    [
      DRY,
      "タスク " + TASK_ID + " の完了前検証を行う（§15-3 step 7）。",
      "",
      "1. docs/task-list.json の当該タスクの verify_commands を **1 本残らず**",
      "   scripts/record-run.sh " + TASK_ID + " <command...> 経由で実行し、exit code を記録する。",
      "2. 完了前 5 ステップゲート:",
      "   (a) 主張ごとに本セッションのツール実行結果を指せるか",
      "   (b) テストを走らせたか（「走った」と「通った」を混同していないか）",
      "   (c) テストを弱めていないか（件数・skip・only・expect の減少）",
      "   (d) タスクの範囲を超えた変更が混ざっていないか",
      "   (e) 未検証項目を未検証と書いたか",
      "3. 1 本でも exit 0 でなければ proposed_status を DONE にしない。",
      "",
      REPO_RULES,
      FINAL_SCHEMA_NOTE,
    ].join("\n"),
    { schema: VERIFY_SCHEMA, model: "opus", label: "final verify " + TASK_ID },
  );
}

// -------------------------------------------------------- step 8: status

// ここが唯一のステータス決定点である。エージェントの proposed_status は入力にすぎない。
// 実効 high が残っている限り DONE 系では閉じない、を最初に評価するのは §15-3 step 5 が
// 「3 周後も high が残れば BLOCKED（DONE_WITH_CONCERNS で通すことを禁止）」と定めているため。
// task_007 では実際に DONE_WITH_CONCERNS で閉じられ、後から BLOCKED へ訂正されている。
let finalStatus;
let finalReason;
if (highRemaining > 0) {
  finalStatus = "BLOCKED";
  finalReason =
    terminal !== null
      ? terminal.reason
      : "実効 high が " + highRemaining + " 件残ったまま周回が終わった";
} else if (terminal !== null) {
  finalStatus = terminal.status;
  finalReason = terminal.reason;
} else if (!verify) {
  finalStatus = "NEEDS_CONTEXT";
  finalReason = "検証エージェントが結果を返さなかった";
} else if (verify.all_verify_commands_green !== true || verify.five_step_gate_passed !== true) {
  finalStatus = verify.proposed_status === "DONE" ? "DONE_WITH_CONCERNS" : verify.proposed_status;
  finalReason = (verify.failures || []).join(" / ") || "検証が全項目 green ではない";
} else {
  finalStatus = verify.proposed_status;
  finalReason = "verify_commands が全て exit 0 で、完了前 5 ステップゲートを通過した";
}

phase("step 8 status");

const statusRecord = await agent(
  [
    DRY,
    "タスク " + TASK_ID + " の完了記録を残す（§15-3 step 8）。",
    "",
    "**確定済みのステータスは " + finalStatus + " である。これを変更してはならない。**",
    "理由: " + finalReason,
    "",
    "やること:",
    "1. docs/task-list.json の当該タスクの completion_status を " + finalStatus + " にし、",
    "   concerns を「[severity: high|medium|low] 指摘 / 対応案」の文字列配列で更新する（G4）。",
    "2. docs/PROGRESS.md に 1 行（task_id・ステータス・要点）を追記する。",
    "3. docs/HANDOFF.md の末尾に「決まったこと・未解決」を追記する。",
    "4. 1 周ごとのコストを scripts/record-run.sh --manual " + TASK_ID + " で記録する。",
    "   コスト実測値（出力トークン）: " + JSON.stringify(costs),
    "5. 欠票の記録（レビューが無効なのではなく、投票が届かなかった事実）:",
    "   " + JSON.stringify(abstentions),
    "6. 残った懸念を docs/concerns/" + TASK_ID + ".md に「指摘 / 深刻度 / 対応案 / 対応予定タスク」で書く。",
    "",
    "禁止: " +
      (finalStatus === "BLOCKED"
        ? "BLOCKED を DONE_WITH_CONCERNS に読み替えないこと。3 周後の high 残は PO 裁定である。"
        : "実行していない検証を実行したことにしないこと。"),
    "",
    REPO_RULES,
    FINAL_SCHEMA_NOTE,
  ].join("\n"),
  { schema: STATUS_SCHEMA, model: "opus", label: "status " + TASK_ID },
);

return {
  task_id: TASK_ID,
  status: finalStatus,
  reason: finalReason,
  dry_run: DRY_RUN,
  max_rounds: MAX_ROUNDS,
  rounds_used: rounds.length,
  spec_tests_regenerated_in_rounds: rounds
    .filter(function (r) {
      return r.spec_tests_regenerated;
    })
    .map(function (r) {
      return r.round;
    }),
  effective_high_remaining: highRemaining,
  unresolved_high: unresolvedHigh,
  audited_rounds: rounds
    .filter(function (r) {
      return r.audited;
    })
    .map(function (r) {
      return r.round;
    }),
  preflight: preflight,
  spec_tests: specTests,
  rounds: rounds,
  abstentions: abstentions,
  costs: costs,
  verify: verify,
  status_record: statusRecord,
};
