// Pi's inline editor is deliberately recognised more narrowly than Claude's box: this adapter has
// no interaction grammars, and its only safe projection is removing a fully verified standard editor
// while leaving every other terminal row raw. The analyser is pure and fixture-grounded.

import type { Block, StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import { analysePiEditor } from "./editor";
import { isPiPastePlaceholder } from "./paste";

/** Pi's read-only pipeline: omit only the exact editor range the analyser verified. */
export function piBuildBlocks(lines: StyledLine[]): Block[] {
  const editor = analysePiEditor(lines);
  if (editor === null) return [{ kind: "raw", lines }];

  // The editor's two borders are the only standalone repeated U+2500 rows removed. Everything
  // outside this analysed range — startup output, widgets, autocomplete, footer and terminal text —
  // remains verbatim in the universal raw block.
  return [{
    kind: "raw",
    lines: lines.filter((_, index) => index < editor.top || index > editor.bottom),
  }];
}

/** A draft is safe only for the analyser's single, unwrapped editor row. */
export function extractInputDraft(lines: StyledLine[]): string | null {
  return analysePiEditor(lines)?.draft ?? null;
}

export const piAdapter: HarnessAdapter = {
  agent: "pi",
  buildBlocks: piBuildBlocks,
  // Pi's footer stays in the raw terminal; it is not a Collie status-line projection.
  extractStatusLines: () => [],
  extractInputDraft,
  // Pane bytes cannot establish Pi child focus or custom-editor Enter semantics, so this adapter
  // intentionally omits composerReady. The generic baseline check still withholds Enter when its
  // observed draft did not change after typing.
  // Pi's lowercase paste marker is its own opaque display token, not user text. It is intentionally
  // NOT send evidence: this adapter does not implement draftCarriesSend without live verification.
  draftIsOpaque: isPiPastePlaceholder,
};

export { analysePiEditor, isPiPastePlaceholder };
