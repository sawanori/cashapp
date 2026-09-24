# サポートブラウザ（雛形）

**ステータス: 雛形。下限の確定は T-P1-23（R-LINE-03）で実施する。本書だけを根拠にリリース判定しない。**

## 前提

主要導線（`(liff)` ルート）は LINE ミニアプリ内、すなわち LINE アプリが内部で開く
アプリ内ブラウザ上で動く。管理画面・法務ページ（`(web)` ルート）は通常の外部ブラウザ。

| レイヤー | 実体 | 備考 |
|---|---|---|
| Android・LINE アプリ内 | Android System WebView（Chrome ベース） | 端末の WebView 更新状況に依存。LINE アプリ自体の最小 Android バージョンは [不明] |
| iOS・LINE アプリ内 | WKWebView（Safari と同エンジン、Safari 自体ではない） | iOS バージョンに追随。LINE アプリの iOS 最小要件は [不明] |
| 管理画面・法務ページ | 通常のデスクトップ/モバイルブラウザ | Chrome / Safari / Edge の直近2バージョンを目安 |

## 現状の `.browserslistrc`

`.browserslistrc` に置いた下限（Android 10 / iOS 14 目安、Chrome・Safari 直近2バージョン）は
**暫定値**。LINE の公式ドキュメントから「LINE アプリが要求する OS 最小バージョン」の一次資料を
取得していないため、これを確定値として扱わない。

## いま実装が強制している下限（task_013 で明記）

**下限値そのものは依然として暫定である**（確定は T-P1-23）。ただし「暫定値をコードのどこが
どう使っているか」は task_013 で確定した。運用上の下限は次の 2 つの重ね合わせである。

| 層 | 下限の実体 | 置き場 |
|---|---|---|
| ビルドターゲット | `.browserslistrc` の `[production]`（Chrome / ChromeAndroid / iOS / Safari の直近 2 バージョン、Android >= 10、iOS >= 14） | `.browserslistrc` |
| 実行時の判定 | CSS の `@supports (display: grid) and (gap: 1rem) and (color: var(--color-text))` を **満たさない** ブラウザを「下限未満」とみなす | `src/styles/tokens.css` の `.legacy-browser-notice` |

実行時の判定に使う機能を上記 3 つにした理由:

- `display: grid` … Chrome 57 / Safari 10.1 以降。
- `gap`（プロパティとしての解釈） … Chrome 66 / Safari 12 以降。
- CSS カスタムプロパティ（`var()`） … Chrome 49 / Safari 9.1 以降。

`.browserslistrc` の暫定下限（Android 10 / iOS 14）はこの 3 つをすべて満たすため、
**下限以上の端末で案内が誤って出ることはない**。逆に、これらを満たさないほど古い WebView は
確実に下限未満であり、案内が出る。`@supports` 自体を解さないブラウザでは「隠す」規則が
適用されないので、やはり案内が残る（fail-safe な側に倒れる）。

**この判定は「下限未満を漏れなく捕まえる」ものではない。** 上の 3 機能を満たしつつ
`.browserslistrc` の下限を割る端末（たとえば Android 10 端末の古い System WebView）は
すり抜ける。厳密化には T-P1-23 で確定した OS / WebView バージョンに対応する機能を選び直す必要がある。

## 静的フォールバックの実装（R-LINE-03）

「白画面を出さない」ための静的 HTML は 3 経路ある。いずれも `src/components/StaticFallback.tsx`
が描き、`src/app/layout.tsx` の `<body>` 最上流か LIFF の起動コードが置く。

| 経路 | 発火条件 | 置き場 |
|---|---|---|
| `legacy` | 上表の `@supports` を満たさない（＝下限未満） | `src/app/layout.tsx` の `.legacy-browser-notice`（CSS のみ。JS 不要） |
| `no_script` | JavaScript が無効（＝ LIFF SDK が初期化できない） | `src/app/layout.tsx` の `<noscript>` |
| `sdk_unavailable` | LIFF SDK を **3 秒**以内に読めない、または `liff.init()` が reject | `src/lib/liff/client.ts` の `bootLiff()` が `sdk_unavailable` / `init_failed` を返し、画面側が同じコンポーネントを出す |

3 秒のタイムアウト値は `src/lib/liff/client.ts` の `SDK_LOAD_TIMEOUT_MS` に置き、
`tests/unit/liff/client.test.ts` が値そのものを検査している。

## 未確認事項（T-P1-23 で解消する）

- [不明] LINE アプリ（iOS/Android）が現在要求している OS 最小バージョン。
- [不明] その OS 最小バージョンに対応する WebView / WKWebView のエンジンバージョンと、
  それが `.browserslistrc` の下限と整合しているか。
- [不明] 上記の `@supports` 判定が、確定後の下限と過不足なく一致するか
  （現状は「下限以上を誤検知しない」ことだけが言える。取りこぼしは残る）。
- [不明] 下限バージョンの実機・エミュレータでの描画確認（自動化しない。人手の手順として
  `docs/runbooks/` に残す。T-P1-23）。

## 運用ルール

- `.browserslistrc` を変更したら本書の対応表と `src/styles/tokens.css` の
  `@supports` 判定を **同時に**更新する（片方だけ動かすと、案内の出る条件と実際の
  ビルドターゲットがずれる）。
- 下限バージョンの実機・エミュレータでの描画確認は自動化しない（人間の手順として `docs/runbooks/` に残す。T-P1-23）。
