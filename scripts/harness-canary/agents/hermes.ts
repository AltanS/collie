// Hermes Agent in the canary, with the provider in the operator's own config. Collie has no adapter
// for hermes: raw mirror, one-step send. Asked for by name only (args.ts § DEFAULT_AGENTS).

import { backspaceSweep, launchLine, pointedRow, type AgentProfile } from "./profile";

const TELEMETRY_QUESTION = "Help improve Hermes?";
const TELEMETRY_NO = "(●) No thanks";

export const hermes: AgentProfile = {
  agent: "hermes",
  versionCommand: ["hermes", "--version"],
  launch: (cols, bin = "hermes") => launchLine(cols, bin),
  startupAnswer(texts) {
    // The shared-metrics question v0.21.7 asks once after an update (measured 2026-10-12). Only ever
    // the no: Enter while the pointer is on "No thanks", else Down towards it, never an opt-in.
    if (!texts.some((t) => t.includes(TELEMETRY_QUESTION))) return null;
    return pointedRow(texts, "→") === TELEMETRY_NO ? ["Enter"] : ["Down"];
  },
  clearKeys: backspaceSweep,
  clearFallback: null,
  exitCommand: "/exit",
  // The slash popup is still painting at 400 ms and takes that Enter; at 1 s it submits (2026-10-12).
  exitSettleMs: 1200,
};
