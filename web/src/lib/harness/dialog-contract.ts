// The DIALOG CONTRACT — the one table that says, per interactive block kind, how to get its model
// out of a Block and how to compare two derivations of it. It is what makes the race guard generic:
// lib/dialog-guard.ts re-derives through `adapterFor(agent).buildBlocks` and then asks this table
// whether the fresh screen is still the one the user tapped, so an adapter that emits a block kind
// gets the guard for free — no harness ever appears in the guard's imports.
//
// The comparators themselves live next to their model types (harness/*-model.ts), because they ARE
// part of those contracts: the exact semantics of "same dialog" differ per kind and were each
// established empirically (a menu ARROW ignores the leftRight label it is about to change; the
// multi-select Submit walk ignores the pointer it is about to move but NOT a checkbox that flipped
// underfoot; the preview note flow ignores the note it is about to edit). This module only wires
// kind → {commits, identity, signature, region}; it invents no semantics of its own.
//
// Two signature accessors, because two different things are being protected:
//   * `signature` — the FRESHNESS token the client comparators lean on, normalised where the
//     choreography legitimately changes the screen (preview: coreSignature; multi-select: the
//     pointer/checkbox-normalised signature). The conformance suite pins it non-empty and
//     text-sensitive: an adapter returning "" or a constant silently disables the guard.
//   * `region` — the LITERAL text of the region, handed to the bridge as the expected-prompt binding
//     for the first write (HERDR prompt-binding). It must be text that is really on screen, so the
//     normalised signature can't stand in for it.
//
// Types + pure functions. It imports the neutral models and the Block AST only — never the registry,
// never a harness — so a model module can never end up depending on an adapter.

import type { Block } from "../blocks";
import { menusEqual, menusSameIdentity, type MenuModel } from "./menu-model";
import { multiSelectEquals, multiSelectIdentity, type MultiSelectModel } from "./multi-select-model";
import { previewCoreEqual, previewsEqual, type PreviewSelectModel } from "./preview-model";
import { promptsEqual, promptsSameIdentity, type PromptModel } from "./prompt-model";
import { wizardsEqual, type WizardModel } from "./wizard-model";

/** The model each interactive block kind carries. Keys are exactly the non-`raw` `Block["kind"]`s —
 *  a new interactive kind that lands without an entry here fails to typecheck in `dialogModelOf`. */
export interface DialogModels {
  "prompt-select": PromptModel;
  wizard: WizardModel;
  "preview-select": PreviewSelectModel;
  "multi-select": MultiSelectModel;
  menu: MenuModel;
}

/** An interactive block kind — every `Block["kind"]` that OWNS THE KEYBOARD. `raw` is not one, and
 *  neither is `autocomplete`: a completion popup is painted while the agent's input box is live under
 *  it, so it emits no keystroke and races nothing. */
export type DialogKind = keyof DialogModels;

/**
 * Whether this block's screen OWNS THE TUI's KEYBOARD — i.e. whether free text typed at it would be
 * swallowed and the submit key answer a modal instead (#34). Exactly the kinds with a row in
 * `DIALOG_CONTRACT`, which is the definition rather than a parallel list: a kind that ships without a
 * row has no committing keystroke to guard, so by construction it does not own the keyboard.
 *
 * `agent-chat.tsx`'s `dialogPresent` is this predicate over the built blocks. It used to be
 * `kind !== "raw"`, which was the same set until a PRESENTATIONAL non-raw kind existed; with
 * `autocomplete` it would have locked the composer out of a pane whose input box is demonstrably live.
 */
export function blockOwnsKeyboard(block: Block): boolean {
  return block.kind in DIALOG_CONTRACT;
}

/** Pull the typed model off a block of `kind`, or null when the block is a different kind. The one
 *  place that knows which field name each block uses for its payload. */
export function dialogModelOf<K extends DialogKind>(block: Block, kind: K): DialogModels[K] | null {
  if (block.kind !== kind) return null;
  // SAFETY: `block.kind === kind` was just checked, and `dialogPayload` returns exactly the payload
  // of the kind it was handed — which is `DialogModels[block.kind]`, i.e. `DialogModels[K]`. The
  // assertion exists only because TS cannot relate the narrowed `block` back to the generic `K`;
  // the per-kind field names it depends on are all checked in `dialogPayload` itself.
  return dialogPayload(block) as DialogModels[K] | null;
}

/** The payload of whatever kind `block` is — the one place each block's field name is written down.
 *  Every arm is fully typechecked against `DialogModels`, so a renamed field fails to compile. */
function dialogPayload(block: Block): DialogModels[DialogKind] | null {
  switch (block.kind) {
    case "prompt-select":
      return block.prompt;
    case "wizard":
      return block.wizard;
    case "preview-select":
      return block.preview;
    case "multi-select":
      return block.multi;
    case "menu":
      return block.menu;
    default:
      return null;
  }
}

/** What the race guard needs to know about one dialog kind. */
export interface DialogComparators<M> {
  /**
   * "Same dialog, same visible state" — the comparison a COMMITTING keystroke must pass. Anything
   * the user could see that would re-route the keystroke participates.
   */
  commits(a: M, b: M): boolean;
  /**
   * "Same dialog" only — the weaker comparison for a keystroke whose OWN effect is the change
   * (a menu arrow moving the highlight, the Submit walk moving the pointer, the note flow opening
   * the input). Identical to `commits` for the kinds whose keys all commit.
   */
  identity(a: M, b: M): boolean;
  /** The freshness token the comparators lean on — pinned non-empty + text-sensitive by conformance. */
  signature(m: M): string;
  /** The literal on-screen region text bound to the first write (the bridge's expected prompt). */
  region(m: M): string;
}

/** The shape of the contract table: one row of comparators per interactive block kind. */
export type DialogContract = { [K in DialogKind]: DialogComparators<DialogModels[K]> };

/** kind → comparators. The whole table is the contract; adding a block kind means adding a row. */
export const DIALOG_CONTRACT: DialogContract = {
  "prompt-select": {
    // Every ANSWER key commits (the digit IS the answer). The feedback flow is the one multi-step
    // recipe here (digit → verify focus → type → Enter), and it moves the pointer and fills the input
    // itself, so its mid-flight polls key on the pointer-/text-independent identity.
    commits: promptsEqual,
    identity: promptsSameIdentity,
    signature: (m) => m.signature,
    region: (m) => m.signature,
  },
  wizard: {
    // Every wizard key commits too — a digit selects AND advances; Left/Right change the step.
    commits: wizardsEqual,
    identity: wizardsEqual,
    signature: (m) => m.signature,
    region: (m) => m.signature,
  },
  "preview-select": {
    // The choreography (digit → verify pointer → Enter, n → verify focus → type → Escape) moves the
    // pointer and the note itself, so its mid-flight polls key on the core identity.
    commits: previewsEqual,
    identity: previewCoreEqual,
    signature: (m) => m.coreSignature,
    region: (m) => m.regionSignature,
  },
  "multi-select": {
    // The Submit walk moves the pointer deliberately; `multiSelectIdentity` ignores the pointer but
    // NOT a checkbox that flipped underfoot (a second device), which must abort the walk.
    commits: multiSelectEquals,
    identity: multiSelectIdentity,
    signature: (m) => m.signature,
    region: (m) => m.regionSignature,
  },
  menu: {
    // A footer-named key COMMITS (in the `/model` picker, Enter writes the user's default), so it
    // takes the full signature check; an arrow only moves the highlight — which is precisely what
    // changes the signature — so it compares identity without the leftRight label.
    commits: menusEqual,
    identity: menusSameIdentity,
    signature: (m) => m.signature,
    region: (m) => m.signature,
  },
};

/**
 * The comparators for a kind known only at runtime, erased to the union of every model.
 *
 * The conformance suite (harness/conformance.ts) walks `DialogKind` in one generic pass; addressing
 * the table with a union key would otherwise INTERSECT the five model types into a parameter type no
 * value can satisfy. Erasing once, here, keeps that erasure in the module that owns the table
 * instead of at each call site — and callers only ever pair these comparators with models the same
 * table produced for the same kind.
 */
export function dialogComparators(kind: DialogKind): DialogComparators<DialogModels[DialogKind]> {
  // SAFETY: every row of `DIALOG_CONTRACT` compares models of exactly one kind. Widening the model
  // parameter to the union is sound for the only use there is — comparing two derivations of the
  // SAME screen, which are the same kind by construction (`modelsOf(adapter, name, kind)`).
  return DIALOG_CONTRACT[kind] as DialogComparators<DialogModels[DialogKind]>;
}
