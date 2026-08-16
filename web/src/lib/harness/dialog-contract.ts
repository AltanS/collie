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

/** An interactive block kind — every `Block["kind"]` except `raw`. */
export type DialogKind = keyof DialogModels;

/** Pull the typed model off a block of `kind`, or null when the block is a different kind. The one
 *  place that knows which field name each block uses for its payload. */
export function dialogModelOf<K extends DialogKind>(block: Block, kind: K): DialogModels[K] | null {
  if (block.kind !== kind) return null;
  // The switch narrows `block` per kind; the cast is on the RESULT only (TS can't relate the
  // narrowed block back to the generic K), and every arm returns that kind's own payload.
  switch (block.kind) {
    case "prompt-select":
      return block.prompt as DialogModels[K];
    case "wizard":
      return block.wizard as DialogModels[K];
    case "preview-select":
      return block.preview as DialogModels[K];
    case "multi-select":
      return block.multi as DialogModels[K];
    case "menu":
      return block.menu as DialogModels[K];
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

/** kind → comparators. The whole table is the contract; adding a block kind means adding a row. */
export const DIALOG_CONTRACT: { [K in DialogKind]: DialogComparators<DialogModels[K]> } = {
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
