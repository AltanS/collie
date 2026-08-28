// WHICH AGENTS CAN HAVE A READABLE TRANSCRIPT AT ALL — the client's half of the question
// `bridge/journal/registry.ts` answers server-side.
//
// The bridge sets `AgentView.hasSession` only when a pane named a session AND its agent has a
// journal adapter (`bridge/types.ts` toPaneWire). Both halves are folded into that one flag, so an
// absent flag cannot say WHICH half failed — and the two want opposite words. An agent with no
// journal adapter has nothing to explain: there is no transcript to read, ever, and a sentence
// about it would be noise. An agent that HAS one and still reported no session is the case an
// operator can fix (issue #137: a missing or outdated `herdr integration install <agent>` hook),
// and silence there reads as a bug in Collie.
//
// So the frontend needs the name list, and it is a NAME LIST, never a detector: nothing may key a
// grammar, a fetch or a pane's identity off a match here — the same rule `KNOWN_HARNESS_NAMES`
// carries bridge-side. It decides one muted sentence and nothing else.
//
// This is NOT `lib/harness/registry.ts`, and the two must not be folded together — that one owns
// block grammars for the LIVE MIRROR (claude, codex, grok, omp, agy), this one owns reading an
// on-disk log (claude, codex, grok, opencode, pi). A harness can plausibly have either without the
// other, which is exactly why the bridge keeps two registries too.
//
// Kept in step with `bridge/journal/registry.ts` by hand, deliberately: the list is not on the wire
// (no bridge publishes it), and a speculative fetch to discover it would cost a request per pane to
// answer a question about a sentence. Adding a journal adapter there means adding its name here.

/** The Herdr `agent` strings this build can read a session log for. Mirrors `journalAgents()`. */
const JOURNAL_AGENTS: ReadonlySet<string> = new Set(["claude", "codex", "grok", "opencode", "pi"]);

/**
 * Whether `agent` is one whose sessions Collie could read a transcript from.
 *
 * EXACT match, like the bridge's own `adapterFor`: a variant string ("claude-code") is not a name
 * the journal registry holds, so the bridge would never set `hasSession` for it either, and
 * promising that pane a fix it cannot apply would be worse than saying nothing.
 */
export function hasJournalAdapter(agent: string | undefined): boolean {
  return agent !== undefined && JOURNAL_AGENTS.has(agent);
}
