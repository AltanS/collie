import { describe, expect, it } from "vitest";

import {
  DOWNLOAD_HUNG_MS,
  KEEP_TRYING_MS,
  LEAD_STALLED_MS,
  PEER_UNREACHABLE_MS,
  PHONE_WAIT_MS,
  formatClock,
  joinNames,
  updateScreenView,
  type UpdatePhase,
  type UpdateScreenCrewRun,
  type UpdateScreenInput,
  type UpdateScreenMode,
} from "./update-screen";
import type { UpdateClaim } from "./update-ribbon";
import type { UpdateCrewMember, UpdatePeerLeg, UpdateRun, UpdateRunState } from "./types";

// Update mode's reading, as a pure function (ADR 0064, amending ADR 0044). The component test next
// door proves what reaches the DOM; WHICH phase wins, which row moves, whether the app is locked and
// when the phone's own step comes are all decided here, so they are pinned here.

const NOW = 1_800_000_000_000;
const FROM = "1.11.1";
const TO = "1.12.0";

const run = (state: UpdateRunState, over: Partial<UpdateRun> = {}): UpdateRun => ({
  schema: 1,
  state,
  from: FROM,
  to: TO,
  startedAt: NOW - 240_000,
  updatedAt: NOW - 4_000,
  pid: 99,
  attempt: 0,
  runId: "run-1",
  ...over,
});

const leg = (name: string, state: UpdatePeerLeg["state"], over: Partial<UpdatePeerLeg> = {}): UpdatePeerLeg => ({
  name,
  state,
  version: FROM,
  updatedAt: NOW - 3_000,
  ...over,
});

const CREW: UpdateCrewMember[] = [
  { name: "minibuch", version: FROM, verdict: "green", reasons: [], asOf: NOW - 3_000 },
  { name: "cellar", version: FROM, verdict: "green", reasons: [], asOf: NOW - 3_000 },
];

const CLAIM: UpdateClaim = {
  startedAt: NOW - 250_000,
  runId: "run-1",
  target: TO,
  peersOnly: false,
  bundleAtStart: "bundle-a",
  skipped: [],
  lead: "bluefin",
  members: ["minibuch", "cellar"],
  lastPhase: null,
};

const BASE: UpdateScreenInput = {
  run: undefined,
  crew: CREW,
  leadName: "bluefin",
  stage: "idle",
  progress: null,
  installingSince: null,
  startedHere: true,
  controllerChangedAt: null,
  released: false,
  now: NOW,
  claim: CLAIM,
  bundle: { id: "bundle-a", version: FROM },
  serverStale: false,
};

const read = (over: Partial<UpdateScreenInput> = {}) => updateScreenView({ ...BASE, ...over });
const other = (over: Partial<UpdateScreenInput> = {}) => read({ startedHere: false, claim: null, ...over });

const WAITING = [leg("minibuch", "waiting"), leg("cellar", "waiting")];
const ARRIVED = [leg("minibuch", "done", { version: TO }), leg("cellar", "done", { version: TO })];

// ── THE WALK, ON THE DEVICE THAT STARTED IT ─────────────────────────────────────────────────────

describe("the seven steps, on the device that started the run", () => {
  const cases: [string, Partial<UpdateScreenInput>, UpdatePhase, number, UpdateScreenMode, boolean][] = [
    ["preflight", { run: run("preflight", { peers: WAITING }) }, "check", 1, "expanded", true],
    ["staging", { run: run("staging", { peers: WAITING }) }, "build", 2, "expanded", true],
    ["restarting", { run: run("restarting", { peers: WAITING }) }, "restart", 3, "expanded", true],
    ["verifying", { run: run("verifying", { peers: WAITING }) }, "verify", 4, "expanded", true],
    [
      "done, a member still moving",
      { run: run("done", { peers: [leg("minibuch", "updating"), leg("cellar", "waiting")] }) },
      "members",
      5,
      "expanded",
      true,
    ],
    ["done, members arrived, no new app yet", { run: run("done", { peers: ARRIVED, settledAt: NOW - 1_000 }) }, "phone", 6, "expanded", true],
    [
      "done, this phone downloading",
      {
        run: run("done", { peers: ARRIVED, settledAt: NOW - 1_000 }),
        stage: "installing",
        installingSince: NOW - 5_000,
        progress: { done: 12, total: 28, at: NOW - 200 },
      },
      "phone",
      6,
      "expanded",
      true,
    ],
    [
      "done, this phone reloaded onto the new app",
      { run: run("done", { peers: ARRIVED, settledAt: NOW - 1_000 }), bundle: { id: "bundle-b", version: FROM } },
      "done",
      7,
      "expanded",
      false,
    ],
  ];
  for (const [label, over, phase, step, mode, locked] of cases) {
    it(`${label}: ${phase}, step ${step}, ${mode}, ${locked ? "locked" : "not locked"}`, () => {
      const view = read(over);
      expect(view.phase).toBe(phase);
      expect(view.step).toBe(step);
      expect(view.mode).toBe(mode);
      expect(view.locked).toBe(locked);
      expect(view.dismissible).toBe(!locked);
      expect(view.mine).toBe(true);
    });
  }

  it("keeps the same rows, in the same order, in every state: the panel's height never changes", () => {
    const keys = cases.map(([, over]) => read(over).rows.map((row) => row.key).join(","));
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("lead,peer:minibuch,peer:cellar,phone");
    // ...and "Ready to start" has the same rows too, so the confirm does not move either.
    const ready = read({ run: undefined, claim: null, startedHere: false, ask: { kind: "crew", version: TO, major: false, peersOnly: false, current: FROM } });
    expect(ready.rows.map((row) => row.key).join(",")).toBe(keys[0]);
  });

  it("names the version on the way and the step's own words", () => {
    const view = read({ run: run("staging", { peers: WAITING }) });
    expect(view.target).toBe(TO);
    expect(view.from).toBe(FROM);
    expect(view.heading).toBe(`Building ${TO} on bluefin`);
    expect(view.rows[0]?.versions).toBe(`${FROM} → ${TO}`);
    // The clock counts from this device's own tap.
    expect(view.startedAt).toBe(CLAIM.startedAt);
    expect(view.endedAt).toBeNull();
  });
});

// ── FAULT 1: THE LEAD'S `done` IS NOT THE END ────────────────────────────────────────────────────

describe("the lead's own `done` while members still wait (2026-09-23 study, fault 1)", () => {
  const view = read({ run: run("done", { peers: [leg("minibuch", "done", { version: TO }), leg("cellar", "waiting")] }) });

  it("stays on step 5, locked, and announces no end", () => {
    expect(view.phase).toBe("members");
    expect(view.mode).toBe("expanded");
    expect(view.locked).toBe(true);
    expect(view.end.kind).toBe("none");
  });

  it("holds this phone's own reload until step 6", () => {
    expect(view.holdsReload).toBe(true);
    expect(read({ run: run("done", { peers: ARRIVED, settledAt: NOW }) }).holdsReload).toBe(false);
  });

  it("gives every OTHER device the strip for the whole of step 5, not silence", () => {
    const seen = other({ run: run("done", { peers: [leg("minibuch", "updating"), leg("cellar", "waiting")] }) });
    expect(seen.mode).toBe("collapsed");
    expect(seen.locked).toBe(false);
    expect(seen.mine).toBe(false);
    expect(seen.heading).toBe("Updating the other machines");
  });
});

// ── FAULT 2: ONLY THE ACTIVE ROW MOVES ──────────────────────────────────────────────────────────

describe("only the active row moves (fault 2)", () => {
  it("draws one active row; a member waiting its turn is queued, still and dimmed", () => {
    const view = read({ run: run("done", { peers: [leg("minibuch", "updating"), leg("cellar", "waiting")] }) });
    const byKey = new Map(view.rows.map((row) => [row.key, row]));
    expect(byKey.get("lead")?.status).toBe("ok");
    expect(byKey.get("peer:minibuch")?.status).toBe("active");
    expect(byKey.get("peer:cellar")).toMatchObject({ status: "queued", dim: true });
    expect(byKey.get("phone")).toMatchObject({ status: "queued", dim: true });
    expect(view.rows.filter((row) => row.status === "active")).toHaveLength(1);
  });

  it("before step 5 every member waits for the lead, whatever its leg says", () => {
    const view = read({ run: run("staging", { peers: [leg("minibuch", "updating"), leg("cellar", "waiting")] }) });
    expect(view.rows.filter((row) => row.status === "active").map((row) => row.key)).toEqual(["lead"]);
    expect(view.rows[1]?.word).toBe("waits for bluefin");
  });

  it("draws the lead as offline, not spinning, while it restarts", () => {
    const view = read({ run: run("restarting", { peers: WAITING, updatedAt: NOW - 14_000 }) });
    expect(view.rows[0]).toMatchObject({ status: "offline", word: "offline, restarting 0:14" });
  });
});

// ── A MEMBER THAT NEEDS YOU ─────────────────────────────────────────────────────────────────────

describe("a member that needs the operator, on step 5", () => {
  const quiet = run("done", {
    peers: [leg("minibuch", "done", { version: TO }), leg("cellar", "waiting", { updatedAt: NOW - PEER_UNREACHABLE_MS - 30_000 })],
  });

  it("asks: Skip it, or keep trying, once it has said nothing for PEER_UNREACHABLE_MS", () => {
    const view = read({ run: quiet });
    expect(view.ask).toEqual({ name: "cellar" });
    expect(view.rows[2]).toMatchObject({ status: "attention", word: "no answer for 1 min" });
    expect(view.note).toBe("cellar has not answered for 1 min. You can skip it.");
  });

  it("does not ask on another device, which cannot answer for this one", () => {
    expect(other({ run: quiet }).ask).toBeNull();
  });

  it("puts the question away for KEEP_TRYING_MS after Keep trying, and asks again after", () => {
    const kept = new Map([["cellar", NOW - 1_000]]);
    expect(read({ run: quiet, keptTrying: kept }).ask).toBeNull();
    const old = new Map([["cellar", NOW - KEEP_TRYING_MS - 1]]);
    expect(read({ run: quiet, keptTrying: old }).ask).toEqual({ name: "cellar" });
  });

  it("names a member's hourly limit in the row's detail slot (ADR 0062) and still offers the skip", () => {
    const view = read({
      run: run("done", { peers: [leg("minibuch", "done", { version: TO }), leg("cellar", "waiting", { reason: "rate-limited, retries in about 14 min" })] }),
    });
    expect(view.rows[2]).toMatchObject({ status: "attention", detail: "rate-limited, retries in about 14 min" });
    expect(view.note).toBe("cellar waits out its once-an-hour limit. You can skip it.");
    expect(view.ask).toEqual({ name: "cellar" });
  });

  it("stops waiting for a skipped member: step 6 comes, and the row says it was skipped", () => {
    const view = read({ run: quiet, claim: { ...CLAIM, skipped: ["cellar"] } });
    expect(view.phase).toBe("phone");
    expect(view.rows[2]).toMatchObject({ status: "skipped", word: "skipped", detail: `Still on ${FROM}.` });
  });

  it("names the skipped member at the end, and offers to try it again", () => {
    const view = read({ run: quiet, claim: { ...CLAIM, skipped: ["cellar"] }, bundle: { id: "bundle-b", version: FROM } });
    expect(view.phase).toBe("done");
    expect(view.subtitle).toBe(`bluefin, minibuch and this phone run ${TO}. cellar did not update.`);
    expect(view.retryNames).toEqual(["cellar"]);
  });
});

// ── STEP 6: THIS PHONE ──────────────────────────────────────────────────────────────────────────

describe("this phone's own step", () => {
  const settled = run("done", { peers: ARRIVED, settledAt: NOW - 1_000, updatedAt: NOW - 1_000 });

  it("asks for the new app once the bridge serves it, and not before", () => {
    expect(read({ run: settled }).kickPhone).toBe(false);
    expect(read({ run: settled, serverStale: true }).kickPhone).toBe(true);
    expect(other({ run: settled, serverStale: true }).kickPhone).toBe(false);
  });

  it("counts files on its own row, as a bar in the row's reserved slot", () => {
    const view = read({ run: settled, stage: "installing", installingSince: NOW - 5_000, progress: { done: 132, total: 214, at: NOW } });
    const phone = view.rows.at(-1);
    expect(phone).toMatchObject({ status: "active", word: "132 of 214 files", detail: null });
    expect(phone?.progress).toBeCloseTo(132 / 214);
    expect(view.subtitle).toBe("Downloading the new app: 132 of 214 files.");
  });

  it("says it is switching once every file is in, or the controller has swapped", () => {
    expect(read({ run: settled, stage: "installing", installingSince: NOW - 5_000, progress: { done: 28, total: 28, at: NOW } }).heading).toBe(
      `Switching this phone to ${TO}`,
    );
    expect(read({ run: settled, controllerChangedAt: NOW - 100 }).rows.at(-1)?.word).toBe("reloading");
  });

  it("offers the app back after DOWNLOAD_HUNG_MS with no new file, and asks for one re-check", () => {
    const view = read({
      run: settled,
      stage: "installing",
      installingSince: NOW - DOWNLOAD_HUNG_MS - 10_000,
      progress: { done: 3, total: 28, at: NOW - DOWNLOAD_HUNG_MS - 1 },
    });
    expect(view.canEscape).toBe(true);
    expect(view.recheckDownload).toBe(true);
    expect(view.rows.at(-1)?.status).toBe("attention");
    const released = read({
      run: settled,
      stage: "installing",
      installingSince: NOW - DOWNLOAD_HUNG_MS - 10_000,
      progress: { done: 3, total: 28, at: NOW - DOWNLOAD_HUNG_MS - 1 },
      released: true,
    });
    expect(released.mode).toBe("collapsed");
    expect(released.locked).toBe(false);
  });

  it("lets the phone keep its app when no new one shows up within PHONE_WAIT_MS", () => {
    const view = read({ run: run("done", { peers: ARRIVED, settledAt: NOW - PHONE_WAIT_MS - 1, updatedAt: NOW - PHONE_WAIT_MS - 1 }) });
    expect(view.phase).toBe("done");
    expect(view.rows.at(-1)).toMatchObject({ status: "skipped", word: "keeps its app for now" });
  });

  it("is done when this bundle is already at the target", () => {
    expect(read({ run: settled, bundle: { id: "bundle-a", version: `${TO}-dev` } }).phase).toBe("done");
  });
});

// ── THE ENDS ─────────────────────────────────────────────────────────────────────────────────────

describe("the three ends, each with a way back and never a toast alone", () => {
  it("Done stays up on the device that started it, and never on another", () => {
    const done = run("done", { peers: ARRIVED, settledAt: NOW - 1_000 });
    const mine = read({ run: done, bundle: { id: "bundle-b", version: TO } });
    expect(mine).toMatchObject({ phase: "done", step: 7, mode: "expanded", locked: false, end: { kind: "done" } });
    expect(mine.heading).toBe("Update finished");
    expect(mine.subtitle).toBe(`bluefin, minibuch, cellar and this phone run ${TO}.`);
    expect(mine.retryNames).toEqual([]);
    expect(other({ run: done }).mode).toBe("hidden");
  });

  it("a rolled-back run is shown on every device, dismissible, and never reached the members", () => {
    const failed = run("rolled-back", { peers: WAITING, reason: "health gate timed out" });
    for (const view of [read({ run: failed }), other({ run: failed })]) {
      expect(view).toMatchObject({ phase: "rolled-back", mode: "expanded", locked: false });
      expect(view.heading).toBe(`bluefin went back to ${FROM}`);
      expect(view.rows[0]).toMatchObject({ status: "failed", detail: "health gate timed out" });
      expect(view.rows[1]).toMatchObject({ status: "skipped", word: "not touched", versions: FROM });
      expect(view.end).toEqual({ kind: "failed", key: `run:run-1:${failed.startedAt}:rolled-back` });
    }
  });

  it("a stuck run carries the command to run by hand", () => {
    const view = read({ run: run("stuck", { recovery: "collie update --rollback" }) });
    expect(view.phase).toBe("stuck");
    expect(view.recovery).toBe("collie update --rollback");
    expect(view.subtitle).toMatch(/Run this on bluefin:$/);
  });

  it("an interrupted run is the stopped end", () => {
    expect(read({ run: run("interrupted") }).phase).toBe("stopped");
  });
});

// ── THE WAY OUT OF A STALL ───────────────────────────────────────────────────────────────────────

describe("Use the app anyway, only after a stall", () => {
  it("is not offered while the lead is moving", () => {
    expect(read({ run: run("staging") }).canEscape).toBe(false);
  });

  it("is offered once the lead has held one state for LEAD_STALLED_MS, and folds the panel to the strip", () => {
    const stalled = run("staging", { updatedAt: NOW - LEAD_STALLED_MS - 1 });
    expect(read({ run: stalled }).canEscape).toBe(true);
    const released = read({ run: stalled, released: true });
    expect(released).toMatchObject({ mode: "collapsed", locked: false, canEscape: false });
    // Nothing is cancelled: the run is still in flight and still on its step.
    expect(released.phase).toBe("build");
  });

  it("is offered when step 5 has not moved for LEAD_STALLED_MS", () => {
    const view = read({ run: run("done", { peers: [leg("minibuch", "updating", { updatedAt: NOW - LEAD_STALLED_MS - 1 })] }) });
    expect(view.phase).toBe("members");
    expect(view.canEscape).toBe(true);
  });
});

// ── READY TO START ───────────────────────────────────────────────────────────────────────────────

describe("Ready to start, the first screen", () => {
  it("is the confirm: every machine and this phone, not locked", () => {
    const view = read({ run: undefined, claim: null, startedHere: false, ask: { kind: "crew", version: TO, major: false, peersOnly: false, current: FROM } });
    expect(view).toMatchObject({ phase: "ready", step: 0, mode: "expanded", locked: false });
    expect(view.heading).toBe(`Update to ${TO}`);
    expect(view.subtitle).toBe("3 machines and this phone, one at a time.");
  });

  it("names the one member a retry is for", () => {
    const view = read({
      run: undefined,
      claim: null,
      startedHere: false,
      ask: { kind: "retry", version: TO, major: false, peersOnly: true, current: TO, names: ["minibuch"] },
    });
    expect(view.heading).toBe("Try minibuch again");
    expect(view.rows[0]).toMatchObject({ status: "ok", word: `already on ${TO}` });
  });

  it("gives way to a run already in flight", () => {
    const view = read({ run: run("staging"), ask: { kind: "crew", version: TO, major: false, peersOnly: false, current: FROM } });
    expect(view.phase).toBe("build");
  });
});

// ── SOMEBODY ELSE'S RUN ──────────────────────────────────────────────────────────────────────────

describe("a claim is about ONE run", () => {
  it("does not lock this device for a newer run somebody else started", () => {
    const view = read({ run: run("staging", { runId: "run-2" }) });
    expect(view.mine).toBe(false);
    expect(view.mode).toBe("collapsed");
    expect(view.locked).toBe(false);
  });
});

// ── A RUN THAT MOVES ONLY THE MEMBERS (M32) ─────────────────────────────────────────────────────

describe("a run that moves only the members", () => {
  const crewOnly = (legs: UpdatePeerLeg[], settledAt: number | null = null): UpdateScreenCrewRun => ({ legs, settledAt, to: TO, current: TO });
  const claim: UpdateClaim = { ...CLAIM, peersOnly: true };

  it("is step 5, locked on the device that started it; the lead and the phone stay as they are", () => {
    const view = read({ claim, crewRun: crewOnly([leg("minibuch", "updating")]) });
    expect(view).toMatchObject({ phase: "members", step: 5, locked: true, inFlight: "crew" });
    expect(view.rows[0]).toMatchObject({ status: "ok", word: `already on ${TO}` });
    expect(view.rows.at(-1)).toMatchObject({ status: "ok", word: "keeps this app" });
  });

  it("holds the screen in the beat before the first sweep", () => {
    expect(read({ claim, crewRun: crewOnly([]) }).locked).toBe(true);
  });

  it("ends on Done on the device that started it, naming the member left behind", () => {
    const view = read({ claim, crewRun: crewOnly([leg("minibuch", "rolled-back", { reason: "health gate timed out" })], NOW - 1_000) });
    expect(view.phase).toBe("done");
    expect(view.mode).toBe("expanded");
    expect(view.retryNames).toEqual(["minibuch"]);
  });

  it("is a strip on another device, and nothing once it is over", () => {
    expect(other({ crewRun: crewOnly([leg("minibuch", "updating")]) }).mode).toBe("collapsed");
    expect(other({ crewRun: crewOnly([leg("minibuch", "done", { version: TO })], NOW) }).mode).toBe("hidden");
  });

  it("never takes the app away when no leg carries a clock", () => {
    const view = read({ claim, crewRun: crewOnly([{ name: "minibuch", state: "updating", version: FROM }]) });
    expect(view.locked).toBe(false);
  });
});

describe("nothing at all", () => {
  it("is hidden with no run, no ask and no crew run", () => {
    expect(read({ claim: null, startedHere: false })).toMatchObject({ mode: "hidden", phase: "none" });
  });
});

describe("the small formatters", () => {
  it("formats the band's clock as m:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(75_400)).toBe("1:15");
    expect(formatClock(-5)).toBe("0:00");
  });

  it("joins names the way a sentence does", () => {
    expect(joinNames(["a"])).toBe("a");
    expect(joinNames(["a", "b"])).toBe("a and b");
    expect(joinNames(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("a document that boots holding a claim, before any source has answered", () => {
  it("opens the panel at once, locked, on the step it last showed, with the rows it started with", () => {
    const view = read({ run: undefined, answered: false, claim: { ...CLAIM, lastPhase: "restart" } });
    expect(view).toMatchObject({ mode: "expanded", locked: true, phase: "restart", step: 3 });
    expect(view.heading).toBe("bluefin is restarting");
    expect(view.rows.map((row) => row.key)).toEqual(["lead", "peer:minibuch", "peer:cellar", "phone"]);
  });

  it("after this phone's own reload, opens on step 6 and lets the first read decide the rest", () => {
    const view = read({ run: undefined, answered: false, bundle: { id: "bundle-b", version: FROM } });
    expect(view.phase).toBe("phone");
    expect(view.holdsReload).toBe(false);
  });

  it("is not provisional once anything has answered", () => {
    expect(read({ run: undefined, answered: true }).phase).toBe("none");
  });
});
