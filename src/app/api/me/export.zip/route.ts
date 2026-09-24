/**
 * `GET /api/me/export.zip`（§9 / §8-1 O-13 / task_021 scope）。
 *
 * 本人の全イベントの一括エクスポート（幹事として作成したイベントの概要と、参加者として
 * claim した請求）を ZIP 1 本（`export.json` を 1 エントリ）にまとめて返す。
 *
 * ★ 依存ライブラリを増やさない（本タスクの files_to_modify は `package.json` / `gate.yml` の
 *   み。zip ライブラリの追加は範囲外）。ZIP は無圧縮 STORE 方式でこのファイル内に最小実装する
 *   （エントリ 1 個・ディレクトリなし。ZIP のローカルファイルヘッダ／セントラルディレクトリ／
 *   終端レコードだけを書く）。
 *
 * ★ 出す内容は本人が既に読める情報の範囲に留める（`GET /api/me` と同じ所有権規約）。
 *   他の参加者の `display_label` は含めない。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { requireSession } from "@/lib/auth/session";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { AppError, ERROR_CODES, newRequestId, toErrorResponse } from "@/lib/errors";
import { logEvent } from "@/lib/logger";

type RouteEnv = RawEnv & DbEnv;

// ============================================================================
// 最小 ZIP ライタ（STORE・無圧縮・エントリ複数可）
// ============================================================================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    const tableRow = CRC_TABLE[(crc ^ (bytes[i] ?? 0)) & 0xff] ?? 0;
    crc = tableRow ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

function dosDateTime(date: Date): { readonly time: number; readonly dateVal: number } {
  const time =
    ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dateVal =
    (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, dateVal };
}

function writeUint32LE(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}
function writeUint16LE(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value & 0xffff, true);
}

/** 無圧縮 (STORE) の単純な ZIP を組み立てる。 */
function buildZip(entries: readonly ZipEntry[], now: Date = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const { time, dateVal } = dosDateTime(now);
  const chunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    writeUint32LE(localView, 0, 0x04034b50);
    writeUint16LE(localView, 4, 20);
    writeUint16LE(localView, 6, 0);
    writeUint16LE(localView, 8, 0);
    writeUint16LE(localView, 10, time);
    writeUint16LE(localView, 12, dateVal);
    writeUint32LE(localView, 14, crc);
    writeUint32LE(localView, 18, size);
    writeUint32LE(localView, 22, size);
    writeUint16LE(localView, 26, nameBytes.length);
    writeUint16LE(localView, 28, 0);
    local.set(nameBytes, 30);

    chunks.push(local, entry.data);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    writeUint32LE(centralView, 0, 0x02014b50);
    writeUint16LE(centralView, 4, 20);
    writeUint16LE(centralView, 6, 20);
    writeUint16LE(centralView, 8, 0);
    writeUint16LE(centralView, 10, 0);
    writeUint16LE(centralView, 12, time);
    writeUint16LE(centralView, 14, dateVal);
    writeUint32LE(centralView, 16, crc);
    writeUint32LE(centralView, 20, size);
    writeUint32LE(centralView, 24, size);
    writeUint16LE(centralView, 28, nameBytes.length);
    writeUint16LE(centralView, 30, 0);
    writeUint16LE(centralView, 32, 0);
    writeUint16LE(centralView, 34, 0);
    writeUint16LE(centralView, 36, 0);
    writeUint32LE(centralView, 38, 0);
    writeUint32LE(centralView, 42, offset);
    central.set(nameBytes, 46);
    centralChunks.push(central);

    offset += local.length + entry.data.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of centralChunks) centralSize += c.length;

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeUint32LE(endView, 0, 0x06054b50);
  writeUint16LE(endView, 4, 0);
  writeUint16LE(endView, 6, 0);
  writeUint16LE(endView, 8, entries.length);
  writeUint16LE(endView, 10, entries.length);
  writeUint32LE(endView, 12, centralSize);
  writeUint32LE(endView, 16, centralStart);
  writeUint16LE(endView, 20, 0);

  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  for (const chunk of centralChunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  out.set(end, cursor);
  return out;
}

// ============================================================================
// ルート
// ============================================================================

interface OrganizedEventRow {
  readonly id: string;
  readonly title: string;
  readonly organizer_label: string;
  readonly status: string;
  readonly created_at: Date;
}

interface ClaimedInvoiceRow {
  readonly id: string;
  readonly event_id: string;
  readonly amount_minor: number;
  readonly settlement_status: string;
  readonly auto_detected: boolean;
  readonly confirmation_method: string;
  readonly created_at: Date;
}

/**
 * `Date | string` を ISO 文字列にする。`src/app/api/admin/gates/route.ts` の `toIso` と
 * 同じ理由（drizzle-orm の postgres-js ドライバが `db.sql` の timestamp パーサを透過にする）
 * による防御。詳細はそちらの docstring と `docs/concerns/task_021.md` を参照。
 */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;

  let db: Awaited<ReturnType<typeof createVerifiedDbClient>> | undefined;
  try {
    const config = loadAppConfig(routeEnv);
    db = await createVerifiedDbClient(routeEnv);
    const session = await requireSession(config, db.sql, request);

    const organizedEvents = await db.sql<OrganizedEventRow[]>`
      SELECT id, title, organizer_label, status, created_at
      FROM event WHERE organizer_user_id = ${session.userId}
      ORDER BY created_at ASC
    `;

    const claimedInvoices = await db.sql<ClaimedInvoiceRow[]>`
      SELECT i.id, i.event_id, i.amount_minor, i.settlement_status, i.auto_detected,
             i.confirmation_method, i.created_at
      FROM participant_claim pc
      JOIN app_user u ON u.id = ${session.userId}
      JOIN invoice i ON i.participant_id = pc.participant_id
      WHERE pc.released_at IS NULL AND pc.line_user_ref = u.line_user_ref
      ORDER BY i.created_at ASC
    `;

    const exported = {
      exportedAt: new Date().toISOString(),
      organizedEvents: organizedEvents.map((row) => ({
        id: row.id,
        title: row.title,
        organizerLabel: row.organizer_label,
        status: row.status,
        createdAt: toIso(row.created_at),
      })),
      claimedInvoices: claimedInvoices.map((row) => ({
        id: row.id,
        eventId: row.event_id,
        amountMinor: row.amount_minor,
        settlementStatus: row.settlement_status,
        autoDetected: row.auto_detected,
        confirmationMethod: row.confirmation_method,
        createdAt: toIso(row.created_at),
      })),
    };

    const json = new TextEncoder().encode(JSON.stringify(exported, null, 2));
    const zip = buildZip([{ name: "export.json", data: json }]);

    logEvent("info", "me.export_zip", {
      requestId,
      userId: session.userId,
      organizedCount: organizedEvents.length,
      claimedCount: claimedInvoices.length,
    });

    // `Uint8Array`（ArrayBufferLike 版）は `BodyInit` / `BlobPart` の型と噛み合わないため、
    // 素の `ArrayBuffer` に切り出してから渡す（`zip` は常に非共有バッファで作っている）。
    const zipBuffer = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;

    return new Response(zipBuffer, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="cashapp-export.zip"',
        "x-request-id": requestId,
      },
    });
  } catch (error) {
    logEvent("info", "me.export_zip.failed", {
      requestId,
      code: error instanceof AppError ? error.code : ERROR_CODES.INTERNAL,
    });
    return toErrorResponse(error, requestId);
  } finally {
    if (db !== undefined) {
      await db.close().catch(() => undefined);
    }
  }
}
