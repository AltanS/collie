// ─── THE ONE PLACE PI DURABLE MEETS THE DURABLE OBJECT'S STORAGE ─────────────────────────────────────────────
// PiHarness opens Pi Durable's storage over the Durable Object's SQLite and hands it to the factory in member.ts.
// It moves every Pi table under the prefix `pi_` (`pi_conversations`, `pi_entries`, `pi_tasks` and so on), and
// Lifecycle keeps its job queue in `cf_agents_jobs`. This example's own tables start with `collie_`, so none of
// them meet.
// `DM_STORAGE=memory` keeps Pi's state in memory instead (`npm run test:memory`): nothing survives a restart then,
// except what the example writes to its own `collie_` tables. PiHarness's own reads (its session list) still look
// at the SQLite store; this example does not use them.
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import type { Env } from "./env.ts";

export function openPiStorage(handed: Storage, env: Env): Storage {
  if (env.DM_STORAGE === "memory") return new MemoryStorage();
  return handed;
}
