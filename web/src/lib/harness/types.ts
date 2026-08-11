// The pluggable detection seam. Each supported agent (Claude and omp today; codex/opencode/… tomorrow)
// contributes ONE HarnessAdapter: its own block-building pipeline plus the two chrome re-surfacing
// probes (the statusline the mirror strips, and a stranded input-box draft). The registry
// (registry.ts) maps a Herdr snapshot `agent` string to its adapter; everything not in the registry
// falls back to the universal raw mirror. This is the single decision site the render pipeline and
// agent-chat's status strip both route through, so the "which agents get grammars" policy can't drift.
//
// An adapter is DETECTION only. The Block union + renderers and the keystroke ACTION recipes
// (prompt/wizard/preview-action) stay in core, dispatched from agent-chat — the adapter just tells
// core what's on screen.

import type { Block, StyledLine } from "../blocks";

export interface HarnessAdapter {
  /** The exact Herdr snapshot `agent` string this adapter claims (its registry key). */
  agent: string;
  /** The adapter's OWN full block pipeline over the pane's styled lines — for Claude that is the
   *  raw-or-dialog result (dialog lift + chrome strip, else a single raw block). */
  buildBlocks(lines: StyledLine[]): Block[];
  /** Re-surface the statusline RUN this agent's chrome-stripping peeled off the mirror tail, one
   *  entry per row, top to bottom. A statusline is an arbitrary user command's output and is
   *  routinely several rows tall (model/cwd/branch on one, permission mode on another), so the
   *  contract is a list — a single-row harness returns a one-element array. Rows stay STYLED: a
   *  statusline separates its fields by colour, so flattening them to text loses what makes it
   *  readable at a glance. Empty = no box at the tail (a menu is up, or a foreign/torn buffer), so
   *  nothing to surface. */
  extractStatusLines(lines: StyledLine[]): StyledLine[];
  /** Re-surface a user draft stranded on the input box's prompt line (null = no box / empty / a
   *  known placeholder). */
  extractInputDraft(lines: StyledLine[]): string | null;
  /**
   * Whether this agent's free-text input box is on screen right now — i.e. whether typing a reply
   * would reach the composer at all, rather than a modal that has the keyboard.
   *
   * OPTIONAL, and its absence means "no idea": the reply path's pre-flight (lib/reply-action.ts)
   * only refuses to type when an adapter answers a definite `false`. An adapter that can't tell
   * omits it and keeps today's type-then-verify behaviour, which is still safe — the submit key is
   * withheld either way; the pre-flight just avoids depositing the text in a menu first.
   */
  composerReady?(lines: StyledLine[]): boolean;
  /**
   * The literal on-screen text of the composer's own prompt row — the region a DESTRUCTIVE write
   * aimed at that row may be bound to. Null = no composer at the tail (the same screens
   * `composerReady` answers false about).
   *
   * The reply path's pre-clear sweep (`ctrl+k` + a run of Backspaces, lib/reply-action.ts) is the one
   * keystroke burst in the app that is authorised by a client-side read rather than by a dialog
   * model, so it has no `signature` to carry. This is its equivalent: pass the row through as
   * `expected_prompt` and the bridge re-reads the pane immediately before `send_keys`, 409ing the
   * write if that row is no longer there (bridge/server.ts `checkPromptBinding`). That collapses the
   * window between "a read said composer" and "the keys land" from a network round-trip to two local
   * RPCs — the same mitigation `lib/dialog-guard.ts` gives every tap.
   *
   * OPTIONAL, and absence means the sweep goes out unbound, which is the pre-existing behaviour. The
   * bridge accepts a region only if it still matches within the last few non-blank rows, so an
   * adapter should return a row that sits AT the tail — one whose own harness paints many rows below
   * it would refuse legitimate sweeps, which is worse than leaving this out.
   */
  composerPrompt?(lines: StyledLine[]): string | null;
  /**
   * SUPPLEMENTAL evidence that `sent` reached the input box, for the case the reply guard's own
   * literal-substring match structurally cannot see: a harness that swallows what was typed and paints
   * a TOKEN of its own instead (Claude's `[Pasted text #N +M lines]`), so the box never holds our
   * words at all and the send stalls forever while every retry re-collapses.
   *
   * OPTIONAL, and consulted ONLY after the generic match has already failed (lib/reply-action.ts) —
   * it can widen what counts as evidence, never narrow it. The contract is strict-or-false: return
   * true only when the token on screen is CONSISTENT with this exact send, because a `true` here fires
   * the submit key. An adapter that can't tell omits it and keeps today's stall.
   */
  draftCarriesSend?(sent: string, draft: string): boolean;
  /**
   * Whether the draft on the input line is the harness's OWN opaque token rather than the user's text
   * — the same placeholder as above, sitting stranded. The stranded-draft preview keeps showing it
   * (it is honestly what the screen says) but stands its "Take over" affordance down: copying
   * `[Pasted text #1 +3 lines]` into the phone composer would make that string the message.
   *
   * OPTIONAL; absence means "it's all real text", which is what every harness without a paste
   * heuristic gets, and is the pre-existing behaviour.
   */
  draftIsOpaque?(draft: string): boolean;
}
