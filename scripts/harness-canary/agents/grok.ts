// Grok Build in the canary, with the model and settings it starts with. Collie reads it with its
// adapter (web/src/lib/harness/grok/). Asked for by name only (args.ts § DEFAULT_AGENTS): a send
// spends the operator's own xAI quota.

import { backspaceSweep, launchLine, type AgentProfile } from "./profile";

export const grok: AgentProfile = {
  agent: "grok",
  versionCommand: ["grok", "--version"],
  launch: (cols, bin = "grok") => launchLine(cols, bin),
  startupAnswer: () => null,
  clearKeys: backspaceSweep,
  clearFallback: null,
  exitCommand: "/exit",
};
