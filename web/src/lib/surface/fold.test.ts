import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  agentOf,
  CUES_BLIND,
  fixtureRows,
  idleFor,
  incidentScreens,
  loadLabels,
  PANES_DIR,
  perturbations,
  readScreen,
  rowsOf,
  SURFACE_FIXTURES_DIR,
} from "../../test/surface-corpus";
import { commandListAt, ownCommandList, readCues } from "./cues";
import { findInputFrame, plainRows, rowText } from "./frame";
import { endsInsideFrame, foldSurface, SURFACE_SOURCES, surfaceOfScreen, type ScreenInput, type SurfaceInput } from "./fold";
import { requireProfile } from "./profile";
import { askOf, isFree, modalWord, type Ask, type Surface } from "./surface";

// M56 spec 04: the fold from a numbered input log to a Surface, and the profile tests of the design
// record (experiments/reader-stability/ARCHITECTURE.md section 4) over the whole fixture corpus:
//  (a) the idle matcher and the modal detector never both match one fixture;
//  (b) a perturbed fixture stays the same or becomes unknown, never free from a dialog;
//  (d) the negative set never reads free.
// (c), quoted dialogs in a transcript, is in cues.test.ts.

const CLAUDE = requireProfile("claude").idle;
const LABELS = loadLabels();
const FIXTURES = readdirSync(PANES_DIR)
  .filter((name) => name.endsWith(".txt"))
  .toSorted();
const NEGATIVE = new Set(["dialog", "screen"]);
// A test that reads the whole corpus takes up to 1.3 s here and ran past 5 s on the GitHub runner; 20 s covers a runner four times slower.
const CORPUS_WALK = { timeout: 20_000 };

// Incident screens that read free when the one profile there is is applied to a harness it does not
// describe. The Surface takes its profile from the binary, never from the screen, so this is a
// record of what a later profile must cover, not a gap in the fold.
const WRONG_PROFILE_FREE = new Map([
  [
    "5de40a86",
    "Muse draws its tasks popup in the rows under its own box where this profile walks a statusline; a statusline is never read for a cue. Muse has no profile, so its panes never read free.",
  ],
]);

function labelOf(name: string) {
  const label = LABELS.fixtures[name];
  if (label === undefined) throw new Error(`${name} has no row in surface-labels.json`);
  return label;
}

/** A fixture read the way the shadow reads it: its harness's own profile, the readers lifting. */
function own(name: string) {
  const label = labelOf(name);
  return readScreen(fixtureRows(name), agentOf(label.harness), idleFor(label.harness));
}

describe("the label file", () => {
  it("has one row per pane fixture, and none for a fixture that is gone", () => {
    expect(Object.keys(LABELS.fixtures).toSorted()).toEqual(FIXTURES);
  });

  it("names a known state on every row", () => {
    const states = new Set(["idle", "draft", "running", "popup", "dialog", "screen", "other"]);
    for (const [name, label] of Object.entries(LABELS.fixtures)) expect(states.has(label.state), name).toBe(true);
  });

  it("holds all eight incident commits of the research note", () => {
    expect(Object.keys(LABELS.incidents).toSorted()).toEqual(
      ["526d7a92", "5de40a86", "78234d4f", "7d964012", "9acc1502", "a3e74596", "c7e5c8e8", "ec3e5efc"].toSorted(),
    );
    for (const incident of incidentScreens()) expect(incident.rows.length, incident.name).toBeGreaterThan(0);
  });
});

describe("running labels", () => {
  const readsFree = (name: string): boolean => {
    const label = LABELS.fixtures[name]!;
    return isFree(readScreen(fixtureRows(name), agentOf(label.harness), idleFor(label.harness)).surface);
  };

  it("no fixture labelled running reads free, except the known mismatches, each with its reason", () => {
    const free = Object.entries(LABELS.fixtures)
      .filter(([name, label]) => label.state === "running" && readsFree(name))
      .map(([name]) => name)
      .toSorted();
    expect(free).toEqual(Object.keys(LABELS.knownMismatches).toSorted());
  });

  it("every known mismatch is a running label that still reads free", () => {
    for (const [name, why] of Object.entries(LABELS.knownMismatches)) {
      expect(LABELS.fixtures[name]?.state, name).toBe("running");
      expect(why.length, name).toBeGreaterThan(20);
      expect(readsFree(name), name).toBe(true);
    }
  });
});

describe("the idle matcher and the modal detector", () => {
  // The idle matcher is the profile's idle signature: the frame is found, the composer is empty and
  // the turn idle, and no cue at all sits at the frame. The modal detector is a block reader's typed
  // lift, or a strong generic cue. The cue halves read the same anchored cluster, so they exclude
  // each other by construction; what this pins is that construction, and that no reader ever lifts a
  // dialog off a screen whose idle signature holds. Run with each fixture's own profile, and again
  // with the one profile there is applied to every fixture (a wrong profile must not make both
  // match either).
  function idleSignature(read: ReturnType<typeof own>): boolean {
    return read.frame !== null && read.surface.composer === "empty" && read.surface.turn === "idle" && read.cues?.strength === "none";
  }
  function modalDetector(read: ReturnType<typeof own>): boolean {
    return askOf(read.surface.modal) !== null || read.cues?.strength === "strong";
  }

  it("never both match one fixture, with its own profile", CORPUS_WALK, () => {
    const both = FIXTURES.filter((name) => {
      const read = own(name);
      return idleSignature(read) && modalDetector(read);
    });
    expect(both).toEqual([]);
  });

  it("never both match one fixture, with the one profile applied to every fixture", CORPUS_WALK, () => {
    const both = FIXTURES.filter((name) => {
      const read = readScreen(fixtureRows(name), agentOf(labelOf(name).harness), CLAUDE);
      return idleSignature(read) && modalDetector(read);
    });
    expect(both).toEqual([]);
  });

  it("never both match: the matchers are not vacuous", CORPUS_WALK, () => {
    const idle = FIXTURES.filter((name) => idleSignature(own(name))).length;
    const modal = FIXTURES.filter((name) => modalDetector(own(name))).length;
    expect(idle).toBeGreaterThan(30);
    expect(modal).toBeGreaterThan(300);
  });
});

/**
 * The claims of `after` that moved toward free from `before`: a modal that became `none`, a turn that
 * became `idle`, a composer that became `empty` or `draft`. A claim that stays, turns `unknown`, or
 * stays a modal of another kind (an ask the reader lost and the cues kept as `unreadable`) moved
 * away from free or nowhere.
 */
function towardFree(before: Surface, after: Surface): string[] {
  const moved: string[] = [];
  if (after.modal === "none" && before.modal !== "none") moved.push(`modal ${modalWord(before.modal)} -> none`);
  if (after.turn === "idle" && before.turn !== "idle") moved.push(`turn ${before.turn} -> idle`);
  if ((after.composer === "empty" || after.composer === "draft") && after.composer !== before.composer) {
    moved.push(`composer ${before.composer} -> ${after.composer}`);
  }
  return moved;
}

describe("perturbed fixtures", () => {
  // Each fixture is perturbed (moved row, blank row, extra status row, dropped border, width change)
  // and read again through the whole pipeline. A perturbed screen may stay the same or lose its
  // claims; it may never become free unless the fixture itself is free, and a negative fixture may
  // never become free at all. On a negative fixture no single claim may move toward free either: the
  // design record's "stays the same or becomes unknown", where a modal that changes kind still counts
  // as a modal.
  for (const name of FIXTURES) {
    it(`perturb: ${name}`, () => {
      const label = labelOf(name);
      const agent = agentOf(label.harness);
      const idle = idleFor(label.harness);
      const before = readScreen(fixtureRows(name), agent, idle).surface;
      const original = isFree(before);
      const wrong: string[] = [];
      for (const perturbed of perturbations(fixtureRows(name))) {
        const after = readScreen(perturbed.rows, agent, idle).surface;
        if (isFree(after) && (!original || NEGATIVE.has(label.state))) wrong.push(`${perturbed.name}: free`);
        if (NEGATIVE.has(label.state)) for (const move of towardFree(before, after)) wrong.push(`${perturbed.name}: ${move}`);
      }
      expect(wrong).toEqual([]);
    });
  }

  it("perturb: a claim that moves toward free is caught", () => {
    const dialog: Surface = { revision: 1, turn: "unknown", modal: "unreadable", composer: "unknown" };
    expect(towardFree(dialog, { ...dialog, modal: "none", composer: "draft" })).toEqual(["modal unreadable -> none", "composer unknown -> draft"]);
    expect(towardFree(dialog, { ...dialog, modal: "unknown" })).toEqual([]);
    expect(towardFree({ ...dialog, modal: { ask: ASK } }, dialog)).toEqual([]);
  });

  it("perturb: the incident screens never become free", CORPUS_WALK, () => {
    const wrong: string[] = [];
    for (const incident of incidentScreens()) {
      const profiles = WRONG_PROFILE_FREE.has(incident.sha) ? [idleFor(incident.agent)] : [idleFor(incident.agent), CLAUDE];
      for (const idle of profiles) {
        for (const perturbed of perturbations(incident.rows)) {
          if (isFree(readScreen(perturbed.rows, incident.agent, idle).surface)) wrong.push(`${incident.name}: ${perturbed.name}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("perturb: most idle frames survive a blank row and an extra status row", () => {
    const idle = FIXTURES.filter((name) => labelOf(name).state === "idle" && labelOf(name).harness === "claude");
    let kept = 0;
    let total = 0;
    for (const name of idle) {
      for (const perturbed of perturbations(fixtureRows(name)).filter((p) => p.name.startsWith("one more status row at"))) {
        total++;
        if (isFree(readScreen(perturbed.rows, "claude", CLAUDE).surface)) kept++;
      }
    }
    expect(total).toBeGreaterThan(30);
    expect(kept / total).toBeGreaterThan(0.9);
  });
});

describe("the negative set", () => {
  // Every dialog, picker, rating prompt, search box and shell prompt fixture, and the eight incident
  // screens, must never read free: with the harness's own profile, and with the one profile there is
  // applied to every screen.
  const negative = FIXTURES.filter((name) => NEGATIVE.has(labelOf(name).state));

  it("negative set: is not vacuous", () => {
    expect(negative.length).toBeGreaterThan(400);
    expect(incidentScreens().length).toBeGreaterThanOrEqual(19);
  });

  for (const name of negative) {
    it(`negative set: ${name} never reads free`, () => {
      const label = labelOf(name);
      expect(isFree(own(name).surface)).toBe(false);
      expect(isFree(readScreen(fixtureRows(name), agentOf(label.harness), CLAUDE).surface)).toBe(false);
      expect(isFree(readScreen(fixtureRows(name), agentOf(label.harness), CLAUDE, { lift: false }).surface)).toBe(false);
    });
  }

  it("negative set: the eight incident screens never read free", () => {
    const wrong = incidentScreens().filter(
      (incident) =>
        isFree(readScreen(incident.rows, incident.agent, idleFor(incident.agent)).surface) ||
        (!WRONG_PROFILE_FREE.has(incident.sha) && isFree(readScreen(incident.rows, incident.agent, CLAUDE).surface)),
    );
    expect(wrong.map((incident) => `${incident.sha} ${incident.name}`)).toEqual([]);
  });

  it("negative set: at least 95% of idle Claude fixtures do read free", () => {
    const idle = FIXTURES.filter((name) => labelOf(name).state === "idle" && labelOf(name).harness === "claude");
    const free = idle.filter((name) => isFree(own(name).surface));
    expect(idle.length).toBeGreaterThan(30);
    expect(free.length / idle.length).toBeGreaterThanOrEqual(0.95);
  });
});

describe("the generic cues alone", () => {
  // The other harnesses have no profile and few readers, so the cues are what keeps their dialogs from
  // a guess: with no reader lifting, every dialog fixture of a harness other than the profiled one
  // reads as a modal (`unreadable`), not merely `unknown`. scripts/surface-corpus.ts fails on the same
  // rule and prints the column.
  const others = FIXTURES.filter((name) => {
    const label = labelOf(name);
    // A "-cut" fixture is a screen truncated on purpose: it hides the footer that proves the dialog, and its uncut sibling is in the set.
    // CUES_BLIND names the dialogs whose bottom cluster the cues cannot reach, each with its reason.
    return (
      label.state === "dialog" &&
      label.harness !== "claude" &&
      label.harness !== "shell" &&
      !name.endsWith("-cut.txt") &&
      !CUES_BLIND.has(name)
    );
  });

  it("cues alone: the set covers codex, pi, opencode, grok and omp", () => {
    const harnesses = new Set(others.map((name) => labelOf(name).harness));
    for (const harness of ["codex", "pi", "opencode", "grok", "omp"]) expect(harnesses.has(harness), harness).toBe(true);
    expect(others.length).toBeGreaterThan(200);
  });

  it("cues alone: flag every dialog fixture of the other harnesses as modal", () => {
    const missed = others.filter((name) => {
      const label = labelOf(name);
      const surface = readScreen(fixtureRows(name), agentOf(label.harness), idleFor(label.harness), { lift: false }).surface;
      return surface.modal !== "unreadable" && askOf(surface.modal) === null;
    });
    expect(missed).toEqual([]);
  });
});

describe("pi's dialogs under its profile", () => {
  // The pi profile takes an extension's painted footer under the box (`idle.frame.underPainted`, issue
  // 485). pi paints much more than footers, so this pins that no pi dialog, a cut one included, reads
  // as a box with no modal: with `modal: none` the phone offers Replace, which types into the dialog.
  it("no pi dialog fixture reads modal none, the ones cut on purpose too", CORPUS_WALK, () => {
    const dialogs = FIXTURES.filter((name) => labelOf(name).harness === "pi" && labelOf(name).state === "dialog");
    expect(dialogs.length).toBeGreaterThan(60);
    expect(dialogs.filter((name) => own(name).surface.modal === "none")).toEqual([]);
  });

  // The omp profile names its command list too (1.22.5): a box past a list may be found where none was.
  it("no omp dialog fixture reads modal none, the ones cut on purpose too", CORPUS_WALK, () => {
    const dialogs = FIXTURES.filter((name) => labelOf(name).harness === "omp" && labelOf(name).state === "dialog");
    expect(dialogs.length).toBeGreaterThan(60);
    expect(dialogs.filter((name) => own(name).surface.modal === "none")).toEqual([]);
  });
});

describe("the typed command's own list under pi's and omp's box (field case 2026-10-17, 1.22.5)", () => {
  // Captured in an isolated Herdr session: pi 1.3.0, pi 0.87.1 and omp 18.6.1 with `/model` or
  // `/settings` typed, at 120 and 80 columns. Each list points at the typed command, so Enter picks
  // that command: a draft with no modal. Until 1.22.5 the list's pointer row and the slash query in
  // the box read as a strong cue (pi), or the list hid the box (omp), so the phone's Model shortcut
  // was left typed with `typed_not_submitted (modal_cue)`.
  const OWN: readonly [string, string][] = [
    ["pi--v130-slash-model-list--w120.txt", "/model"],
    ["pi--v130-slash-model-list--w80.txt", "/model"],
    ["pi--v130-slash-settings-list--w120.txt", "/settings"],
    ["pi--v130-slash-settings-list--w80.txt", "/settings"],
    ["pi--v0871-slash-model-list--w120.txt", "/model"],
    ["pi--v0871-slash-model-list--w80.txt", "/model"],
    ["pi--v0871-slash-settings-list--w120.txt", "/settings"],
    ["pi--v0871-slash-settings-list--w80.txt", "/settings"],
    ["omp--v18-6-slash-model-list--w120.txt", "/model"],
    ["omp--v18-6-slash-model-list--w80.txt", "/model"],
    ["omp--v18-6-slash-settings-list--w120.txt", "/settings"],
    ["omp--v18-6-slash-settings-list--w80.txt", "/settings"],
    // The older captures of the same state: OmO on pi, omp 18.8's pi-shaped box (commit 9acc1502) and an older omp box.
    ["pi--omo-v5130-slash-model.txt", "/model"],
    ["pi--omo-v5130-slash-compact.txt", "/compact"],
    ["omp--v18-8-slash-palette.txt", "/resume"],
    ["omp--v18-8-slash-palette-w48.txt", "/resume"],
    ["omp--slash-palette--filtered.txt", "/new"],
  ];

  for (const [name, command] of OWN) {
    it(`${name}: the box holds ${command}, its own list under it is no dialog`, () => {
      const read = own(name);
      expect(read.frame?.interior.text).toBe(command);
      expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
      expect(read.cues?.strength).toBe("none");
      expect(labelOf(name).state).toBe("popup");
    });
  }

  // A list that points at another command (`/mod` typed, `model` pointed), the selector `/model` opens
  // and the settings screen `/settings` opens all stay dialogs.
  for (const name of [
    "pi--v130-slash-mod-partial--w120.txt",
    "omp--v18-6-slash-mod-partial--w120.txt",
    "pi--v130-model-selector-empty--w120.txt",
    "pi--v0871-model-selector-empty--w120.txt",
    "omp--v18-6-model-selector-empty--w120.txt",
    "pi--v130-settings-screen--w120.txt",
    "omp--v18-6-settings-screen--w120.txt",
    "pi--v110-slash-palette.txt",
    "pi--v120-slash-palette-padded.txt",
    "omp--slash-palette.txt",
  ]) {
    it(`${name}: still reads as a dialog`, () => {
      const read = own(name);
      expect(read.surface.modal).toBe("unreadable");
      expect(isFree(read.surface)).toBe(false);
      expect(labelOf(name).state).toBe("dialog");
    });
  }

  it("a list that points at another command finds no own list, on either profile", () => {
    for (const [name, harness] of [
      ["pi--v130-slash-mod-partial--w120.txt", "pi"],
      ["omp--v18-6-slash-mod-partial--w120.txt", "omp"],
    ] as const) {
      const rows = fixtureRows(name);
      const idle = idleFor(harness)!;
      const frame = findInputFrame(rows, idle);
      const texts = rows.map(rowText);
      expect(frame === null ? null : ownCommandList(texts, frame, idle), name).toBeNull();
      if (frame !== null) expect(commandListAt(texts, frame, idle.volatile.below.commandList)?.pointed, name).toBe("/model");
    }
  });
});

// ── The fold's own rules ─────────────────────────────────────────────────────────────────────────

const IDLE_SCREEN = plainRows(["● done", "", "─".repeat(40), "❯ ", "─".repeat(40), "  model · ctx 3%"]);
const DRAFT_SCREEN = plainRows(["● done", "", "─".repeat(40), "❯ hello there", "─".repeat(40), "  model · ctx 3%"]);
const RUNNING_SCREEN = plainRows(["✻ Pondering… (4s · ↓ 120 tokens)", "", "─".repeat(40), "❯ ", "─".repeat(40), "  model · esc to interrupt"]);
const DIALOG_SCREEN = plainRows([
  "─".repeat(40),
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No",
  "",
  " Esc to cancel",
]);
const ASK: Ask = { id: "ask-1-0", kind: "permission", options: [{ id: "1", label: "Yes" }], channel: "keys", hash: "00" };

function screen(seq: number, at: number, rows: ScreenInput["rows"], revision = seq, ask: Ask | null = null): ScreenInput {
  return { seq, source: "screen", at, revision, rows, ask };
}

describe("the codex profile over the Codex fixtures (M56 spec 13)", () => {
  // The profile tests (a), (b), (c) and (d) of the design record, run with the Codex profile on the
  // Codex fixtures, and with the Codex profile applied to every fixture: a profile on a harness it
  // does not describe must never make a dialog free either.
  const CODEX = requireProfile("codex").idle;
  const codexFixtures = FIXTURES.filter((name) => labelOf(name).harness === "codex");
  const read = (name: string, idle = CODEX) => readScreen(fixtureRows(name), agentOf(labelOf(name).harness), idle);
  const signature = (r: ReturnType<typeof own>): boolean =>
    r.frame !== null && r.surface.composer === "empty" && r.surface.turn === "idle" && r.cues?.strength === "none";
  const detector = (r: ReturnType<typeof own>): boolean => askOf(r.surface.modal) !== null || r.cues?.strength === "strong";

  it("codex: the set holds idle, draft, running and dialog screens from 0.150 to 0.163", () => {
    const states = new Set(codexFixtures.map((name) => labelOf(name).state));
    for (const state of ["idle", "draft", "running", "dialog"] as const) expect(states.has(state), state).toBe(true);
    expect(codexFixtures.length).toBeGreaterThan(40);
  });

  it("codex: the frame module finds the box on every idle Codex fixture", () => {
    const idle = codexFixtures.filter((name) => labelOf(name).state === "idle");
    expect(idle.length).toBeGreaterThan(8);
    for (const name of idle) {
      expect(findInputFrame(fixtureRows(name), CODEX), name).not.toBeNull();
      expect(isFree(read(name).surface), name).toBe(true);
    }
  });

  it("codex: a draft reads as a draft, never free, and a running turn never reads idle", () => {
    for (const name of codexFixtures.filter((n) => labelOf(n).state === "draft")) {
      expect(read(name).surface.composer, name).toBe("draft");
      expect(isFree(read(name).surface), name).toBe(false);
    }
    for (const name of codexFixtures.filter((n) => labelOf(n).state === "running")) {
      expect(read(name).surface.turn, name).toBe("running");
    }
  });

  it("codex (a): the idle matcher and the modal detector never both match, on Codex fixtures and on every fixture", CORPUS_WALK, () => {
    expect(codexFixtures.filter((name) => signature(read(name)) && detector(read(name)))).toEqual([]);
    expect(FIXTURES.filter((name) => signature(read(name)) && detector(read(name)))).toEqual([]);
  });

  it("codex (b): a perturbed Codex fixture never frees a dialog, and no claim of a dialog moves toward free", () => {
    const wrong: string[] = [];
    for (const name of codexFixtures) {
      const label = labelOf(name);
      const before = read(name).surface;
      for (const perturbed of perturbations(fixtureRows(name))) {
        const after = readScreen(perturbed.rows, agentOf(label.harness), CODEX).surface;
        if (isFree(after) && (!isFree(before) || NEGATIVE.has(label.state))) wrong.push(`${name} ${perturbed.name}: free`);
        if (NEGATIVE.has(label.state)) for (const move of towardFree(before, after)) wrong.push(`${name} ${perturbed.name}: ${move}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("codex (c): a Codex dialog quoted in the transcript stays free", () => {
    const rows = fixtureRows("codex--v0162-idle.txt");
    const top = findInputFrame(rows, CODEX)!.top;
    const quote = rowsOf(
      [
        "• Here is the dialog you asked about:",
        "  Would you like to run the following command?",
        "› 1. Yes, proceed (y)",
        "  2. No, and tell Codex what to do differently (esc)",
        "  Press enter to confirm or esc to cancel",
        "",
        "• That is all it shows.",
      ].join("\n"),
    );
    const quoted = [...rows.slice(0, top - quote.length - 2), ...quote, ...rows.slice(top - 2)];
    const r = readScreen(quoted, "codex", CODEX);
    expect(r.frame).not.toBeNull();
    expect(isFree(r.surface)).toBe(true);
    // The quote is a dialog shape: read with no frame, the cues see it.
    expect(readCues(quote.slice(1, 5), null, null).strength).toBe("strong");
  });

  it("codex (c): the same dialog flush on the box is never free", () => {
    const rows = fixtureRows("codex--v0162-idle.txt");
    const top = findInputFrame(rows, CODEX)!.top;
    const dialog = rowsOf(["  Would you like to run the following command?", "› 1. Yes, proceed (y)", "  2. No (esc)", "  Press enter to confirm or esc to cancel"].join("\n"));
    const flush = [...rows.slice(0, top - dialog.length), ...dialog, ...rows.slice(top)];
    expect(isFree(readScreen(flush, "codex", CODEX).surface)).toBe(false);
  });

  it("codex (d): the negative set never reads free with the Codex profile, the 0.156.1 approvals and pickers included", CORPUS_WALK, () => {
    const negative = FIXTURES.filter((name) => NEGATIVE.has(labelOf(name).state));
    const codexNegative = negative.filter((name) => labelOf(name).harness === "codex");
    for (const name of ["codex--v0156-approval-exec-2opt.txt", "codex--v0156-approval-patch.txt", "codex--approval-exec.txt", "codex--v0162-picker-model.txt"]) {
      expect(codexNegative, name).toContain(name);
    }
    const free = negative.filter((name) => isFree(read(name).surface) || isFree(read(name, CODEX).surface));
    expect(free).toEqual([]);
    const lifted = codexNegative.filter((name) => isFree(readScreen(fixtureRows(name), "codex", CODEX, { lift: false }).surface));
    expect(lifted).toEqual([]);
  });

  it("codex: the incident screens never read free with the Codex profile", () => {
    expect(incidentScreens().filter((incident) => isFree(readScreen(incident.rows, incident.agent, CODEX).surface)).map((i) => i.name)).toEqual([]);
  });
});

// ── The profiles of M56 spec 14 ──────────────────────────────────────────────────────────────────

/**
 * One entry per harness profile added by spec 14. `idleMin` is how many idle fixtures the set must hold.
 * `quote` is a dialog as the harness prints it in a transcript: it goes over the live box and must
 * leave the box free. `labels` names the fixture labels that must read `running`.
 */
interface ProfileCase {
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

describe.each(SPEC14)("the $id profile over its fixtures (M56 spec 14)", ({ id, idleMin, quote, states }) => {
  // The profile tests (a), (b), (c) and (d) of the design record, run with this harness's profile on
  // its mine fixtures, and with the profile applied to every fixture: a profile on a harness it does
  // not describe must never make a dialog free either.
  const PROFILE = requireProfile(id).idle;
  const mine = FIXTURES.filter((name) => labelOf(name).harness === id);
  const read = (name: string, idle = PROFILE) => readScreen(fixtureRows(name), agentOf(labelOf(name).harness), idle);
  const signature = (r: ReturnType<typeof read>): boolean =>
    r.frame !== null && r.surface.composer === "empty" && r.surface.turn === "idle" && r.cues?.strength === "none";
  const detector = (r: ReturnType<typeof read>): boolean => askOf(r.surface.modal) !== null || r.cues?.strength === "strong";

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
});

describe("an OMP extension widget around the open box (#468)", () => {
  // An extension draws rows with `ctx.ui.setWidget(key, lines, { placement })`. Under the box
  // (`belowEditor`) they sit below the `╰─` prompt row, so the open box no longer ends on the
  // screen's last row. Those rows are content under the box, not a read cut inside it.
  const OMP = requireProfile("omp").idle;
  const read = (name: string) => readScreen(fixtureRows(name), agentOf("omp"), OMP);
  const IDLE_FREE = { revision: 1, turn: "idle", modal: "none", composer: "empty" };
  const box = ["", " Some earlier assistant output.", "", `╭── π  model  ~/project  main ${"─".repeat(60)}`, `╰─ ${" ".repeat(86)}`];

  it("omp: the reporter's screen, a belowEditor widget row under the open box, reads idle and free, not torn", () => {
    const rows = plainRows([...box, " widget row drawn by an extension with placement: belowEditor"]);
    expect(surfaceOfScreen({ seq: 1, source: "screen", at: 0, revision: 1, rows, ask: null }, OMP).surface).toEqual(IDLE_FREE);
  });

  it("omp: a captured idle box with a belowEditor widget row under it reads idle and free, not torn", () => {
    const r = read("omp--fresh-idle-widget-below.txt");
    expect(r.frame).toMatchObject({ top: 26, bottom: 27, interior: { prompt: 27, text: "" } });
    expect(r.surface).toEqual(IDLE_FREE);
    expect(isFree(r.surface)).toBe(true);
  });

  it("omp: an aboveEditor widget row over the open box reads idle and free", () => {
    const r = read("omp--fresh-idle-widget-above.txt");
    expect(r.frame).toMatchObject({ top: 27, bottom: 28 });
    expect(r.surface).toEqual(IDLE_FREE);
  });

  it("omp: up to maxTailRows rows under the box read free, one more reads torn", () => {
    const widget = (n: number) => Array.from({ length: n }, (_, i) => ` widget row ${i + 1}`);
    expect(OMP.frame.maxTailRows).toBe(3);
    expect(surfaceOfScreen({ seq: 1, source: "screen", at: 0, revision: 1, rows: plainRows([...box, ...widget(3)]), ask: null }, OMP).surface).toEqual(IDLE_FREE);
    expect(surfaceOfScreen({ seq: 1, source: "screen", at: 0, revision: 1, rows: plainRows([...box, "", ...widget(2)]), ask: null }, OMP).surface).toEqual(IDLE_FREE);
    expect(surfaceOfScreen({ seq: 1, source: "screen", at: 0, revision: 1, rows: plainRows([...box, ...widget(4)]), ask: null }, OMP).surface.reason).toBe("torn");
  });

  it("omp: a draft under the widget's box still reads as a draft", () => {
    const rows = plainRows([...box.slice(0, 4), "╰─ Reply with only OK.", "   Second line of the message.", " widget row"]);
    const r = surfaceOfScreen({ seq: 1, source: "screen", at: 0, revision: 1, rows, ask: null }, OMP);
    expect(r.frame?.interior.text).toBe("Reply with only OK. Second line of the message.");
    expect(r.surface.composer).toBe("draft");
  });
});

describe("a running turn on live captures (Claude Code 2.1.301, 2026-10-16)", () => {
  const read = (name: string) => readScreen(fixtureRows(name), agentOf("claude"), idleFor("claude")).surface;

  it("a finished turn's leftover row reads idle and free", () => {
    for (const name of ["claude--v2301-idle-after-turn--w100.txt", "claude--v2301-done-shell-running--w100.txt", "claude--v2301-queued-taken--w100.txt"]) {
      expect(read(name), name).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
      expect(isFree(read(name)), name).toBe(true);
    }
  });

  it("a live running row reads running, with the box empty or holding a draft", () => {
    expect(read("claude--v2301-working-quiet--w100.txt")).toMatchObject({ turn: "running", modal: "none", composer: "empty" });
    expect(read("claude--v2301-working-draft--w100.txt")).toMatchObject({ turn: "running", modal: "none", composer: "draft" });
  });

  it("a queued message reads running with an empty box: its placeholder is faint and its hint row is no modal", () => {
    expect(read("claude--v2301-working-queued-message--w100.txt")).toMatchObject({ turn: "running", modal: "none", composer: "empty" });
  });

  it("the first second of a turn, a spinner with no timer yet, reads idle: a send there goes ahead and is queued all the same", () => {
    expect(read("claude--v2301-spinner-no-timer--w100.txt")).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
  });
});

describe("foldSurface", () => {
  const context = { idle: CLAUDE, pollMs: 1000 };

  it("reads free off an idle frame, and carries the read's revision", () => {
    const { surface } = foldSurface([screen(1, 0, IDLE_SCREEN, 41)], context);
    expect(surface).toEqual({ revision: 41, turn: "idle", modal: "none", composer: "empty" });
    expect(isFree(surface)).toBe(true);
  });

  it("reads a draft, a running turn and a lifted ask", () => {
    expect(foldSurface([screen(1, 0, DRAFT_SCREEN)], context).surface.composer).toBe("draft");
    expect(foldSurface([screen(1, 0, RUNNING_SCREEN)], context).surface.turn).toBe("running");
    const lifted = foldSurface([screen(1, 0, DIALOG_SCREEN, 1, ASK)], context).surface;
    expect(lifted.modal).toEqual({ ask: ASK });
    expect(isFree(lifted)).toBe(false);
  });

  it("reads a strong cue no reader lifted as unreadable, and a weak one as unknown with no reason", () => {
    expect(foldSurface([screen(1, 0, DIALOG_SCREEN)], context).surface).toEqual({
      revision: 1,
      turn: "unknown",
      modal: "unreadable",
      composer: "unknown",
    });
    const weak = plainRows(["● done", "", "  1. first", "  2. second"]);
    expect(foldSurface([screen(1, 0, weak)], context).surface).toEqual({ revision: 1, turn: "unknown", modal: "unknown", composer: "unknown" });
  });

  it("says no-match when there is no frame, no cue and no lift", () => {
    expect(foldSurface([screen(1, 0, plainRows(["$ ls", "a b c", "$"]))], context).surface.reason).toBe("no-match");
  });

  it("says torn when the read ends inside a frame", () => {
    const torn = plainRows(["● done", "", "─".repeat(40), "❯ half a box"]);
    expect(endsInsideFrame(torn, CLAUDE)).toBe(true);
    expect(endsInsideFrame(IDLE_SCREEN, CLAUDE)).toBe(false);
    expect(foldSurface([screen(1, 0, torn)], context).surface).toEqual({ revision: 1, turn: "unknown", modal: "unknown", composer: "unknown", reason: "torn" });
  });

  it("says unreachable when the pane could not be read", () => {
    expect(foldSurface([screen(1, 0, null)], context).surface).toEqual({ revision: 1, turn: "unknown", modal: "unknown", composer: "unreachable" });
  });

  it("reads nothing as stale: no screen read in the log", () => {
    expect(foldSurface([{ seq: 1, source: "tick", at: 0 }], context).surface).toEqual({
      revision: 0,
      turn: "unknown",
      modal: "unknown",
      composer: "unknown",
      reason: "stale",
    });
  });

  it("makes a read stale after two poll intervals, and no clock ever makes a free", () => {
    const fresh: SurfaceInput[] = [screen(1, 0, IDLE_SCREEN), { seq: 2, source: "tick", at: 2000 }];
    expect(isFree(foldSurface(fresh, context).surface)).toBe(true);
    const stale: SurfaceInput[] = [screen(1, 0, IDLE_SCREEN), { seq: 2, source: "tick", at: 2001 }];
    expect(foldSurface(stale, context).surface).toEqual({ revision: 1, turn: "unknown", modal: "unknown", composer: "unknown", reason: "stale" });
    // A stale ask stays an ask: it is never free, and the phone still shows it.
    const staleAsk: SurfaceInput[] = [screen(1, 0, DIALOG_SCREEN, 1, ASK), { seq: 2, source: "tick", at: 9000 }];
    expect(foldSurface(staleAsk, context).surface.modal).toEqual({ ask: ASK });
    // Ticks alone, however many, never turn a dialog free.
    const ticks: SurfaceInput[] = [screen(1, 0, DIALOG_SCREEN), ...Array.from({ length: 20 }, (_, i) => ({ seq: i + 2, source: "tick" as const, at: 100 * i }))];
    expect(isFree(foldSurface(ticks, context).surface)).toBe(false);
  });

  it("takes inputs in seq order, whatever order the list holds them in", () => {
    const log: SurfaceInput[] = [screen(2, 10, DRAFT_SCREEN, 2), screen(1, 5, IDLE_SCREEN, 1)];
    expect(foldSurface(log, context).surface.composer).toBe("draft");
    expect(foldSurface(log.toReversed(), context).surface).toEqual(foldSurface(log, context).surface);
  });

  it("is a pure function of the log", () => {
    const log: SurfaceInput[] = [screen(1, 0, DIALOG_SCREEN, 7), { seq: 2, source: "tick", at: 500 }];
    expect(foldSurface(log, context)).toEqual(foldSurface([...log], context));
  });

  it("has no frame, and so no free, without a profile", () => {
    const { surface } = foldSurface([screen(1, 0, IDLE_SCREEN)], { idle: null, pollMs: 1000 });
    expect(isFree(surface)).toBe(false);
    expect(surface.composer).toBe("unknown");
  });

  it("names its sources in one list: screen reads, ticks and hook edges (spec 11)", () => {
    expect([...SURFACE_SOURCES]).toEqual(["screen", "tick", "edge"]);
  });

  it("agrees with surfaceOfScreen on one read", () => {
    const input = screen(1, 0, IDLE_SCREEN);
    expect(foldSurface([input], context)).toEqual(surfaceOfScreen(input, CLAUDE));
  });

  it("finds the frame the frame module finds", () => {
    expect(foldSurface([screen(1, 0, IDLE_SCREEN)], context).frame).toEqual(findInputFrame(IDLE_SCREEN, CLAUDE));
    expect(rowsOf("a\nb")).toHaveLength(2);
  });
});

// The 2026-10-16 incident on lane 8788: 37 sends refused `unconfirmed` with `modal: unreadable` while a
// fork ran and Claude Code 2.1.301 drew its agents panel under a free box. The capture and the two
// hand-built screens are labelled idle; each must read free, and the panel must be the frame's footer.
describe("the agents panel under the box (incident 2026-10-16)", () => {
  const PANEL = ["claude--v2301-fork-running-main-idle.txt", "claude--v2301-synth-agents-panel.txt", "claude--v2301-synth-agents-panel-walk-fails.txt"];

  for (const name of PANEL) {
    it(`${name} reads free, the panel walked as the footer and no cue read`, () => {
      expect(LABELS.fixtures[name]?.state).toBe("idle");
      const read = readScreen(fixtureRows(name), "claude", CLAUDE);
      expect(read.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "empty" });
      expect(read.frame?.volatile.footer).not.toBeNull();
      expect(read.frame?.volatile.named.some((hit) => hit.name === "agents-panel-main")).toBe(true);
      expect(read.cues?.cues).toEqual([]);
    });
  }
  // The review of 2026-10-16: a dialog drawn between the statusline and the panel must never pass as
  // a second footer. Each reads unreadable or as a dialog, never free.
  const RULE40 = "─".repeat(40);
  const PANEL_ROWS = ["", "  ● main", "  ◯ general-purpose   Reading a file     2m 3s · ↓ 120.1k tokens"];
  const OVER_PANEL = {
    "a Yes/No pointer list": ["  Do you want to proceed?", " ❯ 1. Yes", "   2. No"],
    "a menu with its select hint": [" ❯ Option A", "   Option B", "  Enter to select · Esc to cancel"],
    "a list ending in the view hint": [" ❯ item one", "   item two", "  Enter to select · ↓ to view"],
  } satisfies Record<string, readonly string[]>;
  for (const [what, dialog] of Object.entries(OVER_PANEL)) {
    it(`${what} over the panel never reads free`, () => {
      const rows = rowsOf(["● done", "", RULE40, "❯ ", RULE40, "  ⏵⏵ auto mode on · 1 shell", "", ...dialog, ...PANEL_ROWS].join("\n"));
      const read = readScreen(rows, "claude", CLAUDE);
      expect(modalWord(read.surface.modal)).not.toBe("none");
      expect(isFree(read.surface)).toBe(false);
    });
  }

  it("twelve agent rows under main do not read free", () => {
    const agents = Array.from({ length: 12 }, (_, i) => `  ◯ agent-${String(i)}   working   ${String(i)}s · ↓ 1k tokens`);
    const rows = rowsOf(["● done", "", RULE40, "❯ ", RULE40, "  ⏵⏵ auto mode on · 1 shell", "", "  ● main", ...agents].join("\n"));
    expect(isFree(readScreen(rows, "claude", CLAUDE).surface)).toBe(false);
  });

  // The scratch-bridge lab on 2026-10-16 (Claude Code 2.1.301, a background agent running): the panel
  // stays under the box while the box holds a draft; only the mode row drops its two hints.
  it("the lab screens read free with an empty box and with a draft", () => {
    for (const [name, composer, state] of [
      ["claude--v2301-lab-agents-panel-empty.txt", "empty", "idle"],
      ["claude--v2301-lab-agents-panel-draft.txt", "draft", "draft"],
    ] as const) {
      expect(LABELS.fixtures[name]?.state).toBe(state);
      const read = readScreen(fixtureRows(name), "claude", CLAUDE);
      expect(read.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer });
      expect(read.frame?.volatile.named.map((hit) => hit.name)).toEqual(["agents-panel-main", "agents-panel-agent"]);
      expect(read.cues?.cues).toEqual([]);
    }
  });

  // Eleven agents: the panel shows five and "↓ 6 more". One ↓ focuses the tasks pill, two the panel.
  it("the lab's eleven-agent panel reads free, with the tasks pill focused and with the panel focused", () => {
    for (const name of ["claude--v2301-lab-agents-panel-more.txt", "claude--v2301-lab-agents-panel-tasks-pill.txt", "claude--v2301-lab-agents-panel-focused.txt"]) {
      expect(LABELS.fixtures[name]?.state).toBe("idle");
      const read = readScreen(fixtureRows(name), "claude", CLAUDE);
      expect(read.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "empty" });
      const names = read.frame?.volatile.named.map((hit) => hit.name) ?? [];
      expect(names[0]).toBe("agents-panel-main");
      expect(names.at(-1)).toBe("agents-panel-more");
      expect(read.cues?.cues).toEqual([]);
    }
  });
});

describe("rows around an idle box that 1.21.3 sent to (1.22.1 audit)", () => {
  const IDLE_FREE = { revision: 1, turn: "idle", modal: "none", composer: "empty" };
  // Derived screens in fixtures/surface/ (README there), read with their harness's own profile.
  const audit = (name: string, harness: string) => readScreen(fixtureRows(name, SURFACE_FIXTURES_DIR), agentOf(harness), idleFor(harness));

  // Issue 374's screen: a custom statusLine prints as many rows as the user wrote, and 1.21.3 found
  // the box under up to eight of them. 1.22.0's agy profile searched three.
  it("agy: an idle box over a four-row custom statusLine reads idle and free", () => {
    const read = audit("agy--statusline-four-rows.txt", "agy");
    expect(read.frame).not.toBeNull();
    expect(read.surface).toEqual(IDLE_FREE);
  });

  it("agy: up to eight statusLine rows under the box read free, a ninth row loses the box", () => {
    const AGY = requireProfile("agy").idle;
    const rule = "─".repeat(60);
    const status = (n: number) => Array.from({ length: n }, (_, i) => `status row ${String(i + 1)}`);
    const read = (n: number) => surfaceOfScreen({ seq: 1, source: "screen", at: 0, revision: 1, rows: plainRows(["Done.", "", rule, ">", rule, ...status(n)]), ask: null }, AGY);
    for (let n = 0; n <= 8; n++) expect(read(n).surface, String(n)).toEqual(IDLE_FREE);
    expect(isFree(read(9).surface)).toBe(false);
  });

  // pi prints the folder first under its box. On Windows a folder outside the home folder starts with
  // its drive letter; inside it, with `~`.
  it("pi: a folder row that starts with a drive letter reads idle and free", () => {
    const read = audit("pi--v0871-idle-windows-drive.txt", "pi");
    expect(read.frame).not.toBeNull();
    expect(read.surface).toEqual(IDLE_FREE);
  });

  // A `(y/n)` in the agent's last row, flush on OMP's open box, reads as a single-key prompt and hides
  // the box (`dialogsInBox`). The box is whole, so the read is not torn: the person may check it and
  // confirm, as on pi and muse. It never reads free.
  it("omp: a (y/n) question flush on a whole box is not free and not torn", () => {
    const read = audit("omp--done-yn-question.txt", "omp");
    expect(findInputFrame(fixtureRows("omp--done-yn-question.txt", SURFACE_FIXTURES_DIR), idleFor("omp")!)).not.toBeNull();
    expect(read.surface).toEqual({ revision: 1, turn: "unknown", modal: "unreadable", composer: "unknown" });
    expect(isFree(read.surface)).toBe(false);
  });

  it("omp: a screen with no whole box under a strong cue still reads torn", () => {
    // The slash palette stands under the prompt row, so no frame closes and the read ends inside one.
    const read = own("omp--slash-palette.txt");
    expect(findInputFrame(fixtureRows("omp--slash-palette.txt"), idleFor("omp")!)).toBeNull();
    expect(read.surface.reason).toBe("torn");
  });
});

// Claude Code 2.1.302's "Heads up" notice above a live box: its keys act only on a box that holds one
// digit, so the box stays free. The rating survey over the box is another shape and stays unreadable.
describe("a notice above a live box (Claude Code 2.1.302)", () => {
  it("folds the heads-up notice with no modal over the box", () => {
    const read = readScreen(fixtureRows("claude--v2302-heads-up-above-box--w142.txt"), "claude", CLAUDE);
    expect(read.frame).not.toBeNull();
    expect(read.surface.modal).toBe("none");
    expect(read.surface.composer).toBe("empty");
  });

  it("reads the turn as running from the spinner above the notice, words before its timer and all", () => {
    const read = readScreen(fixtureRows("claude--v2302-heads-up-above-box--w142.txt"), "claude", CLAUDE);
    expect(read.surface.turn).toBe("running");
  });

  it("keeps the rating survey over the box unreadable", () => {
    expect(readScreen(fixtureRows("claude-lab--survey-rating-above-box--w82.txt"), "claude", CLAUDE).surface.modal).toBe("unreadable");
  });
});
