import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "cashapp",
  description: "幹事の精算・集金の台帳（LINE ミニアプリ）",
};

// task_003 の非スコープは UI。実際のデザイン・ルートグループ（(liff) / (web)）の
// 分離・タイポグラフィは task_012/013 以降で入る。ここでは App Router が
// 成立するための最小限のルートレイアウトのみを置く。
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
