// Antigravity's terminal agent in the canary, on the Google account's own weekly quota. Collie reads
// it with its adapter (web/src/lib/harness/agy/). Asked for by name only (args.ts § DEFAULT_AGENTS).

import { backspaceSweep, launchLine, pointedRow, type AgentProfile } from "./profile";

const TRUST_QUESTION = "Do you trust the contents of this project?";
const TRUST_YES = "Yes, I trust this folder";

export const agy: AgentProfile = {
  agent: "agy",
  versionCommand: ["agy", "--version"],
  launch: (cols, bin = "agy") => launchLine(cols, bin),
  startupAnswer(texts) {
    // The folder trust question (1.3.3, measured 2026-10-12) on the canary's fresh project, answered
    // the way a person would: Enter, only while the pointer sits on the yes row.
    if (!texts.some((t) => t.includes(TRUST_QUESTION))) return null;
    return pointedRow(texts, ">") === TRUST_YES ? ["Enter"] : ["Up"];
  },
  clearKeys: backspaceSweep,
  clearFallback: null,
  exitCommand: "/exit",
};
