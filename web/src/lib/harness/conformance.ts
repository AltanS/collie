// The HarnessAdapter CONFORMANCE suite — the CI gate every adapter must clear before its dialog
// buttons are allowed to go hot. It is a single `describe`-registering function, parameterised on
// the adapter under test plus three fixture cohorts, so a future adapter (codex/pi/opencode) gets
// the exact same three invariants for free by calling it from its own `*.test.ts`:
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
//
// Pure + offline: it drives the adapter over the byte-faithful fixture corpus (web/src/fixtures/
// panes/*.txt) through the same parseAnsi → splitLines pipeline the renderer uses. It never touches
// a pane or the network (guard.ts owns that), so it can gate a read-only Tier-1 lift from fixtures
// alone.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { splitLines, type Block, type StyledLine } from "../blocks";
import type { HarnessAdapter } from "./types";
import {
  WIZARD_BACK_KEYS,
  WIZARD_CANCEL_KEYS,
  WIZARD_NEXT_KEYS,
  WIZARD_SUBMIT_KEYS,
} from "./claude/wizard";

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

// A couple of lines of ordinary agent output to append below a dialog. They must be NON-blank (a
// trailing blank run is trimmed off the tail by every detector, which would re-expose the footer)
// and must not themselves look like a menu footer or option row — so appending them makes the
// dialog's footer no longer the last non-blank line, and every tail-anchored detector bails.
function trailingOutput(): StyledLine[] {
  return [textLine("● Wrote the file"), textLine("  ⎿  done")];
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

// Genuinely-future NON-interactive block kinds (like `raw`) that carry no keystrokes and so need no
// key walk. EMPTY today — every interactive kind that ships is modelled below. A new interactive kind
// that lands without a case here must FAIL the suite (see the default branch), not slip through as a
// silent `null`; only a deliberately keyless kind belongs in this allowlist.
const KEYLESS_FUTURE_KINDS = new Set<string>();

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
    default: {
      // `block` is `never` here today — every kind is cased above. The cast names the offending kind
      // at runtime once a FUTURE Block kind is added to the union without a case here: a keyless one
      // is tolerated via the allowlist; any other (an interactive block whose keys aren't being
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

    describe("tail-anchoring (a dialog lifts only at the buffer tail)", () => {
      if (ownFixtures.length === 0) it.todo("no own dialog fixtures supplied");

      for (const name of ownFixtures) {
        it(`${name}: does NOT lift once ordinary output scrolls below it`, () => {
          const scrolled = [...loadLines(name), ...trailingOutput()];
          expect(interactiveBlocks(adapter.buildBlocks(scrolled))).toEqual([]);
        });
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
