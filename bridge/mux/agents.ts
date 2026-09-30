// THE AGENT NAMES THE CONTRACT ACCEPTS — a contract rule, like the key spelling in keys.ts.
//
// `MuxPane.agent` picks two things above the seam: the phone's screen reader for the pane
// (web/src/lib/harness/registry.ts) and the bridge's journal reader for its history
// (bridge/journal/registry.ts). Both look the name up EXACTLY. So a multiplexer's own id for a
// harness (tuios says `claude-code`, where Collie says `claude`) reaches neither reader, and the
// pane is rendered raw with its prompts unread. Nothing used to say so: the conformance suite only
// asked for a lower-cased, non-empty name.
//
// The rule: an agent name is `shell` or one of the names below. An adapter translates its own ids
// into these, and an agent Collie has no harness for reads as a shell. The list is the union of the
// two registries plus the journal's aliases, and `agents.test.ts` fails when it drifts from them.

/** Every agent name a harness reader of Collie's answers to, sorted. */
export const MUX_AGENT_NAMES: readonly string[] = [
  "agy",
  "antigravity",
  "claude",
  "codex",
  "grok",
  "hermes",
  "muse",
  "omp",
  "opencode",
  "pi",
];

/** The agent name of a pane with no agent. */
export const MUX_SHELL_AGENT = "shell";

/** Whether `agent` is a name the contract accepts on a pane. */
export function isMuxAgentName(agent: string): boolean {
  return agent === MUX_SHELL_AGENT || MUX_AGENT_NAMES.includes(agent);
}
