import { describe, expect, it } from "vitest";

import {
  DOWNLOAD_HUNG_MS,
  LEAD_STALLED_MS,
  PEER_UNREACHABLE_MS,
  endKey,
  endSentence,
  updateScreenView,
  type UpdateScreenCrewRun,
  type UpdateScreenEnd,
  type UpdateScreenInput,
  type UpdateScreenMode,
} from "./update-screen";
import type { UpdateCrewMember, UpdatePeerLeg, UpdateRun, UpdateRunState } from "./types";

// The update screen's reading, as a pure function. The component test next door proves the rows that
// reach the DOM; everything about WHICH state wins, and whether the operator may close it, lives here.

const NOW = 1_800_000_000_000;

const run = (state: UpdateRunState, over: Partial<UpdateRun> = {}): UpdateRun => ({
  schema: 1,
  state,
  from: "1.8.2",
  to: "1.9.0",
  startedAt: NOW - 45_000,
  updatedAt: NOW - 4_000,
  pid: 99,
  attempt: 0,
  ...over,
});

const BASE: UpdateScreenInput = {
  run: undefined,
  crew: [],
  leadName: "bluefin",
  stage: "idle",
  progress: null,
  installingSince: null,
  startedHere: false,
  controllerChangedAt: null,
  downloadReleased: false,
  leadReleased: false,
  now: NOW,
};

const read = (over: Partial<UpdateScreenInput> = {}) => updateScreenView({ ...BASE, ...over });

// ── THE CROSS-PRODUCT, IN FULL ──────────────────────────────────────────────────────────────────
//
// Nine run states x two worker stages x started-here or not x the controller swapped or not. Seventy
// two rows, every one of them asserting a mode and a dismissible value, so no combination is
// untested and the odd pairs are rows like any other:
//
//   * `done` + `installing` is LEGITIMATE. The machines finished and this phone is still fetching the
//     bundle they now serve, so the sheet stays up and waits for the controller swap.
//   * `restarting` + `idle` is the ordinary case. The phone has no new bundle to fetch yet.
//   * `installing` + the controller already swapped means this document is running the new bundle, so
//     the device's own leg is closed whatever the stage store still says.
//
// The table is written out rather than computed, on purpose. A generated expectation is the reducer
// asserting against itself, and the one thing this file exists to pin is the SHAPE of the answer.

type Row = readonly [
  UpdateRunState,
  "idle" | "installing",
  boolean,
  boolean,
  UpdateScreenMode,
  boolean,
];

const TABLE: readonly Row[] = [
  ["idle", "idle", true, true, "hidden", true],
  ["idle", "idle", true, false, "hidden", true],
  ["idle", "idle", false, true, "hidden", true],
  ["idle", "idle", false, false, "hidden", true],
  ["idle", "installing", true, true, "hidden", true],
  ["idle", "installing", true, false, "hidden", true],
  ["idle", "installing", false, true, "hidden", true],
  ["idle", "installing", false, false, "hidden", true],
  ["preflight", "idle", true, true, "expanded", false],
  ["preflight", "idle", true, false, "expanded", false],
  ["preflight", "idle", false, true, "collapsed", true],
  ["preflight", "idle", false, false, "collapsed", true],
  ["preflight", "installing", true, true, "expanded", false],
  ["preflight", "installing", true, false, "expanded", false],
  ["preflight", "installing", false, true, "collapsed", true],
  ["preflight", "installing", false, false, "collapsed", true],
  ["staging", "idle", true, true, "expanded", false],
  ["staging", "idle", true, false, "expanded", false],
  ["staging", "idle", false, true, "collapsed", true],
  ["staging", "idle", false, false, "collapsed", true],
  ["staging", "installing", true, true, "expanded", false],
  ["staging", "installing", true, false, "expanded", false],
  ["staging", "installing", false, true, "collapsed", true],
  ["staging", "installing", false, false, "collapsed", true],
  ["restarting", "idle", true, true, "expanded", false],
  ["restarting", "idle", true, false, "expanded", false],
  ["restarting", "idle", false, true, "collapsed", true],
  ["restarting", "idle", false, false, "collapsed", true],
  ["restarting", "installing", true, true, "expanded", false],
  ["restarting", "installing", true, false, "expanded", false],
  ["restarting", "installing", false, true, "collapsed", true],
  ["restarting", "installing", false, false, "collapsed", true],
  ["verifying", "idle", true, true, "expanded", false],
  ["verifying", "idle", true, false, "expanded", false],
  ["verifying", "idle", false, true, "collapsed", true],
  ["verifying", "idle", false, false, "collapsed", true],
  ["verifying", "installing", true, true, "expanded", false],
  ["verifying", "installing", true, false, "expanded", false],
  ["verifying", "installing", false, true, "collapsed", true],
  ["verifying", "installing", false, false, "collapsed", true],
  ["done", "idle", true, true, "hidden", true],
  ["done", "idle", true, false, "hidden", true],
  ["done", "idle", false, true, "hidden", true],
  ["done", "idle", false, false, "hidden", true],
  ["done", "installing", true, true, "hidden", true],
  ["done", "installing", true, false, "expanded", true],
  ["done", "installing", false, true, "hidden", true],
  ["done", "installing", false, false, "collapsed", true],
  ["rolled-back", "idle", true, true, "expanded", true],
  ["rolled-back", "idle", true, false, "expanded", true],
  ["rolled-back", "idle", false, true, "expanded", true],
  ["rolled-back", "idle", false, false, "expanded", true],
  ["rolled-back", "installing", true, true, "expanded", true],
  ["rolled-back", "installing", true, false, "expanded", true],
  ["rolled-back", "installing", false, true, "expanded", true],
  ["rolled-back", "installing", false, false, "expanded", true],
  ["stuck", "idle", true, true, "expanded", true],
  ["stuck", "idle", true, false, "expanded", true],
  ["stuck", "idle", false, true, "expanded", true],
  ["stuck", "idle", false, false, "expanded", true],
  ["stuck", "installing", true, true, "expanded", true],
  ["stuck", "installing", true, false, "expanded", true],
  ["stuck", "installing", false, true, "expanded", true],
  ["stuck", "installing", false, false, "expanded", true],
  ["interrupted", "idle", true, true, "expanded", true],
  ["interrupted", "idle", true, false, "expanded", true],
  ["interrupted", "idle", false, true, "expanded", true],
  ["interrupted", "idle", false, false, "expanded", true],
  ["interrupted", "installing", true, true, "expanded", true],
  ["interrupted", "installing", true, false, "expanded", true],
  ["interrupted", "installing", false, true, "expanded", true],
  ["interrupted", "installing", false, false, "expanded", true],
];

describe("every combination of run state, worker stage, who started it and the controller swap", () => {
  it("has exactly 72 rows — the whole cross-product and nothing missing", () => {
    expect(TABLE).toHaveLength(72);
    const seen = new Set(TABLE.map(([a, b, c, d]) => `${a}|${b}|${c}|${d}`));
    expect(seen.size).toBe(72);
  });

  it.each(TABLE)(
    "run %s, worker %s, startedHere=%s, swapped=%s is %s (dismissible=%s)",
    (state, stage, startedHere, swapped, mode, dismissible) => {
      const view = read({
        run: run(state),
        stage,
        startedHere,
        controllerChangedAt: swapped ? NOW - 1_000 : null,
        installingSince: stage === "installing" ? NOW - 5_000 : null,
        progress: stage === "installing" ? { done: 3, total: 28, at: NOW - 500 } : null,
      });
      expect(view.mode).toBe(mode);
      expect(view.dismissible).toBe(dismissible);
    },
  );

  it("NEVER leaves the sheet expanded and undismissible once the run has settled", () => {
    // The invariant the whole file rests on, asserted over the table rather than over one example:
    // `done`, `rolled-back`, `stuck` and `interrupted` are all over, and a panel the operator cannot
    // close over a run nobody is driving is the sheet sticking open.
    const settled = new Set<UpdateRunState>(["done", "rolled-back", "stuck", "interrupted", "idle"]);
    for (const [state, , , , mode, dismissible] of TABLE) {
      if (!settled.has(state)) continue;
      expect(mode === "expanded" && !dismissible, `${state} must not trap the operator`).toBe(false);
    }
  });

  it("blocks ONLY the device that started a run that is still in flight", () => {
    const inFlight: UpdateRunState[] = ["preflight", "staging", "restarting", "verifying"];
    for (const state of inFlight) {
      expect(read({ run: run(state), startedHere: true })).toMatchObject({
        mode: "expanded",
        dismissible: false,
      });
      expect(read({ run: run(state), startedHere: false })).toMatchObject({
        mode: "collapsed",
        dismissible: true,
      });
    }
  });
});

describe("the rows", () => {
  const peers: UpdatePeerLeg[] = [
    { name: "minibuch", state: "updating", version: "1.8.2", updatedAt: NOW - 3_000 },
    { name: "cellar", state: "package-managed", version: "1.8.2", updatedAt: NOW - 3_000 },
  ];

  it("puts the lead first, then every peer in the order the lead reported them", () => {
    const view = read({ run: run("staging", { peers }), startedHere: true });
    expect(view.rows.map((r) => r.name)).toEqual(["bluefin", "minibuch", "cellar"]);
    expect(view.rows[0]?.lead).toBe(true);
  });

  it("gives the lead a word for every state it can be in — a state with no word reads as a hang", () => {
    const words = new Map<UpdateRunState, string>();
    for (const state of [
      "preflight",
      "staging",
      "restarting",
      "verifying",
      "done",
      "rolled-back",
      "stuck",
      "interrupted",
    ] as const) {
      const view = read({ run: run(state), startedHere: true });
      const word = view.rows[0]?.word ?? "";
      expect(word, state).not.toBe("");
      words.set(state, word);
    }
    expect(words.get("preflight")).toBe("checking");
    expect(words.get("staging")).toBe("building");
    expect(words.get("restarting")).toBe("restarting, back in a moment");
    expect(words.get("verifying")).toBe("checking the new version");
    // A rolled-back row names the version the machine is actually on, which is the first fact wanted.
    expect(words.get("rolled-back")).toBe("back on 1.8.2");
  });

  it("says who owns a package-managed machine, and never calls it a failure", () => {
    const view = read({ run: run("staging", { peers }), startedHere: true });
    const managed = view.rows.find((r) => r.name === "cellar");
    expect(managed?.packageManaged).toBe(true);
    expect(managed?.moving).toBe(false);
    expect(managed?.detail).toMatch(/package manager/);
  });

  it("carries a census row for a machine no leg has named yet", () => {
    const crew: UpdateCrewMember[] = [
      { name: "attic", version: "1.8.2", verdict: "green", reasons: [], asOf: NOW - 9_000 },
    ];
    const view = read({ run: run("preflight"), crew, startedHere: true });
    expect(view.rows.map((r) => r.name)).toEqual(["bluefin", "attic"]);
    expect(view.rows[1]?.word).toBe("waiting");
  });
});

describe("the three thresholds, each with its own way out", () => {
  it(`calls a peer quiet past PEER_UNREACHABLE_MS (${PEER_UNREACHABLE_MS} ms) and dates it`, () => {
    const at = (ago: number) =>
      read({
        startedHere: true,
        run: run("verifying", {
          peers: [{ name: "minibuch", state: "updating", updatedAt: NOW - ago }],
        }),
      }).rows[1];
    expect(at(PEER_UNREACHABLE_MS - 1)?.quiet).toBe(false);
    const quiet = at(PEER_UNREACHABLE_MS);
    expect(quiet?.quiet).toBe(true);
    expect(quiet?.lastSeen).toMatch(/last seen/);
  });

  it("an unreachable leg is quiet whatever its stamp says — the lead has already given up", () => {
    const view = read({
      startedHere: true,
      run: run("verifying", {
        peers: [{ name: "minibuch", state: "unreachable", reason: "missed 3 sweeps", updatedAt: NOW }],
      }),
    });
    expect(view.rows[1]).toMatchObject({ quiet: true, moving: false, detail: "missed 3 sweeps" });
  });

  it(`calls the download hung past DOWNLOAD_HUNG_MS (${DOWNLOAD_HUNG_MS} ms) with no new file`, () => {
    const at = (ago: number) =>
      read({
        startedHere: true,
        run: run("done"),
        stage: "installing",
        installingSince: NOW - ago,
        progress: { done: 12, total: 28, at: NOW - ago },
      });
    expect(at(DOWNLOAD_HUNG_MS - 1).device?.hung).toBe(false);
    expect(at(DOWNLOAD_HUNG_MS).device?.hung).toBe(true);
    // And it owes exactly one re-check, so a badge lying about a dead worker corrects itself.
    expect(at(DOWNLOAD_HUNG_MS).recheckDownload).toBe(true);
  });

  it("the hung-download way out folds the sheet and hands the app back", () => {
    const hung = {
      startedHere: true,
      run: run("staging"),
      stage: "installing" as const,
      installingSince: NOW - DOWNLOAD_HUNG_MS - 1_000,
      progress: { done: 12, total: 28, at: NOW - DOWNLOAD_HUNG_MS - 1_000 },
    };
    expect(read(hung)).toMatchObject({ mode: "expanded", dismissible: false });
    expect(read({ ...hung, downloadReleased: true })).toMatchObject({
      mode: "collapsed",
      dismissible: true,
    });
  });

  it(`calls the lead stalled past LEAD_STALLED_MS (${LEAD_STALLED_MS} ms) in one state`, () => {
    const at = (ago: number) =>
      read({ startedHere: true, run: run("staging", { updatedAt: NOW - ago }) });
    expect(at(LEAD_STALLED_MS - 1).leadStalled).toBe(false);
    expect(at(LEAD_STALLED_MS).leadStalled).toBe(true);
  });

  it("the stalled-lead way out folds the sheet too, and cancels nothing", () => {
    const stalled = { startedHere: true, run: run("staging", { updatedAt: NOW - LEAD_STALLED_MS }) };
    expect(read(stalled)).toMatchObject({ mode: "expanded", dismissible: false });
    const released = read({ ...stalled, leadReleased: true });
    expect(released).toMatchObject({ mode: "collapsed", dismissible: true });
    // The run is still there: letting go of the screen is not letting go of the update.
    expect(released.rows[0]?.word).toBe("building");
  });

  it("never arms a way out on a stamp from a download that is not happening", () => {
    // A worker that finished hours ago leaves a stale stamp behind. A fresh run must not inherit it
    // and hand the operator straight back out of a sheet they have not read.
    const view = read({
      startedHere: true,
      run: run("staging"),
      stage: "idle",
      installingSince: NOW - DOWNLOAD_HUNG_MS - 60_000,
    });
    expect(view.device).toBeNull();
    expect(view.recheckDownload).toBe(false);
  });
});

describe("this device's own row", () => {
  it("counts files, and says 'switching' once every file is in", () => {
    const downloading = read({
      startedHere: true,
      run: run("done"),
      stage: "installing",
      installingSince: NOW - 9_000,
      progress: { done: 12, total: 28, at: NOW - 200 },
    });
    expect(downloading.device).toMatchObject({ phase: "downloading", done: 12, total: 28 });
    expect(downloading.device?.elapsedMs).toBe(9_000);

    const switching = read({
      startedHere: true,
      run: run("done"),
      stage: "installing",
      installingSince: NOW - 9_000,
      progress: { done: 28, total: 28, at: NOW - 200 },
    });
    expect(switching.device?.phase).toBe("switching");
  });

  it("is absent with no run to be about — a bare bundle download is the band's row (2026-09-12)", () => {
    const view = read({ stage: "installing", installingSince: NOW - 5_000 });
    expect(view.device).toBeNull();
    expect(view.mode).toBe("hidden");
  });

  it("is closed by the controller swap, whatever the stage store still says", () => {
    const view = read({
      startedHere: true,
      run: run("done"),
      stage: "installing",
      installingSince: NOW - 9_000,
      controllerChangedAt: NOW - 100,
    });
    expect(view.device).toBeNull();
    expect(view.mode).toBe("hidden");
  });
});

describe("the end announces itself once, in the right words", () => {
  it("names the CREW when there are peers", () => {
    const view = read({
      startedHere: true,
      run: run("done", { peers: [{ name: "minibuch", state: "done", version: "1.9.0" }] }),
    });
    expect(view.end).toEqual({ kind: "crew", version: "1.9.0" });
    expect(endSentence(view.end)).toBe("Crew updated to 1.9.0");
  });

  it("names the MACHINE on a solo install — there is no crew to name", () => {
    const view = read({ startedHere: true, run: run("done") });
    expect(view.end).toEqual({ kind: "solo", machine: "bluefin", version: "1.9.0" });
    expect(endSentence(view.end)).toBe("bluefin updated to 1.9.0");
  });

  it("goes quiet about a run that finished long ago — the announcement is not news tomorrow", () => {
    // The record persists on the snapshot, and the announcement fires per DOCUMENT: a page that
    // reloads onto the new bundle is a new document. Without the window every load for the next week
    // would announce the same update again.
    const view = read({ startedHere: true, run: run("done", { updatedAt: NOW - 11 * 60_000 }) });
    expect(view.end.kind).toBe("none");
  });

  it("says nothing while this phone is still downloading the bundle the machines now serve", () => {
    const view = read({
      startedHere: true,
      run: run("done"),
      stage: "installing",
      installingSince: NOW - 3_000,
      progress: { done: 4, total: 28, at: NOW - 100 },
    });
    expect(view.end.kind).toBe("none");
    expect(endSentence(view.end)).toBeNull();
  });

  it("a run that ended badly leaves the sentence and the sheet, dismissible", () => {
    const view = read({
      startedHere: true,
      run: run("rolled-back", { reason: "health gate timed out" }),
    });
    expect(view.mode).toBe("expanded");
    expect(view.dismissible).toBe(true);
    expect(view.end).toMatchObject({ kind: "failed" });
    expect(endSentence(view.end)).toBeNull();
    // SAFETY: asserted one line above — the narrowing is what the field access below needs.
    expect((view.end as { sentence: string }).sentence).toMatch(/still on 1\.8\.2: health gate timed out/);
  });

  it("says why even when the host sent no reason at all", () => {
    const view = read({ startedHere: true, run: run("stuck") });
    expect(view.end).toMatchObject({ kind: "failed" });
    // SAFETY: asserted one line above — the narrowing is what the field access below needs.
    expect((view.end as { sentence: string }).sentence).toMatch(/stuck: \S/);
  });
});

// ── A RUN THAT MOVES ONLY THE MEMBERS (M32, decided 2026-09-19) ──────────────────────────────────
//
// "Retry crew update", or levelling members while the lead is already current, writes no run record
// on the lead. Its legs ride the status, and the store hands them over as `crewRun`. The same screen
// is owed: the takeover on the device that tapped, the badge on every other device, the failed sheet
// when a member did not arrive, the toast when every member did. The table below is the crew-only
// half of the cross-product, written out for the same reason the one above is.

const LEAD_VERSION = "1.9.1";

/** A crew-only run: the members are levelled to the lead's own version. */
const crewRun = (legs: UpdatePeerLeg[], settledAt: number | null = null): UpdateScreenCrewRun => ({
  legs,
  settledAt,
  to: LEAD_VERSION,
  current: LEAD_VERSION,
});

const MOVING: UpdatePeerLeg[] = [
  { name: "minibuch", state: "updating", version: "1.9.0", updatedAt: NOW - 3_000 },
  { name: "attic", state: "waiting", version: "1.9.0", updatedAt: NOW - 5_000 },
];

/** Every stamp older than the stall threshold: the run has held its state too long. */
const STALLED: UpdatePeerLeg[] = MOVING.map((leg) => ({ ...leg, updatedAt: NOW - LEAD_STALLED_MS - 1_000 }));

const FAILED: UpdatePeerLeg[] = [
  { name: "minibuch", state: "rolled-back", version: "1.9.0", reason: "health gate timed out", updatedAt: NOW - 9_000 },
  { name: "attic", state: "done", version: LEAD_VERSION, updatedAt: NOW - 9_000 },
];

const DONE: UpdatePeerLeg[] = [
  { name: "minibuch", state: "done", version: LEAD_VERSION, updatedAt: NOW - 9_000 },
  { name: "attic", state: "done", version: LEAD_VERSION, updatedAt: NOW - 9_000 },
];

/** The census, as `GET /api/update/check` reports it. */
const census = (minibuch: string | null): UpdateCrewMember[] => [
  { name: "minibuch", version: minibuch, verdict: "green", reasons: [], asOf: NOW - 2_000 },
  { name: "attic", version: LEAD_VERSION, verdict: "green", reasons: [], asOf: NOW - 2_000 },
];

type CrewPhase =
  | "begun"
  | "in flight"
  | "in flight, no clock"
  | "stalled"
  | "escaped"
  | "failed"
  | "failed, member since levelled"
  | "done";

const PHASE = {
  // The beat after this device's own confirm: the run is begun and no sweep has folded it yet.
  begun: { crewRun: crewRun([]), crew: census("1.9.0") },
  "in flight": { crewRun: crewRun(MOVING), crew: census("1.9.0") },
  // Legs with no stamp on them. The bridge backfills one on every leg (crew/follow.ts, M20/12), so
  // this cannot happen today — and the stall, the only way out of the takeover, is measured on those
  // stamps. The sheet shows, the app stays live: no invariant of another module can trap a phone.
  "in flight, no clock": {
    crewRun: crewRun(MOVING.map(({ updatedAt: _drop, ...leg }) => leg)),
    crew: census("1.9.0"),
  },
  stalled: { crewRun: crewRun(STALLED), crew: census("1.9.0") },
  escaped: { crewRun: crewRun(STALLED), crew: census("1.9.0"), leadReleased: true },
  failed: { crewRun: crewRun(FAILED, NOW - 8_000), crew: census("1.9.0") },
  // The part-1 rule, inside the sheet: a failed leg whose member the census shows level is not a
  // failure, so this run ended well.
  "failed, member since levelled": { crewRun: crewRun(FAILED, NOW - 8_000), crew: census(LEAD_VERSION) },
  done: { crewRun: crewRun(DONE, NOW - 8_000), crew: census(LEAD_VERSION) },
} satisfies Record<CrewPhase, Partial<UpdateScreenInput>>;

type CrewRow = readonly [CrewPhase, boolean, UpdateScreenMode, boolean, UpdateScreenEnd["kind"], "crew" | null];

const CREW_TABLE: readonly CrewRow[] = [
  // phase, startedHere, mode, dismissible, end, inFlight
  ["begun", true, "expanded", false, "none", "crew"],
  ["begun", false, "collapsed", true, "none", "crew"],
  ["in flight", true, "expanded", false, "none", "crew"],
  ["in flight", false, "collapsed", true, "none", "crew"],
  ["in flight, no clock", true, "expanded", true, "none", "crew"],
  ["in flight, no clock", false, "collapsed", true, "none", "crew"],
  ["stalled", true, "expanded", false, "none", "crew"],
  ["stalled", false, "collapsed", true, "none", "crew"],
  ["escaped", true, "collapsed", true, "none", "crew"],
  ["escaped", false, "collapsed", true, "none", "crew"],
  ["failed", true, "expanded", true, "failed", null],
  // Every other device: the lead's own reading, which has no run here. The band names the member.
  ["failed", false, "hidden", true, "none", null],
  ["failed, member since levelled", true, "hidden", true, "members", null],
  ["failed, member since levelled", false, "hidden", true, "none", null],
  ["done", true, "hidden", true, "members", null],
  ["done", false, "hidden", true, "none", null],
];

describe("a crew-only run: tapped here or elsewhere, in flight, failed, done, escaped", () => {
  it("has a row for every phase on both kinds of device", () => {
    expect(CREW_TABLE).toHaveLength(Object.keys(PHASE).length * 2);
    expect(new Set(CREW_TABLE.map(([phase, here]) => `${phase}|${here}`)).size).toBe(CREW_TABLE.length);
  });

  it.each(CREW_TABLE)(
    "%s, startedHere=%s is %s (dismissible=%s, end=%s, inFlight=%s)",
    (phase, startedHere, mode, dismissible, end, inFlight) => {
      const view = read({ ...PHASE[phase], startedHere });
      expect(view.mode).toBe(mode);
      expect(view.dismissible).toBe(dismissible);
      expect(view.end.kind).toBe(end);
      expect(view.inFlight).toBe(inFlight);
    },
  );

  it("blocks the app ONLY on the device that tapped, and only while the run is in flight", () => {
    for (const [phase, startedHere, mode, dismissible] of CREW_TABLE) {
      const blocking = mode === "expanded" && !dismissible;
      const inFlight = phase === "begun" || phase === "in flight" || phase === "stalled";
      expect(blocking, `${phase}, startedHere=${startedHere}`).toBe(startedHere && inFlight);
    }
  });

  it("marks the stall on the run's newest leg, with the lead's own threshold, and offers the same way out", () => {
    const at = (ago: number) =>
      read({
        startedHere: true,
        crew: census("1.9.0"),
        crewRun: crewRun(MOVING.map((leg) => ({ ...leg, updatedAt: NOW - ago }))),
      });
    expect(at(LEAD_STALLED_MS - 1).leadStalled).toBe(false);
    expect(at(LEAD_STALLED_MS).leadStalled).toBe(true);
    // No leg has spoken yet: nothing to measure, so nothing is stalled.
    expect(read({ startedHere: true, crewRun: crewRun([]) }).leadStalled).toBe(false);
  });

  it("is honest about the lead: already on the version, not updating, and it restarts nothing", () => {
    const view = read({ ...PHASE["in flight"], startedHere: true });
    expect(view.rows[0]).toMatchObject({
      name: "bluefin",
      lead: true,
      version: LEAD_VERSION,
      word: "already up to date",
      moving: false,
      settled: true,
    });
    expect(view.rows[0]?.detail).toMatch(/only the members/);
    expect(view.rows.map((r) => r.name)).toEqual(["bluefin", "minibuch", "attic"]);
    expect(view.rows[1]).toMatchObject({ moving: true, word: "updating" });
  });

  it("never shows an OLD lead record's state on a crew-only run", () => {
    // The record on disk is from some earlier run. A rolled-back one would otherwise put last week's
    // failure on the screen of a run that is going perfectly well.
    const view = read({
      ...PHASE["in flight"],
      startedHere: true,
      run: run("rolled-back", { updatedAt: NOW - 7 * 86_400_000 }),
    });
    expect(view).toMatchObject({ mode: "expanded", dismissible: false, inFlight: "crew" });
    expect(view.rows[0]?.word).toBe("already up to date");
    expect(view.end.kind).toBe("none");
  });

  it("in the beat before the first sweep, says a member already level is up to date, not waiting", () => {
    const view = read({ ...PHASE.begun, startedHere: true });
    const byName = new Map(view.rows.map((row) => [row.name, row]));
    expect(byName.get("minibuch")).toMatchObject({ word: "waiting", settled: false });
    expect(byName.get("attic")).toMatchObject({ word: "already up to date", settled: true });
  });

  it("draws no device row: the lead serves the same bundle, so a download here is not this run's", () => {
    const view = read({
      ...PHASE["in flight"],
      startedHere: true,
      stage: "installing",
      installingSince: NOW - DOWNLOAD_HUNG_MS - 1_000,
      progress: { done: 3, total: 28, at: NOW - DOWNLOAD_HUNG_MS - 1_000 },
    });
    expect(view.device).toBeNull();
    expect(view.recheckDownload).toBe(false);
  });

  it("names the failed member in the band's own words, and the key tells one failure from the next", () => {
    const view = read({ ...PHASE.failed, startedHere: true });
    expect(view.end).toMatchObject({
      kind: "failed",
      sentence: "Could not update minibuch: health gate timed out.",
      key: `crew:${NOW - 8_000}`,
    });
  });

  it("keeps a failed leg a failure when the member's version is unknown", () => {
    const view = read({ ...PHASE.failed, crew: census(null), startedHere: true });
    expect(view.end.kind).toBe("failed");
  });

  it("toasts the MEMBERS, never the crew: the lead did not move", () => {
    const view = read({ ...PHASE.done, startedHere: true });
    expect(view.end).toEqual({ kind: "members", version: LEAD_VERSION, settledAt: NOW - 8_000 });
    expect(endSentence(view.end)).toBe("Members updated to 1.9.1");
    // Two crew-only runs level to the same version, so the announcement is keyed by the settle.
    expect(endKey(view.end)).toBe(`members:${NOW - 8_000}`);
    expect(endKey(read({ ...PHASE.done, crewRun: crewRun(DONE, NOW - 1_000), startedHere: true }).end)).toBe(
      `members:${NOW - 1_000}`,
    );
  });

  it("leaves a FULL run's legs to the lead's reading: their target is the release above the lead", () => {
    // A full run begins its queue before its own record lands, so for a while its legs ride the
    // status beside an older record. Those are not a crew-only run, and the lead row must not say the
    // lead is sitting this one out.
    const view = read({
      startedHere: true,
      run: run("done", { to: "1.9.0", updatedAt: NOW - 3 * 86_400_000 }),
      crewRun: { legs: MOVING, settledAt: null, to: "1.9.2", current: LEAD_VERSION },
    });
    expect(view.inFlight).toBeNull();
    expect(view.rows.some((r) => r.word === "already up to date")).toBe(false);
    // And a bridge that did not say where the legs are going is not read as crew-only either.
    expect(read({ startedHere: true, crewRun: { ...crewRun(MOVING), to: null } }).inFlight).toBeNull();
  });

  it("gives way to a run the lead takes part in", () => {
    const view = read({ startedHere: true, run: run("staging"), crewRun: crewRun(MOVING) });
    expect(view.inFlight).toBe("lead");
    expect(view.rows[0]?.word).toBe("building");
  });

  it("NEVER leaves the sheet expanded and undismissible once the crew-only run has settled", () => {
    for (const phase of ["failed", "failed, member since levelled", "done"] as const) {
      for (const startedHere of [true, false]) {
        const view = read({ ...PHASE[phase], startedHere });
        expect(view.mode === "expanded" && !view.dismissible, `${phase} must not trap the operator`).toBe(false);
      }
    }
  });
});

describe("the reducer is pure", () => {
  it("answers the same thing twice for one input, and reads no clock of its own", () => {
    const input: Partial<UpdateScreenInput> = { startedHere: true, run: run("staging") };
    expect(read(input)).toEqual(read(input));
  });
});
