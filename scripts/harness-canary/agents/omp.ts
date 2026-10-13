// Oh My Pi in the canary, with thinking off (`--thinking off`, as pi). Collie reads it with its adapter
// (web/src/lib/harness/omp/), and its log is pi's format under `~/.omp/agent/sessions`. Asked for by
// name only (args.ts § DEFAULT_AGENTS): a send spends whichever provider omp is signed in to.

import { backspaceSweep, launchLine, type AgentProfile } from "./profile";

export const omp: AgentProfile = {
  agent: "omp",
  versionCommand: ["omp", "--version"],
  launch: (cols, bin = "omp") => launchLine(cols, `${bin} --thinking off`),
  startupAnswer: () => null,
  clearKeys: backspaceSweep,
  clearFallback: null,
  exitCommand: "/quit",
};
