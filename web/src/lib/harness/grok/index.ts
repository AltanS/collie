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
//
// Permission and ask cards REPLACE the composer. Plan approval LEAVES a composer; composerReady
// is false because detectPlanMenu claims the screen. Option 1 on a permission card is
// always-approve and is never a button.

import { trimTrailingBlank, type Block, type StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import {
  composerPrompt,
  composerReady,
  extractInputDraft,
  extractStatusLines,
  stripCanvasBackground,
  stripChrome,
} from "./chrome";
import { detectAskRegion } from "./ask";
import { detectPermissionRegion } from "./permission";
import { detectPlanMenuRegion } from "./plan-menu";

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

  return [{ kind: "raw", lines: stripChrome(lines) }];
}

export { extractStatusLines, extractInputDraft };

export const grokAdapter: HarnessAdapter = {
  agent: "grok",
  buildBlocks: grokBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  composerReady,
  composerPrompt,
};
