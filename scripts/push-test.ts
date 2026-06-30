// Fire a one-off Web Push to every subscribed device — the manual counterpart to the automatic
// blocked/done notifications, so you can verify push end-to-end WITHOUT waiting for an agent to
// actually block. Reuses the bridge's own Push class + config, so it exercises the real send path
// (VAPID signing → FCM → device, plus dead-endpoint pruning).
//
// Needs the same env the bridge runs with (COLLIE_VAPID_*). Run it via
//   bash scripts/collie-ctl.sh push-test ["title"] ["body"] ["paneId"]
// which sources the plugin .env first. (Direct `bun run scripts/push-test.ts` works too if those
// vars are already exported.)
import { join } from "node:path";
import { loadConfig } from "../bridge/config.ts";
import { Push } from "../bridge/push.ts";

const [title = "Collie test 🐕", body = "Push works — tap to open Collie", paneId = "test"] =
  process.argv.slice(2);

const cfg = loadConfig();

const push = new Push(cfg);
await push.init();
if (!push.enabled) {
  console.error(
    "✗ push is disabled — COLLIE_VAPID_PUBLIC/PRIVATE aren't set (or web-push isn't installed).\n" +
      "  Run via `bash scripts/collie-ctl.sh push-test` so the plugin .env is sourced first.",
  );
  process.exit(1);
}

// Count subscribers up front so an empty list reads as a clear "subscribe on your phone first"
// rather than a silent no-op success.
const subsFile = join(cfg.stateDir, "push-subscriptions.json");
let count = 0;
try {
  count = ((await Bun.file(subsFile).json()) as unknown[]).length;
} catch {
  /* no saved subscriptions yet */
}
if (count === 0) {
  console.error(
    `✗ no subscribed devices in ${subsFile}\n` +
      "  Open the Collie PWA on your phone and enable notifications (Settings → push), then retry.",
  );
  process.exit(1);
}

await push.notify(title, body, { paneId });
console.log(
  `✓ sent "${title}" to ${count} device(s). Check your phone` +
    " (and `journalctl --user -u collie` for any per-endpoint send errors).",
);
