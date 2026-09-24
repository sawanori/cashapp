export const meta = {
  name: "release-audit",
  description:
    "リリース可否を票数ではなく成立条件で判定する。独立した 2 ベンダー以上の go かつ no-go ゼロ。不達は PO の明示承認が docs/gates/release-<version>.json にあることを要求する",
  whenToUse:
    "リリース候補に対して回す。args: { version: string, range?: string, dryRun?: boolean }。判定材料が揃わないときは go を出さず UNKNOWN を返す",
  phases: [
    { title: "evidence", detail: "review-log・ゲート・PO 承認記録を読み取り専用で集める", model: "opus" },
    {
      title: "vendor audits",
      detail: "release-auditor / adversarial-reviewer-gemini / adversarial-reviewer-gpt を並列",
    },
    { title: "decision", detail: "成立条件 5 項目を機械判定する（緩めない）", model: "opus" },
  ],
};

// ---------------------------------------------------------------- 入力と定数

// §15-3 / .claude/agents/release-auditor.md: 票数の全会一致では判定しない。
const REQUIRED_GO_VENDORS = 2;
// 作者ベンダー。Claude 系のみでは成立しない（§16-1 の 2）。
const AUTHOR_VENDOR = "claude";

const input = args && typeof args === "object" ? args : {};
const VERSION = typeof input.version === "string" ? input.version.trim() : "";
const RANGE = typeof input.range === "string" && input.range ? input.range : "直近のリリース候補範囲";
const DRY_RUN = input.dryRun === true;

if (!VERSION) {
  return {
    verdict: "UNKNOWN",
    reason: "args.version が渡されていない。{ version: 'v0.1.0' } を指定すること",
    conditions: [],
    vendors: [],
  };
}

const APPROVAL_PATH = "docs/gates/release-" + VERSION + ".json";

const READ_ONLY_RULES = [
  "禁止（すべて F13 / R-SEC-07）:",
  "- docs/gates/** を書き換えない。リリース可否のフラグを立てるのは PO である。",
  "- wrangler deploy 等のデプロイコマンドを実行しない。デプロイは CI だけが行う。",
  "- git push / supabase db push / npm publish を実行しない。",
  "読み取りと、npm run gate:check のような検査コマンドの実行だけを行う。",
].join("\n");

const EVIDENCE_SCHEMA = {
  type: "object",
  properties: {
    review_log_files: { type: "array", items: { type: "string" } },
    envelopes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          vendor: { type: "string" },
          reviewer_route: { type: "string" },
          model_id_actual: { type: "string" },
        },
        required: ["vendor", "reviewer_route"],
      },
    },
    voted_vendors: { type: "array", items: { type: "string" } },
    unavailable_vendors: { type: "array", items: { type: "string" } },
    approval_file_exists: { type: "boolean" },
    approved_unavailable_vendors: { type: "array", items: { type: "string" } },
    approved_by: { type: "string" },
    release_mode_exists: { type: "boolean" },
    payments_enabled: { type: "boolean" },
    payments_flag_false_evidence: { type: "string" },
    payment_sdk_absent: { type: "boolean" },
    legal_clearance_cleared: { type: "boolean" },
    gate_check_exit_code: { type: "number" },
    gate_check_violations: { type: "number" },
    gate_check_output_tail: { type: "string" },
    unreadable: { type: "array", items: { type: "string" } },
  },
  required: [
    "envelopes",
    "voted_vendors",
    "unavailable_vendors",
    "approval_file_exists",
    "release_mode_exists",
    "legal_clearance_cleared",
    "gate_check_exit_code",
  ],
};

const VENDOR_SCHEMA = {
  type: "object",
  properties: {
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
    verdict: { type: "string", enum: ["go", "no-go", "UNKNOWN"] },
    reasons: { type: "array", items: { type: "string" } },
    blocking_findings: { type: "array", items: { type: "string" } },
  },
  required: ["vendor", "reviewer_route", "verdict", "reasons"],
};

const VERDICT_VALUES = ["go", "no-go", "UNKNOWN"];

/**
 * 票として成立しない封筒の理由を返す（成立していれば null）。reviewer_route が "ok" の
 * 封筒だけを見る。
 *
 * task-loop.ts の invalidEnvelopeReasonOf と同じ理由でここに置く。独立ベンダー数は
 * レーン定数（lane.vendor）で数える値であって、封筒の自己申告で決めてよいものではない。
 * 自己申告を使うと release-auditor（作者ベンダー）のレーンが vendor: "gemini" と書くだけで
 * 成立条件 1「独立した 2 ベンダー以上が go」を 1 票で通せる（R-TH-11 / F6）。
 */
function invalidVendorEnvelopeReasonOf(lane, res) {
  const declared = typeof res.vendor === "string" ? res.vendor.trim() : "";
  if (declared !== lane.vendor) {
    return (
      "封筒の自己申告 vendor がレーン定数と一致しない（lane=" +
      lane.vendor +
      " / envelope=" +
      (declared || "（空）") +
      "）。独立ベンダー数はレーン定数で数える（R-TH-11）"
    );
  }
  const modelId = typeof res.model_id_actual === "string" ? res.model_id_actual.trim() : "";
  if (!modelId) {
    return "封筒に model_id_actual が無い。どのモデルが答えたか分からない票は数えない（§16-2 / R-TH-11）";
  }
  if (VERDICT_VALUES.indexOf(res.verdict) === -1) {
    return (
      "verdict が " +
      VERDICT_VALUES.join(" / ") +
      " のいずれでもない（" +
      String(res.verdict) +
      "）。判定できない封筒を票に数えない"
    );
  }
  return null;
}

const VENDOR_LANES = [
  {
    key: "release-auditor",
    vendor: "claude",
    agentType: "release-auditor",
    model: null,
    brief:
      "役割: 取りまとめ役としての監査。作者と同じベンダーなので、この票は独立ベンダー数には数えない。ただし no-go は no-go として効く。",
  },
  {
    key: "gemini",
    vendor: "gemini",
    agentType: "adversarial-reviewer-gemini",
    model: null,
    brief: "役割: 規約・一次資料に照らした独立監査。逐語引用の無い主張は verdict を UNKNOWN にする。",
  },
  {
    key: "gpt",
    vendor: "gpt",
    agentType: "adversarial-reviewer-gpt",
    model: null,
    brief: "役割: 反例提示型の独立監査。repro を示せない指摘で no-go にしない。経路が通らなければ unavailable を返す。",
  },
];

// ---------------------------------------------------------------- evidence

phase("evidence");

const evidence = await agent(
  [
    DRY_RUN ? "DRY RUN。ファイルを 1 行も変更してはならない。\n" : "",
    "リリース " + VERSION + " の監査材料を集める。対象範囲: " + RANGE + "。",
    "",
    "集めるもの（すべて実測。読めなかったものは unreadable に入れ、推測で埋めない）:",
    "1. docs/review-log/*.json を読み、対象範囲の封筒の vendor / reviewer_route / model_id_actual を",
    "   列挙する。**実際に投票したベンダーだけを voted_vendors に入れる。**",
    "   reviewer_route が unavailable のベンダーは unavailable_vendors に入れる。",
    "2. " + APPROVAL_PATH + " の有無と、そこに記録された「不達ベンダーの明示承認」を読む。",
    "   承認された不達ベンダー名を approved_unavailable_vendors に入れる。",
    "   ファイルが無ければ approval_file_exists を false にする（作ってはならない）。",
    "3. docs/gates/release-mode.json の payments_enabled を読む。",
    "   payments_enabled が false なら、ビルド設定の PAYMENTS_ENABLED が false であることの根拠行を",
    "   payments_flag_false_evidence に入れ、npm ls に決済 SDK が無いことを payment_sdk_absent に入れる。",
    "4. docs/gates/legal-clearance.json の cleared を読む。",
    "5. npm run gate:check を scripts/record-run.sh 経由で実行し、exit code と違反件数、出力の末尾を入れる。",
    "",
    READ_ONLY_RULES,
    "",
    "返り値は人間向けの文章ではなく、次のステップが読むデータである。",
  ].join("\n"),
  { schema: EVIDENCE_SCHEMA, model: "opus", label: "evidence " + VERSION },
);

if (!evidence) {
  return {
    version: VERSION,
    verdict: "UNKNOWN",
    reason: "監査材料を集めるエージェントが結果を返さなかった。材料が揃わないので go は出さない",
    conditions: [],
    vendors: [],
  };
}

log(
  "材料: 投票ベンダー " +
    (evidence.voted_vendors || []).join(",") +
    " / 不達 " +
    (evidence.unavailable_vendors || []).join(",") +
    " / gate:check exit " +
    evidence.gate_check_exit_code,
);

// ----------------------------------------------------------- vendor audits

phase("vendor audits");

const vendorResults = await parallel(
  VENDOR_LANES.map(function (lane) {
    return function () {
      const opts = {
        schema: VENDOR_SCHEMA,
        phase: "vendor audits",
        label: "audit " + lane.key,
      };
      if (lane.agentType) opts.agentType = lane.agentType;
      if (lane.model) opts.model = lane.model;
      return agent(
        [
          DRY_RUN ? "DRY RUN。ファイルを 1 行も変更してはならない。\n" : "",
          "リリース " + VERSION + " の可否を監査する。対象範囲: " + RANGE + "。",
          "",
          lane.brief,
          "",
          "既に集まっている材料（これを鵜呑みにせず、自分で確かめられるものは確かめる）:",
          JSON.stringify(evidence),
          "",
          "go を出してよいのは、次の 5 項目がすべて YES のときだけである:",
          "1. 独立した 2 ベンダー以上が go（Claude 系のみでは成立しない）",
          "2. no-go が 0 件",
          "3. 不達のベンダーがある場合、PO の明示承認が " + APPROVAL_PATH + " にある",
          "4. docs/gates/release-mode.json の 2 段ゲートを満たす",
          "   payments_enabled: false → ビルド設定の PAYMENTS_ENABLED が false、npm ls に決済 SDK が無い",
          "   payments_enabled: true  → docs/gates/legal-clearance.json の cleared が true",
          "5. npm run gate:check が違反 0 件",
          "なお docs/implementation-plan.md §15-3 は「legal-clearance.json の cleared が false なら",
          "無条件 no-go」と定めている。payments_enabled の値によらずこの一文が優先する。",
          "",
          "してはいけないこと:",
          "- 実際に投票していないベンダーを票に数えない。欠票がある状態を「3 ベンダーで監査した」と書かない。",
          "- 成立条件をその場で緩めない。緩める必要が出たら ADR を起票して PO 裁定へ回す。",
          "- 判定材料が揃わないときに「たぶん問題ない」で go を出さない。UNKNOWN を返す。",
          "- 経路が通らなかったら reviewer_route を unavailable にし、attempted_command と",
          "  unreachable_reason を埋める。不達を findings 0 件の go に見せかけない。",
          "- vendor はこのレーンのベンダー '" + lane.vendor + "' を書く。自己申告がレーン定数と",
          "  食い違う封筒、model_id_actual が空の封筒、verdict が go / no-go / UNKNOWN 以外の封筒は、",
          "  invalid_envelope として欠票に落とし、独立ベンダー数には数えない（§16-2 / R-TH-11）。",
          "",
          READ_ONLY_RULES,
          "",
          "返り値は人間向けの文章ではなく、次のステップが読むデータである。",
        ].join("\n"),
        opts,
      );
    };
  }),
);

// -------------------------------------------------------------- decision

phase("decision");

const vendors = [];
const abstentions = [];
for (let i = 0; i < VENDOR_LANES.length; i++) {
  const lane = VENDOR_LANES[i];
  const res = vendorResults[i];
  if (!res || res.reviewer_route !== "ok") {
    abstentions.push({
      lane: lane.key,
      vendor: lane.vendor,
      reviewer_route: res && res.reviewer_route ? res.reviewer_route : "unavailable",
      attempted_command: res && res.attempted_command ? res.attempted_command : "",
      reason:
        res && res.unreachable_reason
          ? res.unreachable_reason
          : "エージェントが封筒を返さなかった（skip / 終端エラー）",
    });
    continue;
  }
  const invalidReason = invalidVendorEnvelopeReasonOf(lane, res);
  if (invalidReason) {
    abstentions.push({
      lane: lane.key,
      vendor: lane.vendor,
      reviewer_route: "invalid_envelope",
      attempted_command: res.attempted_command ? res.attempted_command : "",
      reason: invalidReason,
    });
    log("lane " + lane.key + " の封筒を invalid_envelope として欠票に落とした — " + invalidReason);
    continue;
  }
  vendors.push({
    lane: lane.key,
    // 自己申告ではなくレーン定数。上で一致は確かめてある。
    vendor: lane.vendor,
    verdict: res.verdict,
    model_id_actual: res.model_id_actual,
    reasons: res.reasons || [],
    blocking_findings: res.blocking_findings || [],
  });
}

const goVendors = [];
const noGoVendors = [];
const unknownVendors = [];
for (let i = 0; i < vendors.length; i++) {
  const v = vendors[i];
  if (v.verdict === "go" && goVendors.indexOf(v.vendor) === -1) goVendors.push(v.vendor);
  if (v.verdict === "no-go" && noGoVendors.indexOf(v.vendor) === -1) noGoVendors.push(v.vendor);
  if (v.verdict === "UNKNOWN" && unknownVendors.indexOf(v.vendor) === -1) unknownVendors.push(v.vendor);
}

const independentGoVendors = goVendors.filter(function (v) {
  return v !== AUTHOR_VENDOR;
});

// 不達ベンダーは「票が無い」だけで監査を無効にはしない。ただし PO の明示承認が要る。
const unavailableVendors = [];
for (let i = 0; i < abstentions.length; i++) {
  if (unavailableVendors.indexOf(abstentions[i].vendor) === -1) {
    unavailableVendors.push(abstentions[i].vendor);
  }
}
const evidenceUnavailable = Array.isArray(evidence.unavailable_vendors)
  ? evidence.unavailable_vendors
  : [];
for (let i = 0; i < evidenceUnavailable.length; i++) {
  if (unavailableVendors.indexOf(evidenceUnavailable[i]) === -1) {
    unavailableVendors.push(evidenceUnavailable[i]);
  }
}
const approvedUnavailable = Array.isArray(evidence.approved_unavailable_vendors)
  ? evidence.approved_unavailable_vendors
  : [];
const unapprovedUnavailable = unavailableVendors.filter(function (v) {
  return approvedUnavailable.indexOf(v) === -1;
});

// 4. 2 段ゲート。release-mode.json が無いときは fail-closed（判定材料が無いので満たしていない）。
let stageGateOk;
let stageGateNote;
if (evidence.release_mode_exists !== true) {
  stageGateOk = false;
  stageGateNote = "docs/gates/release-mode.json が無い（PO が作る。AI は作らない）";
} else if (evidence.payments_enabled === true) {
  stageGateOk = evidence.legal_clearance_cleared === true;
  stageGateNote =
    "payments_enabled: true → legal-clearance.json の cleared が " +
    (evidence.legal_clearance_cleared === true ? "true" : "true ではない");
} else {
  stageGateOk = evidence.payment_sdk_absent === true && !!evidence.payments_flag_false_evidence;
  stageGateNote =
    "payments_enabled: false → PAYMENTS_ENABLED の false 根拠 " +
    (evidence.payments_flag_false_evidence ? "あり" : "なし") +
    " / 決済 SDK 不在 " +
    (evidence.payment_sdk_absent === true ? "確認" : "未確認");
}

const conditions = [
  {
    id: 1,
    text:
      "独立した " +
      REQUIRED_GO_VENDORS +
      " ベンダー以上が go（作者ベンダー " +
      AUTHOR_VENDOR +
      " の票は数に入れない）",
    // §15-3「独立した 2 ベンダー以上の go」/ release-auditor.md 条件 1 の逐語をそのまま採る。
    // 作者ベンダー + 独立 1 件（計 2 票）で通す読みは fail-open なので採らない。
    // 解釈の一本化は ADR 待ち（docs/concerns/task_008.md の C-008-10）。
    pass: independentGoVendors.length >= REQUIRED_GO_VENDORS,
    detail:
      "go ベンダー: " +
      (goVendors.length > 0 ? goVendors.join(",") : "なし") +
      " / うち独立: " +
      (independentGoVendors.length > 0 ? independentGoVendors.join(",") : "なし"),
  },
  {
    id: 2,
    text: "no-go が 0 件",
    pass: noGoVendors.length === 0,
    detail: "no-go ベンダー: " + (noGoVendors.length > 0 ? noGoVendors.join(",") : "なし"),
  },
  {
    id: 3,
    text: "不達のベンダーは PO の明示承認が " + APPROVAL_PATH + " にある",
    pass: unapprovedUnavailable.length === 0,
    detail:
      "不達: " +
      (unavailableVendors.length > 0 ? unavailableVendors.join(",") : "なし") +
      " / 未承認: " +
      (unapprovedUnavailable.length > 0 ? unapprovedUnavailable.join(",") : "なし") +
      " / 承認記録: " +
      (evidence.approval_file_exists === true ? "あり" : "なし"),
  },
  {
    id: 4,
    text: "docs/gates/release-mode.json の 2 段ゲートを満たす",
    pass: stageGateOk === true,
    detail: stageGateNote,
  },
  {
    id: 5,
    text: "npm run gate:check が違反 0 件",
    pass: evidence.gate_check_exit_code === 0,
    detail: "exit " + evidence.gate_check_exit_code,
  },
  {
    id: 6,
    text: "legal-clearance.json の cleared が false なら無条件 no-go（§15-3）",
    pass: evidence.legal_clearance_cleared === true,
    detail: "cleared: " + JSON.stringify(evidence.legal_clearance_cleared),
  },
];

const failed = conditions.filter(function (c) {
  return c.pass !== true;
});

// 判定材料が揃わない状態を go にも no-go にもしない。
const materialMissing =
  (Array.isArray(evidence.unreadable) && evidence.unreadable.length > 0) ||
  vendors.length === 0 ||
  unknownVendors.length > 0;

let verdict;
let reason;
if (noGoVendors.length > 0) {
  verdict = "no-go";
  reason = "no-go を出したベンダーがある: " + noGoVendors.join(",");
} else if (failed.length > 0) {
  verdict = materialMissing ? "UNKNOWN" : "no-go";
  reason =
    "成立条件の NO: " +
    failed
      .map(function (c) {
        return c.id + "（" + c.detail + "）";
      })
      .join(" / ");
} else if (materialMissing) {
  verdict = "UNKNOWN";
  reason =
    "成立条件は満たすが判定材料が揃っていない（読めなかったもの: " +
    JSON.stringify(evidence.unreadable || []) +
    " / UNKNOWN 票: " +
    unknownVendors.join(",") +
    "）";
} else {
  verdict = "go";
  reason =
    "成立条件 " +
    conditions.length +
    " 項目すべて YES。go ベンダー " +
    goVendors.join(",") +
    "（うち独立 " +
    independentGoVendors.join(",") +
    "）";
}

log("release " + VERSION + ": " + verdict + " — " + reason);

return {
  version: VERSION,
  verdict: verdict,
  reason: reason,
  dry_run: DRY_RUN,
  conditions: conditions,
  vendors: vendors,
  go_vendors: goVendors,
  independent_go_vendors: independentGoVendors,
  no_go_vendors: noGoVendors,
  unknown_vendors: unknownVendors,
  abstentions: abstentions,
  unavailable_vendors: unavailableVendors,
  unapproved_unavailable_vendors: unapprovedUnavailable,
  approval_path: APPROVAL_PATH,
  evidence: evidence,
};
