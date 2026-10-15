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
import { blockOwnsKeyboard, dialogModelOf, DIALOG_CONTRACT } from "../harness/dialog-contract";
import { shortHash, type Ask, type AskKind, type AskOption } from "./surface";

/** The blocks the phone would build for this screen: the agent's adapter, or one raw block. */
export function readerBlocks(rows: StyledLine[], agent: string | undefined): Block[] {
  return buildBlocks(rows, { agent });
}

function options(labels: readonly string[]): AskOption[] {
  return labels.map((label, i) => ({ id: String(i + 1), label }));
}

interface Lifted {
  readonly kind: AskKind;
  readonly labels: readonly string[];
  readonly signature: string;
}

function lifted(block: Block): Lifted | null {
  switch (block.kind) {
    case "prompt-select": {
      const m = dialogModelOf(block, "prompt-select")!;
      return {
        kind: m.family === "select" ? "question" : "permission",
        labels: m.options.map((o) => o.label),
        signature: DIALOG_CONTRACT["prompt-select"].signature(m),
      };
    }
    case "wizard": {
      const m = dialogModelOf(block, "wizard")!;
      const labels = m.phase === "question" ? m.options.map((o) => o.label) : m.answers.map((a) => a.answer);
      return { kind: "question", labels, signature: DIALOG_CONTRACT.wizard.signature(m) };
    }
    case "preview-select": {
      const m = dialogModelOf(block, "preview-select")!;
      return { kind: "question", labels: m.options.map((o) => o.label), signature: DIALOG_CONTRACT["preview-select"].signature(m) };
    }
    case "multi-select": {
      const m = dialogModelOf(block, "multi-select")!;
      const labels = m.phase === "checkbox" ? m.options.map((o) => o.label) : [];
      return { kind: "question", labels, signature: DIALOG_CONTRACT["multi-select"].signature(m) };
    }
    case "menu": {
      const m = dialogModelOf(block, "menu")!;
      return { kind: "menu", labels: m.actions.map((a) => a.label), signature: DIALOG_CONTRACT.menu.signature(m) };
    }
    default:
      return null;
  }
}

/**
 * The ask a typed block lifted, or null. `revision` is the read the blocks came from; the id is the
 * read and the hash, so the same dialog on the same read always gets the same id. Ids become single
 * use in spec 08; here they only name the ask in the shadow's log.
 */
export function liftAsk(blocks: readonly Block[], revision: number): Ask | null {
  for (const block of blocks) {
    if (!blockOwnsKeyboard(block)) continue;
    const found = lifted(block);
    if (found === null) continue;
    const hash = shortHash([found.kind, ...found.labels, found.signature].join("\n"));
    return { id: `ask-${String(revision)}-${hash.slice(0, 8)}`, kind: found.kind, options: options(found.labels), channel: "keys", hash };
  }
  return null;
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
