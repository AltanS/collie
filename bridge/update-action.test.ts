import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  firstRed,
  FreshPreflightGate,
  mergedUpdateVerdict,
  PACK_PREFLIGHT_MAX_CHECKS,
  PACK_PREFLIGHT_TRUNCATED_ID,
  packPreflightChecks,
  packUpdateRows,
  parsePeerPreflight,
  parsePreflightReport,
  parseUpdateStartRequest,
  peerPreflightWire,
  PreflightCache,
  preflightCommand,
  PREFLIGHT_TTL_MS,
  updateCadenceTick,
  updateStartCommand,
  updateStartVerdict,
  type PreflightCheck,
  type PreflightReport,
  type UpdateStartRequest,
  type UpdateStartState,
  worstVerdict,
} from "./update-action.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import type { UpdateRun, UpdateRunState } from "./update-run.ts";

// `POST /api/update`, decided (bridge/update-action.ts). The handler itself lives inside `Bun.serve`
// and cannot be stood up under `bun test` (CLAUDE.md), so every refusal it can make is decided by
// the pure verdict below and asserted here. The GATE is not one of them — it is the pane path's own
// closure, and `server.test.ts` proves the two share it.

const REPORT = (verdict: "green" | "amber" | "red", checks: PreflightReport["checks"]): PreflightReport => ({
  schema: 1,
  verdict,
  checks,
});

const GREEN = REPORT("green", [{ id: "disk", verdict: "green", reason: "4.2 GB free" }]);

const runAt = (state: UpdateRunState): UpdateRun => ({
  schema: 1,
  state,
  from: "1.3.0",
  to: "1.4.0",
  startedAt: 1_000,
  updatedAt: 2_000,
  pid: 4242,
  attempt: 0,
});

const state = (over: Partial<UpdateStartState> = {}): UpdateStartState => ({
  current: "1.3.0",
  latest: "1.4.0",
  majorAvailable: null,
  run: null,
  lockHeld: false,
  preflight: GREEN,
  ...over,
});

/** A parsed request, built the way the route builds one: through the parser, off a JSON body. */
const ask = (over: JsonObject = {}): UpdateStartRequest => {
  const parsed = parseUpdateStartRequest({ confirm: true, ...over });
  // SAFETY: every body composed here is an object literal, and `parseUpdateStartRequest` returns
  // null for exactly one input — a body that is not an object.
  return parsed as UpdateStartRequest;
};

describe("the update preflight report, as the bridge reads it", () => {
  test("a schema-1 report parses to its verdict and checks", () => {
    const text = JSON.stringify({
      schema: 1,
      verdict: "amber",
      checks: [
        { id: "bun", verdict: "amber", reason: "Bun 1.1.0 is older than measured", remedy: "bun upgrade" },
        { id: "disk", verdict: "green", reason: "4.2 GB free" },
      ],
    });
    const report = parsePreflightReport(text);
    expect(report?.verdict).toBe("amber");
    expect(report?.checks).toHaveLength(2);
    expect(report?.checks[0]?.remedy).toBe("bun upgrade");
    // A check with no remedy carries no such key at all, never an undefined one.
    expect("remedy" in (report?.checks[1] ?? {})).toBe(false);
  });

  test("noise around the document does not lose it — a warning on stdout is not a failure", () => {
    const report = parsePreflightReport(`warning: something\n${JSON.stringify(GREEN)}\n`);
    expect(report?.verdict).toBe("green");
  });

  test("a report from an unknown schema is declined, not half-read", () => {
    expect(parsePreflightReport(JSON.stringify({ ...GREEN, schema: 2 }))).toBeNull();
  });

  test("garbage, an empty string and a non-object all read as no report", () => {
    expect(parsePreflightReport("")).toBeNull();
    expect(parsePreflightReport("not json at all")).toBeNull();
    expect(parsePreflightReport("[]")).toBeNull();
  });

  test("a report carrying `pack` loses the members AND their contribution to the verdict", () => {
    const text = JSON.stringify({
      schema: 1,
      // Red because of a peer this lead cannot ssh to, which is not a reason to refuse the lead's
      // own update — and would show as a red card with no red row.
      verdict: "red",
      checks: [
        { id: "disk", verdict: "green", reason: "4.2 GB free" },
        { id: "bun", verdict: "amber", reason: "Bun 1.1.0 is older than measured" },
      ],
      pack: [{ memberId: "nas", host: "nas.local", verdict: "red", checks: [] }],
    });
    const report = parsePreflightReport(text);
    expect(report?.verdict).toBe("amber");
    expect(report?.checks.map((c) => c.id)).toEqual(["disk", "bun"]);
    expect("pack" in (report ?? {})).toBe(false);
  });

  test("without `pack` the top-level verdict is taken as printed", () => {
    const text = JSON.stringify({
      schema: 1,
      verdict: "red",
      checks: [{ id: "disk", verdict: "green", reason: "4.2 GB free" }],
    });
    expect(parsePreflightReport(text)?.verdict).toBe("red");
  });

  test("worstVerdict is the summary rule", () => {
    expect(worstVerdict([])).toBe("green");
    expect(worstVerdict(["green", "amber"])).toBe("amber");
    expect(worstVerdict(["amber", "red", "green"])).toBe("red");
  });

  test("firstRed names the check, so a refusal is never a generic 'unavailable'", () => {
    const red = REPORT("red", [
      { id: "disk", verdict: "green", reason: "4.2 GB free" },
      { id: "tree", verdict: "red", reason: "2 tracked files are modified", remedy: "git stash" },
    ]);
    expect(firstRed(red)?.id).toBe("tree");
    expect(firstRed(GREEN)).toBeNull();
  });
});

describe("PreflightCache — one subprocess a minute at most", () => {
  test("the report is cached inside the TTL and re-run past it", async () => {
    let runs = 0;
    let now = 0;
    const cache = new PreflightCache({
      now: () => now,
      ttlMs: 60_000,
      run: async () => {
        runs += 1;
        return { stdout: JSON.stringify(GREEN) };
      },
    });
    expect((await cache.get())?.verdict).toBe("green");
    now = 30_000;
    await cache.get();
    expect(runs).toBe(1);
    now = 120_000;
    await cache.get();
    expect(runs).toBe(2);
  });

  test("`force` re-runs it now — what the update route does before it starts anything", async () => {
    let runs = 0;
    const cache = new PreflightCache({
      now: () => 0,
      run: async () => {
        runs += 1;
        return { stdout: JSON.stringify(GREEN) };
      },
    });
    await cache.get();
    await cache.get(true);
    expect(runs).toBe(2);
  });

  test("two callers landing together await the SAME run, never two subprocesses", async () => {
    let runs = 0;
    const cache = new PreflightCache({
      now: () => 0,
      run: async () => {
        runs += 1;
        await Promise.resolve();
        return { stdout: JSON.stringify(GREEN) };
      },
    });
    await Promise.all([cache.get(true), cache.get(true)]);
    expect(runs).toBe(1);
  });

  test("a subprocess that could not run answers no report — never 'nothing is red'", async () => {
    const cache = new PreflightCache({
      now: () => 0,
      run: () => Promise.reject(new Error("ENOENT")),
    });
    expect(await cache.get()).toBeNull();
  });
});

describe("POST api/update — the update write gate's verdict", () => {
  test("a body without a confirm starts nothing", () => {
    const v = updateStartVerdict(ask({ confirm: false }), state());
    expect(v).toMatchObject({ kind: "refuse", status: 400 });
  });

  test("a body that is not an object at all is refused before anything is read", () => {
    expect(parseUpdateStartRequest("yes")).toBeNull();
    expect(parseUpdateStartRequest(null)).toBeNull();
    expect(parseUpdateStartRequest([])).toBeNull();
  });

  test("a double tap is refused by the run in flight, naming it — never a second updater", () => {
    const v = updateStartVerdict(ask(), state({ run: runAt("staging") }));
    expect(v).toEqual({
      kind: "refuse",
      status: 409,
      body: {
        error: "an update is already running (staging); nothing was started",
        code: "update.in_progress",
        detail: { state: "staging" },
      },
    });
  });

  test("a double tap is refused by the LOCK even before a record exists", () => {
    const v = updateStartVerdict(ask(), state({ run: null, lockHeld: true }));
    expect(v).toMatchObject({ kind: "refuse", status: 409, body: { code: "update.in_progress" } });
  });

  test("a finished run does not block the next one", () => {
    expect(updateStartVerdict(ask(), state({ run: runAt("done") })).kind).toBe("start");
    expect(updateStartVerdict(ask(), state({ run: runAt("rolled-back") })).kind).toBe("start");
  });

  test("update preflight red refuses with the red check's own id and reason", () => {
    const red = REPORT("red", [{ id: "tree", verdict: "red", reason: "2 tracked files are modified" }]);
    const v = updateStartVerdict(ask(), state({ preflight: red }));
    expect(v).toEqual({
      kind: "refuse",
      status: 412,
      body: {
        error: "preflight is red on tree: 2 tracked files are modified",
        code: "update.preflight_red",
        detail: { check: "tree", reason: "2 tracked files are modified" },
      },
    });
  });

  test("update preflight amber proceeds — amber is 'you should know', not a gate", () => {
    const amber = REPORT("amber", [{ id: "bun", verdict: "amber", reason: "older Bun than measured" }]);
    expect(updateStartVerdict(ask(), state({ preflight: amber })).kind).toBe("start");
  });

  test("a preflight that could not be produced refuses too", () => {
    const v = updateStartVerdict(ask(), state({ preflight: null }));
    expect(v).toMatchObject({ kind: "refuse", status: 503, body: { code: "update.preflight_unavailable" } });
  });

  test("a version mismatch between the card and this collie is refused", () => {
    const v = updateStartVerdict(ask({ target: "1.3.9" }), state({ latest: "1.4.0" }));
    expect(v).toEqual({
      kind: "refuse",
      status: 409,
      body: {
        error: "this device asked for 1.3.9, but this collie would install 1.4.0",
        code: "update.target_mismatch",
        detail: { asked: "1.3.9", would: "1.4.0" },
      },
    });
  });

  test("the target the operator actually read is accepted", () => {
    expect(updateStartVerdict(ask({ target: "1.4.0" }), state())).toEqual({
      kind: "start",
      to: "1.4.0",
      major: false,
    });
  });

  test("a major confirm is required for the crossing, and its own words say so", () => {
    const v = updateStartVerdict(ask({ target: "2.0.0" }), state({ majorAvailable: "2.0.0" }));
    expect(v).toEqual({
      kind: "refuse",
      status: 412,
      body: {
        error: "2.0.0 crosses a major — a major crossing needs its own confirm",
        code: "update.major_confirm_required",
        detail: { version: "2.0.0" },
      },
    });
  });

  test("with `major: true` the crossing is taken, and it is the MAJOR that is installed", () => {
    const v = updateStartVerdict(
      ask({ target: "2.0.0", major: true }),
      state({ latest: "1.4.0", majorAvailable: "2.0.0" }),
    );
    expect(v).toEqual({ kind: "start", to: "2.0.0", major: true });
  });

  test("`major: true` with no major out refuses rather than quietly taking the routine release", () => {
    const v = updateStartVerdict(ask({ major: true }), state({ majorAvailable: null }));
    expect(v).toMatchObject({ kind: "refuse", status: 409, body: { code: "update.none_available" } });
  });

  test("nothing newer to take is a refusal, not a no-op start", () => {
    expect(updateStartVerdict(ask(), state({ latest: "1.3.0" }))).toMatchObject({
      kind: "refuse",
      body: { code: "update.none_available" },
    });
    expect(updateStartVerdict(ask(), state({ latest: null }))).toMatchObject({
      kind: "refuse",
      body: { code: "update.none_available" },
    });
  });
});

describe("update hands off — the command that leaves this process's cgroup", () => {
  const base = { platform: "linux", binary: "/opt/collie/bin/collie", stamp: "42" };

  test("systemd-run --user --collect on a Linux host that has it", () => {
    expect(updateStartCommand({ ...base, major: false, hasSystemdRun: true, hasSetsid: true })).toEqual([
      "systemd-run",
      "--user",
      "--collect",
      "--unit",
      "collie-api-update-42",
      "/opt/collie/bin/collie",
      "update",
    ]);
  });

  test("a major crossing hands the CLI its own consent flag (ADR 0020)", () => {
    const cmd = updateStartCommand({ ...base, major: true, hasSystemdRun: true, hasSetsid: true });
    expect(cmd.slice(-2)).toEqual(["update", "--major"]);
  });

  test("setsid where there is no user manager, and a bare spawn where there is neither", () => {
    expect(updateStartCommand({ ...base, platform: "darwin", major: false, hasSystemdRun: false, hasSetsid: true })).toEqual(
      ["setsid", "/opt/collie/bin/collie", "update"],
    );
    expect(updateStartCommand({ ...base, major: false, hasSystemdRun: false, hasSetsid: false })).toEqual([
      "/opt/collie/bin/collie",
      "update",
    ]);
  });

  test("it is `collie update` and nothing else — the operator's own verb, not a second recipe", () => {
    const cmd = updateStartCommand({ ...base, major: false, hasSystemdRun: false, hasSetsid: false });
    expect(cmd).toEqual(["/opt/collie/bin/collie", "update"]);
  });
});

describe("the preflight the phone runs", () => {
  test("the argv carries --local, so a peer never refuses the lead's own update (ADR 0016)", () => {
    expect(preflightCommand("/opt/collie/bin/collie")).toEqual([
      "/opt/collie/bin/collie",
      "update",
      "--check",
      "--local",
      "--json",
    ]);
  });
});

// ── The pack's half (M16/03) ─────────────────────────────────────────────────
// Every peer answers for ITSELF over the link the lead already polls, the lead banks the answer, and
// the card reads the bank. Nothing below dials anything; that is the point of it being here.

const CHECK = (id: string, verdict: "green" | "amber" | "red", reason: string): PreflightCheck => ({
  id,
  verdict,
  reason,
});

/** A peer's snapshot answer, with §19's field riding beside the body — the shape the lead reads. */
const wire = (over: JsonObject = {}): JsonValue => ({
  bridge: "connected",
  updatePreflight: {
    verdict: "green",
    asOf: 1_757_000_000_000,
    checks: [{ id: "tree", verdict: "green", reason: "working tree is clean" }],
    ...over,
  },
});

/** The same checks as plain JSON — what a member would actually put on the wire. */
const asJson = (checks: readonly PreflightCheck[]): JsonValue =>
  checks.map((c) => ({ id: c.id, verdict: c.verdict, reason: c.reason }));

describe("a member's own preflight, as it crosses the link", () => {
  test("updatePreflight is read off the answer the snapshot rode on, verdict and asOf and all", () => {
    expect(parsePeerPreflight(wire())).toEqual({
      verdict: "green",
      asOf: 1_757_000_000_000,
      checks: [{ id: "tree", verdict: "green", reason: "working tree is clean" }],
    });
  });

  test("absent preflight is unknown, never green — and so is every shape this build cannot read", () => {
    // The whole of §7.1's absent-means-closed, case by case. Each of these is a member that has told
    // us nothing, and "nothing" may never be rendered as "nothing is wrong".
    const closed: JsonValue[] = [
      { bridge: "connected" },
      { updatePreflight: null },
      wire({ verdict: "blue" }),
      wire({ asOf: 0 }),
      wire({ asOf: "yesterday" }),
      wire({ checks: "none" }),
      wire({ checks: [{ id: "tree", verdict: "green" }] }),
    ];
    for (const value of closed) expect(parsePeerPreflight(value)).toBeNull();
    // And the row it produces blocks by name rather than passing as green.
    const rows = packUpdateRows([{ name: "attic", version: "1.4.0", preflight: null }]);
    expect(rows).toEqual([
      { name: "attic", version: "1.4.0", verdict: "unknown", reasons: ["we could not check attic"], asOf: null },
    ]);
    expect(mergedUpdateVerdict(GREEN, rows).blocks).toBe(true);
  });

  test("the emitted report carries the peer's own verdict whole and drops the remedy", () => {
    const report = REPORT("red", [
      CHECK("tree", "red", "working tree has tracked changes: bridge/server.ts"),
      { id: "disk", verdict: "green", reason: "4.2 GB free", remedy: "make space" },
    ]);
    expect(peerPreflightWire(report, 1_757_000_000_000)).toEqual({
      verdict: "red",
      asOf: 1_757_000_000_000,
      checks: [
        { id: "tree", verdict: "red", reason: "working tree has tracked changes: bridge/server.ts" },
        { id: "disk", verdict: "green", reason: "4.2 GB free" },
      ],
    });
    // Nothing to publish is nothing published — which the other side reads as unknown.
    expect(peerPreflightWire(null, 1_757_000_000_000)).toBeNull();
    expect(peerPreflightWire(report, null)).toBeNull();
  });

  test("the check list is capped at 16, truncation is stated, and it can never change a verdict", () => {
    const many = [
      CHECK("tree", "red", "working tree has tracked changes"),
      ...Array.from({ length: 30 }, (_, i) => CHECK(`c${i}`, "green", `check ${i} passed`)),
    ];
    const capped = packPreflightChecks(many);
    expect(capped).toHaveLength(PACK_PREFLIGHT_MAX_CHECKS);
    // Worst first, so the red that DECIDED the verdict is the last thing truncation would drop.
    expect(capped[0]!.id).toBe("tree");
    const last = capped.at(-1)!;
    expect(last.id).toBe(PACK_PREFLIGHT_TRUNCATED_ID);
    expect(last.verdict).toBe("green");
    expect(last.reason).toContain("16 further checks");
    // The trailing check states a fact; it does not invent a finding.
    expect(worstVerdict(capped.map((c) => c.verdict))).toBe("red");
    // The lead caps what it READS too — a bound one side enforces is one the other can dodge.
    const long = wire({ verdict: "red", asOf: 5, checks: asJson(many) });
    expect(parsePeerPreflight(long)!.checks).toHaveLength(PACK_PREFLIGHT_MAX_CHECKS);
    expect(parsePeerPreflight(long)!.verdict).toBe("red");
  });
});

describe("pack rows — what GET /api/update/check answers with", () => {
  test("pack rows carry name, version, verdict, non-green reasons worst first, and asOf", () => {
    const rows = packUpdateRows([
      {
        name: "minibuch",
        version: "1.4.1",
        preflight: { verdict: "green", asOf: 1_757_000_000_000, checks: [CHECK("tree", "green", "clean")] },
      },
      {
        name: "attic",
        version: "1.4.0",
        preflight: {
          verdict: "red",
          asOf: 1_756_978_000_000,
          checks: [
            CHECK("disk", "green", "4.2 GB free"),
            CHECK("ops", "amber", "no ssh record"),
            CHECK("tree", "red", "working tree has tracked changes: bridge/server.ts"),
          ],
        },
      },
    ]);
    expect(rows).toEqual([
      { name: "minibuch", version: "1.4.1", verdict: "green", reasons: [], asOf: 1_757_000_000_000 },
      {
        name: "attic",
        version: "1.4.0",
        verdict: "red",
        reasons: ["working tree has tracked changes: bridge/server.ts", "no ssh record"],
        asOf: 1_756_978_000_000,
      },
    ]);
  });

  test("pack rows are empty for an empty pack — the key is a fact, never an omission", () => {
    expect(packUpdateRows([])).toEqual([]);
  });
});

describe("the merged verdict — one function, three surfaces", () => {
  test("merged verdict names the member that produced it, and the reason it gave", () => {
    const pack = packUpdateRows([
      {
        name: "attic",
        version: "1.4.0",
        preflight: {
          verdict: "red",
          asOf: 5,
          checks: [CHECK("tree", "red", "working tree has tracked changes: bridge/server.ts")],
        },
      },
    ]);
    expect(mergedUpdateVerdict(GREEN, pack)).toEqual({
      verdict: "red",
      member: "attic",
      reason: "working tree has tracked changes: bridge/server.ts",
      blocks: true,
    });
    // The lead's own red is named the same way, and it is read first.
    const leadRed = REPORT("red", [CHECK("lock", "red", "an update is already running here")]);
    expect(mergedUpdateVerdict(leadRed, pack)).toEqual({
      verdict: "red",
      member: "this collie",
      reason: "an update is already running here",
      blocks: true,
    });
  });

  test("unknown beats amber and blocks; amber never blocks; all green names nobody", () => {
    const amber = packUpdateRows([
      {
        name: "nas",
        version: "1.4.1",
        preflight: { verdict: "amber", asOf: 5, checks: [CHECK("ops", "amber", "no ssh record")] },
      },
    ]);
    const unknown = packUpdateRows([{ name: "attic", version: null, preflight: null }]);
    expect(mergedUpdateVerdict(GREEN, amber)).toEqual({
      verdict: "amber",
      member: "nas",
      reason: "no ssh record",
      blocks: false,
    });
    expect(mergedUpdateVerdict(GREEN, [...amber, ...unknown])).toEqual({
      verdict: "unknown",
      member: "attic",
      reason: "we could not check attic",
      blocks: true,
    });
    expect(mergedUpdateVerdict(GREEN, [])).toEqual({ verdict: "green", member: null, reason: null, blocks: false });
    // A lead whose own preflight could not run is unknown too, by its own name.
    expect(mergedUpdateVerdict(null, [])).toEqual({
      verdict: "unknown",
      member: "this collie",
      reason: "we could not check this collie",
      blocks: true,
    });
  });
});

describe("the fresh-preflight request, across the link", () => {
  test("the fresh header is honoured at most once per TTL per member", () => {
    let now = 10_000;
    const gate = new FreshPreflightGate({ now: () => now });
    expect(gate.admit()).toBe(true);
    // A phone sitting on the page polls every couple of seconds. None of those may shell out.
    now += 1_000;
    expect(gate.admit()).toBe(false);
    now += PREFLIGHT_TTL_MS - 1_001;
    expect(gate.admit()).toBe(false);
    now += 1;
    expect(gate.admit()).toBe(true);
  });

  test("peer preflight cadence: a peer refreshes on the monitor's tick, and nothing else does", () => {
    const calls: string[] = [];
    const tick = (isPeer: boolean) =>
      updateCadenceTick({
        isPeer,
        checkRelease: () => calls.push("release"),
        refreshPreflight: () => calls.push("preflight"),
      });
    tick(true);
    expect(calls).toEqual(["release", "preflight"]);
    calls.length = 0;
    // A lead and a solo instance run the card's own read and nothing extra.
    tick(false);
    expect(calls).toEqual(["release"]);
  });

  test("peer preflight cadence: no third timer — it rides the monitor's own two", () => {
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    // The two numbers are the monitor's, and the tick is the ONE place the refresh hangs off them.
    expect(src).toContain("const updateFirstCheck = setTimeout(updateTick, UPDATE_FIRST_DELAY_MS);");
    expect(src).toContain("const updateTimer = setInterval(updateTick, UPDATE_INTERVAL_MS);");
    expect([...src.matchAll(/updateCadenceTick\(/g)]).toHaveLength(1);
  });

  test("the pack read peeks; it never shells out mid-sweep", async () => {
    let runs = 0;
    let now = 1_000;
    const cache = new PreflightCache({
      now: () => now,
      run: async () => {
        runs += 1;
        return { stdout: JSON.stringify(GREEN) };
      },
    });
    // Nothing has run: "no report", which the other side reads as unknown.
    expect(cache.peek()).toBeNull();
    expect(runs).toBe(0);
    await cache.get();
    expect(cache.peek()).toEqual({ report: GREEN, at: 1_000 });
    now = 99_000;
    // A stale entry stays readable and stays HONEST about its age — never re-run on the pack path.
    expect(cache.peek()).toEqual({ report: GREEN, at: 1_000 });
    expect(runs).toBe(1);
  });
});
