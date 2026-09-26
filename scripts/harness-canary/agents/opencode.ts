// OpenCode in the canary, with its default model. Collie reads it with its adapter
// (web/src/lib/harness/opencode/), the way it reads claude and codex: the composer must be ready,
// a typed draft must read back, and a send goes through type-then-verify. The dialogs scenario
// starts its own OpenCode with a scratch config that asks for permission (dialogs.ts).

import { backspaceSweep, launchLine, type AgentProfile } from "./profile";

export const opencode: AgentProfile = {
  agent: "opencode",
  versionCommand: ["opencode", "--version"],
  launch: (cols) => launchLine(cols, `opencode`),
  startupAnswer: () => null,
  clearKeys: backspaceSweep,
  clearFallback: null,
  exitCommand: "/exit",
};
