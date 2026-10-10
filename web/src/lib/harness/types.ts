// The pluggable detection seam. Each supported agent (claude, codex and omp today; opencode/pi/… tomorrow)
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
  /** Lossless transport pastes. Intermediate parts must be verified before continuing;
   * only the complete reply can authorise Enter. Other harnesses stay single-paste. */
  replyChunks?(text: string): string[];
  /**
   * Whether to type this reply part as ONE bracketed paste (`ESC[200~ … ESC[201~`) rather than as
   * bare keystrokes. `pane.send_text` writes raw bytes (HERDR_API.md), so a long send reaches the
   * harness as several PTY reads, and a harness that guesses pastes from read size can mis-split it.
   * OPTIONAL: only for a harness that turns bracketed paste on, or the markers are typed as junk.
   */
  bracketedPaste?(text: string): boolean;
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
  /** Re-surface a block of rows the harness paints UNDER its statusline about work running beside
   *  the main session (Claude's background-agents footer: "● main" plus one row per agent). Stripped
   *  off the mirror with the rest of the tail, so this is its only surface. STYLED rows, top to
   *  bottom, verbatim. OPTIONAL: a harness without such a block omits it, and `[]` means none now. */
  extractAgentsFooter?(lines: StyledLine[]): StyledLine[];
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
   * Whether a LIFTED dialog currently on screen accepts typed answers through the composer.
   *
   * By default, any lifted dialog causes the composer to refuse typed sends (#34) because the
   * keystrokes would land in the dialog and Enter would submit/confirm whatever was highlighted.
   * An adapter can opt in by declaring this probe: when it answers true for the current screen's
   * lines (and optional candidate `text`), the composer bypasses the #34 refusal and sends through
   * the normal type-then-verify path (which still performs the pre-flight `composerReady` check
   * against a fresh read of the pane).
   *
   * OPTIONAL; absence or returning false keeps the standard #34 refusal.
   */
  dialogAcceptsTyping?(lines: StyledLine[], text?: string): boolean;
  /**
   * The key THIS harness's own modals print as the way OUT of them — a Herdr key token ("Escape",
   * "ctrl+c"), declared here and read from nowhere else.
   *
   * It is the one control the unread-dialog card offers (harness/index.ts `withUnreadDialog`,
   * .adr/0053): when every grammar declined, `composerReady` answered a definite `false` and the
   * screen is not blank, the operator gets this key over the raw mirror instead of a locked composer
   * and no buttons at all. Declare it from the harness's OWN captures or notes, and say in a comment
   * which file it was read from — a declaration is reviewed once, a footer parse is fooled by a
   * phrase.
   *
   * OPTIONAL, and its absence means "this adapter declares no way out": the pass emits no card for
   * that agent, per adapter, by construction. That is a supported answer with a visible cost, and it
   * is the right one while an adapter's `composerReady` has a total false-negative mode (omp).
   *
   * Not every harness spells it the same way: grok's footers give Escape to the scrollback view and
   * name `Ctrl+c:cancel` instead. That single divergence is why the key is declared rather than
   * assumed.
   */
  cancelKey?: string;
  /**
   * Positive evidence that one of THIS harness's modals is on screen, asked by the unread-dialog pass
   * before it offers `cancelKey` (.adr/0053, addendum 2026-09-26). `composerReady` answering `false`
   * says only that no input box is there, and that is also true of a plain shell: herdr reports the
   * agent a moment before its first frame paints and a moment after it exits, and the card used to
   * flash over the shell prompt in both windows.
   *
   * OPTIONAL. Absent keeps the four original conditions unchanged for that adapter. Declared, the
   * card needs it to answer `true` as well; a throw counts as `false`. Read from the harness's own
   * captures, and pinned by the card's allow-list test.
   */
  modalOnScreen?(lines: StyledLine[]): boolean;
  /**
   * Positive evidence that a full overlay box holds the keyboard — the /models-style overlay
   * paints its own bordered box over the middle of the screen while the composer tail stays
   * intact, so `composerReady` still answers true although typing would land in the overlay's
   * filter, never the input box. Asked by the reply path (`lib/reply-action.ts`) before typing
   * and when classifying a stalled send.
   *
   * OPTIONAL. Absent skips both checks for that adapter, which is the pre-existing behaviour. A
   * throw propagates to the caller — the unread-dialog card treats it as `false`, the reply path
   * lets the send reject, exactly like a throwing `composerReady`. Read from the harness's own
   * captures; the suites pin the corpus.
   */
  overlayHoldsKeyboard?(lines: StyledLine[]): boolean;
  /**
   * Literal on-screen text from the composer's prompt/draft tail — the region a DESTRUCTIVE write
   * aimed at that composer may be bound to. Null = no composer at the tail (the same screens
   * `composerReady` answers false about).
   *
   * The reply path's pre-clear sweep (`ctrl+k` + a run of Backspaces, lib/reply-action.ts) is the one
   * keystroke burst in the app that is authorised by a client-side read rather than by a dialog
   * model, so it has no `signature` to carry. This is its equivalent: pass the region through as
   * `expected_prompt` and the bridge re-reads the pane immediately before `send_keys`, 409ing the
   * write if that row is no longer there (bridge/server.ts `checkPromptBinding`). That collapses the
   * window between "a read said composer" and "the keys land" from a network round-trip to two local
   * RPCs — the same mitigation `lib/dialog-guard.ts` gives every tap.
   *
   * OPTIONAL, and absence means the sweep goes out unbound, which is the pre-existing behaviour. The
   * bridge accepts a region only if its match ends within the last few non-blank rows, so an adapter
   * with a wrapping composer should include enough of the tail for the match to end there. A region
   * whose final row sits too high would refuse legitimate sweeps, which is worse than leaving it out.
   */
  composerPrompt?(lines: StyledLine[]): string | null;
  /**
   * Whether the input on screen SUBMITS when it receives a raw newline. `pane.send_text` delivers a
   * `\n` inside the text as a real keypress (HERDR_API.md), so on such a screen a multi-line message
   * would be submitted at its first line break and the rest typed into whatever comes next.
   *
   * OPTIONAL; absence means "a newline inserts a line", which is the pre-existing assumption. The
   * reply path asks it of every read that clears the text to go out, after `composerReady` said yes,
   * and refuses a message that contains a newline when it answers true.
   */
  newlineSubmits?(lines: StyledLine[]): boolean;
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
  /**
   * Tidy one raw block's rows for display only, after every grammar has run: chrome the harness paints
   * inside the transcript that is not content (Grok's dark scrollbar track and its right padding).
   * The terminal mirror calls it through the registry, on the wrapped view with grammars on, so the
   * shared component never imports a harness module.
   *
   * Display only. Never hand the result back to a grammar, a guard or the reply path: it may drop or
   * collapse rows, which would break the raw screen coordinates the send's verification reads.
   *
   * OPTIONAL; absence means the rows are shown as they are.
   */
  prepareDisplay?(lines: StyledLine[]): StyledLine[];
}
