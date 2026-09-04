import { describe, expect, test } from "bun:test";

import type { JsonValue } from "../json.ts";
import type { PreflightReport } from "../update-action.ts";
import type { UpdateRun } from "../update-run.ts";
import { UPDATE_RUN_SCHEMA } from "../update-run.ts";
import {
  FOLLOW_ATTEMPT_INTERVAL_MS,
  followDecision,
  followGuards,
  formatTurn,
  LEAD_RELEASE_HEADER,
  leadReleaseHeader,
  PackFollower,
  parseTurn,
  TURN_MISSED_SWEEPS,
  UPDATE_TURN_HEADER,
  UpdateTurns,
  UPSTREAM_CHECK_ID,
  type FollowFacts,
  type TurnMember,
} from "./follow.ts";
import { member as fixtureMember, neverProxy } from "./fixtures.ts";
import { PackLead } from "./lead.ts";
import { PackRegistry } from "./registry.ts";

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
  test("a settled release is stated, and X-Pack-Lead-Release is its bare version", () => {
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

  test("the two header names are the ones PACK_PROTOCOL registers", () => {
    expect(LEAD_RELEASE_HEADER).toBe("X-Pack-Lead-Release");
    expect(UPDATE_TURN_HEADER).toBe("X-Pack-Update-Turn");
  });
});

describe("the peer's guards", () => {
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
    record?: UpdateRun | null;
    start?: (a: { tag: string; runId: string }) => { ok: true } | { ok: false; reason: string };
  } = {}) => {
    const started: { tag: string; runId: string }[] = [];
    const f = new PackFollower({
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
    });
    return { f, started };
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
    const turns = new UpdateTurns();
    turns.begin(RUN_ID, "1.4.1");
    turns.observe(
      [member({ memberId: "attic", enrolledAt: 1 }), member({ memberId: "basement", enrolledAt: 2 })],
      NOW,
    );
    expect(turns.turnFor("attic")).toBe(`attic;${RUN_ID}`);
    expect(turns.turnFor("basement")).toBeNull();
  });

  test("the queue is in trust-store enrolment order, not member-id order", () => {
    const turns = new UpdateTurns();
    turns.begin(RUN_ID, "1.4.1");
    // `attic` sorts first alphabetically and joined LAST, so enrolment order must hand the turn to
    // `zeta`. This is the whole of why the ordering is stated rather than left incidental.
    turns.observe([member({ memberId: "attic", enrolledAt: 900 }), member({ memberId: "zeta", enrolledAt: 100 })], NOW);
    expect(turns.turnFor("zeta")).not.toBeNull();
    expect(turns.turnFor("attic")).toBeNull();
  });

  test("a member whose preflight is unknown or red is never handed a turn", () => {
    const turns = new UpdateTurns();
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
    const onVersion = new UpdateTurns();
    onVersion.begin(RUN_ID, "1.4.1");
    onVersion.observe([member({ memberId: "attic" }), member({ memberId: "basement", enrolledAt: 2 })], NOW);
    const releasedByVersion = onVersion.observe(
      [member({ memberId: "attic", version: "1.4.1" }), member({ memberId: "basement", enrolledAt: 2 })],
      NOW,
    );
    expect(releasedByVersion.released).toBe(true);
    expect(onVersion.turnFor("basement")).not.toBeNull();

    // (b) the member reports rolled-back.
    const onRollback = new UpdateTurns();
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
    const onMisses = new UpdateTurns();
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
    const turns = new UpdateTurns();
    turns.begin(RUN_ID, "1.4.1");
    expect(turns.observe([member({ memberId: "attic" })], NOW).released).toBe(false);
    expect(turns.observe([member({ memberId: "attic" })], NOW).released).toBe(false);
    expect(turns.observe([member({ memberId: "attic", version: "1.4.1" })], NOW).released).toBe(true);
  });

  test("a lead restart re-grants rather than resuming a persisted turn", () => {
    const before = new UpdateTurns();
    before.begin(RUN_ID, "1.4.1");
    before.observe([member({ memberId: "attic" }), member({ memberId: "basement", enrolledAt: 2 })], NOW);
    expect(before.turnFor("attic")).not.toBeNull();

    // A brand-new instance IS the restarted lead: nothing about the queue was on disk, so it holds
    // no turn until a sweep re-derives one, and a member already on the new version is not in it.
    const after = new UpdateTurns();
    expect(after.turnFor("attic")).toBeNull();
    after.begin(RUN_ID, "1.4.1");
    after.observe([member({ memberId: "attic", version: "1.4.1" }), member({ memberId: "basement", enrolledAt: 2 })], NOW);
    expect(after.turnFor("attic")).toBeNull();
    expect(after.turnFor("basement")).not.toBeNull();
  });

  test("it never steps a peer down: a member ahead of the target is done, never a candidate", () => {
    const turns = new UpdateTurns();
    turns.begin(RUN_ID, "1.4.1");
    turns.observe([member({ memberId: "attic", version: "1.5.0" })], NOW);
    // Nothing in the queue can express "go back to 1.4.1", so the member simply holds no turn. The
    // accepted gap: a lead rolled back by hand after peers advanced leaves the peers ahead, and the
    // remedy is `collie pack update <member>` from the lead, over the operator's own SSH.
    expect(turns.turnFor("attic")).toBeNull();
    expect(turns.peerLegs().find((l) => l.name === "attic")?.state).toBe("done");
  });

  test("no run means no turn and no legs — a lead that has confirmed nothing states nothing", () => {
    const turns = new UpdateTurns();
    expect(turns.observe([member({ memberId: "attic" })], NOW).released).toBe(false);
    expect(turns.peerLegs()).toEqual([]);
    expect(turns.turnFor("attic")).toBeNull();
    turns.begin(RUN_ID, "1.4.1");
    turns.observe([member({ memberId: "attic" })], NOW);
    turns.end();
    expect(turns.peerLegs()).toEqual([]);
    expect(turns.turnFor("attic")).toBeNull();
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
// wiring. This one drives a real `PackLead` instead, because the defect was entirely in the wiring:
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
    const turns = new UpdateTurns();
    const registry = new PackRegistry({ sessions: { get: () => undefined }, self: "desk", members: () => roster });
    const lead = new PackLead({
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
