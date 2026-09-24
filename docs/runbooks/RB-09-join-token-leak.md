# RB-09: 招待トークン（`joinToken`）の漏洩対応

## トリガー

- 招待リンク（`joinToken` を含む URL）が意図しない第三者に共有された・SNS 等で公開された
  疑いがある幹事からの報告。
- §17-5「招待トークン漏洩 → ローテーション」に該当する事象を検知した。

## 手順

1. 幹事が `POST /api/events/:id/rotate-join-token`（既存エンドポイント。task_014/015 の所有）
   を実行し、旧トークンを失効させ新トークンを発行する。
2. 旧トークンでの新規アクセスは、`join_token_hash` が更新されるため以後失敗する
   （`src/lib/join-token.ts` の `resolveEventByJoinToken`）。
3. 既に旧トークンで claim 済みの参加者には影響しない（`joinToken` はイベント単位の候補一覧
   表示までの権限であり、claim 済みの参加者は個別の `claim_token` または `participant_claim`
   で識別されるため）。
4. 幹事に対し、新しい招待リンクを再配布するよう案内する（O-7 の配布導線）。

## 人間承認が必要な操作

- ローテーションの実行そのものは幹事の操作であり、管理者の承認は不要。
- 漏洩の疑いが悪意ある攻撃（総当たり等）によるものと判断される場合、`RB-04-provider-suspension.md`
  の要否（幹事側の問題ではなく攻撃者側の問題であるため通常は不要）を検討する。

## 記録先

- `event.join_token_version` のインクリメントと `join_token_expires_at` の更新（既存の
  `rotate-join-token` の実装）。
- ローテーションの実施は幹事の操作ログとして `audit_log` に記録される（既存実装の担当範囲）。
