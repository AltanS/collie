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
// two registries plus the journal's aliases, plus the names in MUX_PROFILE_ONLY_AGENT_NAMES, and
// `agents.test.ts` fails when it drifts from them.

/**
 * Agent names that have an input profile (web/src/lib/surface/profiles) and no screen or journal
 * reader. The Send Protocol looks the profile up by the pane's agent name, so the name must pass the
 * rule, but nothing renders or reads history for the pane. `agents.test.ts` checks both halves.
 * `cursor` is the Cursor CLI (binary `cursor-agent`), under the name Herdr gives its integration.
 */
export const MUX_PROFILE_ONLY_AGENT_NAMES: readonly string[] = ["cursor"];

/** Every agent name a harness reader or an input profile of Collie's answers to, sorted. */
export const MUX_AGENT_NAMES: readonly string[] = [
  "agy",
  "antigravity",
  "claude",
  "codex",
  "cursor",
  "dsh-tui",
  "grok",
  "hermes",
  "kiro",
  "muse",
  "omp",
  "openclaw",
  "opencode",
  "pi",
];

/** The agent name of a pane with no agent. */
export const MUX_SHELL_AGENT = "shell";

/**
 * Names a multiplexer may report that NO harness reader answers to, on purpose.
 *
 * A durable program has no screen to read and no journal of an agent in a pane, so its panes
 * report `durable` and reach neither reader: the screen reader falls back to raw and the journal
 * finds nothing. They are kept out of {@link MUX_AGENT_NAMES} because that list is exactly the
 * readers' names, and `harness-launch.ts` starts one harness per entry of it.
 */
export const MUX_SCREENLESS_AGENT_NAMES: readonly string[] = ["durable"];

/** Whether `agent` is a name the contract accepts on a pane. */
export function isMuxAgentName(agent: string): boolean {
  return agent === MUX_SHELL_AGENT || MUX_AGENT_NAMES.includes(agent) || MUX_SCREENLESS_AGENT_NAMES.includes(agent);
}
