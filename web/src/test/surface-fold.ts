import { readdirSync } from "node:fs";
import { expect, it } from "vitest";

import {
  agentOf,
  fixtureRows,
  idleFor,
  incidentScreens,
  loadLabels,
  PANES_DIR,
  perturbations,
  readScreen,
  rowsOf,
} from "./surface-corpus";
import { findInputFrame } from "../lib/surface/frame";
import { requireProfile } from "../lib/surface/profile";
import { type Ask, askOf, isFree, modalWord, type Surface } from "../lib/surface/surface";

// Shared by the fold.<part>.test.ts files in src/lib/surface/. It lives here, not beside them, because
// no-harness-names.test.ts scans every non-test file in that folder and a profile test has to name harnesses.
//
// M56 spec 04: the fold from a numbered input log to a Surface, and the profile tests of the design
// record (experiments/reader-stability/ARCHITECTURE.md section 4) over the whole fixture corpus:
//  (a) the idle matcher and the modal detector never both match one fixture;
//  (b) a perturbed fixture stays the same or becomes unknown, never free from a dialog;
//  (d) the negative set never reads free.
// (c), quoted dialogs in a transcript, is in cues.test.ts.

export const CLAUDE = requireProfile("claude").idle;
export const LABELS = loadLabels();
export const FIXTURES = readdirSync(PANES_DIR)
  .filter((name) => name.endsWith(".txt"))
  .toSorted();
export const NEGATIVE = new Set(["dialog", "screen"]);
// A test that reads the whole corpus takes up to 1.3 s here and ran past 5 s on the GitHub runner; 20 s covers a runner four times slower.
export const CORPUS_WALK = { timeout: 20_000 };

// Incident screens that read free when the one profile there is is applied to a harness it does not
// describe. The Surface takes its profile from the binary, never from the screen, so this is a
// record of what a later profile must cover, not a gap in the fold.
export const WRONG_PROFILE_FREE = new Map([
  [
    "5de40a86",
    "Muse draws its tasks popup in the rows under its own box where this profile walks a statusline; a statusline is never read for a cue. Muse has no profile, so its panes never read free.",
  ],
]);

export function labelOf(name: string) {
  const label = LABELS.fixtures[name];
  if (label === undefined) throw new Error(`${name} has no row in surface-labels.json`);
  return label;
}

/** A fixture read the way the shadow reads it: its harness's own profile, the readers lifting. */
export function own(name: string) {
  const label = labelOf(name);
  return readScreen(fixtureRows(name), agentOf(label.harness), idleFor(label.harness));
}

/**
 * The claims of `after` that moved toward free from `before`: a modal that became `none`, a turn that
 * became `idle`, a composer that became `empty` or `draft`. A claim that stays, turns `unknown`, or
 * stays a modal of another kind (an ask the reader lost and the cues kept as `unreadable`) moved
 * away from free or nowhere.
 */
export function towardFree(before: Surface, after: Surface): string[] {
  const moved: string[] = [];
  if (after.modal === "none" && before.modal !== "none") moved.push(`modal ${modalWord(before.modal)} -> none`);
  if (after.turn === "idle" && before.turn !== "idle") moved.push(`turn ${before.turn} -> idle`);
  if ((after.composer === "empty" || after.composer === "draft") && after.composer !== before.composer) {
    moved.push(`composer ${before.composer} -> ${after.composer}`);
  }
  return moved;
}

export const ASK: Ask = { id: "ask-1-0", kind: "permission", options: [{ id: "1", label: "Yes" }], channel: "keys", hash: "00" };

/**
 * One entry per harness profile added by spec 14. `idleMin` is how many idle fixtures the set must hold.
 * `quote` is a dialog as the harness prints it in a transcript: it goes over the live box and must
 * leave the box free. `labels` names the fixture labels that must read `running`.
 */
export interface ProfileCase {
  readonly id: string;
  readonly idleMin: number;
  readonly quote: readonly string[];
  /** The states the fixture set must hold; the default is all four. A harness with no draft capture lists three. */
  readonly states?: readonly string[];
}

const SPEC14: readonly ProfileCase[] = [
  {
    id: "opencode",
    idleMin: 4,
    quote: ["Here is the dialog you asked about:", "  Permission required", "  ❯ 1. Allow once", "    2. Reject", "  Press enter to confirm or esc to cancel", "", "That is all it shows."],
  },
  {
    id: "agy",
    idleMin: 2,
    states: ["idle", "running", "dialog"],
    quote: ["Here is the dialog you asked about:", "  Pick a color", "  > 1. Red", "    2. Blue", "  ↑↓ navigate • Enter to select • Esc to cancel", "", "That is all it shows."],
  },
  {
    id: "grok",
    idleMin: 4,
    quote: ["Here is the dialog you asked about:", "  Pick a color", "  > 1. Red", "    2. Blue", "  ↑↓ navigate • Enter to select • Esc to cancel", "", "That is all it shows."],
  },
  {
    id: "muse",
    idleMin: 2,
    quote: ["Here is the dialog you asked about:", "  Pick a color", "  > 1. Red", "    2. Blue", "  ↑↓ navigate • Enter to select • Esc to cancel", "", "That is all it shows."],
  },
  {
    id: "omp",
    idleMin: 11,
    quote: ["Here is the dialog you asked about:", "  Pick a color", "  > 1. Red", "    2. Blue", "  ↑↓ navigate • Enter to select • Esc to cancel", "", "That is all it shows."],
  },
  {
    id: "pi",
    idleMin: 14,
    quote: ["Here is the dialog you asked about:", "  Pick a color", "  > 1. Red", "    2. Blue", "  ↑↓ navigate • Enter to select • Esc to cancel", "", "That is all it shows."],
  },
];

/** The spec 14 cases with these ids, in the order given. An id that has no case throws, so a part file cannot silently drop a profile. */
export function profileCases(...ids: string[]): ProfileCase[] {
  return ids.map((id) => {
    const found = SPEC14.find((c) => c.id === id);
    if (found === undefined) throw new Error(`no spec 14 case for ${id}`);
    return found;
  });
}

type Read = ReturnType<typeof readScreen>;
const signature = (r: Read): boolean => r.frame !== null && r.surface.composer === "empty" && r.surface.turn === "idle" && r.cues?.strength === "none";
const detector = (r: Read): boolean => askOf(r.surface.modal) !== null || r.cues?.strength === "strong";

/** The suite body of one spec 14 profile, for `describe.each(cases)("the $id profile over its fixtures (M56 spec 14)", profileSuite)`. */
export function profileSuite({ id, idleMin, quote, states }: ProfileCase): void {
  // The profile tests (a), (b), (c) and (d) of the design record, run with this harness's profile on
  // its mine fixtures, and with the profile applied to every fixture: a profile on a harness it does
  // not describe must never make a dialog free either.
  const PROFILE = requireProfile(id).idle;
  const mine = FIXTURES.filter((name) => labelOf(name).harness === id);
  const read = (name: string, idle = PROFILE) => readScreen(fixtureRows(name), agentOf(labelOf(name).harness), idle);

  it(`${id}: the set holds idle, draft, running and dialog screens`, () => {
    const have = new Set<string>(mine.map((name) => labelOf(name).state));
    for (const state of states ?? (["idle", "draft", "running", "dialog"] as const)) expect(have.has(state), state).toBe(true);
  });

  it(`${id}: the frame module finds the box on every idle fixture, and it reads free`, () => {
    const idle = mine.filter((name) => labelOf(name).state === "idle");
    expect(idle.length).toBeGreaterThanOrEqual(idleMin);
    for (const name of idle) {
      expect(findInputFrame(fixtureRows(name), PROFILE), name).not.toBeNull();
      expect(isFree(read(name).surface), name).toBe(true);
    }
  });

  it(`${id}: a draft reads as a draft, never free, and a running turn never reads free`, () => {
    for (const name of mine.filter((n) => labelOf(n).state === "draft")) {
      const surface = read(name).surface;
      expect(isFree(surface), name).toBe(false);
      if (surface.composer !== "unknown") expect(surface.composer, name).toBe("draft");
    }
    // A running fixture may show no sign of the turn (a derived screen with only a ghost draft): its
    // draft then keeps it from free, and that is the claim that counts.
    for (const name of mine.filter((n) => labelOf(n).state === "running" && LABELS.knownMismatches[n] === undefined)) {
      expect(isFree(read(name).surface), name).toBe(false);
    }
  });

  it(`${id} (a): the idle matcher and the modal detector never both match, on its fixtures and on every fixture`, CORPUS_WALK, () => {
    expect(mine.filter((name) => signature(read(name)) && detector(read(name)))).toEqual([]);
    expect(FIXTURES.filter((name) => signature(read(name)) && detector(read(name)))).toEqual([]);
  });

  it(`${id} (b): a perturbed fixture never frees a dialog, and no claim of a dialog moves toward free`, { timeout: 60_000 }, () => {
    const wrong: string[] = [];
    for (const name of mine) {
      const label = labelOf(name);
      const before = read(name).surface;
      for (const perturbed of perturbations(fixtureRows(name))) {
        const after = readScreen(perturbed.rows, agentOf(label.harness), PROFILE).surface;
        if (isFree(after) && (!isFree(before) || NEGATIVE.has(label.state))) wrong.push(`${name} ${perturbed.name}: free`);
        if (NEGATIVE.has(label.state)) for (const move of towardFree(before, after)) wrong.push(`${name} ${perturbed.name}: ${move}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it(`${id} (c): a dialog quoted in the transcript stays free`, () => {
    // The quote goes straight over the live box, as the harness's reply would print it.
    const name = mine.find((n) => labelOf(n).state === "idle" && findInputFrame(fixtureRows(n), PROFILE) !== null)!;
    const rows = fixtureRows(name);
    const top = findInputFrame(rows, PROFILE)!.top;
    const withQuote = [...rows.slice(0, top), ...rowsOf(["", ...quote, ""].join("\n")), ...rows.slice(top)];
    const r = readScreen(withQuote, id, PROFILE);
    expect(r.frame).not.toBeNull();
    expect(isFree(r.surface), name).toBe(true);
  });

  it(`${id} (d): the negative set never reads free with this profile, its mine dialogs included`, CORPUS_WALK, () => {
    const negative = FIXTURES.filter((name) => NEGATIVE.has(labelOf(name).state));
    expect(negative.filter((name) => labelOf(name).harness === id).length).toBeGreaterThan(0);
    const free = negative.filter((name) => isFree(read(name).surface) || isFree(read(name, PROFILE).surface));
    expect(free).toEqual([]);
    const lifted = negative.filter((name) => labelOf(name).harness === id && isFree(readScreen(fixtureRows(name), id, PROFILE, { lift: false }).surface));
    expect(lifted).toEqual([]);
  });

  it(`${id}: the incident screens never read free with this profile`, () => {
    expect(incidentScreens().filter((incident) => isFree(readScreen(incident.rows, incident.agent, PROFILE).surface)).map((i) => i.name)).toEqual([]);
  });
}
