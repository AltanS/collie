// pi in the canary, with its default model and thinking off (`--thinking off`, a flag, cheaper) and
// `--no-session`, so a run leaves no session file behind. Collie has no adapter for pi: raw mirror,
// one-step send.

import { backspaceSweep, launchLine, type AgentProfile } from "./profile";

export const pi: AgentProfile = {
  agent: "pi",
  versionCommand: ["pi", "--version"],
  launch: (cols) => launchLine(cols, `pi --no-session --thinking off`),
  startupAnswer: () => null,
  clearKeys: backspaceSweep,
  clearFallback: null,
  exitCommand: "/quit",
};
