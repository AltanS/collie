// Claude Code in the canary. Haiku is chosen by flag (`--model haiku`), which is cheaper than the
// default and leaves the operator's settings alone. Traps measured 2026-09-26: two Ctrl+C within
// about a second exit Claude, so the draft is cleared with Backspaces and Ctrl+C is only the
// fallback, sent once.

import { backspaceSweep, launchLine, pointedRow, type AgentProfile } from "./profile";

const TRUST_YES = "Yes, I trust this folder";

export const claude: AgentProfile = {
  agent: "claude",
  versionCommand: ["claude", "--version"],
  launch: (cols) => launchLine(cols, `claude --model haiku`),
  startupAnswer(texts) {
    // The folder trust question. Since 2.1.283 the pointer starts on "No, exit", so walk it to the
    // yes row first, and press Enter only once a later read shows the pointer there.
    if (!texts.some((t) => t.includes(TRUST_YES))) return null;
    const pointed = pointedRow(texts, "❯");
    if (pointed === null) return null;
    return pointed.includes(TRUST_YES) ? ["Enter"] : ["Down"];
  },
  clearKeys: backspaceSweep,
  clearFallback: ["ctrl+c"],
  exitCommand: "/exit",
};
