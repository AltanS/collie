// Kiro CLI in the canary, forced onto its V3 engine (`chat --v3`), the one whose journal Collie reads,
// so a run does not depend on the host's own engine setting. Collie
// reads it with its adapter (web/src/lib/harness/kiro/) and its sessions under ~/.kiro/sessions.
// Asked for by name only (args.ts § DEFAULT_AGENTS): a send spends the Kiro account's own credits.

import { backspaceSweep, launchLine, type AgentProfile } from "./profile";

export const kiro: AgentProfile = {
  agent: "kiro",
  versionCommand: ["kiro-cli", "--version"],
  launch: (cols, bin = "kiro-cli") => launchLine(cols, `${bin} chat --v3`),
  // No startup screen is recorded for 2.32.0. One that a fresh project paints shows as `idle`
  // failing, and its answer then goes here.
  startupAnswer: () => null,
  // One Backspace per character clears a draft across its lines, and one removes a paste chip.
  clearKeys: backspaceSweep,
  clearFallback: null,
  exitCommand: "/quit",
};
