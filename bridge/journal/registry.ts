// The journal registry — the SINGLE decision site for "which agents have a readable history".
//
// Maps a Herdr snapshot `agent` string to its JournalAdapter; anything absent from the map has no
// journal, which the history route reports as an ordinary `no-session` rather than an error. Adding a
// harness is a one-line change to the list below plus its adapter module — never a new branch in the
// route or the store.
//
// This deliberately mirrors `web/src/lib/harness/registry.ts`, but the two are NOT the same seam and
// must not be conflated: the frontend harness registry owns block grammars and the send guard for the
// LIVE MIRROR; this one owns reading an on-disk log. A harness can plausibly have one without the
// other.

import { claudeJournal } from "./claude.ts";
import { codexJournal } from "./codex.ts";
import { grokJournal } from "./grok.ts";
import { hermesJournal } from "./hermes.ts";
import { opencodeJournal } from "./opencode.ts";
import { piJournal } from "./pi.ts";
import type { JournalAdapter } from "./types.ts";

/**
 * Where each harness keeps its logs. Every path is a containment root, never a request input.
 *
 * A harness gets a LIST because one machine can hold several of its homes — `CLAUDE_CONFIG_DIR` per
 * profile is the case that forced it (issue #92), and every other harness has the same shape of
 * setting. Roots are searched in order and the first holding the session wins; session ids are
 * globally unique, so that is a lookup, not a guess. A single root is simply a one-element list, and
 * an adapter still accepts a bare string so one-root callers read unchanged.
 */
export interface JournalRoots {
  /** Claude Code's `~/.claude/projects`, one per config dir. */
  claude: readonly string[];
  /** Codex's `$CODEX_HOME/sessions`. */
  codex: readonly string[];
  /** pi's `$PI_CODING_AGENT_DIR/sessions`, or both of `~/.omp/agent/sessions` (Oh My Pi, which
   *  writes pi's format under its own name) and `~/.pi/agent/sessions` when that is unset. */
  pi: readonly string[];
  /** OpenCode's data dir — the SQLite `opencode.db` lives at its top level. */
  opencode: readonly string[];
  /** Grok Build's `$GROK_HOME/sessions`. */
  grok: readonly string[];
  /** Hermes' SessionDB directory — `state.db` lives at its top level. */
  hermes: readonly string[];
}

/**
 * Build the registry for a set of roots.
 *
 * The map is built FROM each adapter's own `agent` field (not a hand-written literal), so a key can
 * never drift from the adapter it points at — the same guarantee the frontend registry gives.
 */
export function buildJournalRegistry(roots: JournalRoots): Record<string, JournalAdapter> {
  const adapters = [
    claudeJournal(roots.claude),
    codexJournal(roots.codex),
    piJournal(roots.pi),
    opencodeJournal(roots.opencode),
    grokJournal(roots.grok),
    hermesJournal(roots.hermes),
  ];
  return Object.fromEntries(adapters.map((a) => [a.agent, a]));
}

/**
 * Agent names that are a SECOND NAME for a registered adapter, not an adapter of their own.
 *
 * Oh My Pi ships as `omp` and reports itself that way, and its session log is pi's log in pi's
 * format — one adapter, two names an agent may answer to. It is a map rather than a branch in
 * {@link adapterFor} because both sides need to read it: the registry resolves a name through it,
 * and `web/src/lib/journal-agents.ts` mirrors the same pairs so the browser knows an `omp` pane
 * COULD have a transcript (registry.test.ts fails when the two drift).
 *
 * An alias never adds an adapter, so it is absent from {@link KNOWN_HARNESS_NAMES}: that list
 * answers "which adapters does this build have", and the answer is still five.
 */
export const AGENT_ALIASES = { omp: "pi" } as const;

/**
 * The same pairs as a Map, which is how {@link adapterFor} asks.
 *
 * A Map rather than a property read because the key is an agent name that ORIGINATES in an agent's
 * own report: `Map.get` cannot be answered by `Object.prototype`, so there is no inherited key to
 * guard against and no assertion to write.
 */
const ALIAS_LOOKUP: ReadonlyMap<string, string> = new Map(Object.entries(AGENT_ALIASES));

/**
 * The adapter for `agent`, or undefined when the agent has no journal.
 *
 * `Object.hasOwn` rather than a truthy lookup, so an inherited Object.prototype key ("toString",
 * "constructor", "__proto__", …) arriving as an agent name can't resolve to a non-adapter and crash
 * the read path. The agent string comes from Herdr, but it originates in an agent's own report — and
 * the alias lookup is asked the same way, for the same reason.
 */
export function adapterFor(
  registry: Record<string, JournalAdapter>,
  agent: string | undefined,
): JournalAdapter | undefined {
  if (agent === undefined) return undefined;
  const canonical = ALIAS_LOOKUP.get(agent) ?? agent;
  return Object.hasOwn(registry, canonical) ? registry[canonical] : undefined;
}

/** The agents this build can serve a journal for — used by the probe script and by tests. */
export function journalAgents(registry: Record<string, JournalAdapter>): string[] {
  return Object.keys(registry).toSorted();
}

/**
 * Every harness name this build knows, independent of where any of their logs live.
 *
 * DERIVED FROM THE ADAPTERS, exactly as the registry itself is — a second hand-written list of
 * harness names is a list that drifts the day a fifth adapter lands. The roots are empty because the
 * question is "what are these called", not "where are they": every adapter factory here is a pure
 * constructor and touches no disk (each source only normalises its root list).
 *
 * It is a name list and NOT a detector. Nothing may key a grammar, a journal read or a pane's
 * identity off a match against it — see `bridge/mux/types.ts` § `MuxPane.agent`.
 */
export const KNOWN_HARNESS_NAMES: readonly string[] = journalAgents(
  buildJournalRegistry({ claude: [], codex: [], pi: [], opencode: [], grok: [], hermes: [] }),
);
