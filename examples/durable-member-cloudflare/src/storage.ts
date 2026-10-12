// ─── THE ONE PLACE PI DURABLE MEETS THE DURABLE OBJECT'S STORAGE ─────────────────────────────────────────────
// Pi Durable 1.1.0 keeps its conversations, entries and tasks in the Durable Object's SQLite through
// `openDurableObjectSqliteStorage(ctx.storage)`. Its tables are named `durable_*`, `conversations`, `entries` and
// so on; this example's own tables start with `collie_`, so the two never meet.
// `DM_STORAGE=memory` keeps Pi's state in memory instead (`npm run test:memory`): nothing survives a restart then,
// except what the example writes to its own `collie_` tables.
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { Env } from "./env.ts";

export async function openPiStorage(ctx: DurableObjectState, env: Env): Promise<Storage> {
  if (env.DM_STORAGE === "memory") return new MemoryStorage();
  return openDurableObjectSqliteStorage(ctx.storage);
}
