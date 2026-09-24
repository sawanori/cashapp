# RB-03: 鍵ローテーション（PEPPER・セッション鍵・ADMIN_ALLOWLIST）

## トリガー

- 定期ローテーション（運用ポリシーで別途定める周期）。
- `PEPPER` / `SESSION_KEYS` / `CRON_SECRETS` の漏洩が疑われる（§17-5 のキルスイッチ条件 ④）。
- 管理者（GitHub アカウント）の退任・資格情報の漏洩。

## 手順（PEPPER / SESSION_KEYS）

1. 新しいバージョンの値を生成する（32 バイト以上。`src/lib/config/env.ts` の
   `MIN_SECRET_BYTES`）。
2. `SESSION_KEYS` は**現行＋直前の 2 世代まで**しか検証されない
   （`src/lib/config/env.ts` の `MAX_SESSION_KEYS`）。新しい鍵を先頭に追加し、直前の鍵を
   1 世代分だけ残す（3 世代目は自動的に検証対象から外れる）。
3. `PEPPER` は `pepper_version` 付きで管理する（`src/lib/config/env.ts` の
   `PepperVersion`）。新バージョンを追加してから、旧バージョンで計算された
   `line_user_ref` の突合手順は `docs/legal-forensics.md` §3 を参照する。
4. `wrangler secret put --env <env>` で投入する（CI の `environment` から。§7-7）。
   ローカルの `.dev.vars` には本番鍵を置かない。
5. 反映後、`GET /api/health` の `pepperFingerprint` が更新されたことを確認する。

## 手順（`ADMIN_ALLOWLIST`）

1. 退任する管理者の GitHub login を許可リストから外す。
2. 追加する管理者の GitHub login を許可リストに加える。
3. `src/lib/admin-auth.ts` の `verifyAdmin` は毎リクエスト GitHub API で実在確認するため、
   許可リストの変更は次のリクエストから即座に反映される（セッションのキャッシュを持たない）。

## 人間承認が必要な操作

- 鍵の生成・投入・許可リストの変更そのもの（`wrangler secret put` は禁止コマンドに準ずる
  運用のため、本番投入は PO が行う。§7-7「本番鍵は CI の `environment: production` からのみ」）。

## 記録先

- ローテーションの実施記録は `docs/HANDOFF.md` に追記する（実値は書かない。バージョン番号・
  実施日のみ）。
- `ADMIN_ALLOWLIST` の変更履歴はリポジトリの環境変数管理（Cloudflare の Secrets）側に残る。
  アプリ内には記録しない（許可リストの値自体を `audit_log` に書くと生の GitHub login が
  監査ログに残ってしまうため、あえて記録しない設計）。
