import { describe, expect, test } from "bun:test";

import type { JsonValue } from "../json.ts";
import type { PreflightReport } from "../update-action.ts";
import type { UpdateRun } from "../update-run.ts";
import { UPDATE_RUN_SCHEMA } from "../update-run.ts";
import {
  FOLLOW_ATTEMPT_INTERVAL_MS,
  LEG_WALL_CLOCK_MS,
  LEG_WALL_CLOCK_REASON,
  followDecision,
  followGuards,
  formatTurn,
  LEAD_RELEASE_HEADER,
  leadReleaseHeader,
  CrewFollower,
  parseTurn,
  TURN_MISSED_SWEEPS,
  UPDATE_TURN_HEADER,
  UpdateTurns,
  UPSTREAM_CHECK_ID,
  type FollowFacts,
  type TurnMember,
} from "./follow.ts";
import { member as fixtureMember, neverProxy } from "./fixtures.ts";
import { CrewLead } from "./lead.ts";
import { CrewRegistry } from "./registry.ts";
import { DEFAULT_MAX_UPLOAD_BYTES } from "../uploads.ts";

// The peer's eight guards and the lead's turn queue, both as data. Nothing here spawns anything:
// the one detached-updater spawn is a seam, and the preflight subprocess is another, so the whole
// decision is exercisable under `bun test` (CLAUDE.md).

const NOW = 1_700_000_000_000;
const RUN_ID = "r-abc";

const run = (over: Partial<UpdateRun> = {}): UpdateRun => ({
  schema: UPDATE_RUN_SCHEMA,
  state: "done",
  from: "v1.0.0",
  to: "v1.1.0",
  startedAt: NOW - 10 * FOLLOW_ATTEMPT_INTERVAL_MS,
  updatedAt: NOW - 10 * FOLLOW_ATTEMPT_INTERVAL_MS,
  pid: 42,
  attempt: 0,
  ...over,
});

const facts = (over: Partial<FollowFacts> = {}): FollowFacts => ({
  installKind: "detached-checkout",
  own: "1.4.0",
  self: "attic",
  leadRelease: "1.4.1",
  turn: formatTurn("attic", RUN_ID),
  run: null,
  now: NOW,
  ...over,
});

const green: PreflightReport = { schema: 1, verdict: "green", checks: [] };
const red = (id: string, reason: string): PreflightReport => ({
  schema: 1,
  verdict: "red",
  checks: [{ id, verdict: "red", reason }],
});

describe("what a lead may state about itself", () => {
  test("a settled release is stated, and X-Crew-Lead-Release is its bare version", () => {
    expect(leadReleaseHeader({ version: "1.4.1", run: null })).toBe("1.4.1");
    expect(leadReleaseHeader({ version: "1.4.1", run: run({ state: "done", to: "v1.4.1" }) })).toBe("1.4.1");
    // A machine that has been on this version since before any recorded run states it too.
    expect(leadReleaseHeader({ version: "1.4.1", run: run({ state: "done", to: "v1.3.0" }) })).toBeNull();
  });

  test("a lead mid-run states nothing", () => {
    for (const state of ["preflight", "staging", "restarting", "verifying"] as const) {
      expect(leadReleaseHeader({ version: "1.4.1", run: run({ state }) })).toBeNull();
    }
  });

  test("a dev build states nothing, whatever its run record says", () => {
    expect(leadReleaseHeader({ version: "1.4.1-dev+8d57cc8", run: null })).toBeNull();
    expect(leadReleaseHeader({ version: "1.0.0-beta.44", run: null })).toBeNull();
    // A `+sha` build stamp with no prerelease tail is still a release, and still states its version.
    expect(leadReleaseHeader({ version: "1.4.1+8d57cc8", run: null })).toBe("1.4.1");
  });

  test("the turn names no code — a member and an opaque run id, and nothing else", () => {
    const value = formatTurn("attic", RUN_ID);
    expect(value).toBe(`attic;${RUN_ID}`);
    expect(value).not.toContain("http");
    expect(value).not.toContain("v1.");
    expect(parseTurn(value)).toEqual({ member: "attic", runId: RUN_ID });
    // Every shape that is not a turn reads as no turn. Absent means closed.
    expect(parseTurn(null)).toBeNull();
    expect(parseTurn("attic")).toBeNull();
    expect(parseTurn(";r-1")).toBeNull();
    expect(parseTurn("attic;")).toBeNull();
    expect(parseTurn("attic;r-1;extra")).toBeNull();
  });

  test("the two header names are the ones CREW_PROTOCOL registers", () => {
    expect(LEAD_RELEASE_HEADER).toBe("X-Crew-Lead-Release");
    expect(UPDATE_TURN_HEADER).toBe("X-Crew-Update-Turn");
  });
});

describe("the peer's guards", () => {
  test("guard 0: a packaged peer refuses first, whatever else is true", () => {
    // The regression this pins. A packaged install's preflight is GREEN BY DESIGN, so before
    // this guard existed such a peer sailed straight through firstRed() in followDecision and spawned
    // a `collie update` every hour that could only ever refuse — the exact failure ADR 0035 exists to
    // eliminate, on this path instead of the phone tap. Every other fact here is otherwise a clean
    // follow: a real answer would be `{ kind: "follow" }` without this guard.
    const d = followGuards(facts({ installKind: "packaged" }));
    expect(d.kind).toBe("refuse");
    expect(d.kind === "refuse" && d.reason).toBe("install-is-packaged");
  });

  test("every other kind still reaches the ordinary guards", () => {
    // The control: guard 0 must not fire on anything else, or it would silently stop every peer
    // from following.
    for (const kind of ["detached-checkout", "linked-clone", "binary", "unknown"] as const) {
      expect(followGuards(facts({ installKind: kind })).kind).toBe("follow");
    }
  });

  test("guard 1: a dev build never follows, and says so", () => {
    const d = followGuards(facts({ own: "1.4.0-dev+ab12cd3" }));
    expect(d.kind).toBe("refuse");
    expect(d.kind === "refuse" && d.reason).toBe("own-build-not-a-release");
    expect(d.kind === "refuse" && d.detail).toContain("never self-levels");
  });

  test("guard 2: an absent header is nothing to follow", () => {
    expect(followGuards(facts({ leadRelease: null })).kind).toBe("refuse");
    const d = followGuards(facts({ leadRelease: null }));
    expect(d.kind === "refuse" && d.reason).toBe("lead-states-nothing");
    // A lead that somehow stated a prerelease is refused by the same guard.
    const pre = followGuards(facts({ leadRelease: "1.5.0-beta.1" }));
    expect(pre.kind === "refuse" && pre.reason).toBe("lead-states-nothing");
  });

  test("guard 3: a peer never downgrades, and equal is not higher", () => {
    const lower = followGuards(facts({ own: "1.4.2", leadRelease: "1.4.1" }));
    expect(lower.kind === "refuse" && lower.reason).toBe("not-higher");
    const equal = followGuards(facts({ own: "1.4.1", leadRelease: "1.4.1" }));
    expect(equal.kind === "refuse" && equal.reason).toBe("not-higher");
  });

  test("guard 4: a peer never crosses a major on its own", () => {
    const d = followGuards(facts({ own: "1.4.0", leadRelease: "2.0.0" }));
    expect(d.kind === "refuse" && d.reason).toBe("crosses-a-major");
    expect(d.kind === "refuse" && d.detail).toContain("crosses a major");
  });

  test("guard 5: already rolled back from this tag in this run is refused, and stays refused", () => {
    const memory = run({ state: "rolled-back", to: "v1.4.1", runId: RUN_ID, startedAt: NOW - 2 * FOLLOW_ATTEMPT_INTERVAL_MS });
    const d = followGuards(facts({ run: memory }));
    expect(d.kind === "refuse" && d.reason).toBe("already-rolled-back");
    expect(d.kind === "refuse" && d.detail).toContain("new confirm");
  });

  test("guard 5: a new run id unlocks one more attempt at the same tag", () => {
    const memory = run({ state: "rolled-back", to: "v1.4.1", runId: "r-old", startedAt: NOW - 2 * FOLLOW_ATTEMPT_INTERVAL_MS });
    const d = followGuards(facts({ run: memory, turn: formatTurn("attic", "r-new") }));
    expect(d.kind).toBe("follow");
    expect(d.kind === "follow" && d.runId).toBe("r-new");
  });

  test("guard 7: a turn for somebody else is the same as no turn", () => {
    const d = followGuards(facts({ turn: formatTurn("basement", RUN_ID) }));
    expect(d.kind === "refuse" && d.reason).toBe("no-turn");
    expect(followGuards(facts({ turn: null })).kind).toBe("refuse");
  });

  test("one attempt an hour, whatever the headers say", () => {
    const recent = run({ state: "done", to: "v1.3.0", startedAt: NOW - 10 * 60_000 });
    const d = followGuards(facts({ run: recent }));
    expect(d.kind === "refuse" && d.reason).toBe("rate-limited");
    expect(d.kind === "refuse" && d.detail).toContain("tries again in");
    // An hour later the same facts follow.
    const later = followGuards(facts({ run: recent, now: NOW + FOLLOW_ATTEMPT_INTERVAL_MS }));
    expect(later.kind).toBe("follow");
  });

  test("all eight guards pass and the peer follows the lead's exact tag", () => {
    const d = followGuards(facts());
    expect(d).toEqual({ kind: "follow", tag: "v1.4.1", runId: RUN_ID });
  });

  test("guard 6: a fresh preflight before the spawn, and red refuses with its own reason", async () => {
    const asked: string[] = [];
    const d = await followDecision(facts(), {
      preflight: (tag) => {
        asked.push(tag);
        return Promise.resolve(red("disk", "less than 200 MB free on /"));
      },
    });
    // It ran, and it ran for the tag the lead named — never for "whatever an update would take".
    expect(asked).toEqual(["v1.4.1"]);
    expect(d.kind === "refuse" && d.reason).toBe("preflight-red");
    expect(d.kind === "refuse" && d.detail).toBe("less than 200 MB free on /");
  });

  test("guard 6: a preflight that could not run at all is not green", async () => {
    const d = await followDecision(facts(), { preflight: () => Promise.resolve(null) });
    expect(d.kind === "refuse" && d.reason).toBe("preflight-red");
    expect(d.kind === "refuse" && d.detail).toContain("could not be run");
  });

  test("guard 8: the tag must resolve upstream, over anonymous https", async () => {
    const d = await followDecision(facts(), {
      preflight: () => Promise.resolve(red(UPSTREAM_CHECK_ID, "no release tag `v1.4.1` upstream — there is nothing to take")),
    });
    expect(d.kind === "refuse" && d.reason).toBe("tag-does-not-resolve");
    expect(d.kind === "refuse" && d.detail).toContain("no release tag");
  });

  test("a green preflight lets the follow through with the tag and the run id", async () => {
    const d = await followDecision(facts(), { preflight: () => Promise.resolve(green) });
    expect(d).toEqual({ kind: "follow", tag: "v1.4.1", runId: RUN_ID });
  });

  test("the cheap guards run before anything is spawned", async () => {
    let ran = 0;
    const d = await followDecision(facts({ leadRelease: null }), {
      preflight: () => {
        ran += 1;
        return Promise.resolve(green);
      },
    });
    expect(d.kind).toBe("refuse");
    expect(ran).toBe(0);
  });
});

describe("the follower spawns the one updater there is", () => {
  const follower = (over: {
    report?: PreflightReport | null;
    own?: string;
    installKind?: FollowFacts["installKind"];
    record?: UpdateRun | null;
    start?: (a: { tag: string; runId: string }) => { ok: true } | { ok: false; reason: string };
  } = {}) => {
    const started: { tag: string; runId: string }[] = [];
    const lines: string[] = [];
    const f = new CrewFollower({
      installKind: over.installKind ?? "detached-checkout",
      self: () => ({ version: over.own ?? "1.4.0", self: "attic" }),
      run: () => over.record ?? null,
      preflight: () => Promise.resolve(over.report === undefined ? green : over.report),
      start:
        over.start ??
        ((a) => {
          started.push(a);
          return { ok: true };
        }),
      now: () => NOW,
      log: (line) => lines.push(line),
    });
    return { f, started, lines };
  };

  test("a granted turn on a green machine starts the updater once", async () => {
    const { f, started } = follower();
    f.observe({ leadRelease: "1.4.1", turn: formatTurn("attic", RUN_ID) });
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([{ tag: "v1.4.1", runId: RUN_ID }]);
  });

  test("a dev build never follows, however many sweeps carry the headers", async () => {
    const { f, started } = follower({ own: "1.4.0-dev+ab12cd3" });
    for (let i = 0; i < 5; i += 1) f.observe({ leadRelease: "1.4.1", turn: formatTurn("attic", RUN_ID) });
    await Promise.resolve();
    expect(started).toEqual([]);
    expect(f.last()?.kind).toBe("refuse");
  });

  test("a packaged peer never spawns the updater, on a green preflight, granted a real turn", async () => {
    // End to end, through the same entry point the router calls on every sweep. Before the guard-0
    // fix this reached firstRed(green) === null and called deps.start() — spawning a `collie update`
    // that would only ever refuse on its own packaged branch, once an hour, forever.
    const { f, started } = follower({ installKind: "packaged" });
    f.observe({ leadRelease: "1.4.1", turn: formatTurn("attic", RUN_ID) });
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([]);
    const last = f.last();
    expect(last?.kind).toBe("refuse");
    expect(last?.kind === "refuse" && last.reason).toBe("install-is-packaged");
  });

  // ── The peer says why it is standing still (M20/11) ──────────────────────
  // The rehearsal on the VM crew found the hole this closes: two peers refused to follow, said
  // nothing, and the lead spent the whole twenty minute wall clock before failing them with a
  // reason that names no cause.

  test("a refusal puts its reason on this peer's own journal", async () => {
    const { f, lines } = follower({ installKind: "packaged" });
    f.observe({ leadRelease: "1.4.1", turn: formatTurn("attic", RUN_ID) });
    expect(lines).toEqual([
      "[crew] follow: not self-levelling (install-is-packaged) — updates come from this machine's package manager (ADR 0035)",
    ]);
  });

  test("a refusal on a sweep whose turn names somebody else is not worth a line", async () => {
    // Measured on the VM crew: keyed on the reason alone, the journal took roughly a line a second,
    // because the reason flaps between `no-turn`, `lead-states-nothing` and the real one as the lead
    // drops its release header mid-run and addresses one member at a time.
    const { f, lines } = follower({ installKind: "packaged" });
    for (let i = 0; i < 10; i += 1) f.observe({ leadRelease: "1.4.1", turn: formatTurn("basement", RUN_ID) });
    for (let i = 0; i < 10; i += 1) f.observe({ leadRelease: null, turn: null });
    expect(lines).toEqual([]);
    // And the moment the turn does name this machine, the reason is on the journal.
    f.observe({ leadRelease: "1.4.1", turn: formatTurn("attic", RUN_ID) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("install-is-packaged");
  });

  test("the same refusal, sweep after sweep, is one line and not one per sweep", async () => {
    const { f, lines } = follower({ own: "1.4.0-dev+ab12cd3" });
    for (let i = 0; i < 20; i += 1) f.observe({ leadRelease: "1.4.1", turn: formatTurn("attic", RUN_ID) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("own-build-not-a-release");
  });

  test("a refusal that changes its reason says so again", async () => {
    let kind: FollowFacts["installKind"] = "packaged";
    const lines: string[] = [];
    const f = new CrewFollower({
      get installKind() {
        return kind;
      },
      self: () => ({ version: "1.4.0-dev+ab12cd3", self: "attic" }),
      run: () => null,
      preflight: () => Promise.resolve(green),
      start: () => ({ ok: true }),
      now: () => NOW,
      log: (line) => lines.push(line),
    });
    f.observe({ leadRelease: "1.4.1", turn: formatTurn("attic", RUN_ID) });
    kind = "detached-checkout";
    f.observe({ leadRelease: "1.4.1", turn: formatTurn("attic", RUN_ID) });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("install-is-packaged");
    expect(lines[1]).toContain("own-build-not-a-release");
  });

  test("a follow names the tag and the run it belongs to", async () => {
    const { f, lines } = follower();
    f.observe({ leadRelease: "1.4.1", turn: formatTurn("attic", RUN_ID) });
    await Promise.resolve();
    await Promise.resolve();
    expect(lines).toEqual([`[crew] follow: self-levelling to v1.4.1 (run ${RUN_ID.slice(0, 8)})`]);
  });

  test("an updater that will not start is recorded as a refusal rather than thrown", async () => {
    const { f } = follower({ start: () => ({ ok: false, reason: "systemd-run: no such unit" }) });
    f.observe({ leadRelease: "1.4.1", turn: formatTurn("attic", RUN_ID) });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.last()?.kind).toBe("refuse");
  });
});

describe("the lead's turn queue", () => {
  const member = (over: Partial<TurnMember> & { memberId: string }): TurnMember => ({
    enrolledAt: 1,
    version: "1.4.0",
    verdict: "green",
    answered: true,
    run: null,
    ...over,
  });

  test("one turn at a time, and nobody else is addressed", () => {
    const turns = new UpdateTurns(() => {});
    turns.begin(RUN_ID, "1.4.1");
    turns.observe(
      [member({ memberId: "attic", enrolledAt: 1 }), member({ memberId: "basement", enrolledAt: 2 })],
      NOW,
    );
    expect(turns.turnFor("attic")).toBe(`attic;${RUN_ID}`);
    expect(turns.turnFor("basement")).toBeNull();
  });

  test("the queue is in trust-store enrolment order, not member-id order", () => {
    const turns = new UpdateTurns(() => {});
    turns.begin(RUN_ID, "1.4.1");
    // `attic` sorts first alphabetically and joined LAST, so enrolment order must hand the turn to
    // `zeta`. This is the whole of why the ordering is stated rather than left incidental.
    turns.observe([member({ memberId: "attic", enrolledAt: 900 }), member({ memberId: "zeta", enrolledAt: 100 })], NOW);
    expect(turns.turnFor("zeta")).not.toBeNull();
    expect(turns.turnFor("attic")).toBeNull();
  });

  test("a member whose preflight is unknown or red is never handed a turn", () => {
    const turns = new UpdateTurns(() => {});
    turns.begin(RUN_ID, "1.4.1");
    turns.observe(
      [
        member({ memberId: "attic", enrolledAt: 1, verdict: null }),
        member({ memberId: "basement", enrolledAt: 2, verdict: "red" }),
        member({ memberId: "cellar", enrolledAt: 3, verdict: "amber" }),
      ],
      NOW,
    );
    // Unknown blocks exactly as red does (§19): "we could not check attic" is not "attic is fine".
    expect(turns.turnFor("attic")).toBeNull();
    expect(turns.turnFor("basement")).toBeNull();
    expect(turns.turnFor("cellar")).not.toBeNull();
  });

  test("the turn releases on the new version, on rolled-back, and on three missed sweeps", () => {
    // (a) the member reports the new version.
    const onVersion = new UpdateTurns(() => {});
    onVersion.begin(RUN_ID, "1.4.1");
    onVersion.observe([member({ memberId: "attic" }), member({ memberId: "basement", enrolledAt: 2 })], NOW);
    const releasedByVersion = onVersion.observe(
      [member({ memberId: "attic", version: "1.4.1" }), member({ memberId: "basement", enrolledAt: 2 })],
      NOW,
    );
    expect(releasedByVersion.released).toBe(true);
    expect(onVersion.turnFor("basement")).not.toBeNull();

    // (b) the member reports rolled-back.
    const onRollback = new UpdateTurns(() => {});
    onRollback.begin(RUN_ID, "1.4.1");
    onRollback.observe([member({ memberId: "attic" }), member({ memberId: "basement", enrolledAt: 2 })], NOW);
    const releasedByRollback = onRollback.observe(
      [
        member({
          memberId: "attic",
          run: { state: "rolled-back", to: "v1.4.1", runId: RUN_ID, reason: "health gate failed", updatedAt: NOW },
        }),
        member({ memberId: "basement", enrolledAt: 2 }),
      ],
      NOW,
    );
    expect(releasedByRollback.released).toBe(true);
    expect(onRollback.peerLegs().find((l) => l.name === "attic")?.state).toBe("rolled-back");
    expect(onRollback.turnFor("basement")).not.toBeNull();

    // (c) three consecutive missed sweeps.
    const onMisses = new UpdateTurns(() => {});
    onMisses.begin(RUN_ID, "1.4.1");
    onMisses.observe([member({ memberId: "attic" }), member({ memberId: "basement", enrolledAt: 2 })], NOW);
    let last = { released: false };
    for (let i = 0; i < TURN_MISSED_SWEEPS; i += 1) {
      last = onMisses.observe(
        [member({ memberId: "attic", answered: false }), member({ memberId: "basement", enrolledAt: 2 })],
        NOW,
      );
    }
    expect(last.released).toBe(true);
    expect(onMisses.peerLegs().find((l) => l.name === "attic")?.state).toBe("unreachable");
    expect(onMisses.turnFor("basement")).not.toBeNull();
  });

  test("an immediate sweep is earned only by a release, never by an ordinary fold", () => {
    const turns = new UpdateTurns(() => {});
    turns.begin(RUN_ID, "1.4.1");
    expect(turns.observe([member({ memberId: "attic" })], NOW).released).toBe(false);
    expect(turns.observe([member({ memberId: "attic" })], NOW).released).toBe(false);
    expect(turns.observe([member({ memberId: "attic", version: "1.4.1" })], NOW).released).toBe(true);
  });

  test("a lead restart re-grants rather than resuming a persisted turn", () => {
    const before = new UpdateTurns(() => {});
    before.begin(RUN_ID, "1.4.1");
    before.observe([member({ memberId: "attic" }), member({ memberId: "basement", enrolledAt: 2 })], NOW);
    expect(before.turnFor("attic")).not.toBeNull();

    // A brand-new instance IS the restarted lead: nothing about the queue was on disk, so it holds
    // no turn until a sweep re-derives one, and a member already on the new version is not in it.
    const after = new UpdateTurns(() => {});
    expect(after.turnFor("attic")).toBeNull();
    after.begin(RUN_ID, "1.4.1");
    after.observe([member({ memberId: "attic", version: "1.4.1" }), member({ memberId: "basement", enrolledAt: 2 })], NOW);
    expect(after.turnFor("attic")).toBeNull();
    expect(after.turnFor("basement")).not.toBeNull();
  });

  test("it never steps a peer down: a member ahead of the target is done, never a candidate", () => {
    const turns = new UpdateTurns(() => {});
    turns.begin(RUN_ID, "1.4.1");
    turns.observe([member({ memberId: "attic", version: "1.5.0" })], NOW);
    // Nothing in the queue can express "go back to 1.4.1", so the member simply holds no turn. The
    // accepted gap: a lead rolled back by hand after peers advanced leaves the peers ahead, and the
    // remedy is `collie crew update <member>` from the lead, over the operator's own SSH.
    expect(turns.turnFor("attic")).toBeNull();
    expect(turns.peerLegs().find((l) => l.name === "attic")?.state).toBe("done");
  });

  test("package-managed is terminal: a run completes with a packaged member present", () => {
    const turns = new UpdateTurns(() => {});
    turns.begin(RUN_ID, "1.4.1");
    turns.observe(
      [
        member({ memberId: "attic", enrolledAt: 1, installKind: "packaged" }),
        member({ memberId: "basement", enrolledAt: 2 }),
      ],
      NOW,
    );
    const attic = turns.peerLegs().find((l) => l.name === "attic");
    expect(attic?.state).toBe("package-managed");
    // Terminal like `done`: the turn went straight past it to the next member, so nothing in the run
    // is waiting on a machine that will never move.
    expect(turns.turnFor("attic")).toBeNull();
    expect(turns.turnFor("basement")).not.toBeNull();

    // And the run completes with it present: `basement` reports the target, and the only member left
    // is the packaged one, which holds no turn and blocks nothing.
    const released = turns.observe(
      [
        member({ memberId: "attic", enrolledAt: 1, installKind: "packaged" }),
        member({ memberId: "basement", enrolledAt: 2, version: "1.4.1" }),
      ],
      NOW,
    );
    expect(released.released).toBe(true);
    expect(turns.turnFor("attic")).toBeNull();
    expect(turns.peerLegs().every((l) => l.state !== "waiting" && l.state !== "updating")).toBe(true);
  });

  test("the lead never grants a turn to a packaged member, whatever else the sweep says", () => {
    // Pure and offline: this is the whole of "the lead never grants a turn to a packaged member".
    // Green preflight, reachable, behind the target — every reason to be handed the turn but one.
    for (const over of [{ verdict: "green" as const }, { verdict: "amber" as const }, { answered: false }]) {
      const turns = new UpdateTurns(() => {});
      turns.begin(RUN_ID, "1.4.1");
      turns.observe([member({ memberId: "attic", installKind: "packaged", ...over })], NOW);
      expect(turns.turnFor("attic")).toBeNull();
      expect(turns.peerLegs().find((l) => l.name === "attic")?.state).toBe("package-managed");
    }

    // A member that names NO kind is unknown, and unknown is not packaged: it is driven exactly as
    // it was before the field existed.
    const older = new UpdateTurns(() => {});
    older.begin(RUN_ID, "1.4.1");
    older.observe([member({ memberId: "attic" })], NOW);
    expect(older.turnFor("attic")).not.toBeNull();
  });

  test("a packaged member that has gone quiet reads unreachable, not calm", () => {
    // `package-managed` takes the place of `waiting` and nothing else. A machine nobody has heard
    // from in three sweeps may be off, and "waits for its package manager" would be a calm sentence
    // about a peer that is not answering at all.
    //
    // `loft` is here to keep the RUN open. A run all of whose legs are terminal settles on the sweep
    // that finds them so (M20/01), and `package-managed` is terminal — so a crew of one packaged
    // member would correctly end before the third sweep, and never reach the case under test.
    const turns = new UpdateTurns(() => {});
    turns.begin(RUN_ID, "1.4.1");
    for (let i = 0; i < TURN_MISSED_SWEEPS; i += 1) {
      turns.observe(
        [member({ memberId: "attic", installKind: "packaged", answered: false }), member({ memberId: "loft" })],
        NOW,
      );
    }
    const leg = turns.peerLegs().find((l) => l.name === "attic")!;
    expect(leg.state).toBe("unreachable");
    expect(leg.reason).toContain("missed");
    expect(turns.turnFor("attic")).toBeNull();
  });

  test("a packaged member's own run record wins: it reads updating, never package-managed", () => {
    // The member is the only witness to its own run. A packaged machine that is somehow moving —
    // an operator running the updater by hand on it — is exactly the thing the page must not hide.
    const turns = new UpdateTurns(() => {});
    turns.begin(RUN_ID, "1.4.1");
    turns.observe(
      [
        member({
          memberId: "attic",
          installKind: "packaged",
          run: { state: "verifying", to: "v1.4.1", runId: RUN_ID, reason: null, updatedAt: NOW },
        }),
      ],
      NOW,
    );
    expect(turns.peerLegs().find((l) => l.name === "attic")?.state).toBe("updating");
    // And it is still handed no turn: only a `waiting` leg is ever eligible.
    expect(turns.turnFor("attic")).toBeNull();
  });

  test("a packaged member already on the target reads as done, which is the truer sentence", () => {
    const turns = new UpdateTurns(() => {});
    turns.begin(RUN_ID, "1.4.1");
    turns.observe([member({ memberId: "attic", version: "1.4.1", installKind: "packaged" })], NOW);
    expect(turns.peerLegs().find((l) => l.name === "attic")?.state).toBe("done");
  });

  test("no run means no turn — a lead that has confirmed nothing states nothing", () => {
    const turns = new UpdateTurns(() => {});
    expect(turns.observe([member({ memberId: "attic" })], NOW).released).toBe(false);
    expect(turns.peerLegs()).toEqual([]);
    expect(turns.turnFor("attic")).toBeNull();
  });

  test("end() stops the queue and KEEPS the last run's legs; begin() is what clears them", () => {
    // The split matters on the phone. The operator is looking at the page they confirmed on, and
    // clearing the rows the instant the run ends would take the outcome off the screen at exactly
    // the moment they earned it. A new run replaces them; nothing else does (M20/01).
    const turns = new UpdateTurns(() => {});
    turns.begin(RUN_ID, "1.4.1");
    turns.observe([member({ memberId: "attic" })], NOW);
    turns.end();
    expect(turns.turnFor("attic")).toBeNull();
    expect(turns.peerLegs().map((l) => l.name)).toEqual(["attic"]);
    turns.end(); // idempotent
    expect(turns.peerLegs().map((l) => l.name)).toEqual(["attic"]);
    turns.begin("run-two", "1.4.2");
    expect(turns.peerLegs()).toEqual([]);
  });

  test("legs that outlive their run still NAME it, so a later run cannot wear them", () => {
    // The composer attaches these rows to the run record on screen. Legs that survive `end` and
    // forget which run made them are the previous run's peers, and its failures, presented under the
    // next run's id (M20/01, after review).
    const turns = new UpdateTurns(() => {});
    expect(turns.legsRun()).toBeNull();
    turns.begin(RUN_ID, "1.4.1");
    turns.observe([member({ memberId: "attic" })], NOW);
    turns.end();
    expect(turns.legsRun()).toBe(RUN_ID);
    turns.begin("run-two", "1.4.2");
    expect(turns.legsRun()).toBe("run-two");
  });

  test("no second timer: the queue arms nothing and moves only when a sweep folds it", async () => {
    const text = await Bun.file(new URL("./follow.ts", import.meta.url)).text();
    expect(text).not.toContain("setInterval");
    expect(text).not.toContain("setTimeout");
    // And the one spawner rule: this module names the command and spawns nothing itself.
    expect(text).not.toContain("Bun.spawn");
  });
});

// ── The queue over a REAL sweep (§5, §19, §20) ───────────────────────────────
//
// The tests above hand `UpdateTurns` a `TurnMember` directly, so they pin the fold and not the
// wiring. This one drives a real `CrewLead` instead, because the defect was entirely in the wiring:
// the queue's "the member reports the new version" release could never fire, since the only route
// that carried a version was `hello` and the sweep does not dial it. A member that had finished
// updating was therefore never marked done, and its turn was released only by a rollback or by
// three missed sweeps.

describe("a member's turn ends when its SWEEP reports the target version", () => {
  const LEAD_NOW = 1_754_000_000_000;
  const body = { sessions: [], agents: [], shellPanes: [] };
  const GREEN = { verdict: "green", asOf: 1, checks: [] };

  function sweeping(answer: () => JsonValue) {
    const roster = [
      fixtureMember({ memberId: "attic", enrolledAt: 1 }),
      fixtureMember({ memberId: "basement", enrolledAt: 2 }),
    ];
    const turns = new UpdateTurns(() => {});
    const registry = new CrewRegistry({ sessions: { get: () => undefined }, self: "desk", members: () => roster });
    const lead = new CrewLead({
      log: () => {},
      registry,
      snapshot: async (link) => ({
        ok: true,
        // `basement` is the next in line and stays behind throughout: it is what proves the turn was
        // handed ON rather than merely dropped.
        value: link.memberId === "attic" ? answer() : { ...body, version: "1.4.0", updatePreflight: GREEN },
        status: 200,
        member: null,
        receivedAt: LEAD_NOW,
        date: null,
      }),
      proxy: neverProxy,
      self: { id: "desk", name: "the herd" },
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
      now: () => LEAD_NOW,
      follow: {
        leadRelease: () => "1.4.1",
        turns,
        enrolledAt: (id) => roster.find((m) => m.memberId === id)?.enrolledAt ?? 0,
      },
    });
    return { lead, turns, registry };
  }

  test("done, released, and handed straight on to the next member in enrolment order", async () => {
    let running = "1.4.0";
    const h = sweeping(() => ({ ...body, version: running, updatePreflight: GREEN }));
    h.turns.begin(RUN_ID, "1.4.1");

    await h.lead.sweep();
    expect(h.turns.turnFor("attic")).toBe(`attic;${RUN_ID}`);
    expect(h.turns.peerLegs().find((l) => l.name === "attic")?.state).toBe("waiting");

    // The member restarts onto the target and says so on the very next sweep — no `hello` anywhere.
    running = "1.4.1";
    await h.lead.sweep();
    expect(h.registry.state("attic").version).toBe("1.4.1");
    const leg = h.turns.peerLegs().find((l) => l.name === "attic");
    expect(leg?.state).toBe("done");
    expect(leg?.version).toBe("1.4.1");
    expect(h.turns.turnFor("attic")).toBeNull();
    expect(h.turns.turnFor("basement")).toBe(`basement;${RUN_ID}`);
  });

  test("a member that never reports one stays waiting — the turn is not released by silence", async () => {
    // The pre-amendment shape, and the defect exactly: the member answers every sweep and the lead
    // learns nothing, so the leg can never leave `waiting` on a version it was never told.
    const h = sweeping(() => ({ ...body, updatePreflight: GREEN }));
    h.turns.begin(RUN_ID, "1.4.1");
    await h.lead.sweep();
    await h.lead.sweep();
    expect(h.registry.state("attic").version).toBeNull();
    expect(h.turns.peerLegs().find((l) => l.name === "attic")?.state).toBe("waiting");
    expect(h.turns.turnFor("attic")).toBe(`attic;${RUN_ID}`);
  });
});

// ── What the journal says about a run's legs ─────────────────────────────────
//
// 2026-09-07: the crew levelled at 17:43:40 and the lead's record still read "moving" at 17:58:07.
// Both journals held one line for the whole run. These are the lines that would have settled it.

describe("the turn queue names each leg change and the moment a run settles", () => {
  const member = (over: Partial<TurnMember> & { memberId: string }): TurnMember => ({
    enrolledAt: 1,
    version: "1.4.0",
    verdict: "green",
    answered: true,
    run: null,
    ...over,
  });

  test("a leg change is one line, and an unchanged leg is none", () => {
    const journal: string[] = [];
    const turns = new UpdateTurns((line) => journal.push(line));
    turns.begin(RUN_ID, "1.4.1");
    turns.observe([member({ memberId: "attic" })], NOW);
    turns.observe([member({ memberId: "attic" })], NOW);
    turns.observe([member({ memberId: "attic", version: "1.4.1" })], NOW);
    turns.observe([member({ memberId: "attic", version: "1.4.1" })], NOW);
    expect(journal).toEqual([
      "[crew] update r-abc: attic new -> waiting (1.4.0)",
      "[crew] update r-abc: attic waiting -> done (1.4.1)",
      "[crew] update r-abc: settled, 1 peer(s) done",
    ]);
  });

  test("the settling line is written once, however many sweeps follow it", () => {
    const journal: string[] = [];
    const turns = new UpdateTurns((line) => journal.push(line));
    turns.begin(RUN_ID, "1.4.1");
    turns.observe([member({ memberId: "attic", version: "1.4.1" })], NOW);
    turns.observe([member({ memberId: "attic", version: "1.4.1" })], NOW);
    turns.observe([member({ memberId: "attic", version: "1.4.1" })], NOW);
    expect(journal.filter((l) => l.includes("settled"))).toEqual(["[crew] update r-abc: settled, 1 peer(s) done"]);
  });

  test("a member still moving holds the run open, and the settling line names each terminal state", () => {
    const journal: string[] = [];
    const turns = new UpdateTurns((line) => journal.push(line));
    turns.begin(RUN_ID, "1.4.1");
    const moving = member({
      memberId: "attic",
      run: { runId: RUN_ID, state: "staging", to: "1.4.1", reason: null, updatedAt: NOW },
    });
    turns.observe([moving, member({ memberId: "basement", enrolledAt: 2, version: "1.4.1" })], NOW);
    // Nothing has settled while `attic` is updating — that is the case the drill could not see.
    expect(journal.some((l) => l.includes("settled"))).toBe(false);
    turns.observe(
      [
        member({
          memberId: "attic",
          run: { runId: RUN_ID, state: "rolled-back", to: "1.4.1", reason: "the health gate failed", updatedAt: NOW },
        }),
        member({ memberId: "basement", enrolledAt: 2, version: "1.4.1" }),
      ],
      NOW,
    );
    expect(journal).toEqual([
      "[crew] update r-abc: attic new -> updating (1.4.0)",
      "[crew] update r-abc: basement new -> done (1.4.1)",
      "[crew] update r-abc: attic updating -> rolled-back (1.4.0)",
      "[crew] update r-abc: settled, 1 peer(s) done, 1 rolled-back",
    ]);
  });
});

// ── A run always ends (M20/01) ───────────────────────────────────────────────
//
// The 2026-09-07 drill's run had every fact needed to close it and no code that could. Three holes
// are pinned here: the schedule that could not see a live run, the leg that could wait forever, and
// the settle that no production path ever called.

describe("a run always ends, on its own, within a bounded time", () => {
  const member = (over: Partial<TurnMember> & { memberId: string }): TurnMember => ({
    enrolledAt: 1,
    version: "1.4.0",
    verdict: "green",
    answered: true,
    run: null,
    ...over,
  });

  test("a member with an open leg is urgent; one with a terminal leg is not, and no run is not", () => {
    const turns = new UpdateTurns(() => {});
    // No run: nobody is urgent, so every peer keeps exactly the backoff it earned.
    expect(turns.hasOpenLeg("attic")).toBe(false);
    turns.begin(RUN_ID, "1.4.1");
    // A member the run has never folded is urgent: the first sweep of a run must reach everybody,
    // and a peer already sitting on the ten-minute step of the ladder is exactly the one it must
    // reach. This is the drill's twelve and a half minutes, closed.
    expect(turns.hasOpenLeg("attic")).toBe(true);
    turns.observe([member({ memberId: "attic" }), member({ memberId: "basement", enrolledAt: 2 })], NOW);
    expect(turns.hasOpenLeg("attic")).toBe(true);
    turns.observe([member({ memberId: "attic", version: "1.4.1" }), member({ memberId: "basement", enrolledAt: 2 })], NOW);
    expect(turns.hasOpenLeg("attic")).toBe(false);
    expect(turns.hasOpenLeg("basement")).toBe(true);
  });

  test("a leg that has not changed state for the wall clock fails, and the run then settles", () => {
    const journal: string[] = [];
    const turns = new UpdateTurns((line) => journal.push(line));
    turns.begin(RUN_ID, "1.4.1");
    const moving = member({
      memberId: "attic",
      run: { runId: RUN_ID, state: "staging", to: "1.4.1", reason: null, updatedAt: NOW },
    });
    turns.observe([moving], NOW);
    expect(turns.settledAt()).toBeNull();

    // One tick short of the wall clock the leg is still open, and the run is still a run.
    turns.observe([moving], NOW + LEG_WALL_CLOCK_MS - 1);
    expect(turns.peerLegs()[0]?.state).toBe("updating");
    expect(turns.settledAt()).toBeNull();

    turns.observe([moving], NOW + LEG_WALL_CLOCK_MS);
    const leg = turns.peerLegs()[0]!;
    expect(leg.state).toBe("unreachable");
    expect(leg.reason).toBe(LEG_WALL_CLOCK_REASON);
    expect(turns.settledAt()).toBe(NOW + LEG_WALL_CLOCK_MS);
    expect(journal.at(-1)).toContain("settled");
    // And the queue is over: no turn is granted from here, whoever asks.
    expect(turns.turnFor("attic")).toBeNull();
  });

  test("the wall clock reads each leg's OWN last change, not the run's start", () => {
    const turns = new UpdateTurns(() => {});
    turns.begin(RUN_ID, "1.4.1");
    const staging = (at: number): TurnMember =>
      member({ memberId: "attic", run: { runId: RUN_ID, state: "staging", to: "1.4.1", reason: null, updatedAt: at } });
    turns.observe([member({ memberId: "attic" }), member({ memberId: "basement", enrolledAt: 2 })], NOW);
    // `attic` moves from waiting to updating half way through the window, which restarts ITS clock
    // and no other. A run's start would have failed both legs together.
    const half = NOW + LEG_WALL_CLOCK_MS / 2;
    turns.observe([staging(half), member({ memberId: "basement", enrolledAt: 2, version: "1.4.1" })], half);
    turns.observe([staging(half), member({ memberId: "basement", enrolledAt: 2, version: "1.4.1" })], NOW + LEG_WALL_CLOCK_MS);
    expect(turns.peerLegs().find((l) => l.name === "attic")?.state).toBe("updating");
    turns.observe([staging(half), member({ memberId: "basement", enrolledAt: 2, version: "1.4.1" })], half + LEG_WALL_CLOCK_MS);
    expect(turns.peerLegs().find((l) => l.name === "attic")?.state).toBe("unreachable");
  });

  test("a member merely QUEUED is not failed for a wait another member's build is spending", () => {
    const turns = new UpdateTurns(() => {});
    turns.begin(RUN_ID, "1.4.1");
    // Two peers, and turns are serial: `attic` holds it and `basement` waits behind it. Answering
    // every sweep on time is all `basement` can do, so the wall clock must not be its own.
    const attic = (at: number): TurnMember =>
      member({ memberId: "attic", run: { runId: RUN_ID, state: "staging", to: "1.4.1", reason: null, updatedAt: at } });
    const basement = member({ memberId: "basement", enrolledAt: 2 });
    turns.observe([member({ memberId: "attic" }), basement], NOW);
    expect(turns.turnFor("attic")).not.toBeNull();

    // `attic` grinds through the whole window and finishes at the last tick before it expires.
    turns.observe([attic(NOW), basement], NOW + LEG_WALL_CLOCK_MS - 1);
    const passed = NOW + LEG_WALL_CLOCK_MS - 1;
    turns.observe([member({ memberId: "attic", version: "1.4.1" }), basement], passed);
    // Nineteen minutes have gone by and `basement` has not been asked for anything yet. It is still
    // waiting, and it now holds the turn.
    expect(turns.peerLegs().find((l) => l.name === "basement")?.state).toBe("waiting");
    expect(turns.turnFor("basement")).not.toBeNull();

    // Its own clock starts at the GRANT, so it has the whole window from there.
    turns.observe([member({ memberId: "attic", version: "1.4.1" }), basement], passed + LEG_WALL_CLOCK_MS - 1);
    expect(turns.peerLegs().find((l) => l.name === "basement")?.state).toBe("waiting");
    turns.observe([member({ memberId: "attic", version: "1.4.1" }), basement], passed + LEG_WALL_CLOCK_MS);
    expect(turns.peerLegs().find((l) => l.name === "basement")?.state).toBe("unreachable");
  });

  test("a run where NOTHING moves still ends, even with no member holding the turn", () => {
    const turns = new UpdateTurns(() => {});
    turns.begin(RUN_ID, "1.4.1");
    // An unknown verdict is never eligible, so this member never receives the turn. Without the
    // run-level clock its leg would stay `waiting` for as long as the process lives.
    const unchecked = member({ memberId: "attic", verdict: null });
    turns.observe([unchecked], NOW);
    expect(turns.turnFor("attic")).toBeNull();
    turns.observe([unchecked], NOW + LEG_WALL_CLOCK_MS - 1);
    expect(turns.settledAt()).toBeNull();
    turns.observe([unchecked], NOW + LEG_WALL_CLOCK_MS);
    expect(turns.peerLegs()[0]?.state).toBe("unreachable");
    expect(turns.settledAt()).toBe(NOW + LEG_WALL_CLOCK_MS);
  });

  test("all legs terminal settles ONCE, stamps the clock, and ends the queue", () => {
    const turns = new UpdateTurns(() => {});
    turns.begin(RUN_ID, "1.4.1");
    turns.observe([member({ memberId: "attic" })], NOW);
    expect(turns.settledAt()).toBeNull();
    expect(turns.current()).not.toBeNull();

    turns.observe([member({ memberId: "attic", version: "1.4.1" })], NOW + 1000);
    expect(turns.settledAt()).toBe(NOW + 1000);
    // `end()` was called from a production path, which is what never happened before this spec.
    expect(turns.current()).toBeNull();

    // A later sweep re-settles nothing: the stamp is the moment it first stopped moving, and a
    // clock that crept forward every tick would be a clock the band could never go quiet on.
    turns.observe([member({ memberId: "attic", version: "1.4.1" })], NOW + 9000);
    expect(turns.settledAt()).toBe(NOW + 1000);
    // And the legs are still readable, so the page keeps the outcome the operator earned.
    expect(turns.peerLegs().map((l) => l.state)).toEqual(["done"]);
  });

  test("a lead with no peers settles its run on the first sweep rather than holding it open", () => {
    const turns = new UpdateTurns(() => {});
    turns.begin(RUN_ID, "1.4.1");
    expect(turns.settledAt()).toBeNull();
    turns.observe([], NOW);
    expect(turns.settledAt()).toBe(NOW);
    expect(turns.current()).toBeNull();
  });

  test("a new run clears the last one's stamp and legs", () => {
    const turns = new UpdateTurns(() => {});
    turns.begin(RUN_ID, "1.4.1");
    turns.observe([member({ memberId: "attic", version: "1.4.1" })], NOW);
    expect(turns.settledAt()).toBe(NOW);
    turns.begin("r-two", "1.4.2");
    expect(turns.settledAt()).toBeNull();
    expect(turns.peerLegs()).toEqual([]);
  });
});


describe("every leg carries a clock the band can read", () => {
  // M20/12. Found by the VM rehearsal: two peers sat on `waiting` for twenty minutes and the card
  // never showed "No action needed, this finishes on its own", because that sentence is gated on an
  // elapsed time the band reads off a leg stamp, and a queued leg carried none.
  const member = (over: Partial<TurnMember> & { memberId: string }): TurnMember => ({
    enrolledAt: 1,
    version: "1.4.0",
    verdict: "green",
    answered: true,
    run: null,
    ...over,
  });

  test("a queued leg is stamped with the moment this lead first saw that state", () => {
    const turns = new UpdateTurns(() => {});
    turns.begin(RUN_ID, "1.4.1");
    const held = member({ memberId: "attic" });
    const queued = member({ memberId: "basement", enrolledAt: 2 });
    turns.observe([held, queued], NOW);
    turns.observe([held, queued], NOW + 90_000);
    const leg = turns.peerLegs().find((l) => l.name === "basement");
    expect(leg?.state).toBe("waiting");
    expect(leg?.updatedAt).toBe(NOW);
  });

  test("the wall clock's own failure carries the moment it failed", () => {
    const turns = new UpdateTurns(() => {});
    turns.begin(RUN_ID, "1.4.1");
    const moving = member({
      memberId: "attic",
      run: { runId: RUN_ID, state: "staging", to: "1.4.1", reason: null, updatedAt: NOW },
    });
    turns.observe([moving], NOW);
    turns.observe([moving], NOW + LEG_WALL_CLOCK_MS);
    const leg = turns.peerLegs()[0]!;
    expect(leg.state).toBe("unreachable");
    expect(leg.reason).toBe(LEG_WALL_CLOCK_REASON);
    expect(leg.updatedAt).toBe(NOW + LEG_WALL_CLOCK_MS);
  });
});


describe("a leg the wall clock failed stays failed", () => {
  // M20/13, measured on the VM crew on 2026-09-08. The clock fired and the very next sweep undid it:
  //   11:05:37  member waiting -> unreachable (no change for 20 minutes)
  //   11:05:38  member unreachable -> waiting (1.7.1+0c7132b)
  // `legOf` reads the member's facts, and a member that answers every sweep and never moves has the
  // same facts a second later. The run was queued afresh, so it could not end.
  const member = (over: Partial<TurnMember> & { memberId: string }): TurnMember => ({
    enrolledAt: 1,
    version: "1.4.0",
    verdict: "green",
    answered: true,
    run: null,
    ...over,
  });

  test("the sweep after the failure does not put the leg back to waiting", () => {
    const journal: string[] = [];
    const turns = new UpdateTurns((line) => journal.push(line));
    turns.begin(RUN_ID, "1.4.1");
    const stuck = member({ memberId: "attic" });
    turns.observe([stuck], NOW);
    turns.observe([stuck], NOW + LEG_WALL_CLOCK_MS);
    expect(turns.peerLegs()[0]?.state).toBe("unreachable");
    // The sweep one second later, with the member answering exactly as before.
    turns.observe([stuck], NOW + LEG_WALL_CLOCK_MS + 1_000);
    const leg = turns.peerLegs()[0]!;
    expect(leg.state).toBe("unreachable");
    expect(leg.reason).toBe(LEG_WALL_CLOCK_REASON);
    expect(journal.filter((l) => l.includes("-> waiting"))).toHaveLength(1);
  });

  test("a one-peer run settles on the failure and stays settled", () => {
    const turns = new UpdateTurns(() => {});
    turns.begin(RUN_ID, "1.4.1");
    const stuck = member({ memberId: "attic" });
    turns.observe([stuck], NOW);
    turns.observe([stuck], NOW + LEG_WALL_CLOCK_MS);
    expect(turns.settledAt()).toBe(NOW + LEG_WALL_CLOCK_MS);
    turns.observe([stuck], NOW + LEG_WALL_CLOCK_MS + 60_000);
    expect(turns.settledAt()).toBe(NOW + LEG_WALL_CLOCK_MS);
    expect(turns.hasOpenLeg("attic")).toBe(false);
  });

  test("a member that takes the build after all is read as done, not held on the old failure", () => {
    // Two members, so the run is still open after the first one fails and the sweep still folds.
    const turns = new UpdateTurns(() => {});
    turns.begin(RUN_ID, "1.4.1");
    const behind = member({ memberId: "basement", enrolledAt: 2 });
    turns.observe([member({ memberId: "attic" }), behind], NOW);
    turns.observe([member({ memberId: "attic" }), behind], NOW + LEG_WALL_CLOCK_MS);
    expect(turns.peerLegs().find((l) => l.name === "attic")?.state).toBe("unreachable");
    turns.observe(
      [member({ memberId: "attic", version: "1.4.1" }), behind],
      NOW + LEG_WALL_CLOCK_MS + 1_000,
    );
    expect(turns.peerLegs().find((l) => l.name === "attic")?.state).toBe("done");
  });
});
