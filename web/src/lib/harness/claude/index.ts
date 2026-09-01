// The Claude Code adapter — the one agent whose TUI shape is VERIFIED (input box, menu footers,
// stepper header) against the fixture corpus in web/src/fixtures/panes/*.txt. Its detectors
// (prompt-select, wizard, preview-select, chrome, markers) live alongside this file; this module
// wires them into the two HarnessAdapter surfaces: the block pipeline (claudeBuildBlocks) and the
// chrome re-surfacing probes (extractStatusLines / extractInputDraft, re-exported from ./chrome).
//
// Every OTHER agent (opencode, pi, a bare shell, or an unknown/absent agent) has an unverified
// TUI shape, so it has no adapter and keeps the plain raw terminal mirror — running Claude's matchers
// on it could mis-lift a menu, strip real output as "chrome", or paint a bogus status strip.

import { trimTrailingBlank, type Block, type StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import { detectPreviewSelectRegion } from "./preview-select";
import { detectWizardRegion } from "./wizard";
import { detectMultiSelectRegion } from "./multi-select";
import { detectPromptSelectRegion } from "./prompt-select";
import { detectMenuRegion } from "./menu";
import { detectAutocompleteRegion } from "./autocomplete";
import { stripChrome, extractStatusLines, extractInputDraft, hasInputBox } from "./chrome";
import { isPastePlaceholderOnly, pasteCarriesSend } from "./paste";

/**
 * Claude's block pipeline: detect a tail dialog (preview / wizard / prompt-select), replacing it with
 * a typed block and keeping everything above it raw; otherwise strip trailing chrome. Any detection
 * miss falls back to a single raw block — the universal T1 behaviour. The registry only ever hands
 * this function a Claude pane, so there is no per-agent gate here.
 */
export function claudeBuildBlocks(lines: StyledLine[]): Block[] {
  // The preview variant runs FIRST: its footer is the most specific anchor ("n to add notes"),
  // and although the wizard/prompt-select detectors can't match its layout (their footer-gap
  // guards fail on the tall preview pane), ordering by specificity keeps the arbitration obvious.
  const previewRegion = detectPreviewSelectRegion(lines);
  if (previewRegion) {
    const before = trimTrailingBlank(lines.slice(0, previewRegion.startLine));
    const blocks: Block[] = [];
    if (before.length > 0) blocks.push({ kind: "raw", lines: before });
    blocks.push({
      kind: "preview-select",
      preview: previewRegion.model,
      lines: lines.slice(previewRegion.startLine),
    });
    return blocks;
  }

  // The wizard runs before prompt-select: its question phase also carries a select footer, so
  // prompt-select's detector would otherwise have to arbitrate (today it bails on the stepper
  // header — that bail stays as a safety net for a wizard this detector misses).
  const wizardRegion = detectWizardRegion(lines);
  if (wizardRegion) {
    const before = trimTrailingBlank(lines.slice(0, wizardRegion.startLine));
    const blocks: Block[] = [];
    if (before.length > 0) blocks.push({ kind: "raw", lines: before });
    blocks.push({ kind: "wizard", wizard: wizardRegion.model, lines: lines.slice(wizardRegion.startLine) });
    return blocks;
  }

  // Multi-select runs after the wizard, before prompt-select: its checkbox screen also carries a
  // select footer, but its `[ ]`/`[✔]` rows + single-question stepper are unique to it (prompt-select
  // bails on the multi-step glyph, wizard on the 2-chip stepper), so ordering keeps arbitration clear.
  const multiRegion = detectMultiSelectRegion(lines);
  if (multiRegion) {
    const before = trimTrailingBlank(lines.slice(0, multiRegion.startLine));
    const blocks: Block[] = [];
    if (before.length > 0) blocks.push({ kind: "raw", lines: before });
    blocks.push({ kind: "multi-select", multi: multiRegion.model, lines: lines.slice(multiRegion.startLine) });
    return blocks;
  }

  const region = detectPromptSelectRegion(lines);
  if (region) {
    const before = trimTrailingBlank(lines.slice(0, region.startLine));
    const blocks: Block[] = [];
    if (before.length > 0) blocks.push({ kind: "raw", lines: before });
    blocks.push({ kind: "prompt-select", prompt: region.model, lines: lines.slice(region.startLine) });
    return blocks;
  }

  // LAST RESORT: a modal screen none of the specific grammars claimed, driven by the keys its own
  // footer names (menu.ts). It runs after all four deliberately — every grammar above encodes a
  // VERIFIED keystroke recipe for a dialog it recognises, and this one only knows what the screen
  // printed. It must never pre-empt them; it exists to catch what they decline (the `/model` picker),
  // where the alternative is no buttons at all and a composer send typed into the picker.
  const menuRegion = detectMenuRegion(lines);
  if (menuRegion) {
    const before = trimTrailingBlank(lines.slice(0, menuRegion.startLine));
    const blocks: Block[] = [];
    if (before.length > 0) blocks.push({ kind: "raw", lines: before });
    blocks.push({ kind: "menu", menu: menuRegion.model, lines: lines.slice(menuRegion.startLine) });
    return blocks;
  }

  // The COMPLETION POPUP (autocomplete.ts) — the one non-raw block that is not a dialog. It runs last
  // because it is the least specific tail shape, and it is gated on `hasInputBox` because that is what
  // separates a live composer with a popup under it from a modal: `stripChrome` below has already had
  // to find the same box (it peels this very run to reach it), so the two answers cannot disagree.
  //
  // The transcript above stays raw and the box stays stripped, exactly as on any other idle screen —
  // the popup is simply lifted out of the mirror, where a 220-column list soft-wrapped into an
  // unreadable wall on a phone, and rendered as a list.
  if (hasInputBox(lines)) {
    const autoRegion = detectAutocompleteRegion(lines);
    if (autoRegion) {
      const before = trimTrailingBlank(stripChrome(lines));
      const blocks: Block[] = [];
      if (before.length > 0) blocks.push({ kind: "raw", lines: before });
      blocks.push({
        kind: "autocomplete",
        autocomplete: autoRegion.model,
        lines: lines.slice(autoRegion.startLine),
      });
      return blocks;
    }
  }

  return [{ kind: "raw", lines: stripChrome(lines) }];
}

export { extractStatusLines, extractInputDraft };

export const claudeAdapter: HarnessAdapter = {
  agent: "claude",
  buildBlocks: claudeBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  // The reply path's pre-flight: Claude's input box is exactly what `hasInputBox` finds, and its
  // absence is exactly the condition under which typing lands in a modal instead (#34's shape).
  composerReady: hasInputBox,
  // Long sends never appear in the box as themselves — Claude collapses them into `[Pasted text #N
  // +M lines]` — so the reply guard's literal match can't verify them and the send stalls. These two
  // read that token: as send evidence when it's consistent with what we typed (.adr/0010), and as
  // "this isn't the user's text" for the stranded-draft preview's Take over.
  draftCarriesSend: pasteCarriesSend,
  draftIsOpaque: isPastePlaceholderOnly,
};
