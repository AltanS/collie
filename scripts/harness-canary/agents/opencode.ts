// OpenCode in the canary, with its default model. Collie has no adapter for it: the phone shows the
// raw mirror and sends in one step (text + submit), and that is what the canary checks.

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
