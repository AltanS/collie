// What the existing readers say about a screen, in the Surface's terms (M56 spec 04). Two readings:
//
//  - `liftAsk`: the dialog a typed block lifted, as an `Ask`. The block grammars stay where they are
//    (the per-harness readers under lib/harness); this only maps the block that owns the keyboard
//    through the dialog contract. The unread-dialog card is not a lift: it is the old readers' "I
//    cannot read this" and the fold's own `unreadable` replaces it (ARCHITECTURE.md section 3).
//  - `legacyFree`: the old send verdict the shadow compares against, "the old parser found the input
//    box and no dialog block owns the keyboard" (`composerReady` and agent-chat's `dialogPresent`).
//
// The agent string comes from the multiplexer and is passed through to the registry; this file names
// no harness.

import type { Block, StyledLine } from "../blocks";
import { buildBlocks } from "../harness/index";
import { adapterFor } from "../harness/registry";
import { blockOwnsKeyboard, dialogModelOf, DIALOG_CONTRACT, type DialogKind } from "../harness/dialog-contract";
import { shortHash, type Ask, type AskKind, type AskOption } from "./surface";

/** The blocks the phone would build for this screen: the agent's adapter, or one raw block. */
export function readerBlocks(rows: StyledLine[], agent: string | undefined): Block[] {
  return buildBlocks(rows, { agent });
}

function options(labels: readonly string[]): AskOption[] {
  return labels.map((label, i) => ({ id: String(i + 1), label }));
}

/**
 * A dialog a typed block lifted, before it has an id (M56 spec 08). The bridge's ask book gives it a
 * single-use id bound to `hash`, `region` and the pane generation; this module stays pure.
 */
export interface LiftedDialog {
  readonly kind: AskKind;
  /** The block kind it came from, a row of the dialog contract. */
  readonly blockKind: DialogKind;
  readonly labels: readonly string[];
  /** The contract's freshness signature of the block. */
  readonly signature: string;
  /**
   * The literal text of the dialog block on screen, from its own top edge to the footer: what the
   * ask id is bound to. Never rows above the dialog (a blinking transcript bullet there changed the
   * binding every second). Null when the grammar found no edge: the bridge refuses a tap then.
   */
  readonly region: string | null;
  /** The hash an `Ask` carries: the kind, the option labels in order and the block's text (which
   *  holds the subject or tool and the input shown). */
  readonly hash: string;
  /** The block itself, so the bridge can plan the keys of an option and read the pointer back. */
  readonly block: Block;
}

interface Lifted {
  readonly kind: AskKind;
  readonly blockKind: DialogKind;
  readonly labels: readonly string[];
  readonly signature: string;
  readonly region: string | null;
  /** What the hash covers besides the labels: the contract's signature, or the dialog block alone
   *  where the signature reads above the dialog. With no edge the signature stands in; no tap is taken. */
  readonly hashText: string;
}

function lifted(block: Block): Lifted | null {
  switch (block.kind) {
    case "prompt-select": {
      const m = dialogModelOf(block, "prompt-select")!;
      const c = DIALOG_CONTRACT["prompt-select"];
      return {
        kind: m.family === "select" ? "question" : "permission",
        blockKind: "prompt-select",
        labels: m.options.map((o) => o.label),
        signature: c.signature(m),
        // The dialog block alone, where the grammar's region reads above it (PromptModel.askRegion).
        region: m.askRegion === undefined ? c.region(m) : m.askRegion,
        hashText: m.askRegion ?? c.signature(m),
      };
    }
    case "wizard": {
      const m = dialogModelOf(block, "wizard")!;
      const labels = m.phase === "question" ? m.options.map((o) => o.label) : m.answers.map((a) => a.answer);
      return { kind: "question", blockKind: "wizard", labels, signature: DIALOG_CONTRACT.wizard.signature(m), region: DIALOG_CONTRACT.wizard.region(m), hashText: DIALOG_CONTRACT.wizard.signature(m) };
    }
    case "preview-select": {
      const m = dialogModelOf(block, "preview-select")!;
      const c = DIALOG_CONTRACT["preview-select"];
      return { kind: "question", blockKind: "preview-select", labels: m.options.map((o) => o.label), signature: c.signature(m), region: c.region(m), hashText: c.signature(m) };
    }
    case "multi-select": {
      const m = dialogModelOf(block, "multi-select")!;
      const c = DIALOG_CONTRACT["multi-select"];
      const labels = m.phase === "checkbox" ? m.options.map((o) => o.label) : [];
      return { kind: "question", blockKind: "multi-select", labels, signature: c.signature(m), region: c.region(m), hashText: c.signature(m) };
    }
    case "menu": {
      const m = dialogModelOf(block, "menu")!;
      return { kind: "menu", blockKind: "menu", labels: m.actions.map((a) => a.label), signature: DIALOG_CONTRACT.menu.signature(m), region: DIALOG_CONTRACT.menu.region(m), hashText: DIALOG_CONTRACT.menu.signature(m) };
    }
    default:
      return null;
  }
}

/** The first dialog a block that owns the keyboard lifted, or null. The unread-dialog card is not one. */
export function liftDialog(blocks: readonly Block[]): LiftedDialog | null {
  for (const block of blocks) {
    if (!blockOwnsKeyboard(block)) continue;
    const found = lifted(block);
    if (found === null) continue;
    const hash = shortHash([found.kind, ...found.labels, found.hashText].join("\n"));
    return { ...found, hash, block };
  }
  return null;
}

/** The ask of a lifted dialog under a given id: the options are its labels in order, ids from 1. */
export function askOfLift(dialog: LiftedDialog, id: string): Ask {
  return { id, kind: dialog.kind, options: options(dialog.labels), channel: "keys", hash: dialog.hash };
}

/**
 * The ask a typed block lifted, or null, with an id from its content alone. The bridge's ask book
 * replaces the id with a single-use one bound to the pane generation (M56 spec 08); this id only
 * names the ask where no book runs (shadow mode with the Send Protocol off, the corpus script).
 * `revision` is kept for the callers and not used: Herdr reads every pane at revision 0.
 */
export function liftAsk(blocks: readonly Block[], revision: number): Ask | null {
  void revision;
  const dialog = liftDialog(blocks);
  return dialog === null ? null : askOfLift(dialog, `ask-${dialog.hash.slice(0, 8)}`);
}

/**
 * The old verdict: the agent's adapter found its input box (`composerReady` answered true) and no
 * block owns the keyboard. An agent with no adapter, or an adapter that cannot tell, is not free.
 */
export function legacyFree(rows: StyledLine[], blocks: readonly Block[], agent: string | undefined): boolean {
  const adapter = adapterFor(agent);
  if (adapter?.composerReady === undefined) return false;
  let ready: boolean;
  try {
    ready = adapter.composerReady(rows);
  } catch {
    return false;
  }
  return ready && !blocks.some(blockOwnsKeyboard);
}
