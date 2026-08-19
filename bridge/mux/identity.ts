// Pane and space IDENTITY — a contract rule, not an adapter's private business.
//
// It is here because it is the one thing that is expensive to get wrong later: an id that changes
// under the operator invalidates a per-pane draft, an open pane view, a notification, an audit line
// and (in a pack) a `(host, session, paneId)` address. Nothing above the adapter can repair that, so
// the rules are stated once and every adapter is held to them by conformance (M10/03).
//
// THE RULES
//
//  1. **Opaque above the adapter.** Only the adapter that minted an id may parse it. Nothing else
//     may read structure into it — not the routes, not the phone, not a test. Herdr's `w6:p3`,
//     tmux's `%0` and zellij's `terminal_1` are three different shapes and that is fine.
//  2. **Stable while the pane lives.** The same pane keeps its id across a reconnect of the adapter,
//     a restart of the multiplexer process, a rename, and a move between tabs or spaces. An id
//     derived from anything the operator can change (a label, a title, a position) breaks this.
//  3. **Unique within one collie.** Across every space and tab of the configured target. NOT across
//     machines — a pack address is `(host, session, paneId)` and the host half is the lead's job
//     (PACK_PROTOCOL.md §4), so an adapter must not try to make its ids globally unique.
//  4. **Never recycled onto a different pane** for the lifetime of the bridge process. A
//     multiplexer that reuses a slot number must salt it; answering for the wrong pane is worse
//     than answering "gone".
//  5. **Transport-safe.** An id travels as a single URL path segment (`/api/pane/:id`), as a cache
//     key on the phone, and inside a JSON body. {@link isValidMuxId} is that rule, mechanically.
//
// Rule 5 is checkable here and now; rules 1–4 are behavioural and are pinned by the conformance
// suite. Both halves are the contract.

/**
 * Longest id Collie will carry. Generous next to every real multiplexer (Herdr's longest observed
 * is single digits) and short enough that an id can never be a payload in disguise.
 */
export const MUX_ID_MAX_LENGTH = 128;

/** Control characters, whitespace, and the URL path punctuation an id must never carry (rule 5). */
const UNSAFE_ID_CHAR = /[\p{C}\s/?#]/u;

/**
 * Whether `id` is a well-formed Collie mux id (rule 5).
 *
 * Rejects: empty, over-long, anything carrying a control character, whitespace, `/`, `?` or `#`.
 * The last three are the URL rule: the id is one path segment of `/api/pane/:id`, read back with
 * `decodeURIComponent`, and a segment that has to be split or re-joined to survive that round trip
 * will eventually not survive it.
 *
 * `%` is deliberately ALLOWED, and the reason is rule 1: tmux's own stable pane id is `%0` (probe,
 * M10/04). Percent-encoding handles it — an id that had to be re-encoded to be carried would stop
 * being the multiplexer's id, which is the property rule 2 rests on.
 */
export function isValidMuxId(id: string): boolean {
  if (id.length === 0 || id.length > MUX_ID_MAX_LENGTH) return false;
  return !UNSAFE_ID_CHAR.test(id);
}

/** One pane's identity as an adapter reports it — the pair uniqueness is checked over. */
export interface MuxIdentity {
  readonly paneId: string;
  readonly spaceId: string;
}

/** What {@link checkIdentitySet} found wrong, in the words the conformance failure prints. */
export type MuxIdentityProblem =
  | { readonly kind: "malformed"; readonly id: string; readonly field: "paneId" | "spaceId" }
  | { readonly kind: "duplicate"; readonly id: string };

/**
 * Rules 3 and 5 over one snapshot's worth of panes: every id is well formed, and no pane id repeats.
 *
 * Space ids repeating is normal (many panes share a space) and is not a duplicate. Pure, so the
 * conformance suite and any adapter's own tests can run it with no multiplexer present.
 */
export function checkIdentitySet(panes: readonly MuxIdentity[]): MuxIdentityProblem[] {
  const problems: MuxIdentityProblem[] = [];
  const seen = new Set<string>();
  for (const pane of panes) {
    if (!isValidMuxId(pane.paneId)) problems.push({ kind: "malformed", id: pane.paneId, field: "paneId" });
    if (!isValidMuxId(pane.spaceId)) problems.push({ kind: "malformed", id: pane.spaceId, field: "spaceId" });
    if (seen.has(pane.paneId)) problems.push({ kind: "duplicate", id: pane.paneId });
    seen.add(pane.paneId);
  }
  return problems;
}

/**
 * Rule 2 across two observations of the same multiplexer (before and after a reconnect, a rename or
 * a mux restart): every pane that survived kept its id.
 *
 * Returns the ids that were present before and are missing after. A pane genuinely closed in between
 * shows up here too, which is why the conformance suite runs it over a quiescent target — the check
 * is "did the ids move", and a moved id is indistinguishable from a closed one from the outside.
 * That is exactly why rule 2 has to be an adapter promise rather than something inferred later.
 */
export function idsLostBetween(
  before: readonly MuxIdentity[],
  after: readonly MuxIdentity[],
): string[] {
  const still = new Set(after.map((pane) => pane.paneId));
  return before.filter((pane) => !still.has(pane.paneId)).map((pane) => pane.paneId);
}
