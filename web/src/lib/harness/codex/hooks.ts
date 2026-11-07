// Codex's hook-trust prompt (HOOKS_NOTES.md). Codex asks before it runs a lifecycle hook that is new or
// changed, and it asks again at EVERY launch until the hook is trusted. Herdr's Codex integration
// installs a SessionStart hook in `~/.codex/hooks.json`, so on a Herdr host this is the first screen of
// every new Codex until the person trusts it, and the phone showed the unread-dialog card there. Captured
// on 0.166.0 and 0.167.0 (2026-11-07), the same copy on both:
//
//   Hooks need review
//   1 hook is new or changed.
//   Hooks can run outside the sandbox after you trust them.
//
// › 1. Review hooks
//   2. Trust all and continue
//   3. Continue without trusting (hooks won't run)
//
//   enter confirm · esc skip
//
// The rows are numbered, but no digit was pressed on this widget, so each button sends only what the
// screen names: the arrow walk the `›` pointer implies, then Enter (`enter confirm`), the recipe of the
// folder-trust prompt (trust.ts). Probed live on 0.167.0, 2026-11-07: `Down, Enter` trusted the hook and
// opened the composer, `Down, Down, Enter` and `Escape` (`esc skip`) both opened the composer with the
// hook untrusted, and the prompt came back at the next launch. `Review hooks` opens the hooks browser,
// which no grammar reads. The labels, their order, the title and the footer are all pinned; anything
// else refuses (fail-closed null), and so does an option that wraps on a narrow pane. Pure; no pane
// access.

import { trimTrailingBlank, type StyledLine } from "../../blocks";
import { pointerWalk } from "../menu-hints";
import type { PromptModel, PromptOption } from "../prompt-model";
import { isBlank, lastNonBlankIndex, lineText, regionSignature, rstrip, skipBlanksUp } from "./markers";

export interface HooksRegion {
  model: PromptModel;
  startLine: number;
}

const FOOTER = /^\s*enter confirm · esc skip$/;
const TITLE = /^\s*Hooks need review$/;
const OPTION = /^(?:› |\s{2})([1-3])\. (.+)$/;
const LABELS = ["Review hooks", "Trust all and continue", "Continue without trusting (hooks won't run)"] as const;
// Rows between the title and the option list: the count line and the sandbox warning, plus slack for a
// warning that wraps on a narrow pane.
const TITLE_REACH = 8;

/** The hook-trust prompt at the tail, or null. */
export function detectHooksRegion(lines: StyledLine[]): HooksRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const fi = lastNonBlankIndex(texts);
  if (fi < 3 || !FOOTER.test(texts[fi]!)) return null;

  // One blank row separates the footer from the options; the three options are contiguous.
  const bottom = skipBlanksUp(texts, fi - 1);
  if (bottom < 2) return null;
  const first = bottom - LABELS.length + 1;
  let pointed = -1;
  for (let i = 0; i < LABELS.length; i++) {
    const row = texts[first + i]!;
    const option = OPTION.exec(row);
    if (option === null || option[1] !== String(i + 1) || option[2]!.trim() !== LABELS[i]) return null;
    if (row.startsWith("› ")) {
      // Exactly one row carries the pointer; it is where a bare Enter lands.
      if (pointed >= 0) return null;
      pointed = i;
    }
  }
  if (pointed < 0) return null;

  // The title opens the section above the options: the warning rows, then a gap of blank rows.
  const top = skipBlanksUp(texts, first - 1);
  if (top < 0) return null;
  let titleRow = -1;
  for (let i = top; i >= 0 && top - i < TITLE_REACH; i--) {
    if (TITLE.test(texts[i]!)) {
      titleRow = i;
      break;
    }
    if (isBlank(texts[i]!)) break;
  }
  if (titleRow < 0) return null;

  const signature = regionSignature(lines, titleRow, fi + 1);
  if (signature === "") return null;

  const options: PromptOption[] = LABELS.map((label, i) => ({ label, keys: pointerWalk(pointed, i) }));
  options[pointed] = { ...options[pointed]!, keyLabel: "›" };

  return {
    startLine: titleRow,
    model: {
      question: "Hooks need review",
      subject: trimTrailingBlank(lines.slice(titleRow + 1, top + 1)),
      options,
      family: "trust",
      coreSignature: texts[titleRow]!.trim(),
      signature,
    },
  };
}
