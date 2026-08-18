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
  /** pi's `$PI_CODING_AGENT_DIR/sessions`. */
  pi: readonly string[];
  /** OpenCode's data dir — the SQLite `opencode.db` lives at its top level. */
  opencode: readonly string[];
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
  ];
  return Object.fromEntries(adapters.map((a) => [a.agent, a]));
}

/**
 * The adapter for `agent`, or undefined when the agent has no journal.
 *
 * `Object.hasOwn` rather than a truthy lookup, so an inherited Object.prototype key ("toString",
 * "constructor", "__proto__", …) arriving as an agent name can't resolve to a non-adapter and crash
 * the read path. The agent string comes from Herdr, but it originates in an agent's own report.
 */
export function adapterFor(
  registry: Record<string, JournalAdapter>,
  agent: string | undefined,
): JournalAdapter | undefined {
  return agent !== undefined && Object.hasOwn(registry, agent) ? registry[agent] : undefined;
}

/** The agents this build can serve a journal for — used by the probe script and by tests. */
export function journalAgents(registry: Record<string, JournalAdapter>): string[] {
  return Object.keys(registry).toSorted();
}
