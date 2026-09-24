// @vitest-environment jsdom

/**
 * `src/components/ShareSheet.tsx`（O-7 配布 / 制約 N8 / task_016）。
 *
 * done_definition の本体:
 *   - `isApiAvailable=false` のときはコピー導線のみ表示する（`shareTargetPicker` の
 *     ボタン・セクションが出ない）。主導線（催促文＋URL コピー・個別リンク一覧・
 *     疑われた際の説明テンプレ）は `isApiAvailable` の値に関わらず必ず出る。
 *
 * 併せて picker のキャンセルと不可の 2 経路（implementation_steps）、
 * リンク未発行時はコピー系導線を出さないこと（C-015-2 の帰結）も検査する。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ShareSheet, type ShareSheetProps } from "@/components/ShareSheet";

afterEach(() => {
  cleanup();
});

const baseProps: ShareSheetProps = {
  organizerLabel: "山田太郎",
  eventTitle: "秋の飲み会",
  collectByAt: "2026-10-10T00:00:00.000Z",
  defaultAmountMinor: 3000,
  joinLink: "https://liff.line.me/1234567890-abcd1234/e?t=tok_abc",
  onCreateLink: () => {},
  creatingLink: false,
  participants: [
    { id: "p1", displayLabel: "鈴木", amountMinor: null, unpaid: true },
    { id: "p2", displayLabel: "佐藤", amountMinor: 3000, unpaid: false },
  ],
  isApiAvailable: false,
  onShareViaPicker: vi.fn(async () => "sent" as const),
};

describe("isApiAvailable=false のときはコピー導線のみ表示する（N8）", () => {
  it("shareTargetPicker のボタン・セクションが無い", () => {
    render(<ShareSheet {...baseProps} isApiAvailable={false} />);

    expect(screen.queryByRole("button", { name: "LINE の友だちに送る" })).not.toBeInTheDocument();
    expect(screen.queryByText("LINE で直接送る（補助）")).not.toBeInTheDocument();
  });

  it("催促文コピー・個別リンク一覧・説明テンプレ・QR の導線はすべて出る", async () => {
    render(<ShareSheet {...baseProps} isApiAvailable={false} />);

    expect(screen.getByRole("button", { name: "催促文をコピー" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "説明文をコピー" })).toBeInTheDocument();
    // QR は `buildJoinLinkQrSvg` の解決を待って描画される（非同期）。
    expect(await screen.findByRole("img", { name: "配布用リンクの QR コード" })).toBeInTheDocument();
    // 既定フィルタは未払いのみ（R-UX-03 と同じ既定）。
    expect(screen.getByText("鈴木")).toBeInTheDocument();
    expect(screen.queryByText("佐藤")).not.toBeInTheDocument();
  });
});

describe("isApiAvailable=true のときは picker が補助導線として追加される", () => {
  it("「LINE の友だちに送る」ボタンが出て、押すと onShareViaPicker を呼ぶ", async () => {
    const onShareViaPicker = vi.fn(async () => "sent" as const);
    render(<ShareSheet {...baseProps} isApiAvailable={true} onShareViaPicker={onShareViaPicker} />);

    // 主導線（コピー系）は picker の有無に関わらず出続ける。
    expect(screen.getByRole("button", { name: "催促文をコピー" })).toBeInTheDocument();

    const button = screen.getByRole("button", { name: "LINE の友だちに送る" });
    fireEvent.click(button);
    expect(onShareViaPicker).toHaveBeenCalledTimes(1);
    await screen.findByText("送信しました。");
  });

  it("キャンセルされたときの結果を表示する（picker のキャンセル経路）", async () => {
    const onShareViaPicker = vi.fn(async () => "canceled" as const);
    render(<ShareSheet {...baseProps} isApiAvailable={true} onShareViaPicker={onShareViaPicker} />);

    fireEvent.click(screen.getByRole("button", { name: "LINE の友だちに送る" }));
    await screen.findByText("送信をやめました。");
  });

  it("unavailable の結果はコピー導線を案内する（picker の不可経路）", async () => {
    const onShareViaPicker = vi.fn(async () => "unavailable" as const);
    render(<ShareSheet {...baseProps} isApiAvailable={true} onShareViaPicker={onShareViaPicker} />);

    fireEvent.click(screen.getByRole("button", { name: "LINE の友だちに送る" }));
    await screen.findByText(/この環境では使えませんでした/);
  });
});

describe("配布用リンクが無いとき（C-015-2: 生トークンは再取得できない）", () => {
  it("「リンクを作る」導線だけが出て、コピー系導線は出ない", () => {
    render(<ShareSheet {...baseProps} joinLink={null} isApiAvailable={false} />);

    expect(screen.getByRole("button", { name: "リンクを作る" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "催促文をコピー" })).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "配布用リンクの QR コード" })).not.toBeInTheDocument();
  });

  it("押すと onCreateLink を呼ぶ", () => {
    const onCreateLink = vi.fn();
    render(<ShareSheet {...baseProps} joinLink={null} onCreateLink={onCreateLink} isApiAvailable={false} />);

    fireEvent.click(screen.getByRole("button", { name: "リンクを作る" }));
    expect(onCreateLink).toHaveBeenCalledTimes(1);
  });
});

describe("未払い者だけを再共有する（既定フィルタ）", () => {
  it("「全員」を選ぶと支払済みの参加者も一覧に出る", () => {
    render(<ShareSheet {...baseProps} isApiAvailable={false} />);

    expect(screen.queryByText("佐藤")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("全員"));
    expect(screen.getByText("佐藤")).toBeInTheDocument();
  });
});

describe("参加者の続きがある場合（レビュー是正 C-016-6: 100 名超のカーソルページング）", () => {
  it("hasMoreParticipants=false（既定）では「さらに読み込む」ボタンが出ない", () => {
    render(<ShareSheet {...baseProps} isApiAvailable={false} />);

    expect(screen.queryByRole("button", { name: "さらに読み込む" })).not.toBeInTheDocument();
  });

  it("hasMoreParticipants=true では「さらに読み込む」ボタンが出て、押すと onLoadMoreParticipants を呼ぶ", () => {
    const onLoadMoreParticipants = vi.fn();
    render(
      <ShareSheet
        {...baseProps}
        isApiAvailable={false}
        hasMoreParticipants={true}
        onLoadMoreParticipants={onLoadMoreParticipants}
      />,
    );

    const button = screen.getByRole("button", { name: "さらに読み込む" });
    fireEvent.click(button);
    expect(onLoadMoreParticipants).toHaveBeenCalledTimes(1);
  });

  it("loadingMoreParticipants=true の間はボタンが無効になる", () => {
    render(
      <ShareSheet
        {...baseProps}
        isApiAvailable={false}
        hasMoreParticipants={true}
        loadingMoreParticipants={true}
        onLoadMoreParticipants={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "読み込み中…" })).toBeDisabled();
  });
});
