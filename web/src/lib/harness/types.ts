// The pluggable detection seam. Each supported agent (Claude today; codex/opencode/… tomorrow)
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
  /** Re-surface the statusline this agent's chrome-stripping peeled off the mirror tail (null = no
   *  box at the tail, so nothing to surface). */
  extractStatusLine(lines: StyledLine[]): string | null;
  /** Re-surface a user draft stranded on the input box's prompt line (null = no box / empty / a
   *  known placeholder). */
  extractInputDraft(lines: StyledLine[]): string | null;
}
