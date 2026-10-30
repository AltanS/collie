import { describe, expect, test } from "bun:test";

import { CREW_PROTOCOL_VERSION } from "../bridge/crew/enrollment.ts";
import { leadStore, member, peerStore } from "../bridge/crew/fixtures.ts";
import { serializeTrustStore } from "../bridge/crew/trust-store.ts";
import { countSessions, gatherCensus, type CensusInput } from "./census.ts";
import { context, fakeFiles, STATE } from "./fakes.ts";

// The census `collie status` prints under its head, gathered from fakes: a fake crew dial (the `hello`
// each member answers), a fake bridge snapshot, and a fake devices file. Nothing here dials anything.

const TRUST = `${STATE}/crew-trust.json`;
const DEVICES = `${STATE}/paired-devices.json`;
const SECRET_FILE = `${STATE}/local-secret`;
const SECRET = "A".repeat(43);

const device = (label: string) => ({ label, tokenHash: "0".repeat(64), createdAt: 1, lastSeenAt: 2 });

interface AgentRow {
  paneId: string;
  agent: string;
  kind: string;
  status: string;
  hasSession?: boolean;
}

function agent(status: string, hasSession: boolean, kind = "agent"): AgentRow {
  const row: AgentRow = { paneId: `p-${status}-${String(hasSession)}`, agent: "claude", kind, status };
  // `hasSession` is absent on the wire rather than false, which is the state the block counts.
  if (hasSession) row.hasSession = true;
  return row;
}

const SNAPSHOT = JSON.stringify({
  bridge: "connected",
  agents: [
    agent("working", true),
    agent("working", false),
    agent("blocked", true),
    agent("idle", true),
    agent("done", false),
    agent("some-future-state", false),
    // A shell pane is not an agent session.
    agent("idle", false, "shell"),
  ],
});

interface Seen {
  url: string;
  headers: Record<string, string>;
}

interface Rig {
  deps: Parameters<typeof gatherCensus>[0];
  seen: Seen[];
}

type Answer = Response | Error;

/**
 * `answers` maps a URL fragment to the reply: a member's `hello`, or this bridge's `/api/snapshot`.
 * A URL nobody scripted fails the way a closed port does.
 */
function rig(files: Record<string, string>, answers: Record<string, Answer>): Rig {
  const seen: Seen[] = [];
  const deps: Rig["deps"] = {
    // A budget no test can outrun: the fake resolves at once, and a real timer must never misfire.
    ctx: context({ COLLIE_CREW_TIMEOUT_MS: "60000" }, { stateDir: STATE, port: 8788 }),
    files: fakeFiles(files),
    now: () => 1_754_000_000_000,
    fetch: async (url, init) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => {
        headers[k] = v;
      });
      seen.push({ url, headers });
      const key = Object.keys(answers).find((k) => url.includes(k));
      const answer = key === undefined ? undefined : answers[key];
      if (answer === undefined) throw new Error("connection refused");
      if (answer instanceof Error) throw answer;
      return answer.clone();
    },
  };
  return { deps, seen };
}

const hello = (memberId: string, version: string): Response =>
  new Response(JSON.stringify({ protocol: CREW_PROTOCOL_VERSION, member: memberId, version }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-crew-protocol": String(CREW_PROTOCOL_VERSION),
      "x-crew-member": memberId,
    },
  });

const snapshot = (body = SNAPSHOT): Response => new Response(body, { status: 200 });

const RUNNING_LEAD: CensusInput = { running: true, crew: "lead" };
const lead = (...peers: string[]): string =>
  serializeTrustStore(leadStore({ peers: peers.map((memberId) => member({ memberId })) }));

describe("members", () => {
  test("one row per member, from the same hello dial crew status makes", async () => {
    const r = rig(
      { [TRUST]: lead("minibuch", "minibuch-hc") },
      {
        "minibuch.example": hello("minibuch", "1.25.0"),
        "minibuch-hc.example": new Error("timed out"),
        "/api/snapshot": snapshot(),
      },
    );
    const census = await gatherCensus(r.deps, RUNNING_LEAD);
    expect(census.members).toEqual([
      { name: "minibuch", role: "peer", link: "reachable", version: "1.25.0", mux: null, panes: null },
      { name: "minibuch-hc", role: "peer", link: "unreachable", version: null, mux: null, panes: null },
    ]);
    // `hello` only: the second question of `crew status` (a snapshot read per member) is not asked.
    expect(r.seen.filter((s) => s.url.includes("/crew/v1/")).map((s) => s.url)).toEqual([
      "https://minibuch.example:8787/crew/v1/hello",
      "https://minibuch-hc.example:8787/crew/v1/hello",
    ]);
  });

  test("a member that never answers shows unreachable and the other blocks still fill", async () => {
    const r = rig({ [TRUST]: lead("nas"), [DEVICES]: JSON.stringify({ devices: [device("Pixel")] }) }, { "/api/snapshot": snapshot() });
    const census = await gatherCensus(r.deps, RUNNING_LEAD);
    expect(census.members.map((m) => [m.name, m.link])).toEqual([["nas", "unreachable"]]);
    expect(census.devices.count).toBe(1);
    expect(census.sessions.read).toBe("ok");
  });

  test("a peer lists its lead, and an unenrolled member is not dialled", async () => {
    const peer = rig({ [TRUST]: serializeTrustStore(peerStore()) }, { "desk.example": hello("desk", "1.25.0") });
    const fromPeer = await gatherCensus(peer.deps, { running: false, crew: "peer" });
    expect(fromPeer.members.map((m) => [m.name, m.role, m.link])).toEqual([["desk", "lead", "reachable"]]);

    const gone = rig(
      { [TRUST]: serializeTrustStore(leadStore({ peers: [member({ memberId: "nas" }), member({ memberId: "old", status: "unenrolled" })] })) },
      { "nas.example": hello("nas", "1.25.0") },
    );
    const census = await gatherCensus(gone.deps, RUNNING_LEAD);
    expect(census.members.map((m) => [m.name, m.link])).toEqual([
      ["nas", "reachable"],
      ["old", "unenrolled"],
    ]);
    expect(gone.seen.filter((s) => s.url.includes("old.example"))).toEqual([]);
  });

  test("a solo install has no members", async () => {
    const r = rig({}, { "/api/snapshot": snapshot() });
    expect((await gatherCensus(r.deps, { running: true, crew: "solo" })).members).toEqual([]);
    expect(r.seen.some((s) => s.url.includes("/crew/v1/"))).toBe(false);
  });
});

describe("devices", () => {
  test("the count and the labels, off the same registry the pairedDevices count reads", async () => {
    const files = { [DEVICES]: JSON.stringify({ devices: [device("Pixel"), device("iPad")] }) };
    const census = await gatherCensus(rig(files, {}).deps, { running: false, crew: "solo" });
    expect(census.devices).toEqual({ count: 2, names: ["Pixel", "iPad"] });
    expect((await gatherCensus(rig({}, {}).deps, { running: false, crew: "solo" })).devices).toEqual({ count: 0, names: [] });
  });

  test("a peer holds none of its own", async () => {
    const files = { [DEVICES]: JSON.stringify({ devices: [device("Pixel")] }) };
    const census = await gatherCensus(rig(files, {}).deps, { running: false, crew: "peer" });
    expect(census.devices.count).toBe(0);
  });
});

describe("sessions", () => {
  test("counts by state, and how many report a session id", async () => {
    const r = rig({}, { "/api/snapshot": snapshot() });
    const { sessions } = await gatherCensus(r.deps, { running: true, crew: "solo" });
    expect(sessions).toEqual({
      read: "ok",
      refusedWith: null,
      total: 6,
      // A state this build does not know counts as unknown, and the shell pane is not counted.
      byState: { working: 2, blocked: 1, idle: 1, done: 1, unknown: 1 },
      withSessionId: 3,
    });
  });

  test("the read carries the local credential and never a Tailscale header", async () => {
    const r = rig({ [SECRET_FILE]: `${SECRET}\n` }, { "/api/snapshot": snapshot() });
    await gatherCensus(r.deps, { running: true, crew: "solo" });
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0]!.url).toBe("http://127.0.0.1:8788/api/snapshot");
    expect(r.seen[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(Object.keys(r.seen[0]!.headers).map((k) => k.toLowerCase())).not.toContain("tailscale-user-login");
  });

  test("with no bridge running nothing is dialled and the block says so", async () => {
    const r = rig({}, { "/api/snapshot": snapshot() });
    const { sessions } = await gatherCensus(r.deps, { running: false, crew: "solo" });
    expect(sessions).toMatchObject({ read: "bridge-not-running", total: null, byState: null, withSessionId: null });
    expect(r.seen).toEqual([]);
  });

  test("a refusal, a silence and a body that is not a snapshot are three different answers", async () => {
    const refused = rig({}, { "/api/snapshot": new Response("no", { status: 403 }) });
    expect((await gatherCensus(refused.deps, { running: true, crew: "solo" })).sessions).toMatchObject({
      read: "refused",
      refusedWith: 403,
      total: null,
    });
    const silent = rig({}, {});
    expect((await gatherCensus(silent.deps, { running: true, crew: "solo" })).sessions.read).toBe("unreadable");
    const junk = rig({}, { "/api/snapshot": snapshot("<html>") });
    expect((await gatherCensus(junk.deps, { running: true, crew: "solo" })).sessions.read).toBe("unreadable");
  });

  test("a bridge bound to its tailnet address is dialled there, not on loopback", async () => {
    const r = rig({}, { "/api/snapshot": snapshot() });
    const bound = { ...r.deps, ctx: context({ COLLIE_HOST: "100.64.0.8" }, { stateDir: STATE, port: 8795 }) };
    await gatherCensus(bound, { running: true, crew: "solo" });
    expect(r.seen[0]!.url).toBe("http://100.64.0.8:8795/api/snapshot");
  });

  test("countSessions refuses a body with no agents list", () => {
    expect(countSessions("{}")).toBeNull();
    expect(countSessions("[]")).toBeNull();
    expect(countSessions('{"agents":[]}')).toEqual({
      total: 0,
      byState: { working: 0, blocked: 0, idle: 0, done: 0, unknown: 0 },
      withSessionId: 0,
    });
  });
});
