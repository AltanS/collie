import { join } from "node:path";

import { loadConfig } from "../bridge/config.ts";
import { Push } from "../bridge/push.ts";
import type { CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import type { Files } from "./sys.ts";

// `push-test` — fire a one-off Web Push to every subscribed device, the manual counterpart to the
// automatic blocked/done notifications, so push can be verified end to end WITHOUT waiting for an
// agent to actually block. It reuses the bridge's own `Push` class and config, so it exercises the
// real send path (VAPID signing → FCM → device, plus dead-endpoint pruning).
//
// It was a `bun run scripts/push-test.ts` behind the shell, whose only job was to source `.env`
// first. In the binary the merged `.env` is already resolved (cli/context.ts), so this is simply a
// verb — and `scripts/push-test.ts` now calls into here rather than being a second implementation.

export interface PushDeps {
  ctx: CliContext;
  io: Io;
  files: Files;
}

const DEFAULTS = ["Collie test 🐕", "Push works — tap to open Collie", "test"] as const;

export async function cmdPushTest(deps: PushDeps, args: readonly string[]): Promise<number> {
  const [title = DEFAULTS[0], body = DEFAULTS[1], paneId = DEFAULTS[2]] = args;

  // `loadConfig()` reads `process.env`; the CLI's context is the `.env`-merged environment, and this
  // is where a mode-600 `COLLIE_VAPID_PRIVATE` reaches the signer. Same handoff `_exec-bridge` does.
  for (const [k, v] of Object.entries(deps.ctx.env)) if (v !== undefined) process.env[k] = v;
  const cfg = loadConfig();

  const push = new Push(cfg);
  await push.init();
  if (!push.enabled) {
    deps.io.err(
      "✗ push is disabled — COLLIE_VAPID_PUBLIC/PRIVATE aren't set (or web-push isn't installed).",
    );
    deps.io.err(`  Set them in ${join(deps.ctx.configDir, ".env")} and retry.`);
    return EXIT.FAIL;
  }

  // Count subscribers up front so an empty list reads as a clear "subscribe on your phone first"
  // rather than a silent no-op success.
  const subsFile = join(cfg.stateDir, "push-subscriptions.json");
  const count = countSubscriptions(deps.files.read(subsFile));
  if (count === 0) {
    deps.io.err(`✗ no subscribed devices in ${subsFile}`);
    deps.io.err(
      "  Open the Collie PWA on your phone and enable notifications (Settings → push), then retry.",
    );
    return EXIT.FAIL;
  }

  await push.notify(title, body, { paneId });
  deps.io.out(
    `✓ sent "${title}" to ${count} device(s). Check your phone` +
      " (and `collie logs` for any per-endpoint send errors).",
  );
  return EXIT.OK;
}

/** How many devices the saved subscription file names. Absent or unparseable reads as none. */
export function countSubscriptions(raw: string | null): number {
  if (raw === null) return 0;
  try {
    const data: unknown = JSON.parse(raw);
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}
