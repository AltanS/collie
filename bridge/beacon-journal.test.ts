import { describe, expect, test } from "bun:test";
import { mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";

import { identityOf } from "./beacon/decorate.ts";
import { fakeBeaconReader, type FakeBeacon } from "./beacon/fake.ts";
import { readBeacons } from "./beacon/reader.ts";
import { BEACON_SCHEMA_VERSION, type BeaconMarker, type BeaconReading, type BeaconRecord } from "./beacon/types.ts";
import { adapterFor, buildJournalRegistry } from "./journal/registry.ts";
import { journalAgentOf } from "./types.ts";
import type { AgentView } from "./types.ts";
import type { AgentSessionRef, JournalAdapter } from "./journal/types.ts";

// WHERE A BEACON'S REF MEETS THE JOURNAL (M11/04). Nothing under `bridge/journal/` changes to make
// pane history work on tmux or zellij: the decorator (M11/03) fills `MuxPane.agentSession` from the
// beacon and the existing route, registry, adapter and containment run unmodified. That claim is only
// worth as much as its proof, so these tests walk the whole seam end to end — sweep a beacon
// directory, take the reading's identity, ask the registry for the adapter, and hand the adapter the
// ref — against REAL files, because containment is a question about symlinks and real paths and
// cannot be answered against a fake.
//
// WHICH IS WHY THIS FILE SITS HERE AND NOT UNDER `bridge/beacon/`. That directory's rule is that no
// filesystem call of any kind appears under it, and M11/04 greps for it rather than trusting it
// (`git grep -nE 'readFile|Bun.file|realpath' -- bridge/beacon` must be empty). A test needing real
// symlinks is a filesystem call, so it lives beside `beacon-io.ts` — the same split, for the same
// reason. `bun test bridge/beacon` still selects it: the filter matches the file path.
//
// Two rules are pinned here and they are the two a later change could break with no type error:
//
//  1. AN EXPIRED BEACON STILL YIELDS HISTORY. Expiry retires an IDENTITY — the status claim and the
//     agent label both go, and the pane reads as a shell again (M11/03) — but never the session ref.
//     A finished conversation is still on disk and still readable, so the ref and the harness that
//     wrote it travel on with the pane, server-side and invisible: `journalAgentOf` is what the
//     history route asks, and it is the only consumer.
//
//  2. A PATH-KIND REF IS CONFINED, WITH NO CARVE-OUT FOR "THE OPERATOR INSTALLED THE HOOK". Today's
//     Claude emitter writes `id` refs only, so the path case here is synthetic on purpose: it is the
//     rule for a FUTURE emitter that has no stable id (pi's existing shape), written down while the
//     seam is being built rather than when somebody needs it. Anything that can write into the beacon
//     directory is the threat model, so a beacon-supplied path has exactly pi's standing and reaches
//     the disk through `containedRealpathIn` or not at all.

const CLAUDE_SESSION = "0f9d1c2e-1111-4222-8333-444455556666";
const PI_SESSION = "019f4665-7df0-7540-a64f-7068335f21af";

const LIVE_PID = 4242;
const LIVE_PID_START = 1_000_000;

const TMUX_MARKER: BeaconMarker = { namespace: "tmux", scope: "/tmp/tmux-1000/default", pane: "%7" };

/** A well-formed beacon record. Only what a test varies is a parameter. */
function record(fields: {
  readonly harness?: string;
  readonly session?: AgentSessionRef;
  readonly pane?: string;
}): BeaconRecord {
  return {
    schemaVersion: BEACON_SCHEMA_VERSION,
    harness: fields.harness ?? "claude",
    // CLAUDE'S REF IS THE ID, AND THE ID IS STRICTLY STRONGER THAN A CONTAINMENT CHECK. An id is
    // pattern-validated and then used to BUILD a path inside a root Collie configured, so it can never
    // name a file outside one; a path can only be REJECTED once it already names one, by
    // `containedRealpathIn`. Both are safe and the id is safer, which is why the hook payload's
    // `transcript_path` is not in the schema at all (.adr/0024) — an unread attacker-chosen value is a
    // hazard waiting for a future consumer.
    session: fields.session ?? { kind: "id", value: CLAUDE_SESSION },
    status: "working",
    pid: LIVE_PID,
    pidStartTime: LIVE_PID_START,
    markers: [{ ...TMUX_MARKER, pane: fields.pane ?? TMUX_MARKER.pane }],
    heartbeatMs: 1_800_000_000_000 - 60_000,
  };
}

/** The reading a directory holding exactly these beacons produces, in key order. */
function sweep(beacons: readonly FakeBeacon[]): Promise<readonly BeaconReading[]> {
  return readBeacons(fakeBeaconReader(beacons));
}

/** The one reading a single-beacon sweep produced. Fails loudly rather than resolving to undefined. */
async function onlyReading(beacon: FakeBeacon): Promise<BeaconReading> {
  const readings = await sweep([beacon]);
  expect(readings).toHaveLength(1);
  // SAFETY: the length assertion above is the invariant — a one-beacon sweep has a first reading.
  return readings[0]!;
}

/**
 * What the history route would get for this beacon: the log its ref resolves to, and how many turns
 * parsed out of it.
 *
 * The three `null` returns are the three honest `no-session` causes the spec insists must stay
 * distinguishable, and they are distinguishable here by which step answered — a harness Collie will
 * not carry, a harness with no journal adapter, and a ref that resolves to nothing.
 */
async function historyFor(
  reading: BeaconReading,
  registry: Record<string, JournalAdapter>,
): Promise<{ path: string; turns: number } | null> {
  const identity = identityOf(reading);
  if (identity === null) return null;
  const adapter = adapterFor(registry, identity.agent);
  if (adapter === undefined) return null;
  const path = await adapter.source.resolve(identity.session);
  if (path === null) return null;
  const { text } = await adapter.source.load(path);
  return { path, turns: adapter.parse(text).length };
}

const claudeRow = (uuid: string, text: string) =>
  JSON.stringify({
    type: "user",
    uuid,
    timestamp: "2026-08-20T10:00:00.000Z",
    message: { role: "user", content: text },
  });

const piRows = (id: string, text: string) =>
  [
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-08-20T10:00:00.000Z", cwd: "/repo" }),
    JSON.stringify({
      type: "message",
      id: "m1",
      parentId: "p0",
      timestamp: "2026-08-20T10:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text }] },
    }),
  ].join("\n");

/**
 * Real roots on disk, plus a file no root may reach and a symlink into it.
 *
 *   base/claude/-var-home-you-repo/<CLAUDE_SESSION>.jsonl   the log a claude beacon's id names
 *   base/pi/-repo-/…_<PI_SESSION>.jsonl                     the log a pi beacon's path names
 *   base/outside/secrets.jsonl                              a file neither root may serve
 *   base/pi/-repo-/escape.jsonl → base/outside/secrets.jsonl  the escape containment must refuse
 */
async function fixture() {
  const created = `${tmpdir()}/collie-beacon-journal-${Math.floor(performance.now() * 1000)}`;
  await mkdir(created, { recursive: true });
  const base = await realpath(created);
  const claude = `${base}/claude`;
  const pi = `${base}/pi`;
  await mkdir(`${claude}/-var-home-you-repo`, { recursive: true });
  await mkdir(`${pi}/-repo-`, { recursive: true });
  await mkdir(`${base}/outside`, { recursive: true });
  await Bun.write(`${claude}/-var-home-you-repo/${CLAUDE_SESSION}.jsonl`, claudeRow(CLAUDE_SESSION, "hello"));
  const piLog = `${pi}/-repo-/2026-08-20T10-00-00-000Z_${PI_SESSION}.jsonl`;
  await Bun.write(piLog, piRows(PI_SESSION, "hello from pi"));
  await Bun.write(`${base}/outside/secrets.jsonl`, piRows(PI_SESSION, "not yours to read"));
  const escape = `${pi}/-repo-/escape.jsonl`;
  await symlink(`${base}/outside/secrets.jsonl`, escape);
  const registry = buildJournalRegistry({ claude: [claude], codex: [], pi: [pi], opencode: [], grok: [] });
  return { base, claude, pi, piLog, escape, outside: `${base}/outside/secrets.jsonl`, registry };
}

/** The pane a dead agent left behind, before its ref and harness are put back on it. */
function shellView(): AgentView {
  return {
    paneId: "%7",
    workspaceId: "$0",
    workspaceLabel: "repo",
    workspaceNumber: 1,
    tabId: "@0",
    agent: "shell",
    status: "unknown",
    cwd: "/var/home/you/repo",
    focused: false,
    kind: "shell",
  };
}

describe("a beacon's session ref, read by the journal registry", () => {
  // THE LOAD-BEARING TEST OF M11/04. Nothing in bridge/journal/ knows a beacon exists; the ref simply
  // arrives from a different place than Herdr's `agent_session` record and is read the same way.
  test("an EXPIRED beacon still yields history — the ref survives expiry", async () => {
    const fx = await fixture();
    const reading = await onlyReading({ record: record({}), alive: false });

    expect(reading.liveness).toBe("expired");
    // The status claim is gone with the process that made it; the session ref is not.
    expect(reading).not.toHaveProperty("status");
    expect(reading.session).toEqual({ kind: "id", value: CLAUDE_SESSION });

    const history = await historyFor(reading, fx.registry);
    expect(history?.path).toBe(`${fx.claude}/-var-home-you-repo/${CLAUDE_SESSION}.jsonl`);
    expect(history?.turns).toBe(1);
    await rm(fx.base, { recursive: true, force: true });
  });

  // A live beacon and an expired one differ in exactly one field, and it is not the one history uses.
  test("a live beacon and an expired one resolve to the same log", async () => {
    const fx = await fixture();
    const live = await historyFor(await onlyReading({ record: record({}) }), fx.registry);
    const dead = await historyFor(await onlyReading({ record: record({}), alive: false }), fx.registry);
    expect(live).toEqual(dead);
    expect(live?.turns).toBe(1);
    await rm(fx.base, { recursive: true, force: true });
  });

  // WHAT THE HISTORY ROUTE ACTUALLY ASKS, for the pane whose agent has ended. That pane reads as a
  // shell (M11/03) — no agent name on it at all — so the route keys the registry off the harness the
  // decorator kept beside the ref. Reading `agent` here would answer "shell", find no adapter, and
  // turn every finished conversation into `no-session` the moment its process exited.
  test("a dead agent's pane is a shell, and its transcript is still reachable", async () => {
    const fx = await fixture();
    const reading = await onlyReading({ record: record({}), alive: false });
    const identity = identityOf(reading);
    // The pane the decorator produced: a shell to the operator, a lookup key underneath.
    expect(identity).not.toBeNull();
    // SAFETY: the assertion above is the invariant — a `claude` beacon always names an identity.
    const named = identity!;
    const pane: AgentView = { ...shellView(), agentSession: named.session, sessionAgent: named.agent };
    expect(journalAgentOf(pane)).toBe("claude");
    const adapter = adapterFor(fx.registry, journalAgentOf(pane));
    expect(await adapter?.source.resolve(named.session)).toBe(
      `${fx.claude}/-var-home-you-repo/${CLAUDE_SESSION}.jsonl`,
    );
    await rm(fx.base, { recursive: true, force: true });
  });

  // A LIVE pane is unchanged by that rule: it carries no `sessionAgent`, so the key is its own agent.
  test("a live pane keys its journal off its own agent, exactly as before", () => {
    expect(journalAgentOf({ ...shellView(), agent: "claude", kind: "agent" })).toBe("claude");
  });

  // The second of the three `no-session` causes: a harness registered for identity and not for
  // history. It is not an error and it must not read like one.
  test("a beacon harness with no journal adapter is an ordinary no-session", async () => {
    const fx = await fixture();
    const reading = await onlyReading({ record: record({ harness: "amp" }) });
    expect(identityOf(reading)?.agent).toBe("amp");
    expect(adapterFor(fx.registry, "amp")).toBeUndefined();
    expect(await historyFor(reading, fx.registry)).toBeNull();
    await rm(fx.base, { recursive: true, force: true });
  });

  // The third: the beacon is fine, the log is gone. Same answer, and still not an error.
  test("a beacon naming a session whose log was deleted is an ordinary no-session", async () => {
    const fx = await fixture();
    const gone: AgentSessionRef = { kind: "id", value: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" };
    const reading = await onlyReading({ record: record({ session: gone }) });
    expect(await historyFor(reading, fx.registry)).toBeNull();
    await rm(fx.base, { recursive: true, force: true });
  });
});

// A path-kind beacon ref gets pi's standing and pi's containment — `containedRealpathIn`, per root,
// after symlink resolution — because there is no third branch to give it anything else. These tests
// are the guard against one being added: a future emitter with no stable id changes which harness
// writes a path, never what a path is allowed to reach.
describe("containment confines a path-kind beacon ref, per root, after symlink resolution", () => {
  test("containment serves a path-kind ref that really lives inside its root", async () => {
    const fx = await fixture();
    const reading = await onlyReading({
      record: record({ harness: "pi", session: { kind: "path", value: fx.piLog } }),
    });
    const history = await historyFor(reading, fx.registry);
    expect(history?.path).toBe(fx.piLog);
    expect(history?.turns).toBe(1);
    await rm(fx.base, { recursive: true, force: true });
  });

  test("containment refuses a path-kind ref that symlinks out of its root", async () => {
    const fx = await fixture();
    const reading = await onlyReading({
      record: record({ harness: "pi", session: { kind: "path", value: fx.escape } }),
    });
    // The name sits inside the root and the file it names does not. Only realpath containment can
    // tell the two apart, and the honest answer is the same one an absent log gets.
    expect(await historyFor(reading, fx.registry)).toBeNull();
    await rm(fx.base, { recursive: true, force: true });
  });

  test("containment refuses a path-kind ref naming a file outside every root", async () => {
    const fx = await fixture();
    const reading = await onlyReading({
      record: record({ harness: "pi", session: { kind: "path", value: fx.outside } }),
    });
    expect(await historyFor(reading, fx.registry)).toBeNull();
    await rm(fx.base, { recursive: true, force: true });
  });

  // Traversal is the same question asked with `..` instead of a symlink, and it gets the same answer
  // from the same check — no extra branch, no string sanitising of the value on the way in.
  test("containment refuses a path-kind ref that traverses out with ..", async () => {
    const fx = await fixture();
    const traversal = `${fx.pi}/-repo-/../../outside/secrets.jsonl`;
    const reading = await onlyReading({
      record: record({ harness: "pi", session: { kind: "path", value: traversal } }),
    });
    expect(await historyFor(reading, fx.registry)).toBeNull();
    await rm(fx.base, { recursive: true, force: true });
  });

  // An EXPIRED path-kind beacon is confined exactly as a live one is: expiry is not a trust event in
  // either direction, and "the operator installed the hook" is not one at all.
  test("containment applies to an expired path-kind ref too", async () => {
    const fx = await fixture();
    const reading = await onlyReading({
      record: record({ harness: "pi", session: { kind: "path", value: fx.escape } }),
      alive: false,
    });
    expect(reading.liveness).toBe("expired");
    expect(await historyFor(reading, fx.registry)).toBeNull();
    await rm(fx.base, { recursive: true, force: true });
  });
});
