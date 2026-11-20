// The shared types of the desktop keymap core (M108). Pure types: nothing here runs.

import type { ActionId, ModeId } from "./actions";

/** One key with its modifiers. `meta` is `metaKey` (Cmd on a Mac). See `chord.ts` for the key form. */
export interface Chord {
  readonly key: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

/** One parsed binding. `prefix` is true for `prefix+x`. `index` is the digit of an indexed action. */
export interface Binding {
  readonly prefix: boolean;
  readonly chord: Chord;
  readonly index?: number;
}

/**
 * What the operator's `shortcuts.toml` delivers over the wire, the shape spec 02's bridge reader
 * sends: every value is a list (the bridge turns a string into a one-item list and `""` into `[]`).
 * The key `prefix` holds the prefix chords, every other key is an action id.
 */
export interface UserShortcuts {
  [name: string]: string[];
}

export type DiagnosticCode =
  | "invalid-binding"
  | "range-not-indexed"
  | "indexed-needs-digit"
  | "unsafe-direct"
  | "browser-reserved"
  | "reserved"
  | "collision"
  | "prefix-in-mode"
  | "unknown-action"
  | "herdr-name"
  | "invalid-prefix";

/** A binding that was dropped, and why. The rest of the file still loads. The message is English,
 *  for the operator who edits the file, and is never translated. */
export interface Diagnostic {
  /** The action id as written in the file, or `prefix`. */
  readonly action: string;
  /** The binding text as written, empty when there was none. */
  readonly binding: string;
  readonly code: DiagnosticCode;
  readonly message: string;
}

/** What one key tap did in the keymap. The action table's ids reach the app through `run`. */
export interface Hit<Id extends string = ActionId> {
  readonly action: Id;
  readonly index?: number;
  readonly opensMode?: ModeId;
  /** Running the action ends its sticky mode, after it ran. */
  readonly leavesMode?: true;
}

export interface ModeKeymap<Id extends string = ActionId> {
  readonly keys: ReadonlyMap<string, Hit<Id>>;
  /** Chord ids that leave the mode: `esc` and the keys the mode names. */
  readonly exits: ReadonlySet<string>;
}

export interface Keymap<Id extends string = ActionId> {
  /** Every key that enters the prefix mode. The first one is the primary prefix, for display. */
  readonly prefix: readonly Chord[];
  /** Direct bindings in the normal mode, by chord id. Each one carries a modifier. */
  readonly direct: ReadonlyMap<string, Hit<Id>>;
  /** `prefix+x` bindings, by the chord id of `x`. */
  readonly prefixed: ReadonlyMap<string, Hit<Id>>;
  readonly modes: ReadonlyMap<ModeId, ModeKeymap<Id>>;
  /** The live bindings of every action in the table, in table order. Unbound is an empty list. */
  readonly bindings: ReadonlyMap<Id, readonly Binding[]>;
  readonly diagnostics: readonly Diagnostic[];
  /** Whether `mod` meant Cmd when the keymap was built. */
  readonly mac: boolean;
}

/** The part of a `KeyboardEvent` the resolver reads, so a test needs no DOM. */
export interface KeyLike {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing: boolean;
  readonly keyCode: number;
  /** `event.getModifierState("AltGraph")`. */
  readonly altGraph: boolean;
  /** `event.repeat`. A held prefix never toggles. */
  readonly repeat?: boolean;
}

export type Mode = "normal" | "prefix" | ModeId;

export type Outcome<Id extends string = ActionId> =
  /** Not ours: the key goes on as usual. */
  | { readonly type: "pass" }
  /** Ours and consumed, nothing runs. */
  | { readonly type: "swallow" }
  | { readonly type: "enter-prefix" }
  /** The prefix pressed twice: send this chord to the focused pane. */
  | { readonly type: "send-prefix"; readonly chord: Chord }
  | { readonly type: "cancel" }
  | { readonly type: "run"; readonly action: Id; readonly index?: number }
  | { readonly type: "mode"; readonly id: ModeId }
  | { readonly type: "leave-mode" };
