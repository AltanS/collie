// The HarnessAdapter CONFORMANCE suite — the CI gate every adapter must clear before its dialog
// buttons are allowed to go hot. It is a single `describe`-registering function, parameterised on
// the adapter under test plus three fixture cohorts, so a future adapter (codex/pi/opencode) gets
// the exact same invariants for free by calling it from its own `*.test.ts`:
//
//   1. CONSERVATIVE DETECTION (fail-closed) — the adapter must return ONLY raw blocks on every
//      FOREIGN adapter's fixtures and on NEUTRAL (plain shell / log) output. A detector that lifts
//      an interactive block from a buffer it doesn't own would type keystrokes into a live terminal,
//      so "return null on anything unrecognised" is non-negotiable and pinned here.
//   2. TAIL-ANCHORING — every one of the adapter's OWN dialogs lifts ONLY while it sits at the
//      buffer tail. Append a couple of lines of ordinary output below it (the menu has scrolled up)
//      and detection must fall back to raw-only. This is the false-positive guard every detector
//      leans on (see the grammars' "the footer is the last non-blank line" invariant).
//   3. KEY-GRAMMAR VALIDITY — every keystroke any interactive block can emit is a valid Herdr
//      `pane.send_keys` key (HERDR_API.md §"send_keys key grammar"): a single literal char, a bare
//      special key, or a `+`-joined modifier chord. Multi-char digit runs ("10") and the paging/edit
//      keys (PageUp/Home/End/Delete) are rejected — Herdr answers those with `invalid_key`.
//   4. THE GENERIC MODAL CONTRACT — for any fixture that lifts a `menu` block: every action key came
//      out of the shared whitelist (menu-hints.ts) and none is a digit (.adr/0009), the model carries
//      a non-empty signature that MOVES when the region's text does (it is the whole race guard), and
//      the adapter's `composerReady` — if it has one — says false while the modal has the keyboard.
//      Neutral output must lift no menu at all. An adapter with no menu fixtures registers a todo.
//   5. THE DIALOG-MODEL CONTRACT — for EVERY block kind the adapter up-levels (the generalisation of
//      4's signature leg): the model's signature and its bound region text are non-empty, the
//      signature MOVES when a row the dialog was derived from changes, and the kind's comparators
//      (harness/dialog-contract.ts) agree — the same screen re-derived is the same dialog, a
//      perturbed one fails the COMMITTING comparison. That is precisely what the race guard
//      (lib/dialog-guard.ts) leans on to refuse a tap on a stale render; an adapter that emits a
//      constant signature would disable it silently. A kind the adapter never emits registers a todo.
//
// Pure + offline: it drives the adapter over the byte-faithful fixture corpus (web/src/fixtures/
// panes/*.txt) through the same parseAnsi → splitLines pipeline the renderer uses. It never touches
// a pane or the network (guard.ts owns that), so it can gate a read-only Tier-1 lift from fixtures
// alone.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { lineText, splitLines, type Block, type StyledLine } from "../blocks";
import type { HarnessAdapter } from "./types";
import {
  DIALOG_CONTRACT,
  dialogComparators,
  dialogModelOf,
  type DialogKind,
  type DialogModels,
} from "./dialog-contract";
import {
  WIZARD_BACK_KEYS,
  WIZARD_CANCEL_KEYS,
  WIZARD_NEXT_KEYS,
  WIZARD_SUBMIT_KEYS,
} from "./wizard-model";
import {
  MENU_DOWN_KEYS,
  MENU_LEFT_KEYS,
  MENU_RIGHT_KEYS,
  MENU_UP_KEYS,
  menuKeyFor,
} from "./menu-hints";

// Anchored on this file's own directory (NOT `new URL(..., import.meta.url)`, which Vite statically
// rewrites into a root-relative asset path) so fixtures resolve regardless of the run cwd. This file
// sits one level ABOVE the per-detector tests, so it's two ".."s to src, not three.
const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");

function loadLines(name: string): StyledLine[] {
  return splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
}

// A single unstyled visual line — the minimum an AnsiSegment needs (no colour flags). Used to
// synthesise the trailing output that pushes a dialog off the buffer tail.
function textLine(text: string): StyledLine {
  return { segments: [{ text, style: {}, muted: false }] };
}

// `DEFAULT_PROMPT_TAIL_LINES` in bridge/prompt-binding.ts, plus the two steps of the matcher this
// suite has to reproduce to check an adapter against it. Mirrored rather than imported: nothing in
// web/ imports bridge code (wire types are mirrored the same way). Both sides work on ALREADY-parsed
// text here, so the bridge's SGR strip has nothing left to do — what remains is its rstrip and its
// "blank rows are not rows" rule, which is the counting the tail window is expressed in.
const BRIDGE_PROMPT_TAIL_LINES = 6;

function normalizeRegion(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0);
}

/** Index in `fresh` of the LAST line of the LAST occurrence of `expected`, or -1. */
function lastMatchEnd(fresh: string[], expected: string[]): number {
  if (expected.length === 0) return -1;
  let end = -1;
  for (let start = 0; start <= fresh.length - expected.length; start++) {
    if (expected.every((line, offset) => fresh[start + offset] === line)) {
      end = start + expected.length - 1;
    }
  }
  return end;
}

// A couple of lines of ordinary agent output to append below a dialog. They must be NON-blank (a
// trailing blank run is trimmed off the tail by every detector, which would re-expose the footer)
// and must not themselves look like a menu footer or option row — so appending them makes the
// dialog's footer no longer the last non-blank line, and every tail-anchored detector bails.
function trailingOutput(): StyledLine[] {
  return [textLine("● Wrote the file"), textLine("  ⎿  done")];
}

/** The index of the last non-blank line — where every tail-anchored grammar's footer sits. */
function lastNonBlank(lines: StyledLine[]): number {
  let i = lines.length - 1;
  while (i >= 0 && lines[i]!.segments.map((s) => s.text).join("").trim() === "") i--;
  return i < 0 ? lines.length : i;
}

/** The signatures of every menu block in a build — the race guard's freshness token, in order. */
function menuSignatures(blocks: Block[]): string[] {
  return blocks.flatMap((b) => (b.kind === "menu" ? [b.menu.signature] : []));
}

/** Every interactive block kind, in the order the contract table declares them. A kind added to
 *  `DialogModels` without a fixture that lifts it registers a todo below, never a silent pass. */
// SAFETY: `DIALOG_CONTRACT` is annotated `DialogContract`, a mapped type whose keys ARE exactly
// `DialogKind` — so its own keys are that union and nothing else. `Object.keys` is only weakly typed
// because a wider object could be assigned; this table is a literal declared right here.
const DIALOG_KINDS = Object.keys(DIALOG_CONTRACT) as DialogKind[];

/** The models of `kind` the adapter lifts from `name`, in order (usually 0 or 1 — a grammar claims at
 *  most one tail dialog). Re-parses the fixture on every call, which is the point: the race guard
 *  re-derives from scratch on every tap, so the invariants must hold on a fresh derivation. */
function modelsOf<K extends DialogKind>(
  adapter: HarnessAdapter,
  name: string,
  kind: K,
): DialogModels[K][] {
  return modelsIn(adapter.buildBlocks(loadLines(name)), kind);
}

function modelsIn<K extends DialogKind>(blocks: Block[], kind: K): DialogModels[K][] {
  return blocks.flatMap((b) => {
    const model = dialogModelOf(b, kind);
    return model === null ? [] : [model];
  });
}

/** Append a marker to line `i`, keeping every existing segment (and its styling — the wizard's
 *  current chip is marked ONLY by a background colour, so a re-synthesised plain line would change
 *  more than the text). */
function perturbLine(lines: StyledLine[], i: number): StyledLine[] {
  const copy = [...lines];
  copy[i] = { segments: [...lines[i]!.segments, { text: " zqx", style: {}, muted: false }] };
  return copy;
}

// How far ABOVE the lifted region a perturbation may reach. Every grammar folds a bounded run of
// lines above its first option into the signature (the dialog's SUBJECT — the diff, command, or
// prompt it is about, which is what tells two same-shaped dialogs apart), and for the preview variant
// that subject is the ONLY thing the core signature takes in full: its option rows contribute their
// left column, and the preview pane / notes line are normalised out by design. So a probe confined to
// the region would find nothing to move there, and would be testing the normalisation rather than the
// guard. Sized past every grammar's own lookback.
const PERTURB_LOOKBACK = 60;

/**
 * Perturb ONE row the model was derived from and return the re-derived model, or null when no row
 * works. Rows are tried region-first, then upward into the subject lines above it, until one both
 * keeps the dialog liftable and moves its signature.
 *
 * The invariant is that SOME visible text the user is looking at reaches the signature — not that
 * every row does: a signature that ignored the pointer column would be right to (the choreography
 * moves it), while one that ignored everything would silently disable the race guard.
 *
 * The footer (the last non-blank line) is never perturbed: every grammar is tail-anchored on it, so
 * touching it tests detection, not the signature.
 */
function perturbRegion<K extends DialogKind>(
  adapter: HarnessAdapter,
  name: string,
  kind: K,
): DialogModels[K] | null {
  const lines = loadLines(name);
  const blocks = adapter.buildBlocks(lines);
  const count = modelsIn(blocks, kind).length;
  const region = blocks.find((b) => dialogModelOf(b, kind) !== null)!;
  const start = lines.length - region.lines.length; // the region is the buffer's tail slice
  const footer = lastNonBlank(lines);
  const signature = DIALOG_CONTRACT[kind].signature;
  const before = signature(modelsIn(blocks, kind).at(-1)!);

  const candidates = [
    ...range(start, lines.length), // the region itself, top-down
    ...range(Math.max(0, start - PERTURB_LOOKBACK), start).toReversed(), // then upward into the subject
  ];
  for (const i of candidates) {
    if (i === footer) continue;
    if (lineIsBlank(lines[i]!)) continue;
    const after = modelsIn(adapter.buildBlocks(perturbLine(lines, i)), kind);
    if (after.length !== count) continue; // this row is load-bearing for detection — try another
    if (signature(after.at(-1)!) !== before) return after.at(-1)!;
  }
  return null;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
}

function lineIsBlank(line: StyledLine): boolean {
  return line.segments.map((s) => s.text).join("").trim().length === 0;
}

/** Every non-raw block — i.e. an interactive dialog the adapter lifted out of the raw mirror.
 *  Kind-agnostic (`kind !== "raw"`) so a newly-added block kind counts as interactive automatically. */
function interactiveBlocks(blocks: Block[]): Block[] {
  return blocks.filter((b) => b.kind !== "raw");
}

// Herdr's verified pane.send_keys grammar (HERDR_API.md + project CLAUDE.md). Bare special keys are
// case-insensitive; a lone character is typed literally; modifiers join with `+`.
const SPECIAL_KEYS = new Set([
  "up",
  "down",
  "left",
  "right",
  "tab",
  "enter",
  "escape",
  "space",
  "backspace",
  "bs",
]);
// Explicitly rejected by Herdr (any spelling → invalid_key): no paging or forward-delete via keys.
const UNSUPPORTED_KEYS = new Set(["pageup", "pagedown", "home", "end", "insert", "delete"]);
const MODIFIERS = new Set(["ctrl", "shift", "alt", "cmd", "super"]);

/**
 * Whether `key` is a keystroke Herdr's `pane.send_keys` accepts. A key is valid when it is a single
 * literal character (digit/letter/punct), a bare special key (`Enter`, `Up`, `shift`-less `Tab`, …),
 * a function key `F1`–`F12`, or a `+`-joined modifier chord (`ctrl+c`, `shift+tab`, `ctrl+left`).
 * Rejects multi-char digit runs (`"10"`) and the unsupported paging/edit keys — the two ways a
 * detector could emit an unsendable plan.
 */
export function isValidHerdrKey(key: string): boolean {
  if (key.length === 0) return false;
  const lower = key.toLowerCase();
  if (UNSUPPORTED_KEYS.has(lower)) return false;
  if (key.length === 1) return true; // a single literal character (digit, letter, punctuation)
  if (SPECIAL_KEYS.has(lower)) return true; // a bare special key (case-insensitive)
  if (/^f([1-9]|1[0-2])$/i.test(key)) return true; // F1..F12
  const parts = lower.split("+");
  if (parts.length < 2 || parts.some((p) => p.length === 0)) return false;
  const last = parts[parts.length - 1]!;
  const mods = parts.slice(0, -1);
  if (!mods.every((m) => MODIFIERS.has(m))) return false;
  if (last.length === 1) return true; // ctrl+c, shift+a
  return SPECIAL_KEYS.has(last) && !UNSUPPORTED_KEYS.has(last); // shift+tab, ctrl+left
}

// NON-interactive block kinds (like `raw`) that carry no keystrokes and so need no key walk. A new
// INTERACTIVE kind that lands without a case below must FAIL the suite (see the default branch), not
// slip through as a silent `null`; only a deliberately keyless kind belongs in this allowlist.
//
// `autocomplete` is one: the agent's completion popup is painted while its input box is LIVE under it
// (harness/autocomplete-model.ts), so the block emits nothing, races nothing, and has no row in the
// dialog contract. Its fixtures still take the fail-closed and tail-anchoring legs above, which is
// where a popup grammar could actually do harm.
const KEYLESS_FUTURE_KINDS = new Set<string>(["autocomplete"]);

/**
 * Every keystroke an interactive block can emit, walked off its model + the family's control
 * constants. `null` = a keyless kind (`raw`, or a future entry in KEYLESS_FUTURE_KINDS) whose keys
 * needn't be validated. An interactive kind with no case here THROWS rather than returning null, so
 * the key-grammar invariant can never go silently vacuous when a new dialog kind ships.
 */
function emittableKeys(block: Block): string[] | null {
  switch (block.kind) {
    case "raw":
      return null;
    case "prompt-select":
      return block.prompt.options.flatMap((o) => o.keys);
    case "wizard": {
      // Both phases can navigate steps; the review phase's controls ARE submit(1)/cancel(2).
      const controls = [
        ...WIZARD_BACK_KEYS,
        ...WIZARD_NEXT_KEYS,
        ...WIZARD_SUBMIT_KEYS,
        ...WIZARD_CANCEL_KEYS,
      ];
      return block.wizard.phase === "question"
        ? [...block.wizard.options.flatMap((o) => o.keys), ...controls]
        : controls;
    }
    case "preview-select": {
      // preview-action.ts's recipe: a digit moves the pointer, Enter selects, `n` opens the note
      // input, ctrl+k/Backspace clear it, Escape blurs; a wizard step navigates with Left/Right.
      const digits = block.preview.options.map((o) => String(o.n));
      const controls = [
        "Enter",
        "n",
        "Escape",
        "ctrl+k",
        "Backspace",
        ...WIZARD_BACK_KEYS,
        ...WIZARD_NEXT_KEYS,
      ];
      return [...digits, ...controls];
    }
    case "multi-select":
      // checkbox: a digit toggles each option (and the "Chat about this" escape), Up/Down move the
      // pointer, Enter activates it. review: the confirm screen's `1. Submit answers / 2. Cancel`.
      return block.multi.phase === "checkbox"
        ? [
            ...block.multi.options.map((o) => String(o.n)),
            ...(block.multi.escape ? [String(block.multi.escape.n)] : []),
            "Up",
            "Down",
            "Enter",
          ]
        : ["1", "2"];
    case "menu":
      // The generic grammar emits ONLY the keys the screen's own footer named, plus the arrows it
      // advertised. Walking `actions` here is what pins .adr/0009's ban in CI: a digit can only
      // appear in this list if the detector synthesised one, and this suite would still pass it as a
      // valid Herdr key — so the menu-grammar tests assert the absence directly, and this leg keeps
      // the plans sendable.
      return [
        ...block.menu.actions.flatMap((a) => a.keys),
        ...(block.menu.nav.upDown ? [...MENU_UP_KEYS, ...MENU_DOWN_KEYS] : []),
        ...(block.menu.nav.leftRight !== undefined ? [...MENU_LEFT_KEYS, ...MENU_RIGHT_KEYS] : []),
      ];
    default: {
      // SAFETY: `block` is `never` here today — every kind is cased above — so widening it back to
      // `Block` cannot be wrong for any value that exists. The assertion is what names the offending
      // kind at runtime once a FUTURE Block kind is added to the union without a case here: a keyless
      // one is tolerated via the allowlist; any other (an interactive block whose keys aren't being
      // validated) fails loudly so the key-grammar invariant can't go vacuous.
      const kind = (block as Block).kind;
      if (KEYLESS_FUTURE_KINDS.has(kind)) return null;
      throw new Error(`conformance: unmodelled interactive block kind "${kind}" — extend emittableKeys`);
    }
  }
}

/**
 * Register the conformance invariants for `adapter` against its fixture cohorts:
 *  - `ownFixtures`     — this adapter's dialog captures (EACH must lift ≥1 interactive block).
 *  - `foreignFixtures` — OTHER adapters' dialog captures (must stay raw — cross-adapter fail-closed).
 *  - `neutralFixtures` — plain shell output / logs with no dialog (must stay raw).
 *
 * Fail-closed on a misfiled fixture: every own fixture must lift an interactive block (checked
 * per-fixture below). A no-dialog capture misfiled into `ownFixtures` would otherwise pass
 * tail-anchoring trivially and never exercise the key-grammar leg — so it is a failure, named by
 * fixture, not silently tolerated.
 */
export function describeAdapterConformance(
  adapter: HarnessAdapter,
  opts: { ownFixtures: string[]; foreignFixtures: string[]; neutralFixtures: string[] },
): void {
  const { ownFixtures, foreignFixtures, neutralFixtures } = opts;

  describe(`HarnessAdapter conformance — ${adapter.agent}`, () => {
    describe("conservative detection (fail-closed on foreign + neutral buffers)", () => {
      const alien: { name: string; cohort: string }[] = [
        ...foreignFixtures.map((name) => ({ name, cohort: "foreign" })),
        ...neutralFixtures.map((name) => ({ name, cohort: "neutral" })),
      ];
      if (alien.length === 0) it.todo("no foreign or neutral fixtures supplied");
      for (const { name, cohort } of alien) {
        it(`${name} (${cohort}) → raw-only, no interactive block`, () => {
          const blocks = adapter.buildBlocks(loadLines(name));
          expect(blocks.length).toBeGreaterThan(0);
          expect(interactiveBlocks(blocks)).toEqual([]);
        });
      }
    });

    describe("own fixtures each lift an interactive block (no misfiled raw capture)", () => {
      if (ownFixtures.length === 0) it.todo("no own dialog fixtures supplied");
      for (const name of ownFixtures) {
        it(`${name}: lifts ≥1 interactive block`, () => {
          const lifted = interactiveBlocks(adapter.buildBlocks(loadLines(name)));
          expect(
            lifted.length,
            `${name} lifted no interactive block — a neutral/raw capture misfiled into ownFixtures?`,
          ).toBeGreaterThan(0);
        });
      }
    });

    // `composerPrompt` is the region a DESTRUCTIVE write gets bound to (harness/types.ts): the reply
    // path hands it to the caller's pre-clear sweep, which passes it as `expected_prompt` so the
    // bridge can 409 a burst aimed at a screen that moved. Its whole value is that it describes the
    // same screen `composerReady` just approved — an adapter that named a region for a screen it
    // refuses would hand out a binding to a pane the pre-flight will not type into, and one that
    // named none for a screen it approves silently downgrades the sweep to an unbound write. Both are
    // caught by requiring the two to agree, on every cohort.
    describe("composerPrompt agrees with composerReady", () => {
      const all = [...ownFixtures, ...foreignFixtures, ...neutralFixtures];
      if (!adapter.composerPrompt || !adapter.composerReady) {
        it.todo("adapter supplies no composerPrompt/composerReady pair");
      } else {
        const prompt = adapter.composerPrompt.bind(adapter);
        const ready = adapter.composerReady.bind(adapter);
        for (const name of all) {
          it(`${name}: a region exists exactly when the composer is ready`, () => {
            const lines = loadLines(name);
            const region = prompt(lines);
            expect(region === null).toBe(!ready(lines));
            // A region the bridge cannot find on screen binds nothing at all.
            if (region !== null) expect(region.trim().length).toBeGreaterThan(0);
          });
        }

        // The other half of "the bridge can actually use this": `verifyExpectedPrompt`
        // (bridge/prompt-binding.ts) accepts a binding only when the match ENDS within the last
        // DEFAULT_PROMPT_TAIL_LINES (6) NON-BLANK rows of the fresh read. A region an adapter names
        // with more than that beneath it can never verify, so every destructive sweep on that screen
        // 409s ("The input box changed while clearing it") with nothing actually wrong — fail-closed,
        // but a permanent refusal the user cannot act on. omp shipped one row of margin here (its
        // slash palette is painted BELOW the box); this leg is what stops the next adapter repeating
        // it. An adapter that cannot fit the window must return null and take an unbound write.
        for (const name of all) {
          it(`${name}: a named region ends inside the bridge's ${BRIDGE_PROMPT_TAIL_LINES}-row tail window`, () => {
            const lines = loadLines(name);
            const region = prompt(lines);
            if (region === null) return;
            // Both sides normalized the way the bridge normalizes: trailing whitespace off, blank
            // rows dropped entirely (bridge/prompt-binding.ts `normalizePromptRegion`).
            const fresh = normalizeRegion(lines.map(lineText).join("\n"));
            const expected = normalizeRegion(region);
            const matchEnd = lastMatchEnd(fresh, expected);
            expect(matchEnd, `${name}: the named region is not on its own screen`).toBeGreaterThan(-1);
            expect(
              fresh.length - 1 - matchEnd,
              `${name}: ${fresh.length - 1 - matchEnd} non-blank rows sit below the named region — ` +
                `the bridge can only bind within the last ${BRIDGE_PROMPT_TAIL_LINES}`,
            ).toBeLessThan(BRIDGE_PROMPT_TAIL_LINES);
          });
        }
      }
    });

    describe("tail-anchoring (a dialog lifts only at the buffer tail)", () => {
      if (ownFixtures.length === 0) it.todo("no own dialog fixtures supplied");

      for (const name of ownFixtures) {
        it(`${name}: does NOT lift once ordinary output scrolls below it`, () => {
          const scrolled = [...loadLines(name), ...trailingOutput()];
          expect(interactiveBlocks(adapter.buildBlocks(scrolled))).toEqual([]);
        });
      }
    });

    // The GENERIC MODAL contract (harness/menu-model.ts + menu-hints.ts). Every adapter that ships
    // menu fixtures gets these for free; an adapter with none of them registers the todo and stays
    // honest about it. What is pinned here is what a menu block PROMISES the renderer and the race
    // guard — not how any one harness finds it.
    describe("menu blocks (the generic modal contract)", () => {
      const menuFixtures = ownFixtures.filter((name) =>
        adapter.buildBlocks(loadLines(name)).some((b) => b.kind === "menu"),
      );
      if (menuFixtures.length === 0) it.todo("adapter lifts no menu blocks from its own fixtures");

      for (const name of menuFixtures) {
        // .adr/0009 at the CI edge: a synthesised digit is a VALID Herdr key, so the key-grammar leg
        // above would happily pass one. Round-tripping through the shared whitelist is what makes an
        // invented key impossible — `menuKeyFor` is the only sanctioned source of a menu action key.
        it(`${name}: every action key came from the shared whitelist, and none is a digit`, () => {
          for (const block of adapter.buildBlocks(loadLines(name))) {
            if (block.kind !== "menu") continue;
            for (const key of block.menu.actions.flatMap((a) => a.keys)) {
              expect(/^\d+$/.test(key), `${name} synthesised the digit key ${key} (.adr/0009)`).toBe(
                false,
              );
              expect(menuKeyFor(key), `${name} emits off-whitelist menu key ${key}`).toBe(key);
            }
          }
        });

        // The signature IS the race guard (Herdr's `revision` is a stub). An empty or constant one
        // would disable it silently, so both halves are checked: present, and text-sensitive.
        it(`${name}: the menu carries a non-empty, text-sensitive signature`, () => {
          const lines = loadLines(name);
          for (const block of adapter.buildBlocks(lines)) {
            if (block.kind !== "menu") continue;
            expect(block.menu.signature.length, `${name} signs its menu with ""`).toBeGreaterThan(0);
            expect(block.menu.title.length, `${name} lifts an untitled menu`).toBeGreaterThan(0);
          }
          // Perturb the region's text (a row inserted just ABOVE the footer, so the footer stays the
          // last non-blank line and the menu still lifts): the signature must move with it.
          const perturbed = [...lines];
          perturbed.splice(lastNonBlank(lines), 0, textLine("  ○ Something else entirely"));
          const after = menuSignatures(adapter.buildBlocks(perturbed));
          expect(after.length, `${name}: the perturbed capture stopped lifting a menu`).toBe(
            menuSignatures(adapter.buildBlocks(lines)).length,
          );
          expect(after).not.toEqual(menuSignatures(adapter.buildBlocks(lines)));
        });

        // A menu HAS the keyboard. If the adapter can tell whether its composer is on screen, it must
        // say no here — otherwise the reply pre-flight (lib/reply-action.ts) would type the user's
        // message into the modal, which is the exact `/model` bug the grammar exists to end.
        it(`${name}: composerReady is false while the modal is up`, () => {
          if (!adapter.composerReady) return; // "no idea" is allowed; a wrong "yes" is not
          expect(adapter.composerReady(loadLines(name))).toBe(false);
        });
      }

      // Neutral output is never a modal — a menu lifted from a log would put live keystroke buttons
      // under ordinary text. (Implied by the fail-closed leg; asserted directly so the menu contract
      // reads whole in one place.)
      for (const name of neutralFixtures) {
        it(`${name} (neutral): lifts no menu block`, () => {
          expect(adapter.buildBlocks(loadLines(name)).some((b) => b.kind === "menu")).toBe(false);
        });
      }
    });

    // THE DIALOG-MODEL contract (harness/*-model.ts + dialog-contract.ts), checked for EVERY block
    // kind the adapter up-levels — the generalisation of the menu-signature invariant above. What is
    // pinned is what the race guard (lib/dialog-guard.ts) assumes of ANY adapter's model:
    //   * the signature is non-empty (an empty/constant one silently disables the guard, because
    //     Herdr's `revision` is a stub and this is the whole freshness check), and the bound region
    //     text is non-empty too (the bridge has to find it in its own fresh read);
    //   * the signature is TEXT-SENSITIVE: perturb a row of the region and it moves;
    //   * the comparators agree with that: the same screen re-derived is the same dialog, and a
    //     perturbed screen FAILS the committing comparison — which is exactly what stops a tap on a
    //     stale render from firing at the screen that replaced it.
    // A kind the adapter never emits registers a todo rather than passing vacuously.
    describe("dialog models (signature + identity contract)", () => {
      for (const kind of DIALOG_KINDS) {
        const kindFixtures = ownFixtures.filter((name) => modelsOf(adapter, name, kind).length > 0);
        if (kindFixtures.length === 0) {
          it.todo(`adapter lifts no ${kind} blocks from its own fixtures`);
          continue;
        }
        // `kind` is the UNION here, so addressing the table with it would intersect the five models
        // into an impossible parameter type. `dialogComparators` does that erasure once, in the
        // module that owns the table, and keeps this loop one generic pass instead of five
        // hand-written copies. The comparators are only ever handed models this same table produced
        // for this same kind (`modelsOf(..., kind)`).
        const contract = dialogComparators(kind);

        for (const name of kindFixtures) {
          it(`${name}: the ${kind} model signs itself (signature + bound region non-empty)`, () => {
            for (const model of modelsOf(adapter, name, kind)) {
              expect(contract.signature(model).length, `${name} signs its ${kind} with ""`).toBeGreaterThan(0);
              expect(contract.region(model).length, `${name} binds its ${kind} to ""`).toBeGreaterThan(0);
            }
          });

          it(`${name}: re-deriving the same screen is the same ${kind}`, () => {
            // Two independent derivations of the same bytes (a fresh parse each time — what the guard
            // does on every tap). Both the identity and the committing comparison must hold, or a
            // guard would reject taps on a screen that never moved.
            const a = modelsOf(adapter, name, kind).at(-1)!;
            const b = modelsOf(adapter, name, kind).at(-1)!;
            expect(contract.identity(a, b), `${name}: ${kind} identity is unstable`).toBe(true);
            expect(contract.commits(a, b), `${name}: ${kind} equality is unstable`).toBe(true);
          });

          it(`${name}: a perturbed region moves the signature and fails the committing check`, () => {
            const before = modelsOf(adapter, name, kind).at(-1)!;
            const probe = perturbRegion(adapter, name, kind);
            expect(
              probe,
              `${name}: no row of the ${kind} region changes its signature — the race guard is blind ` +
                `to a screen that changed under the user`,
            ).not.toBeNull();
            expect(contract.signature(probe!)).not.toBe(contract.signature(before));
            expect(
              contract.commits(before, probe!),
              `${name}: a ${kind} whose region text changed still passes the committing comparison`,
            ).toBe(false);
          });
        }
      }
    });

    describe("key-grammar validity (every emittable key is send_keys-valid)", () => {
      if (ownFixtures.length === 0) it.todo("no own dialog fixtures supplied");
      for (const name of ownFixtures) {
        it(`${name}: every keystroke its blocks can emit validates`, () => {
          for (const block of interactiveBlocks(adapter.buildBlocks(loadLines(name)))) {
            const keys = emittableKeys(block);
            if (keys === null) continue; // a kind not modelled here yet — tolerated
            expect(keys.length, `${name} / ${block.kind} exposes no keys`).toBeGreaterThan(0);
            for (const key of keys) {
              expect(
                isValidHerdrKey(key),
                `${name} / ${block.kind} emits invalid key ${JSON.stringify(key)}`,
              ).toBe(true);
            }
          }
        });
      }
    });
  });
}
