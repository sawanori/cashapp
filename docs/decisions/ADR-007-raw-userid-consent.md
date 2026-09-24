# ADR-007: 幹事の生 LINE userId 保持の同意設計

## ステータス

`proposed`（2026-09-25、task_023 修正ラウンドで `accepted` から差し戻し）。

`docs/implementation-plan.md`:765 は「本リポジトリで人間（PO）が実際に関与する関門は 3 つだけ
である: ① `docs/gates/**.json` の変更、② ADR の `accepted` 化、③ 実機確認とパイロット」と定めて
おり、ADR の `accepted` 化は PO 専権のゲートである。直前ラウンド（2026-09-25、task_023 再着手）
は本 ADR を `accepted` にしたが、その決定の主体は本 ADR 自身が明記するとおり「プロジェクト運営
フロー（PO 指示の申し送り）」であり、PO 本人の明示的な回答（AskUserQuestion 等）ではなかった。
敵対レビュー（本ラウンドに渡された「レビューのギャップ」、severity: high）はこれを PO ゲート
未通過のまま `accepted` を名乗った実体不一致と指摘し、本ラウンドで `proposed` に差し戻した。

**パターン B（下記「決定（暫定）」）自体は取り下げない。** `src/lib/line/messaging.ts` /
`src/lib/outbox-transports.ts` の実装は本ラウンドでも変更していない（Pattern B を前提に動作を
継続する）。変えたのは「この選択が PO によって正式に承認された」という本 ADR の**ステータス
表明**であり、実装の挙動ではない。**PO が本 ADR を明示的にレビューし `accepted` にするか、
パターン A へ切り替えるまで、パターン B は暫定運用として扱う。**

## コンテキスト

task_023（Messaging API チャネル・幹事向け要対応通知・依存先込み health・外形監視）の目標は
「要対応（mismatch / paid_after_void / orphan / 二重払い / 支払手段なし）が幹事に LINE 公式
アカウント経由で届く」こと（`docs/implementation-plan.md` §7-7「外形監視」・R-OPS-01）である。
これを実現するには LINE Messaging API の `push` を使う必要があるが、`push` の宛先指定には
**生の LINE userId**（LINE 側が発行する `U` で始まる ID）が要る。

一方 `docs/implementation-plan.md` §7-5「最小 PII と保持」は次のように定めている。

> LINE userId | 生値を保存しない。`line_user_ref`（HMAC、`pepper_version` 付き）のみ。
> 突合（提示された userId をハッシュして一致検索）はできるが逆引きはできない状態を維持し、
> その手順を `docs/legal-forensics.md` に記載

つまり現行の設計は「生 userId を DB に持たない」ことを前提にしており、Messaging API の
`push` が要求する「生 userId を持つ」こととそのままでは両立しない。

`docs/research/premortem-phase1b-2026-09-24.md` の P-12（S2 × high）はこの衝突を次のように
指摘している。

- 新設される生 userId 列は DB 内で最も価値の高い秘密になるが、PEPPER のローテーション設計にも
  90 日の保持設計にも組み込まれていない。
- 対応案は「(a) 生 userId を保持する」「(b) 保持せず outbox は運営者向け内部通知だけにして
  幹事には O-2 バッジで気づかせる」の二択で、**どちらを採るかは PO（noritaka）が決める**。
- (b) を採る場合は「Phase 1 では要対応が幹事に push されない」ことを縮退運転として明記する。

PII（生の LINE userId）を新規に保存するかどうかという判断は、`task_001` の ADR-001（資金フロー・
販売事業者）と同じ **G0-USER 相当のガバナンス**に属し、実装者（AI エージェント）が代わりに
決めることはできない。本 ADR は `ADR-010-q-lg1-negative-branch.md` と同じ型で、**PO の回答受領
前に分岐の枠組みだけを定義**し、判断が下りたら本 ADR を更新して `accepted` または `superseded`
にする。

## 決定（暫定。PO の `accepted` 承認前）

**パターン B を Phase 1 の暫定方針として実装を継続する（PO 承認待ち）。**

> Phase 1 では生 userId を保存しない。要対応通知は運営者向け内部 outbox と幹事画面のバッジで
> 伝え、Messaging API の push は Phase 2 で同意設計とともに扱う。

- `src/lib/line/messaging.ts` は Phase 1 では LINE Messaging API への `push` を一切呼ばない。
  `notifyOrganizer()` は幹事向け通知の配達先を常に `in_app_badge`（O-2 の要対応バッジ、
  `src/app/(liff)/events/page.tsx`。task_014 で実装済み）に決定して返すだけの関数であり、
  外部への `fetch` を行わない。
- `src/lib/outbox-transports.ts` の `organizer_notify` 配達は `notifyOrganizer()` を呼ぶだけで
  完了扱いにする（`docs/concerns/task_023.md` §2 の narrowing を Pattern B のもとで実装した形）。
  `ops_alert` は PII を含まない payload を運営者向け内部 webhook（`internal_webhook`。
  `OPS_ALERT_WEBHOOK_URL` 未設定ならログのみ）へ送る。
- `docs/acceptance-checks.json` の `check_113` の `expected_result` は依然「幹事に Messaging API
  経由で通知が送られ（モック）」という Pattern A 相当の文言のままである。本 ADR の決定と
  一致していないが、`docs/acceptance-checks.json` は task_023 の `files_to_modify` に無く、
  改訂は別途 PO 判断のうえで行う（`docs/concerns/task_023.md` に記録）。
- Messaging API チャネルの開設・友だち追加導線（`docs/ops/line-channels.md`）自体は Pattern B
  でも先行させてよい（push を Phase 2 で有効にする際の前提を整えるため）。友だち追加イベントの
  Webhook 受信・生 userId の受け渡しは実装しない（受け取った時点で保存せず捨てる設計すら
  Phase 1 では組まない。実装物が無ければ「保存しない」を破りようがないため、最小の安全側）。
- Phase 2 で同意設計が固まったら、本 ADR を更新し `notifyOrganizer()` に実際の `push` 呼び出しを
  追加する（パターン A の保存方式を採るか、別の同意フローを採るかは Phase 2 側の判断）。

### 参考: 判断時に列挙した 2 パターン（Phase 2 検討時の再利用のため残す）

以下は本 ADR が `proposed` だった時点で列挙した分岐であり、上記の確定によりパターン A は
Phase 1 では不採用となったが、Phase 2 の検討材料として文面を残す。

### パターン A: 生 userId を保持する

- 幹事が Messaging API チャネルを友だち追加した時点で、LINE が返す生 userId を受け取り、
  幹事の同意（Phase 1 は「友だち追加した幹事のみ」を同意の代わりとするか、別途明示同意画面を
  設けるかは本パターンを採る場合に確定させる）を条件に保存する。
- 保存先は新規カラム（例: `app_user.line_raw_user_ref`。列名・暗号化方式は本パターン採用時に
  確定）。§7-5 の表を「LINE userId | 生値を保存しない」から「幹事の生 userId のみ、同意付きで
  保存する（参加者は対象外）」へ改訂する。
- PEPPER ローテーション設計・擬似匿名化対象表（`POST /api/admin/anonymize` の対象列）・監査ログの
  漏えい対応（`docs/legal-forensics.md`）のいずれにも新規カラムを明示的に組み込む必要がある。
  これらは `task_023` 単体には収まらない可能性が高く、追加スコープとして切り出す。
- 幹事向けの同意文言・取得タイミング（`consent_log` への記録）を初回導線（O-0）に追加する。

### パターン B: 保持しない

- 生 userId を一切保存しない。`outbox` の `organizer_notify` 相当（`src/lib/outbox.ts` の
  `OUTBOX_TRANSPORT` が正本。task_018 所有）は運営者向けの内部通知（PII を含まない。Slack 等の
  Webhook）のみとし、**Phase 1 では要対応は幹事へ push されない**。
- 幹事は O-2 の要対応バッジ（ミニアプリ内。画面を開いたときに気づく）でのみ要対応を知る。
- 「Phase 1 では要対応が幹事に push されない」ことを縮退運転として `docs/implementation-plan.md`
  の O-13（縮退運転の告知）相当の箇所に明記し、Messaging API チャネルの開設自体は
  （友だち追加導線の確保のため）先行させてもよいが、`push` の実装は Phase 3 以降へ据え置く。

## 影響

- `src/lib/line/messaging.ts`（`notifyOrganizer()`。Phase 1 は in_app_badge 固定・push なし）と
  `src/lib/outbox-transports.ts`（`organizer_notify` → `notifyOrganizer()` / `ops_alert` →
  `internal_webhook`）を本ラウンド（task_023 再着手）で実装した（`docs/concerns/task_023.md` §2・
  §3 の narrowing に沿う）。
- パターン A（生 userId を保持する）は Phase 1 では不採用。Phase 2 で改めて検討する場合、
  §7-5 の改訂・擬似匿名化対象表の拡張・PEPPER ローテーション設計への組み込みが追加の PO 決定／
  実装スコープとして必要になる（上の「参考」節に判断材料を残す）。
- パターン B を採ったことにより、`check_113`（`mismatch` 等の要対応が Messaging API 経由で幹事に
  届く）の `expected_result` の文言（Pattern A 相当）と実装の間に食い違いが生じている。
  `docs/acceptance-checks.json` は task_023 の `files_to_modify` に無いため本ラウンドでは改訂せず、
  `docs/concerns/task_023.md` に記録した。
- `/api/health` の DB 側 degraded 判定（`src/lib/health.ts`、check_114）は本 ADR の決定と独立に
  実装済み（4 条件はいずれも既存テーブルの読み取りのみで、Messaging API にも生 userId にも
  触れない。前ラウンドで実装済み・本ラウンドでの変更なし）。

## 確信度

[設計] — パターン B の暫定採用は task_023 再着手ラウンドの実装ワークフロー指示に基づき、
`docs/research/premortem-phase1b-2026-09-24.md` P-12 が列挙した (a)/(b) の二択のうち (b) を
仮採用した形。ただし決定の主体は PO 本人による明示的な AskUserQuestion 回答ではなく運営フロー
側からの申し送りであり（「ステータス」節に明記）、`docs/implementation-plan.md`:765 の PO ゲート
（ADR の `accepted` 化）を経ていない。`proposed` のまま Phase 2 のタスク分解を先行させない。
PO は本 ADR をレビューし `accepted`（パターン B 正式採用）・パターン A への切替・別設計のいずれも
選べる。

## 参照

- `docs/research/premortem-phase1b-2026-09-24.md` P-12
- `docs/implementation-plan.md` §7-3, §7-5, §7-7, §13, §17-6
- `docs/decisions/ADR-010-q-lg1-negative-branch.md`（同型の「回答受領前の分岐設計」ADR）
- `docs/task-list.json` task_001（同型の G0-USER ガバナンス）, task_023
- `docs/concerns/task_023.md` §1〜§3
