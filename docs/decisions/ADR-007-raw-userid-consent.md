# ADR-007: 幹事の生 LINE userId 保持の同意設計

## ステータス

`proposed`

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

## 決定（PO 回答受領前の分岐設計。proposed）

Messaging API 経由で幹事へ `push` するかどうかは、以下 2 パターンのいずれかになりうる。
各パターンでの対応方針を、回答受領前の時点で次のとおり定める。

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

- `src/lib/line/messaging.ts`（幹事の生 userId を Messaging API 用に受け取る想定のモジュール）と
  `src/lib/outbox-transports.ts`（`organizer_notify` → 具体的な配達手段の実装）は、本 ADR が
  `accepted` になり、かつ `src/lib/outbox.ts`（task_018 所有）が確定コミットされるまで実装しない
  （`docs/concerns/task_023.md` §2・§3）。
- パターン A を採る場合、§7-5 の改訂・擬似匿名化対象表の拡張・PEPPER ローテーション設計への
  組み込みが追加の PO 決定／実装スコープとして発生する。
- パターン B を採る場合、`check_113`（`mismatch` 等の要対応が Messaging API 経由で幹事に届く）の
  `expected_result` 自体を「Phase 1 は運営者向け内部通知のみ、幹事への push は Phase 3」に
  改訂する必要があり、`docs/acceptance-checks.json` の更新は PO 判断のうえ別途行う。
- いずれのパターンでも、`/api/health` の DB 側 degraded 判定（`src/lib/health.ts`、check_114）は
  本 ADR の決定を待たずに独立して実装できる（4 条件はいずれも既存テーブルの読み取りのみで、
  Messaging API にも生 userId にも触れない）。task_023 の今回の作業はこの独立部分のみを実装した。

## 確信度

[設計] — `docs/research/premortem-phase1b-2026-09-24.md` P-12 の対応案（「ADR-007 を task_023 より
前に書き、(a) 生 userId を保持する、(b) 保持せず…のどちらを採るかを PO が決める」）に基づき、
回答到着前の時点で分岐の枠組みを起票する。`docs/implementation-plan.md` §13 付近の ADR 一覧が
`ADR-007 生 userId 同意` を `proposed` 止まりの作成対象として挙げている（`[設計]/[不明]` 依存は
`proposed` 止まり）。いずれのパターンも採用を確定するものではない。

## 参照

- `docs/research/premortem-phase1b-2026-09-24.md` P-12
- `docs/implementation-plan.md` §7-3, §7-5, §7-7, §13, §17-6
- `docs/decisions/ADR-010-q-lg1-negative-branch.md`（同型の「回答受領前の分岐設計」ADR）
- `docs/task-list.json` task_001（同型の G0-USER ガバナンス）, task_023
- `docs/concerns/task_023.md` §1〜§3
