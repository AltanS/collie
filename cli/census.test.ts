import { describe, expect, test } from "bun:test";

import type { JsonValue } from "../bridge/json.ts";
import { CREW_PROTOCOL_VERSION } from "../bridge/crew/enrollment.ts";
import { leadStore, member, peerStore } from "../bridge/crew/fixtures.ts";
import { serializeTrustStore } from "../bridge/crew/trust-store.ts";
import { censusLines, countSessions, gatherCensus, type Census, type CensusInput, type CensusMember } from "./census.ts";
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

/** A member's `/crew/v1/snapshot` answer: crew headers on, the body as given. */
const crewSnapshot = (memberId: string, body: Record<string, JsonValue>): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-crew-protocol": String(CREW_PROTOCOL_VERSION), "x-crew-member": memberId },
  });

const snapshot = (body = SNAPSHOT): Response => new Response(body, { status: 200 });

const RUNNING_LEAD: CensusInput = { running: true, crew: "lead" };
const lead = (...peers: string[]): string =>
  serializeTrustStore(leadStore({ peers: peers.map((memberId) => member({ memberId })) }));

describe("members", () => {
  test("one row per member, from the same hello and snapshot dials crew status makes", async () => {
    const r = rig(
      { [TRUST]: lead("minibuch", "minibuch-hc") },
      {
        // The snapshot answer is listed before the hello, since a fragment matches the first key that fits.
        "minibuch.example:8787/crew/v1/snapshot": crewSnapshot("minibuch", { bridge: "connected", agents: [], mux: "herdr", panes: 4, host: "minibuch-box" }),
        "minibuch.example": hello("minibuch", "1.25.0"),
        "minibuch-hc.example": new Error("timed out"),
        "/api/snapshot": snapshot(),
      },
    );
    const census = await gatherCensus(r.deps, RUNNING_LEAD);
    expect(census.members).toEqual([
      { name: "minibuch", role: "peer", link: "reachable", version: "1.25.0", mux: "herdr", panes: 4, host: "minibuch-box" },
      { name: "minibuch-hc", role: "peer", link: "unreachable", version: null, mux: null, panes: null, host: null },
    ]);
    // Both questions of `crew status` for a member that answered, and only `hello` for one that did not.
    expect(r.seen.filter((s) => s.url.includes("/crew/v1/")).map((s) => s.url)).toEqual([
      "https://minibuch.example:8787/crew/v1/hello",
      "https://minibuch-hc.example:8787/crew/v1/hello",
      "https://minibuch.example:8787/crew/v1/snapshot",
    ]);
  });

  test("an older member shows a dash for panes, a member still starting shows none, never zero", async () => {
    const r = rig(
      { [TRUST]: lead("old", "booting") },
      {
        // `old` gets the bare hello for its snapshot, so neither field arrives; `booting` names its mux and sends no count.
        "booting.example:8787/crew/v1/snapshot": crewSnapshot("booting", { bridge: "disconnected", agents: [], mux: "tmux" }),
        "old.example": hello("old", "1.24.2"),
        "booting.example": hello("booting", "1.25.0"),
        "/api/snapshot": snapshot(),
      },
    );
    const census = await gatherCensus(r.deps, RUNNING_LEAD);
    expect(census.members.map((m) => [m.name, m.mux, m.panes])).toEqual([
      ["old", null, null],
      ["booting", "tmux", null],
    ]);
  });

  test("the hello mux block names the multiplexer when the snapshot answer carries no name", async () => {
    const withBlock = new Response(
      JSON.stringify({
        protocol: CREW_PROTOCOL_VERSION,
        member: "nas",
        version: "1.24.2",
        mux: { name: "zellij", capabilities: {}, unsupportedKeys: [], notes: {} },
      }),
      { status: 200, headers: { "content-type": "application/json", "x-crew-protocol": String(CREW_PROTOCOL_VERSION), "x-crew-member": "nas" } },
    );
    const r = rig({ [TRUST]: lead("nas") }, { "nas.example": withBlock, "/api/snapshot": snapshot() });
    const census = await gatherCensus(r.deps, RUNNING_LEAD);
    expect(census.members.map((m) => [m.name, m.mux, m.panes])).toEqual([["nas", "zellij", null]]);
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

describe("members, grouped by host (M77)", () => {
  const row = (name: string, over: Partial<CensusMember> = {}): CensusMember => ({
    name,
    role: "peer",
    link: "reachable",
    version: "1.25.0",
    mux: "herdr",
    panes: 2,
    host: null,
    ...over,
  });
  const census = (members: CensusMember[]): Census => ({
    members,
    devices: { count: 0, names: [] },
    sessions: { read: "bridge-not-running", refusedWith: null, total: null, byState: null, withSessionId: null },
  });
  const memberBlock = (members: CensusMember[]): string[] => censusLines(census(members), "lead").slice(0, 1 + members.length + new Set(members.map((m) => m.host ?? m.name)).size);

  test("a host that runs two instances gets one host line with both instances under it", () => {
    const lines = censusLines(
      census([
        row("bluefin", { role: "lead", host: "bluefin" }),
        row("minibuch", { host: "minibuch" }),
        row("bluefin-hc", { host: "bluefin", mux: "herdr-core" }),
        row("minibuch-hc", { host: "minibuch", mux: "herdr-core", link: "unreachable", version: null, panes: null }),
      ]),
      "lead",
    );
    expect(lines.slice(0, 7)).toEqual([
      "  members",
      "    bluefin",
      "      bluefin      lead  reachable    1.25.0  mux herdr  panes 2",
      "      bluefin-hc   peer  reachable    1.25.0  mux herdr-core  panes 2",
      "    minibuch",
      "      minibuch     peer  reachable    1.25.0  mux herdr  panes 2",
      "      minibuch-hc  peer  unreachable  -       mux herdr-core  panes -",
    ]);
    expect(lines.filter((l) => /^\s+(bluefin|minibuch)\s*$/.test(l))).toHaveLength(2);
  });

  test("a member without a host is its own group, under its id", () => {
    const lines = memberBlock([row("a", { host: "box" }), row("b", { host: "box" }), row("old")]);
    expect(lines.filter((l) => /^ {4}\S+$/.test(l))).toEqual(["    box", "    old"]);
  });

  test("when no host carries two instances the list stays flat, as before", () => {
    const lines = censusLines(census([row("bluefin", { host: "bluefin" }), row("minibuch", { host: "minibuch" })]), "lead");
    expect(lines.slice(0, 3)).toEqual([
      "  members",
      "    bluefin   reachable  1.25.0  mux herdr  panes 2",
      "    minibuch  reachable  1.25.0  mux herdr  panes 2",
    ]);
  });
});
