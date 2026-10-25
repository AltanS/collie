import { describe, expect, test } from "bun:test";

import { realFiles } from "./sys.ts";
import { capabilityTemplate, CANCEL_METHODS, MOSHI_ENTRY_COMMAND, moshiArgvOf, moshiNow, spawnProvider } from "./codex-moshi.ts";

// THE REAL MOSHI, GATED. It never runs in CI and never runs by default: it starts the installed Moshi
// `codex-hook` with a made-up permission request, which Moshi may post to a phone, so it needs the
// operator's say-so and somebody holding the phone.
//
//   COLLIE_MOSHI_CANCEL_INTEGRATION=1 [COLLIE_MOSHI_CANCEL_METHOD=sigterm|sigint] bun test cli/codex-moshi.integration.test.ts
//
// What this test proves is only the PROCESS half: the request reaches the real provider and the
// provider ends when asked, inside the grace, without being killed. It cannot see the phone, so it does
// NOT assert that the remote request was withdrawn. It prints a proof record for the installed Moshi
// with `remoteWithdrawn: false`; whoever watched the phone sets it to true and saves it as
// `<config dir>/codex-moshi-capability.json` (cli/codex-moshi.ts). Until then `--with-moshi` is refused.

const ENABLED = process.env.COLLIE_MOSHI_CANCEL_INTEGRATION === "1";
const method = CANCEL_METHODS.find((word) => word === process.env.COLLIE_MOSHI_CANCEL_METHOD) ?? "sigterm";
const GRACE_MS = 3000;

describe.skipIf(!ENABLED)("the installed Moshi, cancelled", () => {
  test("ends when it is asked to, within the grace, and is not killed", async () => {
    const argv = moshiArgvOf(MOSHI_ENTRY_COMMAND);
    const now = moshiNow(realFiles, MOSHI_ENTRY_COMMAND);
    expect(argv).not.toBeNull();
    expect(now).not.toBeNull();
    const payload = JSON.stringify({
      session_id: "collie-cancel-probe",
      turn_id: "probe",
      transcript_path: null,
      cwd: process.cwd(),
      hook_event_name: "PermissionRequest",
      model: "probe",
      permission_mode: "default",
      tool_name: "Bash",
      tool_input: { command: "echo collie-cancel-probe" },
    });
    const run = spawnProvider(argv!, payload, { method, graceMs: GRACE_MS });
    // Time for Moshi to post its request to the phone.
    await Bun.sleep(4000);
    const outcome = await run.cancel(GRACE_MS);
    console.log(`cancel outcome: ${outcome}. Did the request leave the phone? Record what you saw in the proof below.`);
    console.log(capabilityTemplate(MOSHI_ENTRY_COMMAND, now!, { method, graceMs: GRACE_MS }));
    expect(outcome).toBe("exited");
  }, 30_000);
});
