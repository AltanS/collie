// Muse Code in the canary, with the model and settings it starts with. Collie reads it with its adapter
// (web/src/lib/harness/muse/) and its log under the XDG data dir. Asked for by name only
// (args.ts § DEFAULT_AGENTS): a send spends whichever provider muse is pointed at.

import { backspaceSweep, launchLine, pointedRow, type AgentProfile } from "./profile";

const TRUST_QUESTION = "Do you trust this workspace?";
const TRUST_YES = "Trust and continue";

export const muse: AgentProfile = {
  agent: "muse",
  versionCommand: ["muse", "--version"],
  launch: (cols, bin = "muse") => launchLine(cols, bin),
  startupAnswer(texts) {
    // The workspace trust question (1.4.6, measured 2026-10-12) on the canary's fresh project:
    // Enter only while the pointer sits on "Trust and continue", else Up towards it, never Quit.
    if (!texts.some((t) => t.includes(TRUST_QUESTION))) return null;
    const pointed = pointedRow(texts, ">");
    if (pointed === null) return null;
    return pointed.includes(TRUST_YES) ? ["Enter"] : ["Up"];
  },
  clearKeys: backspaceSweep,
  clearFallback: null,
  exitCommand: "/exit",
};
