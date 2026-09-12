import { afterEach, describe, expect, it } from "vitest";

import {
  clearUpdateStarted,
  dismissesLocally,
  dismissTarget,
  DONE_WINDOW_MS,
  getUpdateStarted,
  noteUpdateStarted,
  REASON_BUDGET,
  linkChangeBandNote,
  linkChangeNote,
  managerOf,
  ribbonText,
  CREW_PATIENCE_MS,
  readRun,
  ribbonView,
  peerLegsOf,
  crewSettledAt,
  subscribeUpdateStarted,
  truncateWords,
  type RibbonInput,
} from "./update-ribbon";
import type { UpdateInfo, UpdatePeerLeg, UpdatePeerLegState, UpdateRun, UpdateRunState } from "./types";

// The band's reading, as a pure function. The component test next door proves the row that comes out
// of it; everything about WHICH state wins lives here, where it needs no DOM.

const NOW = 1_800_000_000_000;

const run = (state: UpdateRunState, over: Partial<UpdateRun> = {}): UpdateRun => ({
  schema: 1,
  state,
  from: "1.4.1",
  to: "1.5.0",
  startedAt: NOW - 40_000,
  updatedAt: NOW - 2_000,
  pid: 99,
  attempt: 0,
  ...over,
});

const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  current: "1.4.1",
  latest: "1.5.0",
  latestUrl: null,
  releaseAvailable: true,
  majorAvailable: null,
  majorUrl: null,
  bridgeStale: false,
  checkedAt: NOW - 60_000,
  ...over,
});

const read = (over: Partial<RibbonInput> = {}) =>
  ribbonView({
    update: info(),
    bundleStale: false,
    bundleInstalling: false,
    dismissedVersion: null,
    dismissedCrewVersion: null,
    now: NOW,
    ...over,
  });

afterEach(() => clearUpdateStarted());

describe("update ribbon states", () => {
  it("says nothing when there is nothing to say", () => {
    expect(read({ update: undefined })).toEqual({ kind: "silent" });
    expect(read({ update: info({ releaseAvailable: false }) })).toEqual({ kind: "silent" });
  });

  it("(a) offers the release the snapshot names", () => {
    expect(read()).toEqual({ kind: "available", version: "1.5.0" });
  });

  it("(a) needs a version to name — releaseAvailable with no latest says nothing", () => {
    expect(read({ update: info({ latest: null }) })).toEqual({ kind: "silent" });
  });

  it("an unreachable peer is a failed leg, not a moving one (M16/04)", () => {
    // The lead gave up on that machine after three missed sweeps, so the band names it rather than
    // counting it among the machines still going.
    // SAFETY: `unreachable` IS a member of `UpdatePeerLegState`; the assertion only narrows the
    // inferred `string` of an object literal to it, and the union above is what makes that sound.
    const peers = [
      { name: "minibuch", state: "unreachable" as UpdatePeerLegState, reason: "minibuch has missed 3 sweeps" },
    ];
    expect(read({ update: info({ releaseAvailable: false, run: run("done", { peers }) }) })).toEqual({
      kind: "peer-failed",
      name: "minibuch",
      reason: "minibuch has missed 3 sweeps",
      target: "1.5.0", // closable, keyed to the version the run was heading for (M20/04)
    });
  });

  it("a finished run that is long past still leaves the bundle row alone", () => {
    // `DONE_WINDOW_MS` used to gate an "Updated to X, tap to reload" row of the band's own. That row
    // is the update screen's toast now, and what is left here is the PWA row, which has never had a
    // window: the bundle on screen either is behind the bridge or it is not.
    const stale = run("done", { updatedAt: NOW - DONE_WINDOW_MS - 1 });
    expect(read({ update: info({ run: stale }), bundleStale: true })).toEqual({ kind: "bundle" });
  });
});

// ── THE HANDOVER, PINNED ────────────────────────────────────────────────────────────────────────
//
// M28/01 moved every state that IS a run to `components/update-screen.tsx`: the confirm just tapped,
// the four in-flight states, the finished run, and the peers trailing it. A band that still said any
// of those would be a forty-character row repeating a full-screen sheet, reconciled twice — which is
// the class of bug M20 spent three specs on. This is the test named in the milestone's checklist.
describe("run states belong to the screen", () => {
  it("says nothing about a run in flight, in any of its four states", () => {
    for (const state of ["preflight", "staging", "restarting", "verifying"] as const) {
      expect(read({ update: info({ releaseAvailable: false, run: run(state) }) })).toEqual({
        kind: "silent",
      });
    }
  });

  it("says nothing about a run that finished", () => {
    expect(read({ update: info({ releaseAvailable: false, run: run("done") }) })).toEqual({
      kind: "silent",
    });
  });

  it("says nothing about a peer that is still moving", () => {
    const peers: UpdatePeerLeg[] = [
      { name: "minibuch", state: "restarting" },
      { name: "cellar", state: "done" },
    ];
    expect(read({ update: info({ releaseAvailable: false, run: run("done", { peers }) }) })).toEqual({
      kind: "silent",
    });
  });

  it("says nothing about a peer whose package manager owns it", () => {
    const peers: UpdatePeerLeg[] = [{ name: "minibuch", state: "package-managed" }];
    expect(read({ update: info({ releaseAvailable: false, run: run("done", { peers }) }) })).toEqual({
      kind: "silent",
    });
  });

  it("lets the offer through under a run, because the offer is not the run", () => {
    // The row that used to be suppressed by a run in flight is a standing fact about the machine, and
    // the sheet over it is about this run. Two different things, and the band keeps the one that is
    // still true.
    expect(read({ update: info({ run: run("staging") }) })).toEqual({
      kind: "available",
      version: "1.5.0",
    });
  });

  it("keeps the FAILED leg, which is not a run in progress but a statement about one that is over", () => {
    const peers: UpdatePeerLeg[] = [
      { name: "cellar", state: "restarting" },
      { name: "minibuch", state: "rolled-back", reason: "health gate timed out" },
    ];
    expect(read({ update: info({ releaseAvailable: false, run: run("done", { peers }) }) })).toMatchObject({
      kind: "peer-failed",
      name: "minibuch",
    });
  });

  it("keeps both download states, which are about the PWA and not about a run", () => {
    expect(read({ bundleStale: true, bundleInstalling: true })).toEqual({ kind: "bundle-installing" });
    expect(read({ bundleStale: true })).toEqual({ kind: "bundle" });
  });
});

describe("rolled back peer on the band", () => {
  const failed = (reason?: string): UpdateInfo =>
    info({ run: run("done", { peers: [{ name: "minibuch", state: "rolled-back", reason }] }) });

  it("names the peer with its reason", () => {
    expect(read({ update: failed("health gate timed out") })).toEqual({
      kind: "peer-failed",
      name: "minibuch",
      reason: "health gate timed out",
      target: "1.5.0",
    });
    // ONE sentence for all four failed states (M20/04). It used to say "rolled back" about an
    // `unreachable` peer too, which is a specific claim that was simply false there.
    expect(ribbonText(read({ update: failed("health gate timed out") }))).toBe(
      "Could not update minibuch: health gate timed out. See Updates.",
    );
  });

  it("cuts an over-long reason on a word boundary", () => {
    const long = "health gate timed out after three attempts on the standby door";
    const view = read({ update: failed(long) });
    expect(view).toMatchObject({ kind: "peer-failed" });
    // SAFETY: asserted one line above — the narrowing is what the field access below needs.
    const reason = (view as { reason: string }).reason;
    expect(reason.length).toBeLessThanOrEqual(REASON_BUDGET + 1); // + the ellipsis
    expect(reason).toBe("health gate timed out after three…");
    expect(long.startsWith(reason.slice(0, -1))).toBe(true); // no word was cut in half
  });

  it("still says why when the peer sent no reason at all", () => {
    const view = read({ update: failed() });
    expect(view.kind).toBe("peer-failed");
    expect(ribbonText(view)).toMatch(/^Could not update minibuch: \S/);
  });

  it("outranks a peer that is merely still moving", () => {
    const peers: UpdatePeerLeg[] = [
      { name: "cellar", state: "restarting" },
      { name: "minibuch", state: "rolled-back", reason: "health gate timed out" },
    ];
    expect(read({ update: info({ run: run("done", { peers }) }) })).toMatchObject({
      kind: "peer-failed",
      name: "minibuch",
    });
  });
});

describe("the restarting gap", () => {
  it("is the update screen's to narrate, and the band adds nothing to it (M28/01)", () => {
    // A poll that fails during `restarting` leaves the last record on screen, and the sheet is what
    // says "restarting, back in a moment". The band's job here is to stay out of the way.
    expect(read({ update: info({ releaseAvailable: false, run: run("restarting") }) })).toEqual({
      kind: "silent",
    });
  });
});

describe("truncateWords", () => {
  it("leaves anything within budget alone", () => {
    expect(truncateWords("short enough", 40)).toBe("short enough");
  });

  it("cuts at the last space and marks the cut", () => {
    expect(truncateWords("one two three four", 11)).toBe("one two…");
  });

  it("cuts mid-word only when there is no space to cut at", () => {
    expect(truncateWords("aaaaaaaaaaaa", 4)).toBe("aaaa…");
  });
});

describe("the just-posted store", () => {
  it("notifies on both edges and is cleared idempotently", () => {
    let hits = 0;
    const off = subscribeUpdateStarted(() => hits++);
    noteUpdateStarted(NOW);
    expect(getUpdateStarted()).toBe(NOW);
    clearUpdateStarted();
    clearUpdateStarted(); // already clear — no second notification
    expect(getUpdateStarted()).toBeNull();
    expect(hits).toBe(2);
    off();
  });
});

// ── A PACKAGED HOST (M17/08) ────────────────────────────────────────────────────────────────────
//
// `collie update` refuses on a machine a package manager owns (ADR 0035), so a band that offered a
// tap-to-update there would be offering a tap that fails. The line names the manager instead, and
// the tap still goes to the page, where the command is.

describe("a packaged host reads its own line", () => {
  const packaged = (over: Partial<UpdateInfo> = {}) =>
    info({ installKind: "packaged", packageCommand: "sudo pacman -Syu", ...over });

  it("names the manager from the host's own command, and never says Tap to update", () => {
    const view = read({ update: packaged() });
    expect(view).toEqual({ kind: "available-packaged", version: "1.5.0", manager: "pacman" });
    expect(ribbonText(view)).toBe("Collie 1.5.0 available via pacman.");
    expect(ribbonText(view)).not.toContain("Tap to update");
  });

  it("reads the manager off the three commands a host can actually resolve", () => {
    // The exact strings `cli/package-command.ts` names, sudo and all.
    expect(managerOf("sudo pacman -Syu collie-bin")).toBe("pacman");
    expect(managerOf("nix profile upgrade collie")).toBe("nix");
    expect(managerOf("brew upgrade collie")).toBe("brew");
    // And no command at all — a packaged install under a prefix nobody recognises.
    expect(managerOf(undefined)).toBeNull();
    expect(managerOf("   ")).toBeNull();
  });

  it("states the version alone when the packaged host resolved no manager to name", () => {
    const view = read({ update: packaged({ packageCommand: undefined }) });
    expect(view).toEqual({ kind: "available-packaged", version: "1.5.0", manager: null });
    expect(ribbonText(view)).toBe("Collie 1.5.0 available. See Updates.");
    expect(ribbonText(view)).not.toContain("Tap to update");
  });

  it("is dismissable in the OFFER scope, keyed by the version it names", () => {
    expect(dismissTarget(read({ update: packaged() }))).toEqual({ scope: "offer", version: "1.5.0" });
    expect(read({ update: packaged(), dismissedVersion: "1.5.0" })).toEqual({ kind: "silent" });
    // And a crew notice put down at the same version leaves this host's own offer standing: two
    // decisions, two keys.
    expect(read({ update: packaged(), dismissedCrewVersion: "1.5.0" })).toMatchObject({
      kind: "available-packaged",
    });
  });

  it("leaves every other install kind on the ordinary offer", () => {
    const view = read({ update: info({ installKind: "binary", packageCommand: undefined }) });
    expect(view).toEqual({ kind: "available", version: "1.5.0" });
    expect(ribbonText(view)).toBe("Collie 1.5.0 available.");
  });
});
// ── WHAT A DISMISS CAN CLOSE (M17/08) ───────────────────────────────────────────────────────────
//
// The rule is whether the state ends on its own. A failed peer does, and it is closable for that
// reason: it has already ended, badly, and the sentence would otherwise stand until some later run
// replaced it. The offer is a standing fact and closable too. The quiet crew states left with the run
// states (M28/01), so what is left here is the offer, the failed leg and the download.

describe("what carries a close", () => {
  it("a FAILED peer can be put down, keyed to the version the run was heading for (M20/04)", () => {
    expect(dismissTarget({ kind: "peer-failed", name: "minibuch", reason: "gate", target: "1.5.0" })).toEqual({
      scope: "crew",
      version: "1.5.0",
    });
    // With nothing to key it to, it stays: a dismissal no newer version can raise again is a mute.
    expect(dismissTarget({ kind: "peer-failed", name: "minibuch", reason: "gate", target: null })).toBeNull();
  });

  it("gives the bundle row and silence no dismiss at all", () => {
    expect(dismissTarget({ kind: "bundle" })).toBeNull();
    expect(dismissTarget({ kind: "silent" })).toBeNull();
  });

  it("the DOWNLOAD row closes in this document and posts nothing (2026-09-12)", () => {
    // It is closable for the reason the others are not: the wait has no end of its own. A worker
    // stuck in `installing` on a dead link is waited on with no timer and no forced reload, so the
    // close is the operator's only way back to the app they already have.
    expect(dismissesLocally({ kind: "bundle-installing" })).toBe(true);
    // And it is NOT a dismissal: nothing was declined, so no version goes to the bridge.
    expect(dismissTarget({ kind: "bundle-installing" })).toBeNull();
  });

  it("every other state is put down on the bridge or not at all", () => {
    expect(dismissesLocally({ kind: "bundle" })).toBe(false);
    expect(dismissesLocally({ kind: "available", version: "1.5.0" })).toBe(false);
    expect(dismissesLocally({ kind: "silent" })).toBe(false);
  });
});

// ── One clock (M20/04) ──────────────────────────────────────────────────────

describe("the band and the card read one clock", () => {
  it("a peer still moving long past the DONE window is still MOVING, whatever the clock says", () => {
    // The 2026-09-07 shape exactly: the lead finished at 17:43, the peer was still listed as moving
    // at 17:58, and the band had gone quiet at 17:53 because state (d) borrowed (c)'s window. The
    // band no longer draws that state at all (M28/01) — the reading it and the card share still has
    // to answer the question, and the update screen is now the surface that renders the answer.
    const peers: UpdatePeerLeg[] = [{ name: "minibuch", state: "restarting", updatedAt: NOW - 15 * 60_000 }];
    const stale = run("done", { updatedAt: NOW - DONE_WINDOW_MS - 1, peers });
    const reading = readRun({ update: info({ releaseAvailable: false, run: stale }), now: NOW });
    expect(reading.moving).toBe(true);
    expect(reading.movingLegs.map((l) => l.name)).toEqual(["minibuch"]);
  });

  it("goes still the moment the lead stamps the run settled, and not before", () => {
    // `settledAt` is the key, never elapsed time. Spec 01 writes it when the last leg goes terminal.
    const peers: UpdatePeerLeg[] = [{ name: "minibuch", state: "restarting" }];
    const moving = info({ releaseAvailable: false, run: run("done", { peers }) });
    expect(readRun({ update: moving, now: NOW }).moving).toBe(true);

    const settled = info({
      releaseAvailable: false,
      run: run("done", { peers, settledAt: NOW - 1_000 }),
    });
    expect(readRun({ update: settled, now: NOW }).moving).toBe(false);
  });

  it("a peers-only run has no local record at all, and the reading still sees it (M20/09)", () => {
    // "Retry crew update" writes nothing to `update.json`, so `run` is absent for the whole run. Both
    // surfaces used to require a `done` record here and were therefore blind to it.
    const update = info({
      releaseAvailable: false,
      peers: [{ name: "minibuch", state: "updating" }],
    });
    const reading = readRun({ update, now: NOW });
    expect(reading.moving).toBe(true);
    expect(reading.movingLegs.map((l) => l.name)).toEqual(["minibuch"]);
  });

  it("past the patience window the reading calls the run slow; before it, it does not", () => {
    const at = (ago: number) =>
      readRun({
        update: info({
          releaseAvailable: false,
          run: run("done", { peers: [{ name: "minibuch", state: "restarting", updatedAt: NOW - ago }] }),
        }),
        now: NOW,
      });
    expect(at(CREW_PATIENCE_MS - 1).slow).toBe(false);
    expect(at(CREW_PATIENCE_MS).slow).toBe(true);
    expect(at(CREW_PATIENCE_MS).elapsedMs).toBe(CREW_PATIENCE_MS);
  });


  it("readRun answers every question both surfaces ask, from one pass", () => {
    const legs: UpdatePeerLeg[] = [
      { name: "minibuch", state: "restarting", updatedAt: NOW - 3 * 60_000 },
      { name: "cellar", state: "package-managed" },
      { name: "attic", state: "done" },
    ];
    const reading = readRun({ update: info({ run: run("done", { peers: legs }) }), now: NOW });
    expect(reading.moving).toBe(true);
    expect(reading.movingLegs.map((l) => l.name)).toEqual(["minibuch"]);
    expect(reading.managed.map((l) => l.name)).toEqual(["cellar"]);
    expect(reading.failed).toBeNull();
    expect(reading.elapsedMs).toBe(3 * 60_000);
    expect(reading.slow).toBe(true);
    expect(reading.settledAt).toBeNull();
  });

  it("readRun reports a settled run as still, whatever its legs say", () => {
    // The lead's stamp is the answer. A client that re-folded the rows would be a second opinion
    // about a question already answered, and two opinions is the bug.
    const legs: UpdatePeerLeg[] = [{ name: "minibuch", state: "restarting", updatedAt: NOW - 60_000 }];
    const reading = readRun({
      update: info({ run: run("done", { peers: legs, settledAt: NOW - 5_000 }) }),
      now: NOW,
    });
    expect(reading.moving).toBe(false);
    expect(reading.movingLegs).toEqual([]);
    expect(reading.elapsedMs).toBeNull();
    expect(reading.settledAt).toBe(NOW - 5_000);
  });
});

describe("legs come from the live status, not from a record the caller was holding", () => {
  // M20/14, measured on the VM crew. A peers-only retry leaves the PREVIOUS run in the status with
  // its legs stripped off it (M20/09) and this run's legs at the top level. The Updates card was also
  // holding its own copy of that previous run, fetched a moment earlier, still carrying that run's
  // failed legs — a copy no timestamp could call stale. Read from it, the card showed last run's
  // failures for the whole of this run while the band, which holds no such copy, was right.

  const settled: UpdateRun = run("done", { updatedAt: NOW - 60_000, settledAt: NOW - 60_000, peers: [{ name: "minibuch", state: "rolled-back", reason: "health gate timed out", updatedAt: NOW - 60_000 }] });

  it("this run's legs at the top level beat last run's legs on a held record", () => {
    const live = info({ run: run("done", { updatedAt: NOW - 60_000 }), peers: [{ name: "minibuch", state: "restarting", updatedAt: NOW - 2_000 }] });
    const legs = peerLegsOf(live, settled);
    expect(legs.map((l) => l.state)).toEqual(["restarting"]);
  });

  it("the settle stamp comes from the document the legs came from", () => {
    // This run is still moving, so it has no settle stamp. Last run's, off the held record, would
    // read as "the crew is done" over a band that is still counting.
    const live = info({ run: run("done", { updatedAt: NOW - 60_000 }), peers: [{ name: "minibuch", state: "restarting", updatedAt: NOW - 2_000 }] });
    expect(crewSettledAt(live, settled)).toBeNull();
  });

  it("a status with no legs anywhere still falls back to the held record", () => {
    const bare = info({ run: undefined, peers: undefined });
    expect(peerLegsOf(bare, settled).map((l) => l.state)).toEqual(["rolled-back"]);
    expect(crewSettledAt(bare, settled)).toBe(NOW - 60_000);
  });
});

// ── THE SENTENCE ABOUT THE CREW LINK (M27/06) ───────────────────────────────────────────────────
//
// The bridge decides whether there is one. The band's job is to print it after the offer, and to
// print nothing at all when the field is absent — which is a solo install, an ordinary release and
// every release published before the asset existed.

describe("the crew link sentence", () => {
  /** What the CARD and the push say. */
  const LINE = "Changes the crew link. Update the lead first, members follow.";
  /** What the BAND says — the row is held to forty characters, so it states what changes and the
   *  tap lands on the card for the rest. */
  const SHORT = "Changes the crew link.";

  it("appends the SHORT form to the offer — the band is one budgeted row", () => {
    const view = read({ update: info({ linkChange: { from: 1, to: 2 } }) });
    expect(view).toEqual({ kind: "available", version: "1.5.0" });
    expect(ribbonText(view, { from: 1, to: 2 })).toBe(`Collie 1.5.0 available. ${SHORT}`);
    // Never the whole sentence: that one belongs above the confirm, where there is room for it.
    expect(ribbonText(view, { from: 1, to: 2 })).not.toContain("members follow");
  });

  it("is absent when the reading carries no link change", () => {
    const view = read();
    expect(ribbonText(view)).toBe("Collie 1.5.0 available.");
    expect(ribbonText(view, null)).not.toContain("crew link");
    expect(linkChangeBandNote(null)).toBeNull();
    expect(linkChangeBandNote(undefined)).toBeNull();
    expect(linkChangeNote(null)).toBeNull();
    expect(linkChangeNote(undefined)).toBeNull();
  });

  it("keeps two cuts of one fact — the row's and the card's", () => {
    expect(linkChangeBandNote({ from: 1, to: 2 })).toBe(SHORT);
    expect(linkChangeNote({ from: 1, to: 2 })).toBe(LINE);
  });

  it("rides the packaged offer too — that host still has a crew to level", () => {
    const view = read({ update: info({ installKind: "packaged", packageCommand: "sudo pacman -Syu" }) });
    expect(ribbonText(view, { from: 1, to: 2 })).toBe(`Collie 1.5.0 available via pacman. ${SHORT}`);
  });

  it("says nothing on a state that is past being told — the bundle reload row", () => {
    // The sentence only changes what the operator DOES before a confirm, and the reload row is not
    // one: the tap there reloads this page onto a bundle that already exists.
    const view = read({ bundleStale: true });
    expect(ribbonText(view, { from: 1, to: 2 })).toBe(ribbonText(view));
  });
});
