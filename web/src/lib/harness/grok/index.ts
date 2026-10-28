// The Grok Build adapter. Chrome/status/draft are Tier 1. Interactive kinds with dated captures
// and notes: permission (`prompt-select` — cards are CLASSIFIED by row, not layout-pinned: the
// bottom Yes/No pair becomes the buttons, persistent rows never do; see permission.ts),
// ask_user_question radio cards (`prompt-select`, digit N submits; `z` is free-text — parsed to
// lock buttons, not typed from the phone), and plan approval (`menu` of footer-named keys,
// including the Tab-into-composer
// footer). Checkbox asks stay raw: a digit submits. The chrome probes sit on the REPLY path: registering any
// adapter switches core off one-shot send, after which `extractInputDraft` is what the submit key
// waits on and `composerReady` decides whether a byte is typed.
//
// The review bar is #99 (agy). That PR went hot on day one by emitting `prompt-select` (whose
// keystroke recipe is already live in core) and by prefix-matching inside `adapterFor`. Two rules
// this file exists to keep:
//
//   1. TIER 2 ONLY WHERE PROBED. Emitting `prompt-select` / `wizard` / `menu` is automatically
//      Tier 2 (HARNESS_CONTRIBUTING.md): dated fixture corpus, a notes file with the verified
//      recipe, `describeAdapterConformance`, and maintainer live-verification. Permission, ask,
//      and plan review clear that bar. A later lift must not start by synthesising digits from
//      numbered rows — ADR 0009 — unless a live probe of THAT screen says the digit is safe.
//   2. EXACT AGENT STRING. Register `agent: "grok"` only. Prefix-matching in `adapterFor` was the
//      other #99 reject: it widened claude/omp to any string with those prefixes. Catalog variant
//      folding (`grok-build` → grok slash palette) lives in `canonicalAgent`, never here.
//      Herdr reports `agent: "grok"` — live-checked 2026-08-23 against `herdr agent` kinds and
//      every Grok Build pane on the capture host (kind list, pane.agent, agent_session.agent).
//
// Permission and ask cards REPLACE the composer. Plan approval LEAVES a composer; composerReady
// is false because detectPlanMenu claims the screen. Option 1 on a permission card is
// always-approve and is never a button.

import { lineText, trimTrailingBlank, type Block, type StyledLine } from "../../blocks";
import type { DialogDetector, HarnessAdapter } from "../types";
import {
  composerPrompt,
  composerReady,
  extractInputDraft,
  extractStatusLines,
  prepareGrokDisplay,
  stripCanvasBackground,
  stripChrome,
} from "./chrome";
import { detectAskRegion } from "./ask";
import { detectPermissionRegion } from "./permission";
import { detectPlanMenuRegion } from "./plan-menu";
import { detectModelPickerRegion } from "./model-picker";
import { detectTrustRegion } from "./trust";

/** The detectors `grokBuildBlocks` runs, in its order, for the unread-dialog card's report (ADR 0123).
 *  Detection is text-based, so the canvas strip `grokBuildBlocks` does first changes no answer. */
const GROK_DIALOG_DETECTORS: readonly DialogDetector[] = [
  { name: "permission", detect: detectPermissionRegion },
  { name: "ask", detect: detectAskRegion },
  { name: "plan-menu", detect: detectPlanMenuRegion },
  { name: "model-picker", detect: detectModelPickerRegion },
  { name: "trust", detect: detectTrustRegion },
];

export function grokBuildBlocks(lines: StyledLine[]): Block[] {
  // Drop Grok's full-screen theme-canvas paint before any block is built, so every rendered
  // surface (raw mirror and dialog blocks alike) sits on the mirror's own ground — see
  // stripCanvasBackground. Detection is text-based and unaffected.
  lines = stripCanvasBackground(lines);
  const permission = detectPermissionRegion(lines);
  if (permission) {
    const before = trimTrailingBlank(lines.slice(0, permission.startLine));
    const blocks: Block[] = [];
    if (before.length > 0) blocks.push({ kind: "raw", lines: before });
    blocks.push({
      kind: "prompt-select",
      prompt: permission.model,
      lines: lines.slice(permission.startLine),
    });
    return blocks;
  }

  const ask = detectAskRegion(lines);
  if (ask) {
    const before = trimTrailingBlank(lines.slice(0, ask.startLine));
    const blocks: Block[] = [];
    if (before.length > 0) blocks.push({ kind: "raw", lines: before });
    blocks.push({ kind: "prompt-select", prompt: ask.model, lines: lines.slice(ask.startLine) });
    return blocks;
  }

  const plan = detectPlanMenuRegion(lines);
  if (plan) {
    const before = trimTrailingBlank(lines.slice(0, plan.startLine));
    const blocks: Block[] = [];
    if (before.length > 0) blocks.push({ kind: "raw", lines: before });
    blocks.push({ kind: "menu", menu: plan.model, lines: lines.slice(plan.startLine) });
    return blocks;
  }

  const picker = detectModelPickerRegion(lines);
  if (picker) {
    const before = trimTrailingBlank(lines.slice(0, picker.startLine));
    const blocks: Block[] = [];
    if (before.length > 0) blocks.push({ kind: "raw", lines: before });
    blocks.push({ kind: "prompt-select", prompt: picker.model, lines: lines.slice(picker.startLine) });
    return blocks;
  }

  const trust = detectTrustRegion(lines);
  if (trust) {
    const before = trimTrailingBlank(lines.slice(0, trust.startLine));
    const blocks: Block[] = [];
    if (before.length > 0) blocks.push({ kind: "raw", lines: before });
    blocks.push({ kind: "prompt-select", prompt: trust.model, lines: lines.slice(trust.startLine) });
    return blocks;
  }

  return [{ kind: "raw", lines: stripChrome(lines) }];
}

export { extractStatusLines, extractInputDraft };

// How many of the screen's last non-blank rows may carry a dialog's footer: the same window Claude's
// `modalOnScreen` reads (claude/index.ts MODAL_HINT_ROWS).
const MODAL_HINT_ROWS = 6;
// grok's footer grammar: `Key:verb` hints joined by ` │ ` (`Tab:next answer  │  Esc:scrollback  │
// Shift+x:dismiss`, grok/ASK_NOTES.md; `… │ Ctrl+c:cancel │ Esc:scrollback`, PERMISSION_NOTES.md).
const KEY_HINT = /^[A-Za-z][\w+.-]*:\S/;

/** A row of two or more `Key:verb` hints joined by `│`. */
function isKeyHintRow(text: string): boolean {
  const hints = text.trim().split(/\s*│\s*/);
  return hints.length >= 2 && hints.every((hint) => KEY_HINT.test(hint));
}

/**
 * Positive evidence of a grok dialog for the unread-dialog card (.adr/0053, addendum 2026-09-26): one
 * of the last rows is grok's key-hint footer. The shell after exit (`Resume this session with: grok
 * --resume <id>`) prints none, and the card no longer flashes over it, which would have offered to
 * send ctrl+c to the shell (harness canary 2026-10-12, Grok Build 1.0.50).
 */
function grokModalOnScreen(lines: StyledLine[]): boolean {
  const rows: string[] = [];
  for (let i = lines.length - 1; i >= 0 && rows.length < MODAL_HINT_ROWS; i--) {
    const text = lineText(lines[i]!);
    if (text.trim() !== "") rows.push(text);
  }
  return rows.some(isKeyHintRow);
}

export const grokAdapter: HarnessAdapter = {
  agent: "grok",
  buildBlocks: grokBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  composerReady,
  // The way OUT of a grok modal, for the unread-dialog card (.adr/0053) — and the reason the key is
  // DECLARED per adapter rather than assumed to be Escape. Read from `grok/PERMISSION_NOTES.md`
  // (`… Ctrl+o:always-approve │ Ctrl+c:cancel │ Esc:scrollback`) and `grok/ASK_NOTES.md`
  // (`Tab:next answer │ Esc:scrollback │ Shift+x:dismiss`): on grok, Escape opens the scrollback
  // view. Ctrl+C is the cancel.
  cancelKey: "ctrl+c",
  modalOnScreen: grokModalOnScreen,
  dialogDetectors: GROK_DIALOG_DETECTORS,
  composerPrompt,
  // Drops the scrollbar track and the terminal padding from the phone mirror's wrapped view.
  prepareDisplay: prepareGrokDisplay,
};
