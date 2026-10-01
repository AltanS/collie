// Codex in the canary. The default model at low reasoning effort, set by `-c` for this process only.
// Trap measured 2026-09-26: Ctrl+C on an EMPTY composer exits Codex, so it is never sent; a draft
// is cleared with Backspaces and there is no fallback.

import { backspaceSweep, launchLine, pointedRow, type AgentProfile } from "./profile";

const TRUST_QUESTION = "Trust this folder?";
const TRUST_YES = "Trust and continue";

/**
 * The launch arguments every canary codex shares. `check_for_update_on_startup=false` keeps codex's
 * "Update available" prompt away: its default answer is "Update now", which would change the user's
 * install, and it takes the place of the composer the canary waits for.
 */
export const CODEX_ARGS = `-c 'model_reasoning_effort="low"' -c check_for_update_on_startup=false`;

export const codex: AgentProfile = {
  agent: "codex",
  versionCommand: ["codex", "--version"],
  launch: (cols) => launchLine(cols, `codex ${CODEX_ARGS}`),
  startupAnswer(texts) {
    // The folder trust question (0.156.1). `-c projects…trust_level` and `-a`/`-s` do not skip it,
    // measured 2026-09-26, so it is answered like a person would: pointer on "Trust and continue",
    // then Enter.
    if (!texts.some((t) => t.includes(TRUST_QUESTION))) return null;
    const pointed = pointedRow(texts, "›");
    if (pointed === null) return null;
    return pointed.includes(TRUST_YES) ? ["Enter"] : ["Up"];
  },
  clearKeys: backspaceSweep,
  clearFallback: null,
  exitCommand: "/quit",
};
