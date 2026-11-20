// The mode machine: one key event in, one outcome out (M108). No DOM and no React: the root
// listener (spec 03) reads a `KeyboardEvent` into a `KeyLike`, asks `press`, and acts on the answer.
//
// The modes follow Herdr (src/client/shell/input.rs, the mode router):
//   normal    a direct binding runs; the prefix enters `prefix`; every other key is not ours.
//   prefix    one shot, no timeout. The prefix again sends it literally; Esc cancels; a match runs
//             and returns; any other key is swallowed and returns.
//   sticky    a mode a binding opened (navigate, resize). It stays until Esc, or a key the mode names.
//             Its own keys run, the prefix still opens `prefix` over it. A press with Ctrl or Meta
//             that is none of those passes (ctrl+c, cmd+r keep working); a bare key is swallowed.
//
// How a key event meets a binding, in order:
//   1. `event.key` first, so a layout that moves a letter keeps working by what the key says.
//   2. A shifted symbol matches the binding written without Shift (`?` for `?`, and for `shift+/`).
//   3. Only when nothing matched, a ctrl-only or alt-only chord retries with the physical key
//      (`code` KeyA..KeyZ, Digit0..9), and only when `key` is not itself an ASCII letter or digit:
//      that is a non-Latin layout, or a Mac's Option letter. A Dvorak `ctrl+x` stays `ctrl+x`.
//      A bare key retries the same way inside `prefix` and a sticky mode, never in `normal`,
//      where a bare key is typing.
//   AltGr reaches the page as Ctrl+Alt on Windows. A key typed with AltGr is its character with no
//   modifier, so `ctrl+alt+q` never fires on a German `@`.

import type { ActionId, ModeId } from "./actions";
import { chordId, eventKeyId, isLetter, isSingleChar, shiftedSymbol } from "./chord";
import type { Chord, Hit, KeyLike, Keymap, Mode, Outcome } from "./types";

export interface Resolver<Id extends string = ActionId> {
  /** The mode now: `prefix` while the prefix is open, else the sticky mode, else `normal`. */
  readonly mode: Mode;
  /** The sticky mode under the prefix, or null. */
  readonly sticky: ModeId | null;
  press(event: KeyLike): Outcome<Id>;
  /** Back to `normal`. For a blur. */
  reset(): void;
  /** Ends a pending prefix and leaves a sticky mode as it is. For a route change. */
  cancelPrefix(): void;
}

/** Keys that are not a choice yet: a modifier on its own, a dead key, an IME step. */
const IGNORED_KEYS: ReadonlySet<string> = new Set([
  "Control",
  "Shift",
  "Alt",
  "Meta",
  "AltGraph",
  "OS",
  "Super",
  "Hyper",
  "CapsLock",
  "Fn",
  "Dead",
  "Unidentified",
  "Process",
]);

const IME_KEY_CODE = 229;
const ASCII_ALPHANUMERIC = /^[a-z0-9]$/;
const PHYSICAL_LETTER = /^Key([A-Z])$/;
const PHYSICAL_DIGIT = /^Digit([0-9])$/;

const PASS = { type: "pass" } as const;
const SWALLOW = { type: "swallow" } as const;
const ENTER_PREFIX = { type: "enter-prefix" } as const;
const CANCEL = { type: "cancel" } as const;
const LEAVE_MODE = { type: "leave-mode" } as const;

interface Press {
  readonly key: string;
  readonly code: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly repeat: boolean;
}

function toPress(event: KeyLike): Press {
  const key = eventKeyId(event.key);
  const isAltGraphChar = event.altGraph && isSingleChar(key);
  return {
    key,
    code: event.code,
    // AltGr is how the character was typed, not a chord. On Windows it also sets Ctrl.
    ctrl: isAltGraphChar && event.altKey ? false : event.ctrlKey,
    alt: isAltGraphChar ? false : event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
    repeat: event.repeat === true,
  };
}

/** The chord ids a press may match, best first. */
function keyIds(press: Press): string[] {
  const mods = { ctrl: press.ctrl, alt: press.alt, meta: press.meta };
  const ids = [chordId({ ...mods, key: press.key, shift: press.shift })];
  if (!press.shift || !isSingleChar(press.key) || isLetter(press.key)) return ids;
  // A shifted symbol already says Shift: `?` is the binding `?`, and `/` with Shift is `shift+/`.
  ids.push(chordId({ ...mods, key: press.key, shift: false }));
  const typed = shiftedSymbol(press.key);
  if (typed !== null) ids.push(chordId({ ...mods, key: typed, shift: false }));
  return ids;
}

/**
 * The chord id of the physical key, for a ctrl-only or alt-only press on a non-Latin layout, and
 * for a bare press where the caller says the key is a choice (inside the prefix or a mode).
 */
function physicalId(press: Press, allowBare: boolean): string | null {
  const isBare = !press.ctrl && !press.alt && !press.shift && !press.meta;
  const isCtrlOrAltOnly = !press.shift && !press.meta && press.ctrl !== press.alt;
  if (!isCtrlOrAltOnly && !(allowBare && isBare)) return null;
  if (ASCII_ALPHANUMERIC.test(press.key)) return null;
  const letter = PHYSICAL_LETTER.exec(press.code)?.[1];
  const digit = PHYSICAL_DIGIT.exec(press.code)?.[1];
  const key = letter === undefined ? digit : letter.toLowerCase();
  if (key === undefined) return null;
  return chordId({ key, ctrl: press.ctrl, alt: press.alt, shift: false, meta: false });
}

/** The id of the first binding the press matches, key first and the physical key last. */
function matchId(input: { press: Press; has: (id: string) => boolean; allowBare: boolean }): string | null {
  const { press, has, allowBare } = input;
  const byKey = keyIds(press).find(has);
  if (byKey !== undefined) return byKey;
  const byCode = physicalId(press, allowBare);
  return byCode !== null && has(byCode) ? byCode : null;
}

function lookup<T>(map: ReadonlyMap<string, T>, press: Press, allowBare = false): T | undefined {
  const id = matchId({ press, has: (candidate) => map.has(candidate), allowBare });
  return id === null ? undefined : map.get(id);
}

export function createResolver<Id extends string = ActionId>(keymap: Keymap<Id>): Resolver<Id> {
  const prefixes = new Map<string, Chord>(keymap.prefix.map((chord): [string, Chord] => [chordId(chord), chord]));
  let isInPrefix = false;
  let sticky: ModeId | null = null;

  function outcomeFor(hit: Hit<Id>): Outcome<Id> {
    if (hit.opensMode !== undefined) {
      sticky = hit.opensMode;
      return { type: "mode", id: hit.opensMode };
    }
    // The key ran and the mode ends with it: the outcome is still a `run`, so the app acts on it.
    if (hit.leavesMode) sticky = null;
    return hit.index === undefined ? { type: "run", action: hit.action } : { type: "run", action: hit.action, index: hit.index };
  }

  /** The prefix pressed in the normal mode or in a sticky mode. A held key never toggles. */
  function openPrefix(press: Press): Outcome<Id> {
    if (press.repeat) return SWALLOW;
    isInPrefix = true;
    return ENTER_PREFIX;
  }

  function pressNormal(press: Press): Outcome<Id> {
    if (lookup(prefixes, press) !== undefined) return openPrefix(press);
    const hit = lookup(keymap.direct, press);
    return hit === undefined ? PASS : outcomeFor(hit);
  }

  function pressInPrefix(press: Press): Outcome<Id> {
    const prefix = lookup(prefixes, press);
    if (prefix !== undefined) {
      if (press.repeat) return SWALLOW;
      isInPrefix = false;
      return { type: "send-prefix", chord: prefix };
    }
    isInPrefix = false;
    if (press.key === "esc") return CANCEL;
    const hit = lookup(keymap.prefixed, press, true);
    return hit === undefined ? SWALLOW : outcomeFor(hit);
  }

  function pressInMode(press: Press, id: ModeId): Outcome<Id> {
    const mode = keymap.modes.get(id);
    if (mode === undefined) throw new Error(`shortcuts: the keymap has no mode ${id}`);
    if (lookup(prefixes, press) !== undefined) return openPrefix(press);
    if (press.key === "esc" || matchId({ press, has: (candidate) => mode.exits.has(candidate), allowBare: true }) !== null) {
      sticky = null;
      return LEAVE_MODE;
    }
    const hit = lookup(mode.keys, press, true);
    if (hit !== undefined) return outcomeFor(hit);
    // Ctrl and Meta chords are not typing: ctrl+c and cmd+r keep working inside a mode.
    return press.ctrl || press.meta ? PASS : SWALLOW;
  }

  return {
    get mode(): Mode {
      if (isInPrefix) return "prefix";
      return sticky ?? "normal";
    },
    get sticky(): ModeId | null {
      return sticky;
    },
    press(event: KeyLike): Outcome<Id> {
      if (event.isComposing || event.keyCode === IME_KEY_CODE) return PASS;
      if (IGNORED_KEYS.has(event.key)) return PASS;
      const press = toPress(event);
      if (isInPrefix) return pressInPrefix(press);
      if (sticky !== null) return pressInMode(press, sticky);
      return pressNormal(press);
    },
    reset(): void {
      isInPrefix = false;
      sticky = null;
    },
    cancelPrefix(): void {
      isInPrefix = false;
    },
  };
}
