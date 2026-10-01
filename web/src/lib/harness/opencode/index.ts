// The opencode adapter — registered by Herdr's `agent` string for opencode panes (verified live:
// herdr reports `agent: "opencode"` with an agent_session ref). It is Tier 1 chrome plus the Tier-2
// permission-dialog lift, following the shape the omp and codex adapters established:
//
//   * `buildBlocks` — the permission dialog lifts into a `prompt-select` block (tappable buttons;
//     the generic race guard, renderer and conformance invariants come with the kind), and so do
//     the `question` tool's dialogs (issue 329: question.ts and question-tabs.ts); every other
//     screen stays RAW with the composer's own chrome (draft rows, model row, rule, status rows)
//     stripped off the tail.
//   * `extractStatusLines` — the status rows opencode paints BELOW its rule (cwd, key hints, the
//     token/cost run, the version), re-surfaced as app chrome instead of being lost with the strip.
//   * `extractInputDraft` — a stranded draft read off the interior rows, placeholder refused.
//   * `composerReady` + `composerPrompt` — the reply path's pre-flight and destructive-sweep
//     binding. Registering ANY adapter swaps core off the one-shot send (reply-action.ts), so these
//     two are what turn "reply" from type-and-pray into type-then-verify for opencode panes.
//
// The measurement record (fixture corpus, probed choreography, and the decisions above) lives in
// web/src/fixtures/panes/README.md's opencode section and PERMISSION_NOTES.md beside this file.

import { isBlank, lineText, type Block, type StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import {
  composerPrompt,
  draftIsOpaque,
  extractInputDraft,
  extractStatusLines,
  hasComposer,
  modalOnScreen,
  stripChrome,
} from "./chrome";
import { detectPermissionDialog } from "./dialog";
import { isBareBar } from "./markers";
import { detectQuestionDialog } from "./question";
import { detectQuestionTabs } from "./question-tabs";
import { opencodeReplyChunks } from "./reply-chunks";

/** The mirror rows above a dialog that starts at `startLine`. The block carries the question itself,
 *  so the mirror keeps only what is above it: the dialog's top padding (a bare bar row) would hang
 *  there alone, so it goes with the blank rows. */
function mirrorAbove(lines: StyledLine[], startLine: number): StyledLine[] {
  let end = startLine;
  while (end > 0 && (isBlank(lineText(lines[end - 1]!)) || isBareBar(lineText(lines[end - 1]!)))) end--;
  return lines.slice(0, end);
}

/**
 * The adapter's block pipeline: the permission dialog at the tail lifts into a `prompt-select`
 * block (its region [option row … tail] replaced by buttons, title and subject above kept raw), and
 * so does a single-select question dialog (its region [question … tail] replaced, issue 329). The
 * question dialogs with a tab bar lift too (`question-tabs.ts`): a multi-select question and its
 * Confirm tab into a `multi-select` block, a many-question call's steps and its Confirm tab into a
 * `wizard` or `multi-select` block, each replacing [tab row … tail]. Anything else is one raw block
 * with the composer tail stripped. The registry only ever hands this function an opencode pane, so
 * there is no per-agent gate here.
 */
export function opencodeBuildBlocks(lines: StyledLine[]): Block[] {
  const dialog = detectPermissionDialog(lines);
  if (dialog !== null) {
    return [
      { kind: "raw", lines: lines.slice(0, dialog.startLine) },
      { kind: "prompt-select", prompt: dialog.model, lines: lines.slice(dialog.startLine) },
    ];
  }
  const question = detectQuestionDialog(lines);
  if (question !== null) {
    return [
      { kind: "raw", lines: mirrorAbove(lines, question.startLine) },
      { kind: "prompt-select", prompt: question.model, lines: lines.slice(question.startLine) },
    ];
  }
  const tabs = detectQuestionTabs(lines);
  if (tabs !== null) {
    const raw: Block = { kind: "raw", lines: mirrorAbove(lines, tabs.startLine) };
    const rest = lines.slice(tabs.startLine);
    return tabs.kind === "wizard"
      ? [raw, { kind: "wizard", wizard: tabs.model, lines: rest }]
      : [raw, { kind: "multi-select", multi: tabs.model, lines: rest }];
  }
  return [{ kind: "raw", lines: stripChrome(lines) }];
}

export const opencodeAdapter: HarnessAdapter = {
  agent: "opencode",
  buildBlocks: opencodeBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  composerReady: hasComposer,
  // The unread-dialog card's one key (.adr/0053), read from opencode's own screens and probed live
  // on 1.18.32 (2026-09-26): every picker prints it as its `esc` hint (oc--agents-picker.txt,
  // oc--command-palette.txt) and Escape closes it; on the permission dialog Escape declines (the
  // "Always allow" step goes back to the first step, the first step closes and the request is
  // rejected). Declared only now that composerReady finds the composer at 50 columns, so the card
  // cannot stand over a healthy narrow pane.
  cancelKey: "Escape",
  modalOnScreen,
  composerPrompt,
  replyChunks: opencodeReplyChunks,
  draftIsOpaque,
};
