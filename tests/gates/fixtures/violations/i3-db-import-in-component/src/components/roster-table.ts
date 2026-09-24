// 違反フィクスチャ（I3）。コンポーネント層が DB クライアントの語彙を直接取り込んでいる。
import { sql } from "drizzle-orm";

export const rosterQuery = sql`select 1`;
