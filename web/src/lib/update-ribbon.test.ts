import { afterEach, describe, expect, it } from "vitest";

import {
  clearUpdateStarted,
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
    startedAt: null,
    bundleStale: false,
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

  it("(s) shows starting update at the instant of confirm", () => {
    expect(read({ startedAt: NOW })).toEqual({ kind: "starting" });
  });

  it("(b) counts through fetching, building and restarting", () => {
    const phase = (state: UpdateRunState) =>
      read({ update: info({ run: run(state) }) });
    expect(phase("preflight")).toEqual({ kind: "updating", phase: "fetching", version: "1.5.0" });
    expect(phase("staging")).toEqual({ kind: "updating", phase: "building", version: "1.5.0" });
    expect(phase("restarting")).toEqual({ kind: "updating", phase: "restarting", version: "1.5.0" });
    expect(phase("verifying")).toEqual({ kind: "updating", phase: "restarting", version: "1.5.0" });
  });

  it("(c) names the new version once the run is done and this bundle is behind", () => {
    expect(read({ update: info({ run: run("done") }), bundleStale: true })).toEqual({
      kind: "updated",
      version: "1.5.0",
    });
  });

  it("(d) names the peers the lead is waiting on", () => {
    const peers: UpdatePeerLeg[] = [
      { name: "minibuch", state: "restarting" },
      { name: "cellar", state: "done" },
    ];
    expect(read({ update: info({ run: run("done", { peers }) }) })).toEqual({
      kind: "peers",
      names: ["minibuch"],
      target: null, // a moving peer carries no dismiss — see `dismissTarget`
      elapsedMs: null, // no leg stamp, so nothing to count (M20/04)
    });
  });

  it("(d) is gone once every peer reports done", () => {
    const peers: UpdatePeerLeg[] = [{ name: "minibuch", state: "done" }];
    expect(read({ update: info({ releaseAvailable: false, run: run("done", { peers }) }) })).toEqual({
      kind: "silent",
    });
  });

  it("counts a peer state it has never heard of as still moving, never as finished", () => {
    // A newer bridge may report a word this client does not know. A leg that vanished from the band
    // would read as "that machine is fine".
    // SAFETY: the assertion is the POINT of this test — it plants a wire value outside the union
    // this client compiles against, which is exactly what an older client reading a newer bridge
    // receives. Nothing downstream trusts the value; the reading only asks whether it is `done`.
    const peers = [{ name: "minibuch", state: "levitating" as UpdatePeerLegState }];
    expect(read({ update: info({ run: run("done", { peers }) }) })).toEqual({
      kind: "peers",
      names: ["minibuch"],
      target: null, // a moving peer carries no dismiss — see `dismissTarget`
      elapsedMs: null, // no leg stamp, so nothing to count (M20/04)
    });
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

  it("stops speaking about a run that finished long ago — state (c) ONLY (M20/04)", () => {
    // The window gates the "Updated to X, tap to reload" line and nothing else. It used to gate the
    // moving-peers line as well, which is how the band fell silent at ten minutes on 2026-09-07
    // while the Updates card kept the same peer moving for five more.
    const stale = run("done", { updatedAt: NOW - DONE_WINDOW_MS - 1 });
    expect(read({ update: info({ run: stale }), bundleStale: true })).toEqual({ kind: "bundle" });
  });
});

describe("update ribbon precedence", () => {
  it("(s) outranks an offer, and yields the moment the status object speaks", () => {
    expect(read({ startedAt: NOW })).toEqual({ kind: "starting" });
    // An `idle` record is the placeholder, not a run: it has not spoken.
    expect(read({ startedAt: NOW, update: info({ run: run("idle") }) })).toEqual({ kind: "starting" });
    expect(read({ startedAt: NOW, update: info({ run: run("preflight") }) })).toMatchObject({
      kind: "updating",
    });
  });

  it("a run in flight outranks the offer that produced it", () => {
    expect(read({ update: info({ run: run("staging") }) })).toMatchObject({ kind: "updating" });
  });

  it("a finished run outranks both the offer and the peers trailing it", () => {
    const peers: UpdatePeerLeg[] = [{ name: "minibuch", state: "restarting" }];
    expect(read({ update: info({ run: run("done", { peers }) }), bundleStale: true })).toEqual({
      kind: "updated",
      version: "1.5.0",
    });
  });

  it("peers outrank the offer", () => {
    const peers: UpdatePeerLeg[] = [{ name: "minibuch", state: "restarting" }];
    expect(read({ update: info({ run: run("done", { peers }) }) })).toMatchObject({ kind: "peers" });
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

describe("restarting gap is not an outage", () => {
  it("keeps saying Restarting while the bridge is away", () => {
    // A poll that fails leaves the last record on screen, which is exactly this input again.
    const view = read({ update: info({ run: run("restarting") }) });
    expect(view).toEqual({ kind: "updating", phase: "restarting", version: "1.5.0" });
    expect(ribbonText(view)).toBe("Updating to 1.5.0. Restarting");
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
    expect(ribbonText(view)).toBe("Collie 1.5.0 available. Tap to update.");
  });
});

// ── WHAT A DISMISS CAN CLOSE (M17/08) ───────────────────────────────────────────────────────────
//
// The rule is whether the state ends on its own. A run, a finished run and a failed peer do, and a
// band the operator closed there is an ending they can no longer see. The offer and the QUIET crew
// states do not: a machine a package manager owns can stand behind for weeks.

describe("dismissing the quiet crew states", () => {
  const managed: UpdatePeerLeg[] = [{ name: "minibuch", state: "package-managed" }];
  const quiet = (over: Partial<UpdateInfo> = {}) =>
    info({ releaseAvailable: false, run: run("done", { peers: managed }), ...over });

  it("offers a dismiss in the CREW scope, keyed by the version the crew is heading for", () => {
    const view = read({ update: quiet() });
    expect(view).toEqual({ kind: "package-managed", names: ["minibuch"], target: "1.5.0" });
    expect(dismissTarget(view)).toEqual({ scope: "crew", version: "1.5.0" });
  });

  it("keys the dismiss to the release upstream names when the run record names no target", () => {
    const view = read({ update: quiet({ run: run("done", { peers: managed, to: null }) }) });
    expect(dismissTarget(view)).toEqual({ scope: "crew", version: "1.5.0" }); // `update.latest`
  });

  it("hides the quiet band once that version was dismissed IN ITS OWN SCOPE", () => {
    expect(read({ update: quiet(), dismissedCrewVersion: "1.5.0" })).toEqual({ kind: "silent" });
  });

  it("is untouched by a dismissed offer at the same version — two decisions, two keys", () => {
    // The offer is about THIS host and the notice is about another machine. Putting one down must
    // not put the other down with it.
    expect(read({ update: quiet(), dismissedVersion: "1.5.0" })).toMatchObject({
      kind: "package-managed",
    });
  });

  it("raises the band again for a newer target — a dismiss is a version, not a mute", () => {
    const view = read({
      update: quiet({ latest: "1.6.0", run: run("done", { peers: managed, to: "1.6.0" }) }),
      dismissedCrewVersion: "1.5.0",
    });
    expect(view).toMatchObject({ kind: "package-managed", target: "1.6.0" });
  });

  it("lets a failed leg win over the quiet states, and carries its own close (M20/04)", () => {
    // A rolled-back peer outranks the quiet crew notice beside it: the operator asked for that run
    // and this is how it ended. It is CLOSABLE, unlike a run in progress, because it has ended and
    // nothing will replace the sentence until some later run does.
    const peers: UpdatePeerLeg[] = [
      { name: "minibuch", state: "rolled-back", reason: "health gate timed out" },
      { name: "cellar", state: "package-managed" },
    ];
    const view = read({
      update: quiet({ run: run("done", { peers }) }),
      dismissedVersion: "1.5.0",
      dismissedCrewVersion: "1.5.0",
    });
    expect(view).toMatchObject({ kind: "peer-failed", name: "minibuch" });
    expect(dismissTarget(view)).toEqual({ scope: "crew", version: "1.5.0" });
  });

  it("dismisses nothing while a peer is still moving", () => {
    const peers: UpdatePeerLeg[] = [
      { name: "minibuch", state: "restarting" },
      { name: "cellar", state: "package-managed" },
    ];
    const view = read({
      update: quiet({ run: run("done", { peers }) }),
      dismissedCrewVersion: "1.5.0",
    });
    // Still on screen despite the dismissal, and carrying no close: the operator has to be able to
    // see the end of a run somebody is driving.
    expect(view).toMatchObject({ kind: "peers", names: ["minibuch"] });
    expect(dismissTarget(view)).toBeNull();
  });

  it("gives a run and the bundle row no dismiss at all", () => {
    expect(dismissTarget(read({ update: info({ run: run("staging") }) }))).toBeNull();
    expect(dismissTarget({ kind: "starting" })).toBeNull();
    expect(dismissTarget({ kind: "updated", version: "1.5.0" })).toBeNull();
    expect(dismissTarget({ kind: "bundle" })).toBeNull();
    expect(dismissTarget({ kind: "silent" })).toBeNull();
  });

  it("a FAILED peer can be put down, because it is the one crew state that does not end (M20/04)", () => {
    // Every other state here describes something in progress, and a dismissed run is a run the
    // operator can no longer see the end of. A failed leg has already ended, badly, and the sentence
    // would otherwise stand until some later run replaced it.
    expect(dismissTarget({ kind: "peer-failed", name: "minibuch", reason: "gate", target: "1.5.0" })).toEqual({
      scope: "crew",
      version: "1.5.0",
    });
    // With nothing to key it to, it stays: a dismissal no newer version can raise again is a mute.
    expect(dismissTarget({ kind: "peer-failed", name: "minibuch", reason: "gate", target: null })).toBeNull();
  });
});

// ── One clock (M20/04) ──────────────────────────────────────────────────────

describe("the band and the card read one clock", () => {
  it("a peer still moving long past the DONE window is still the peers band", () => {
    // The 2026-09-07 shape exactly: the lead finished at 17:43, the peer was still listed as moving
    // at 17:58, and the band had gone quiet at 17:53 because state (d) borrowed (c)'s window.
    const peers: UpdatePeerLeg[] = [{ name: "minibuch", state: "restarting", updatedAt: NOW - 15 * 60_000 }];
    const stale = run("done", { updatedAt: NOW - DONE_WINDOW_MS - 1, peers });
    expect(read({ update: info({ releaseAvailable: false, run: stale }) })).toMatchObject({
      kind: "peers",
      names: ["minibuch"],
    });
  });

  it("goes quiet the moment the lead stamps the run settled, and not before", () => {
    // `settledAt` is the key, never elapsed time. Spec 01 writes it when the last leg goes terminal.
    const peers: UpdatePeerLeg[] = [{ name: "minibuch", state: "restarting" }];
    const moving = info({ releaseAvailable: false, run: run("done", { peers }) });
    expect(read({ update: moving })).toMatchObject({ kind: "peers" });

    const settled = info({
      releaseAvailable: false,
      run: run("done", { peers, settledAt: NOW - 1_000 }),
    });
    expect(read({ update: settled })).toEqual({ kind: "silent" });
  });

  it("a peers-only run has no local record at all, and the band still sees it (M20/09)", () => {
    // "Retry crew update" writes nothing to `update.json`, so `run` is absent for the whole run. The
    // band used to require a `done` record here and was therefore blind to it.
    const update = info({
      releaseAvailable: false,
      peers: [{ name: "minibuch", state: "updating" }],
    });
    expect(read({ update })).toMatchObject({ kind: "peers", names: ["minibuch"] });
  });

  it("past the patience window the band names the elapsed time; before it, the words are unchanged", () => {
    const at = (ago: number) =>
      read({
        update: info({
          releaseAvailable: false,
          run: run("done", { peers: [{ name: "minibuch", state: "restarting", updatedAt: NOW - ago }] }),
        }),
      });
    expect(at(CREW_PATIENCE_MS - 1)).toMatchObject({ elapsedMs: null });
    expect(ribbonText(at(CREW_PATIENCE_MS - 1))).toBe("Updating 1 peer: minibuch");

    const slow = at(CREW_PATIENCE_MS);
    expect(slow).toMatchObject({ kind: "peers", elapsedMs: CREW_PATIENCE_MS });
    expect(ribbonText(slow)).toBe("Updating 1 peer: minibuch, 2 min");
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
    expect(ribbonText(view, { from: 1, to: 2 })).toBe(`Collie 1.5.0 available. Tap to update. ${SHORT}`);
    // Never the whole sentence: that one belongs above the confirm, where there is room for it.
    expect(ribbonText(view, { from: 1, to: 2 })).not.toContain("members follow");
  });

  it("is absent when the reading carries no link change", () => {
    const view = read();
    expect(ribbonText(view)).toBe("Collie 1.5.0 available. Tap to update.");
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

  it("says nothing on a state that is past being told — a run already in flight", () => {
    const view = read({ update: info({ run: run("staging") }) });
    expect(ribbonText(view, { from: 1, to: 2 })).toBe("Updating to 1.5.0. Building");
  });
});
