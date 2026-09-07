import { afterEach, describe, expect, it } from "vitest";

import {
  clearUpdateStarted,
  dismissTarget,
  DONE_WINDOW_MS,
  getUpdateStarted,
  noteUpdateStarted,
  REASON_BUDGET,
  managerOf,
  ribbonText,
  ribbonView,
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
    dismissedPackVersion: null,
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
    });
  });

  it("stops speaking about a run that finished long ago", () => {
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
    });
    expect(ribbonText(read({ update: failed("health gate timed out") }))).toBe(
      "minibuch rolled back: health gate timed out. See Updates.",
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
    expect(ribbonText(view)).toMatch(/^minibuch rolled back: \S/);
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
    // And a pack notice put down at the same version leaves this host's own offer standing: two
    // decisions, two keys.
    expect(read({ update: packaged(), dismissedPackVersion: "1.5.0" })).toMatchObject({
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
// band the operator closed there is an ending they can no longer see. The offer and the QUIET pack
// states do not: a machine a package manager owns can stand behind for weeks.

describe("dismissing the quiet pack states", () => {
  const managed: UpdatePeerLeg[] = [{ name: "minibuch", state: "package-managed" }];
  const quiet = (over: Partial<UpdateInfo> = {}) =>
    info({ releaseAvailable: false, run: run("done", { peers: managed }), ...over });

  it("offers a dismiss in the PACK scope, keyed by the version the pack is heading for", () => {
    const view = read({ update: quiet() });
    expect(view).toEqual({ kind: "package-managed", names: ["minibuch"], target: "1.5.0" });
    expect(dismissTarget(view)).toEqual({ scope: "pack", version: "1.5.0" });
  });

  it("keys the dismiss to the release upstream names when the run record names no target", () => {
    const view = read({ update: quiet({ run: run("done", { peers: managed, to: null }) }) });
    expect(dismissTarget(view)).toEqual({ scope: "pack", version: "1.5.0" }); // `update.latest`
  });

  it("hides the quiet band once that version was dismissed IN ITS OWN SCOPE", () => {
    expect(read({ update: quiet(), dismissedPackVersion: "1.5.0" })).toEqual({ kind: "silent" });
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
      dismissedPackVersion: "1.5.0",
    });
    expect(view).toMatchObject({ kind: "package-managed", target: "1.6.0" });
  });

  it("lets a failed leg win over any dismissal, at the dismissed version or not", () => {
    // A rolled-back peer is not a standing fact somebody may put down: it is the end of a run the
    // operator asked for, and it outranks every dismissal there is.
    const peers: UpdatePeerLeg[] = [
      { name: "minibuch", state: "rolled-back", reason: "health gate timed out" },
      { name: "cellar", state: "package-managed" },
    ];
    const view = read({
      update: quiet({ run: run("done", { peers }) }),
      dismissedVersion: "1.5.0",
      dismissedPackVersion: "1.5.0",
    });
    expect(view).toMatchObject({ kind: "peer-failed", name: "minibuch" });
    expect(dismissTarget(view)).toBeNull();
  });

  it("dismisses nothing while a peer is still moving", () => {
    const peers: UpdatePeerLeg[] = [
      { name: "minibuch", state: "restarting" },
      { name: "cellar", state: "package-managed" },
    ];
    const view = read({
      update: quiet({ run: run("done", { peers }) }),
      dismissedPackVersion: "1.5.0",
    });
    // Still on screen despite the dismissal, and carrying no close: the operator has to be able to
    // see the end of a run somebody is driving.
    expect(view).toMatchObject({ kind: "peers", names: ["minibuch"] });
    expect(dismissTarget(view)).toBeNull();
  });

  it("gives a run, a failed peer and the bundle row no dismiss at all", () => {
    expect(dismissTarget(read({ update: info({ run: run("staging") }) }))).toBeNull();
    expect(dismissTarget({ kind: "starting" })).toBeNull();
    expect(dismissTarget({ kind: "updated", version: "1.5.0" })).toBeNull();
    expect(dismissTarget({ kind: "bundle" })).toBeNull();
    expect(dismissTarget({ kind: "peer-failed", name: "minibuch", reason: "gate" })).toBeNull();
    expect(dismissTarget({ kind: "silent" })).toBeNull();
  });
});
