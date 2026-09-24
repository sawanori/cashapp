export const meta = {
  name: "premortem",
  description:
    "legal / payment / platform / harness の 4 レンズで「もう失敗した」前提の失敗モードを並列に起案し、既存台帳との差分だけを docs/premortem/<date>.json に残す",
  whenToUse:
    "フェーズ境界で回す。args: { date?: 'YYYY-MM-DD', phase?: string, scope?: string, dryRun?: boolean }。既出は新規として出さない（R-TH-09 の雪だるまを作らない）",
  phases: [
    { title: "date", detail: "出力ファイル名に使う UTC 日付を確定する" },
    {
      title: "lenses",
      detail: "legal / payment / platform / harness の 4 レンズを並列で起案する",
      model: "opus",
    },
    {
      title: "consolidate",
      detail: "レンズ間の重複を畳み、既存台帳との差分だけを docs/premortem/<date>.json に書く",
      model: "opus",
    },
  ],
};

// ---------------------------------------------------------------- 入力と定数

const BASELINE = "docs/research/premortem-risks.md";
// §16-2 運用レーン: 前回 high の未対応が 3 件以上なら新規着手停止（G11）。
const G11_THRESHOLD = 3;

const input = args && typeof args === "object" ? args : {};
const PHASE_LABEL = typeof input.phase === "string" && input.phase ? input.phase : "（フェーズ指定なし）";
const SCOPE = typeof input.scope === "string" && input.scope ? input.scope : "リポジトリ全体の現在の差分";
const DRY_RUN = input.dryRun === true;

const DRY = DRY_RUN
  ? [
      "DRY RUN。ファイルを 1 行も変更してはならない。出力すべき内容を返すだけにとどめる。",
      "",
    ].join("\n")
  : "";

// 4 レンズ。docs/task-list.json task_008 の scope が定める 4 本であり、
// .claude/agents/premortem-facilitator.md の 4 レンズをこの名前に割り付けている。
const LENSES = [
  {
    key: "legal",
    title: "legal-compliance",
    brief: [
      "資金決済法（収納代行・為替取引・前払式支払手段）・特商法・個人情報保護法・LINE の各規約。",
      "「幹事個人が受け取る」「サービスが一旦預かる」の線引きが崩れる瞬間を探す。",
      "一次資料を再取得せずに法令・規約の解釈を断定しないこと。断定が要るものは照会（§18）へ回す。",
    ].join("\n"),
  },
  {
    key: "payment",
    title: "security / payment-integrity",
    brief: [
      "資金・冪等・順序・鍵。二重請求、取りこぼし、Webhook の順序逆転、再送、返金、台帳の不一致。",
      "金額が 1 円でもずれる経路と、ずれたことに誰も気づかない経路を分けて挙げる。",
    ].join("\n"),
  },
  {
    key: "platform",
    title: "platform / ops-support / ux-adoption",
    brief: [
      "LINE ミニアプリ審査・LIFF の挙動・Cloudflare Workers の制約・決済事業者の審査と停止、",
      "および運用負荷・問い合わせ・幹事と参加者の離脱。プラットフォーム側の一方的な変更で",
      "サービスが止まる経路を含める。",
    ].join("\n"),
  },
  {
    key: "harness",
    title: "team-harness / data-infra",
    brief: [
      "ハーネス自体の失敗（F1〜F13）・DB・インフラ。ゲートが空振りする、レビューが自己レビューに",
      "退化する、欠票が「監査済み」と読み替えられる、基準値の再生成で改竄が洗浄される、といった",
      "「検査しているつもりで何も検査していない」状態を探す。",
    ].join("\n"),
  },
];

const ITEM_SCHEMA = {
  type: "object",
  properties: {
    failure_mode: { type: "string" },
    trigger_moment: { type: "string" },
    what_happens: { type: "string" },
    detection_signal: { type: "string" },
    countermeasure: { type: "string" },
    degraded_mode: { type: "string" },
    severity: { type: "string", enum: ["S1", "S2", "S3"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: [
    "failure_mode",
    "trigger_moment",
    "what_happens",
    "detection_signal",
    "countermeasure",
    "degraded_mode",
    "severity",
    "confidence",
  ],
};

const LENS_SCHEMA = {
  type: "object",
  properties: {
    lens: { type: "string" },
    baseline_read: { type: "boolean" },
    baseline_count: { type: "number" },
    new_items: { type: "array", items: ITEM_SCHEMA },
    restated: {
      type: "array",
      items: {
        type: "object",
        properties: {
          risk_id: { type: "string" },
          status_change: { type: "string", enum: ["あり", "なし"] },
        },
        required: ["risk_id", "status_change"],
      },
    },
    unaddressed_high_from_last_round: { type: "array", items: { type: "string" } },
  },
  required: ["lens", "baseline_read", "new_items", "restated"],
};

const CONSOLIDATE_SCHEMA = {
  type: "object",
  properties: {
    output_path: { type: "string" },
    written: { type: "boolean" },
    new_count: { type: "number" },
    restated_count: { type: "number" },
    severity_breakdown: {
      type: "object",
      properties: {
        S1: { type: "number" },
        S2: { type: "number" },
        S3: { type: "number" },
      },
      required: ["S1", "S2", "S3"],
    },
    cross_lens_duplicates_dropped: { type: "number" },
    g11_blocked: { type: "boolean" },
    g11_unaddressed_high: { type: "number" },
    headline: { type: "string" },
  },
  required: ["output_path", "written", "new_count", "g11_blocked", "headline"],
};

// -------------------------------------------------------------- 日付の確定

// Workflow スクリプトでは現在時刻を読む組み込み（Date 系・乱数）が使えない。resume 時に
// 同じ入力から同じ結果を再現できなくなるためである。args.date が無いときだけ、
// シェルの date -u を 1 回だけ叩いて確定させる。
phase("date");

let runDate = typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : "";

if (!runDate) {
  const stamped = await agent(
    [
      "`date -u +%Y-%m-%d` を 1 回だけ実行し、その標準出力をそのまま date に入れて返す。",
      "他のコマンドを実行しない。ファイルを読まない。書かない。推測で日付を書かない。",
    ].join("\n"),
    {
      schema: {
        type: "object",
        properties: { date: { type: "string" }, command_output: { type: "string" } },
        required: ["date"],
      },
      model: "sonnet",
      label: "date -u",
    },
  );
  if (!stamped || typeof stamped.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(stamped.date)) {
    return {
      status: "NEEDS_CONTEXT",
      reason:
        "出力ファイル名に使う日付を確定できなかった。args.date に 'YYYY-MM-DD' を渡して再実行すること",
      lenses: [],
    };
  }
  runDate = stamped.date;
}

const OUTPUT_PATH = "docs/premortem/" + runDate + ".json";
log("出力先: " + OUTPUT_PATH + "（対象: " + PHASE_LABEL + "）");

// ---------------------------------------------------------- 4 レンズの並列起案

phase("lenses");

const lensResults = await parallel(
  LENSES.map(function (lens) {
    return function () {
      return agent(
        [
          DRY,
          "プレモータムの " + lens.title + " レンズを回す。対象フェーズ: " + PHASE_LABEL + "。",
          "対象範囲: " + SCOPE + "。",
          "",
          "レンズの担当範囲:",
          lens.brief,
          "",
          "手順（.claude/agents/premortem-facilitator.md の手順をこのレンズだけで回す）:",
          "1. 対象範囲の diff と docs/task-list.json の当該範囲を読む。",
          "2. 「このフェーズは既に失敗した。何が起きたか」から逆算して失敗モードを列挙する。",
          "3. **" + BASELINE + " を必ず読み、既出は新規として出さない。**",
          "   既出なら risk_id を引いて restated に「再掲・状況変化あり／なし」とだけ書く。",
          "   読めなかったら baseline_read を false にする（読んでいないのに読んだことにしない）。",
          "4. 新規は 7 項目すべてが埋まるものだけを出す。1 つでも埋まらないものは出さない。",
          "5. 検知シグナルは機械で取れる値に限る。「注意深く見る」のような人手依存は新規として採らない。",
          "6. 前回の high で未対応のものを unaddressed_high_from_last_round に列挙する。",
          "",
          "してはいけないこと:",
          "- 実装コストを見積もらない。対策は「何を測るか」までで止める。",
          "- 既存台帳の言い換えを新規として水増ししない。**ユニーク検出 0 件ならそう報告する。**",
          "- " + BASELINE + " を書き換えない。追記の可否は PO の判断である。",
          "",
          "返り値は人間向けの文章ではなく、次のステップが読むデータである。",
        ].join("\n"),
        {
          schema: LENS_SCHEMA,
          agentType: "premortem-facilitator",
          phase: "lenses",
          label: "lens " + lens.key,
        },
      );
    };
  }),
);

const lenses = [];
const missingLenses = [];
for (let i = 0; i < LENSES.length; i++) {
  if (lensResults[i]) {
    lenses.push({ key: LENSES[i].key, result: lensResults[i] });
  } else {
    missingLenses.push(LENSES[i].key);
  }
}

if (missingLenses.length > 0) {
  log("レンズ欠測: " + missingLenses.join(", ") + "（この分は差分に含まれない）");
}

if (lenses.length === 0) {
  return {
    status: "BLOCKED",
    reason: "4 レンズすべてが結果を返さなかった",
    date: runDate,
    output_path: OUTPUT_PATH,
    missing_lenses: missingLenses,
    lenses: [],
  };
}

const rawNewCount = lenses.reduce(function (sum, l) {
  return sum + (Array.isArray(l.result.new_items) ? l.result.new_items.length : 0);
}, 0);
const unaddressedHigh = [];
for (let i = 0; i < lenses.length; i++) {
  const list = lenses[i].result.unaddressed_high_from_last_round;
  if (!Array.isArray(list)) continue;
  for (let j = 0; j < list.length; j++) {
    if (unaddressedHigh.indexOf(list[j]) === -1) unaddressedHigh.push(list[j]);
  }
}
const g11Blocked = unaddressedHigh.length >= G11_THRESHOLD;

log(
  "レンズ起案: 新規候補 " +
    rawNewCount +
    " 件（重複畳み込み前）/ 前回 high の未対応 " +
    unaddressedHigh.length +
    " 件 / G11 " +
    (g11Blocked ? "抵触" : "非抵触"),
);

// ------------------------------------------------------------ 差分の書き出し

phase("consolidate");

const consolidated = await agent(
  [
    DRY,
    "4 レンズの起案を畳んで " + OUTPUT_PATH + " に書く。",
    "",
    "レンズの出力（そのままの JSON）:",
    JSON.stringify(
      lenses.map(function (l) {
        return { lens: l.key, result: l.result };
      }),
    ),
    "",
    "欠測したレンズ: " + (missingLenses.length > 0 ? missingLenses.join(", ") : "なし"),
    "",
    "やること:",
    "1. " + BASELINE + " をもう一度読み、各 new_items が本当に既出でないことを確かめる。",
    "   既出だったものは new_items から外し restated に移す（外した件数を数える）。",
    "2. レンズ間で同じ失敗モードを指しているものを 1 件に畳む",
    "   （cross_lens_duplicates_dropped に落とした件数を入れる）。",
    "3. 7 項目のどれかが埋まっていない item は落とす。検知シグナルが人手依存のものも落とす。",
    "4. " + OUTPUT_PATH + " を次の形で書く（mkdir -p docs/premortem を先に行う）:",
    "   {",
    '     "date": "' + runDate + '",',
    '     "generated_at": "<date -u +%Y-%m-%dT%H:%M:%SZ の実出力>",',
    '     "phase": "' + PHASE_LABEL + '",',
    '     "scope": "' + SCOPE + '",',
    '     "baseline": "' + BASELINE + '",',
    '     "baseline_count": <台帳の件数>,',
    '     "missing_lenses": [...],',
    '     "g11": { "blocked": ' + (g11Blocked ? "true" : "false") + ', "unaddressed_high": [...] },',
    '     "new_items": [ { "id": "P-' + runDate + '-01", "lens": "...", 7 項目 } ],',
    '     "restated": [ { "risk_id": "...", "status_change": "あり|なし", "lens": "..." } ]',
    "   }",
    "   同名ファイルが既にある場合は上書きせず、読み込んで new_items を差分追記する。",
    "5. " + BASELINE + " は書き換えない（追記の可否は PO の判断）。docs/gates/** も書き換えない。",
    "",
    "headline は 1 行で「新規 N 件（S1 x / S2 y / S3 z）、既出の再掲 M 件、G11 の判定」。",
    (g11Blocked
      ? "G11 に抵触している。headline の最初に「新規着手の停止（G11）」を宣言すること。"
      : ""),
    "",
    "ユニーク検出が 0 件ならそう書く。水増ししない。",
    "返り値は人間向けの文章ではなく、次のステップが読むデータである。",
  ].join("\n"),
  { schema: CONSOLIDATE_SCHEMA, model: "opus", label: "consolidate " + runDate },
);

if (!consolidated) {
  return {
    status: "BLOCKED",
    reason: "畳み込みエージェントが結果を返さなかった。レンズの生出力は journal に残っている",
    date: runDate,
    output_path: OUTPUT_PATH,
    missing_lenses: missingLenses,
    raw_new_count: rawNewCount,
    g11_blocked: g11Blocked,
    unaddressed_high: unaddressedHigh,
    lenses: lenses,
  };
}

return {
  status: consolidated.written ? "DONE" : "DONE_WITH_CONCERNS",
  date: runDate,
  output_path: consolidated.output_path || OUTPUT_PATH,
  written: consolidated.written === true,
  dry_run: DRY_RUN,
  phase_label: PHASE_LABEL,
  scope: SCOPE,
  raw_new_count: rawNewCount,
  new_count: consolidated.new_count,
  restated_count: consolidated.restated_count,
  severity_breakdown: consolidated.severity_breakdown,
  cross_lens_duplicates_dropped: consolidated.cross_lens_duplicates_dropped,
  missing_lenses: missingLenses,
  g11_blocked: g11Blocked || consolidated.g11_blocked === true,
  unaddressed_high: unaddressedHigh,
  headline: consolidated.headline,
};
