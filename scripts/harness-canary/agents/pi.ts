// pi in the canary, with its default model and thinking off (`--thinking off`, a flag, cheaper).
// Collie has no adapter for pi: raw mirror, one-step send.
//
// `--no-session` WAS here, so a run left no session file behind. It was dropped on 2026-09-30, when
// spec 05 gave the canary a journal check, for three reasons and not for convenience:
//
//   A canary has to run the agent the way an OPERATOR runs it. Nobody runs pi with `--no-session`,
//   and a session file is the thing Chat reads, so the flag hid the whole surface under test.
//
//   pi was the only agent exempt. claude, codex and opencode all already write to the operator's own
//   store on every canary run, because the canary isolates herdr (its own socket and config,
//   `herdr.ts` § cleanEnv) and deliberately does not isolate an agent's own config or home. One
//   agent writing nothing was an inconsistency, not a policy.
//
//   One launch line keeps the thing under test the same in all six scenarios. Passing the flag for
//   five scenarios and dropping it for `journal` would have tested two different pis, and a reader
//   fault that only appears with sessions on would then hide in the five.
//
// The residue is one pi session per run, in the same place the other three already leave theirs. If
// that ever matters, the fix is isolating EVERY agent's store, not exempting one agent again.

import { backspaceSweep, launchLine, type AgentProfile } from "./profile";

export const pi: AgentProfile = {
  agent: "pi",
  versionCommand: ["pi", "--version"],
  launch: (cols) => launchLine(cols, `pi --thinking off`),
  startupAnswer: () => null,
  clearKeys: backspaceSweep,
  clearFallback: null,
  exitCommand: "/quit",
};
