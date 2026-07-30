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
import { ompJournal } from "./omp.ts";
import { piJournal } from "./pi.ts";
import type { JournalAdapter } from "./types.ts";

/** Where each harness keeps its logs. Every path is a containment root, never a request input. */
export interface JournalRoots {
  /** Claude Code's `~/.claude/projects`. */
  claude: string;
  /** Codex's `$CODEX_HOME/sessions`. */
  codex: string;
  /** OMP's `~/.omp/agent/sessions`. */
  omp: string;
  /** pi's `$PI_CODING_AGENT_DIR/sessions`. */
  pi: string;
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
    ompJournal(roots.omp),
    piJournal(roots.pi),
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
  return Object.keys(registry).sort();
}
