// THE CONFORMANCE FIXTURE REGISTRY — the second half of what registering an adapter means.
//
// `registry.ts` says which multiplexers this build can DRIVE. This says how each of them is PROVED:
// one {@link MuxConformanceFixture} per registered adapter, and `conformance.test.ts` fails an
// adapter that has none. Two lists rather than one field on the factory, because a fixture pulls in a
// fake transport and a seeded world — none of which belongs in the module the bridge starts from.
//
// Adding tmux (M10/04) or zellij (M10/05) is therefore exactly two lines: its factory in
// `MUX_ADAPTERS`, its fixture here. No new test file, ever — the suite iterates.
//
// ── THE DECORATED VARIANTS (M11/03) ───────────────────────────────────────────────────────────────
//
// What actually runs on a tmux or zellij host is the adapter WITH the beacon decorator around it, so
// that build gets the whole suite too — twice, because the decorator's honesty runs in two
// directions and each has its own way of being wrong:
//
//   • hooks INSTALLED ⇒ `agentDetection` / `agentSessionRef` are declared, and the suite's
//     `declaredPaneFactsArePopulated` demands that a pane really names an agent and carries a session.
//   • hooks ABSENT ⇒ both stay absent, and `undeclaredPaneFactsAreAbsent` demands every pane read as
//     a shell of unknown status with no session — the same calls, answering honestly the other way.
//
// The beacons are seeded BESIDE the fake transport, keyed off the ids of the world the fake actually
// built rather than off hard-coded pane names: the join is the thing under test, so a fixture that
// asserted its own ids would be proving its own arithmetic. Nothing here needs Claude, tmux, zellij
// or a state directory.

import { withAgentBeacons } from "../beacon/decorate.ts";
import { fakeBeaconReader, FAKE_BEACON_NOW, type FakeBeacon } from "../beacon/fake.ts";
import { BEACON_SCHEMA_VERSION, type BeaconMarker, type BeaconStatus } from "../beacon/types.ts";
import type { MuxConformanceFixture, MuxConformanceWorld } from "./conformance.ts";
import { herdrConformanceFixture } from "./herdr/fixture.ts";
import { tmuxMuxFactory } from "./tmux/adapter.ts";
import { FakeTmux, FAKE_TMUX_SOCKET, tmuxConformanceFixture, tmuxWorld } from "./tmux/fixture.ts";
import { tmuxBeaconMatcher } from "./tmux/markers.ts";
import { zellijMuxFactory } from "./zellij/adapter.ts";
import { FakeZellij, SESSION, zellijConformanceFixture, zellijWorld } from "./zellij/fixture.ts";
import { zellijBeaconMatcher } from "./zellij/markers.ts";
import type { MuxAdapter } from "./types.ts";

/** The harness the seeded beacons claim to be — the emitter's own (`cli/beacon.ts`). */
const SEEDED_HARNESS = "claude";

/** One beacon for one pane of a fixture's world, as its agent's hook would have written it. */
function seedBeacon(markers: readonly BeaconMarker[], status: BeaconStatus, pid: number): FakeBeacon {
  return {
    record: {
      schemaVersion: BEACON_SCHEMA_VERSION,
      harness: SEEDED_HARNESS,
      session: { kind: "id", value: `fixture-session-${String(pid)}` },
      status,
      pid,
      pidStartTime: 4242,
      markers,
      heartbeatMs: FAKE_BEACON_NOW,
    },
  };
}

/**
 * A zellij Collie pane id with its `terminal_` namespace stripped back off — what the pane's own
 * `$ZELLIJ_PANE_ID` held, and so what the emitter would have stored raw.
 */
function bareZellijPane(paneId: string): string {
  return paneId.replace(/^terminal_/u, "");
}

/** The pane ids of a world, in the order the multiplexer listed them. */
async function paneIdsOf(world: MuxConformanceWorld): Promise<readonly string[]> {
  return (await world.adapter.snapshot()).panes.map((pane) => pane.paneId);
}

/**
 * tmux's decorated world.
 *
 * `$TMUX_PANE` IS the Collie pane id on tmux, so the marker carries it unchanged; the scope is the
 * server socket, which the fake answers `#{socket_path}` with exactly as the real binary does.
 */
async function tmuxDecoratedWorld(hooksInstalled: boolean): Promise<MuxConformanceWorld> {
  const fake = new FakeTmux();
  const world = tmuxWorld(fake);
  const namespace = tmuxMuxFactory.mux;
  const beacons = (await paneIdsOf(world)).map((paneId, index) =>
    seedBeacon([{ namespace, scope: FAKE_TMUX_SOCKET, pane: paneId }], index === 0 ? "waiting" : "working", 900 + index),
  );
  // A twin of EVERY pane, on another tmux server — the scope check's negative control, seeded into
  // every decorated run rather than into one test. A join that ignored the scope would see two
  // beacons per pane, and two answers to a question with one answer is absence (decorate.ts), so
  // every pane would fall back to a shell and `declaredPaneFactsArePopulated` would fail loudly.
  const foreign = (await paneIdsOf(world)).map((paneId) =>
    seedBeacon([{ namespace, scope: "/tmp/tmux-1000/somebody-else", pane: paneId }], "idle", 999),
  );
  return decorated(world, withAgentBeacons(world.adapter, fakeBeaconReader([...beacons, ...foreign]), {
    matcher: tmuxBeaconMatcher(namespace, fake),
    hooksInstalled: () => hooksInstalled,
  }));
}

/**
 * zellij's decorated world.
 *
 * `$ZELLIJ_PANE_ID` is a BARE INTEGER, so the marker carries the id with the adapter's `terminal_`
 * prefix stripped back off — which is exactly the transformation the matcher has to apply, and the
 * reason this fixture would fail if it were dropped.
 */
async function zellijDecoratedWorld(hooksInstalled: boolean): Promise<MuxConformanceWorld> {
  const fake = new FakeZellij();
  const built = zellijWorld(fake);
  const namespace = zellijMuxFactory.mux;
  const beacons = (await paneIdsOf(built.world)).map((paneId, index) =>
    seedBeacon([{ namespace, scope: SESSION, pane: bareZellijPane(paneId) }], index === 0 ? "waiting" : "working", 900 + index),
  );
  // The scope check's negative control — another zellij session's same-numbered panes. See tmux's.
  const foreign = (await paneIdsOf(built.world)).map((paneId) =>
    seedBeacon([{ namespace, scope: "somebody-elses-session", pane: bareZellijPane(paneId) }], "idle", 999),
  );
  return decorated(built.world, withAgentBeacons(built.world.adapter, fakeBeaconReader([...beacons, ...foreign]), {
    matcher: zellijBeaconMatcher(namespace, built.session),
    hooksInstalled: () => hooksInstalled,
  }));
}

/** The same world, driven through the decorated adapter. Every perturbation stays the fixture's. */
function decorated(world: MuxConformanceWorld, adapter: MuxAdapter): MuxConformanceWorld {
  return { ...world, adapter };
}

/**
 * One fixture per registered adapter, plus the decorated build of each adapter that has a beacon
 * matcher. Keyed by nothing — the suite matches on `fixture.mux`, and a variant shares it.
 */
export const MUX_CONFORMANCE_FIXTURES: readonly MuxConformanceFixture[] = [
  herdrConformanceFixture,
  tmuxConformanceFixture,
  zellijConformanceFixture,
  { mux: tmuxMuxFactory.mux, variant: "beacons, hooks installed", create: () => tmuxDecoratedWorld(true) },
  { mux: tmuxMuxFactory.mux, variant: "beacons, hooks absent", create: () => tmuxDecoratedWorld(false) },
  { mux: zellijMuxFactory.mux, variant: "beacons, hooks installed", create: () => zellijDecoratedWorld(true) },
  { mux: zellijMuxFactory.mux, variant: "beacons, hooks absent", create: () => zellijDecoratedWorld(false) },
];

/**
 * The fixture for `mux`, or undefined when the adapter has not contributed one.
 *
 * The FIRST match, which is the undecorated one: this answers "is this adapter proved at all", and
 * the variants are extra proof of a build rather than a replacement for the adapter's own.
 */
export function fixtureFor(mux: string): MuxConformanceFixture | undefined {
  return MUX_CONFORMANCE_FIXTURES.find((fixture) => fixture.mux === mux);
}
