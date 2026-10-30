import { describe, expect, test } from "bun:test";

import type { JsonObject, JsonValue } from "../bridge/json.ts";
import { asJsonObject, asJsonString, parseJson } from "../web/src/lib/json.ts";
import { peerStore } from "../bridge/crew/fixtures.ts";
import { serializeTrustStore, trustStorePath } from "../bridge/crew/trust-store.ts";
import { localSecretPath, mintLocalSecret } from "../bridge/local-secret.ts";
import { capture, context, fakeFiles, STATE } from "./fakes.ts";
import { EXIT } from "./io.ts";
import { ageOf, cmdSessions, MEMBER_FOOTER, SESSIONS_USAGE, SESSIONS_VERB, type SessionsDeps } from "./sessions.ts";

// `collie sessions` over a fixture snapshot. Nothing here dials a bridge or reads a disk: the fetch is
// a table of answers by URL, and the clock is pinned.

const NOW = 1_800_000_000_000;
const SECRET = mintLocalSecret();

const pane = (over: JsonObject): JsonObject => ({
  paneId: "t1",
  workspaceId: "w1",
  workspaceLabel: "collie",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "claude",
  status: "idle",
  cwd: "/work/collie",
  focused: false,
  kind: "agent",
  hasSession: true,
  lastActiveAt: NOW - 3 * 60_000,
  ...over,
});

// The lead's own answer to `?sessions=all`: its two members, a Claude pane on each, and a shell pane.
// The member `lab` comes back narrow here: its primary session only, and no durable agent.
const LEAD_WIDE = {
  agents: [
    pane({ host: "collie-04rj6a", paneId: "t2", workspaceLabel: "zeta", workspaceNumber: 2, agent: "codex", model: "gpt-9", status: "working", session: "default", lastActiveAt: NOW - 2 * 3600_000 }),
    pane({ host: "collie-04rj6a", paneId: "t1", session: "default", status: "blocked", model: "claude-opus-5-5", instance: "ab12" }),
    pane({ host: "lab", paneId: "p9", workspaceLabel: "narrow", session: "default" }),
  ],
  shellPanes: [pane({ host: "collie-04rj6a", paneId: "t3", agent: "shell", kind: "shell", status: "unknown", hasSession: undefined, lastActiveAt: undefined, workspaceLabel: "scratch", workspaceNumber: 3, session: "default" })],
  sessions: [
    { name: "default", isPrimary: true, reachable: true, agents: 2, working: 1, blocked: 1, host: "collie-04rj6a", kind: "terminal" },
    { name: "desk", isPrimary: false, reachable: true, agents: 1, working: 0, blocked: 0, host: "collie-04rj6a", mux: "durable", kind: "program" },
  ],
  servers: [
    { id: "collie-04rj6a", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: NOW, mux: "herdr" },
    { id: "lab", name: "lab", isLead: false, reachable: true, protocol: "ok", lastSeenAt: NOW, mux: "herdr-core" },
  ],
};
// The durable agent is a pane of its own session `desk`, found only on the widened read.
LEAD_WIDE.agents.push(
  pane({ host: "collie-04rj6a", paneId: "d1", workspaceLabel: "Desk workspace", workspaceNumber: 0, agent: "durable", status: "working", session: "desk" }),
);

// The same lead asked for member `lab` wide: its pane list now holds the durable agent as well.
const LAB_WIDE = {
  ...LEAD_WIDE,
  agents: [
    pane({ host: "lab", paneId: "p9", workspaceLabel: "narrow", session: "default" }),
    pane({ host: "lab", paneId: "q1", workspaceLabel: "Edge program", workspaceNumber: 0, agent: "durable", status: "idle", session: "edge" }),
  ],
  shellPanes: [],
  sessions: [{ name: "default", isPrimary: true, reachable: true, agents: 1, working: 0, blocked: 0, host: "lab", kind: "terminal" }],
};

interface Harness {
  deps: SessionsDeps;
  io: ReturnType<typeof capture>;
  urls: string[];
  headers: Record<string, string>[];
}

function harness(
  answer: (url: string) => Response | Error,
  files: Record<string, string> = { [localSecretPath(STATE)]: `${SECRET}\n` },
  env: Record<string, string> = {},
): Harness {
  const io = capture();
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const deps: SessionsDeps = {
    ctx: context(env),
    io,
    files: fakeFiles(files),
    now: () => NOW,
    fetch: async (url, init) => {
      urls.push(url);
      // SAFETY: this verb always sends a plain object of string headers, never a Headers or a tuple list.
      headers.push({ ...(init.headers as Record<string, string> | undefined) });
      const r = answer(url);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { deps, io, urls, headers };
}

const json = (body: JsonValue): Response => new Response(JSON.stringify(body));
const crew = (url: string): Response => json(url.includes("host=lab") ? LAB_WIDE : LEAD_WIDE);
const out = (h: Harness): string => h.io.stdout.join("\n");
/** The `--json` document: its rows, and the note a member adds. */
function parsed(h: Harness): { rows: JsonObject[]; note?: string } {
  const doc = asJsonObject(parseJson(h.io.stdout[0] ?? ""));
  if (doc === undefined || !Array.isArray(doc.rows)) throw new Error("not a --json document");
  const rows = doc.rows.map(asJsonObject).filter((r): r is JsonObject => r !== undefined);
  const note = asJsonString(doc.note);
  return note === undefined ? { rows } : { rows, note };
}

describe("collie sessions", () => {
  test("the verb name is one constant", () => {
    expect(SESSIONS_VERB).toBe("sessions");
    expect(SESSIONS_USAGE).toContain(`collie ${SESSIONS_VERB}`);
  });

  test("prints the table sorted by member, then workspace, with the footer", async () => {
    const h = harness(crew);
    expect(await cmdSessions(h.deps, [])).toBe(EXIT.OK);
    const lines = h.io.stdout;
    expect(lines[0]).toMatch(/^MEMBER\s+MUX\s+SEAT\s+HARNESS\s+STATE\s+SESSION\s+ACTIVE$/);
    const body = lines.slice(1, 6).map((l) => l.split(/\s{2,}/));
    expect(body).toEqual([
      ["bluefin", "durable", "-", "desk", "working", "yes", "3m"],
      ["bluefin", "herdr", "collie (t1)", "claude claude-opus-5-5", "blocked", "yes", "3m"],
      ["bluefin", "herdr", "zeta (t2)", "codex gpt-9", "working", "yes", "2h"],
      ["lab", "herdr-core", "-", "edge", "idle", "yes", "3m"],
      ["lab", "herdr-core", "narrow (p9)", "claude", "idle", "yes", "3m"],
    ]);
    expect(lines.at(-1)).toBe("5 sessions: 1 blocked, 2 working, 2 idle");
    expect(out(h)).not.toContain(MEMBER_FOOTER);
  });

  test("a durable agent has no seat and shows its program name as the harness", async () => {
    const h = harness(crew);
    await cmdSessions(h.deps, ["--json"]);
    const durable = parsed(h).rows.find((r) => r.paneId === "d1")!;
    expect(durable.seat).toBeNull();
    expect(durable.harness).toBe("desk");
    expect(durable.mux).toBe("durable");
  });

  test("the lead is read once wide, and each reachable member once more by host", async () => {
    const h = harness(crew);
    await cmdSessions(h.deps, []);
    expect(h.urls).toEqual([
      "http://127.0.0.1:8787/api/snapshot?sessions=all",
      "http://127.0.0.1:8787/api/snapshot?host=lab&sessions=all",
    ]);
    expect(h.headers[0]!.authorization).toBe(`Bearer ${SECRET}`);
  });

  test("--state keeps one state, and the footer counts only what is shown", async () => {
    const h = harness(crew);
    await cmdSessions(h.deps, ["--state", "working"]);
    expect(h.io.stdout.slice(1, 3).every((l) => l.includes("working"))).toBe(true);
    expect(h.io.stdout.at(-1)).toBe("2 sessions: 2 working");
  });

  test("--member keeps one member, by id or by name", async () => {
    const h = harness(crew);
    await cmdSessions(h.deps, ["--member", "lab"]);
    expect(h.io.stdout.slice(1, 3).every((l) => l.startsWith("lab"))).toBe(true);
    expect(h.io.stdout.at(-1)).toBe("2 sessions: 2 idle");

    const byId = harness(crew);
    await cmdSessions(byId.deps, ["--member", "collie-04rj6a"]);
    expect(byId.io.stdout.at(-1)).toBe("3 sessions: 1 blocked, 2 working");
    const byName = harness(crew);
    await cmdSessions(byName.deps, ["--member", "bluefin"]);
    expect(byName.io.stdout.at(-1)).toBe("3 sessions: 1 blocked, 2 working");
  });

  test("the MEMBER column shows the server's name, and --json keeps the id beside it", async () => {
    const h = harness(crew);
    await cmdSessions(h.deps, ["--json"]);
    const { rows } = parsed(h);
    const lead = rows.find((r) => r.paneId === "t1")!;
    expect(lead.member).toBe("collie-04rj6a");
    expect(lead.memberName).toBe("bluefin");
    const member = rows.find((r) => r.paneId === "p9")!;
    expect(member.member).toBe("lab");
    expect(member.memberName).toBe("lab");

    const table = harness(crew);
    await cmdSessions(table.deps, []);
    expect(table.io.stdout.join("\n")).not.toContain("collie-04rj6a");
  });

  test("the MUX column: a durable row keeps its own, others take the host's, none shows a dash", async () => {
    const snapshot = {
      ...LEAD_WIDE,
      servers: [
        { id: "collie-04rj6a", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: NOW, mux: "herdr" },
        { id: "old", name: "old", isLead: false, reachable: true, protocol: "ok", lastSeenAt: NOW },
      ],
      agents: [...LEAD_WIDE.agents.filter((a) => a.host === "collie-04rj6a"), pane({ host: "old", paneId: "o1", session: "default" })],
    };
    const h = harness(() => json(snapshot));
    await cmdSessions(h.deps, ["--json"]);
    const mux = (paneId: string): JsonValue | undefined => parsed(h).rows.find((r) => r.paneId === paneId)?.mux;
    expect(mux("d1")).toBe("durable");
    expect(mux("t1")).toBe("herdr");
    expect(mux("o1")).toBeNull();

    const table = harness(() => json(snapshot));
    await cmdSessions(table.deps, []);
    expect(table.io.stdout.find((l) => l.startsWith("old"))).toMatch(/^old\s+-\s+collie \(o1\)/);
  });

  test("a shell pane is not listed, and --all adds it", async () => {
    const plain = harness(crew);
    await cmdSessions(plain.deps, ["--json"]);
    expect(parsed(plain).rows.some((r) => r.paneId === "t3")).toBe(false);

    const all = harness(crew);
    await cmdSessions(all.deps, ["--all", "--json"]);
    const shell = parsed(all).rows.find((r) => r.paneId === "t3")!;
    expect(shell.kind).toBe("shell");
    expect(shell.session).toBe("no");
    expect(shell.active).toBeNull();
    expect(parsed(all).rows).toHaveLength(6);
  });

  test("--json carries the raw fields and the derived columns", async () => {
    const h = harness(crew);
    expect(await cmdSessions(h.deps, ["--json"])).toBe(EXIT.OK);
    const { rows } = parsed(h);
    const row = rows.find((r) => r.paneId === "t1")!;
    expect(row).toMatchObject({
      paneId: "t1",
      host: "collie-04rj6a",
      instance: "ab12",
      agent: "claude",
      status: "blocked",
      cwd: "/work/collie",
      workspaceLabel: "collie",
      hasSession: true,
      lastActiveAt: NOW - 180_000,
      kind: "agent",
      model: "claude-opus-5-5",
      member: "collie-04rj6a",
      memberName: "bluefin",
      mux: "herdr",
      seat: "collie (t1)",
      harness: "claude claude-opus-5-5",
      state: "blocked",
      session: "yes",
      active: "3m",
    });
    expect(rows.map((r) => r.member)).toEqual(["collie-04rj6a", "collie-04rj6a", "collie-04rj6a", "lab", "lab"]);
    expect(rows.map((r) => r.memberName)).toEqual(["bluefin", "bluefin", "bluefin", "lab", "lab"]);
  });

  test("on a member the footer says its panes only, and --json carries the same note", async () => {
    const solo = { agents: [pane({ paneId: "t1" })], shellPanes: [], sessions: [{ name: "default", isPrimary: true, reachable: true, agents: 1, working: 0, blocked: 0 }] };
    const files = { [localSecretPath(STATE)]: `${SECRET}\n`, [trustStorePath(STATE)]: serializeTrustStore(peerStore()) };
    const h = harness(() => json(solo), files);
    expect(await cmdSessions(h.deps, [])).toBe(EXIT.OK);
    expect(h.io.stdout[1]).toMatch(/^local\s+-\s+collie \(t1\)\s+claude\s+idle\s+yes\s+3m$/);
    expect(h.io.stdout.at(-1)).toBe(MEMBER_FOOTER);
    expect(h.urls).toHaveLength(1);

    const j = harness(() => json(solo), files);
    await cmdSessions(j.deps, ["--json"]);
    expect(parsed(j).note).toBe(MEMBER_FOOTER);
  });

  test("a solo install prints no member footer", async () => {
    const solo = { agents: [pane({})], shellPanes: [], sessions: [] };
    const h = harness(() => json(solo));
    await cmdSessions(h.deps, []);
    expect(out(h)).not.toContain(MEMBER_FOOTER);
    expect(h.io.stdout.at(-1)).toBe("1 session: 1 idle");
  });

  test("no bridge running: one line on stderr and exit 1", async () => {
    const h = harness(() => new Error("ECONNREFUSED"));
    expect(await cmdSessions(h.deps, [])).toBe(EXIT.FAIL);
    expect(h.io.stdout).toEqual([]);
    expect(h.io.stderr).toHaveLength(1);
    expect(h.io.stderr[0]).toContain("no bridge answers here");
  });

  test("a refused read says what doctor says, and exits 1", async () => {
    const h = harness(() => new Response("no", { status: 403 }), {});
    expect(await cmdSessions(h.deps, [])).toBe(EXIT.FAIL);
    expect(h.headers[0]!.authorization).toBeUndefined();
    const said = h.io.stderr.join("\n");
    expect(said).toContain("refused this read of `/api/snapshot` (403)");
    expect(said).toContain("`collie restart` so the bridge writes its local read credential");
    expect(said).toContain("COLLIE_TRUSTED_USER");
  });

  test("a body that is not a snapshot is named as such", async () => {
    const h = harness(() => new Response("<html>"));
    expect(await cmdSessions(h.deps, [])).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("not a snapshot");
  });

  test("a bad flag exits 2 with the usage line", async () => {
    for (const args of [["--nope"], ["--state"], ["--member", "--all"]]) {
      const h = harness(crew);
      expect(await cmdSessions(h.deps, args)).toBe(EXIT.USAGE);
      expect(h.io.stderr.at(-1)).toBe(SESSIONS_USAGE);
      expect(h.urls).toEqual([]);
    }
  });

  test("no sessions at all says so", async () => {
    const h = harness(() => json({ agents: [], shellPanes: [], sessions: [] }));
    expect(await cmdSessions(h.deps, [])).toBe(EXIT.OK);
    expect(h.io.stdout).toEqual(["no agent sessions"]);
  });

  test("a member that cannot be read wide keeps its narrow rows and says so", async () => {
    const h = harness((url) => (url.includes("host=lab") ? new Response("x", { status: 500 }) : json(LEAD_WIDE)));
    await cmdSessions(h.deps, ["--json"]);
    expect(h.io.stderr.join("\n")).toContain("could not read lab wide");
    expect(parsed(h).rows.filter((r) => r.member === "lab").map((r) => r.paneId)).toEqual(["p9"]);
  });
});

describe("ageOf", () => {
  test("seconds, minutes, hours, days, and never negative", () => {
    expect(ageOf(NOW - 5_000, NOW)).toBe("5s");
    expect(ageOf(NOW - 3 * 60_000, NOW)).toBe("3m");
    expect(ageOf(NOW - 2 * 3600_000, NOW)).toBe("2h");
    expect(ageOf(NOW - 5 * 86_400_000, NOW)).toBe("5d");
    expect(ageOf(NOW + 9_000, NOW)).toBe("0s");
  });
});
