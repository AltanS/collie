// OpenCode in the canary, with its default model. Collie reads it with its adapter
// (web/src/lib/harness/opencode/), the way it reads claude and codex: the composer must be ready,
// a typed draft must read back, and a send goes through type-then-verify. The dialogs scenario
// starts its own OpenCode with a scratch config that asks for permission (dialogs.ts).

import { backspaceSweep, launchLine, type AgentProfile } from "./profile";

/**
 * Keeps OpenCode's "Update Available" dialog away (1.18.34 offered 1.19.0 on 2026-10-12): it takes
 * the place of the composer the canary waits for, and its Confirm would change the user's install.
 * The same reason as Codex's `check_for_update_on_startup=false`.
 */
export const OPENCODE_ENV = "OPENCODE_DISABLE_AUTOUPDATE=1";

export const opencode: AgentProfile = {
  agent: "opencode",
  versionCommand: ["opencode", "--version"],
  launch: (cols, bin = "opencode") => launchLine(cols, `${OPENCODE_ENV} ${bin}`),
  startupAnswer: () => null,
  clearKeys: backspaceSweep,
  clearFallback: null,
  exitCommand: "/exit",
};
