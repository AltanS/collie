import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "./json.ts";
import { asJsonObject, asJsonString } from "../web/src/lib/json.ts";
import { localCredentialOf, mintLocalSecret } from "./local-secret.ts";
import { isLocalKeyRoute, LOCAL_KEY_ROUTES, localConfigView, localSnapshotView, localTricksView, localUpdateCheckView } from "./local-key.ts";
import { parseCrewRows } from "./update-action.ts";
import { apiFrontGate, browserPairingGate, type PairingGate } from "./server.ts";
import { loadConfig } from "./config.ts";

// The local key's four views, and the leak test: every field of the snapshot, the tricks reply, the
// update check and the config is planted with an e-mail, a path, a question, a title, a held send and
// a trick output, and none of them comes back to the key, on a marked route or on a refused one.

const REPO = join(import.meta.dir, "..");
const TYPES = readFileSync(join(REPO, "bridge/types.ts"), "utf8");
const SCHEMA = readFileSync(join(REPO, "web/src/lib/tricks/schema.ts"), "utf8");
const UPDATE_ACTION = readFileSync(join(REPO, "bridge/update-action.ts"), "utf8");

/** The field names of one declaration (`export interface X {` or `export type X = … & {`), up to its close. */
function fieldsOf(source: string, opener: string): string[] {
  const at = source.indexOf(opener);
  if (at < 0) throw new Error(`no declaration ${opener}`);
  const end = source.indexOf("\n}", at);
  const body = source.slice(at + opener.length, end);
  return [...body.matchAll(/^ {2}(?:readonly )?(\w+)\??:/gm)].map((m) => m[1]!);
}

const PLANTED = [
  "leak.person@example.org",
  "/home/someone/private-project/notes.md",
  "Shall I delete the production database now?",
  "PLANTED terminal title of a build",
  "PLANTED held send: push it to main",
  "PLANTED trick output: 42 widgets sold",
] as const;

/** A value that carries every planted string, for a field of any type. */
const blob = (): JsonValue => ({ text: PLANTED[2], list: [...PLANTED], nested: { title: PLANTED[3], body: [PLANTED[4], { out: PLANTED[5] }] } });

/** The text a kept field carries: its own marker, so a test can say which kept field said what. */
const kept = (field: string): string => `KEPT-${field}`;

/** One object with every named field planted, and the kept ones set to a value of their real type. */
function planted(fields: readonly string[], keptValues: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const f of fields) out[f] = f in keptValues ? keptValues[f] : blob();
  return out;
}

const AGENT_VIEW = fieldsOf(TYPES, "export interface AgentView {");
const PANE_WIRE = [...AGENT_VIEW.filter((f) => f !== "agentSession" && f !== "sessionAgent"), ...fieldsOf(TYPES, "export type PaneWire = Omit<AgentView, \"agentSession\" | \"sessionAgent\"> & {")];
const SNAPSHOT = fieldsOf(TYPES, "export interface SnapshotResponse {");
const SESSION = [...fieldsOf(TYPES, "export interface SessionSummary {"), ...fieldsOf(TYPES, "export interface SessionCard {")];
const SERVER = fieldsOf(TYPES, "export interface ServerSummary {");
const UPDATE = fieldsOf(TYPES, "export interface UpdateStatus {");
const TRICK = fieldsOf(SCHEMA, "export interface WireTrickInfo {");
const TRICKS_REPLY = fieldsOf(SCHEMA, "export interface TricksReply {");
const CREW_ROW = fieldsOf(UPDATE_ACTION, "export interface CrewUpdateRow {");
/** `GET /api/update/check`: the update status, the crew run's legs, and the route's own three fields. */
const UPDATE_CHECK = [...UPDATE, "peers", "settledAt", "preflight", "crew", "releaseNotes"];
const CONFIG = fieldsOf(TYPES, "export interface BridgeConfig {");

const KEPT_PANE: JsonObject = {
  paneId: kept("paneId"),
  kind: "agent",
  agent: kept("agent"),
  hasSession: true,
  status: "working",
  host: kept("host"),
  session: kept("session"),
  model: kept("model"),
  workspaceLabel: kept("workspaceLabel"),
  workspaceNumber: 3,
  lastActiveAt: 1_800_000_000_000,
};

function world(): JsonObject {
  const pane = planted(PANE_WIRE, KEPT_PANE);
  const shell = planted(PANE_WIRE, { ...KEPT_PANE, kind: "shell" });
  const session = planted(SESSION, { name: kept("session.name"), host: kept("session.host"), isPrimary: true, kind: "terminal", mux: kept("session.mux") });
  const server = planted(SERVER, { id: kept("server.id"), name: kept("server.name"), isLead: true, reachable: true, mux: kept("server.mux") });
  const update = planted(UPDATE, { restartNeeded: false, restartCommand: kept("restartCommand") });
  return planted(SNAPSHOT, { agents: [pane], shellPanes: [shell], sessions: [session], servers: [server], update });
}

function tricksWorld(): JsonObject {
  const trick = planted(TRICK, { id: kept("trick.id"), on: true, state: "failing", lastRunAt: kept("lastRunAt"), error: kept("trick.error"), pending: blob() });
  return planted([...TRICKS_REPLY, "path"], { tricks: [trick], path: kept("path"), runsOn: { lead: kept("runsOn.lead"), extra: blob() } });
}

const KEPT_CREW_ROW: JsonObject = { name: kept("crew.name"), verdict: "red", reasons: [kept("crew.reason")], asOf: 1_800_000_000_000 };

function updateCheckWorld(): JsonObject {
  const row = planted(CREW_ROW, KEPT_CREW_ROW);
  return planted(UPDATE_CHECK, { crew: [row] });
}

function configWorld(): JsonObject {
  return planted(CONFIG, {});
}

/** Every string anywhere in a JSON value. */
function stringsOf(value: JsonValue | undefined): string[] {
  const s = asJsonString(value);
  if (s !== undefined) return [s];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  const o = asJsonObject(value);
  return o === undefined ? [] : Object.values(o).flatMap(stringsOf);
}

describe("the fixture plants every declared field", () => {
  test("the field scans found the declarations, so the world is not empty", () => {
    expect(PANE_WIRE.length).toBeGreaterThan(50);
    expect(PANE_WIRE).toContain("terminalTitle");
    expect(PANE_WIRE).toContain("asks");
    expect(PANE_WIRE).toContain("held");
    expect(SNAPSHOT).toContain("agents");
    expect(TRICK).toContain("about");
    expect(TRICKS_REPLY).toContain("parts");
    expect(CREW_ROW).toEqual(expect.arrayContaining(["name", "version", "verdict", "reasons", "asOf", "installKind", "health"]));
    expect(UPDATE).toContain("run");
    expect(CONFIG).toEqual(expect.arrayContaining(["vapidPublicKey", "operatorCommands", "operatorQuickReplies", "operatorFonts", "stt", "mux"]));
  });
});

describe("localSnapshotView: an allow-list of what the CLI reads", () => {
  test("the panes keep exactly the CLI's fields, and nothing else", () => {
    const view = localSnapshotView(world());
    expect(Object.keys(view).toSorted()).toEqual(["agents", "servers", "sessions", "shellPanes", "update"]);
    expect(view.agents).toEqual([KEPT_PANE]);
    expect(view.shellPanes).toEqual([{ ...KEPT_PANE, kind: "shell" }]);
    expect(view.sessions).toEqual([{ name: kept("session.name"), host: kept("session.host"), isPrimary: true, kind: "terminal", mux: kept("session.mux") }]);
    expect(view.servers).toEqual([{ id: kept("server.id"), name: kept("server.name"), isLead: true, reachable: true, mux: kept("server.mux") }]);
    expect(view.update).toEqual({ restartNeeded: false, restartCommand: kept("restartCommand") });
  });

  test("a field the snapshot gains later stays out", () => {
    const w = world();
    const pane = { ...KEPT_PANE, brandNewText: PLANTED[3] };
    const view = localSnapshotView({ ...w, agents: [pane], brandNewTop: PLANTED[0] });
    expect(stringsOf(view)).not.toContain(PLANTED[3]);
    expect(stringsOf(view)).not.toContain(PLANTED[0]);
  });

  test("a kept field of the wrong type is dropped, never passed through", () => {
    const view = localSnapshotView({ agents: [{ paneId: blob(), status: { text: PLANTED[2] } }], update: { restartCommand: [PLANTED[1]] } });
    expect(view.agents).toEqual([{}]);
    expect(view.update).toEqual({});
    expect(stringsOf(view)).toEqual([]);
  });

  test("no servers and no update in, none out: a solo body stays a solo body", () => {
    const view = localSnapshotView({ agents: [], shellPanes: [], sessions: [] });
    expect(view).toEqual({ agents: [], shellPanes: [], sessions: [] });
  });
});

describe("localTricksView: an allow-list of what trick list and doctor read", () => {
  test("each trick keeps its row, pending is only a mark, and the PATH and the lead ride along", () => {
    const view = localTricksView(tricksWorld());
    expect(view).toEqual({
      tricks: [{ id: kept("trick.id"), on: true, state: "failing", lastRunAt: kept("lastRunAt"), error: kept("trick.error"), pending: {} }],
      path: kept("path"),
      runsOn: { lead: kept("runsOn.lead") },
    });
  });
});

describe("localUpdateCheckView: the crew rows collie crew update prints, and nothing else", () => {
  test("each row keeps exactly name, verdict, reasons and asOf; the body keeps only crew", () => {
    const view = localUpdateCheckView(updateCheckWorld());
    expect(Object.keys(view)).toEqual(["crew"]);
    expect(view.crew).toEqual([KEPT_CREW_ROW]);
  });

  test("the CLI's own reader reads the view as it reads the full row, minus version and install kind", () => {
    const full = updateCheckWorld();
    const row = { ...KEPT_CREW_ROW, version: "1.2.3", installKind: "packaged" };
    const [fromView] = parseCrewRows(localUpdateCheckView({ ...full, crew: [row] }));
    expect(fromView).toEqual({ name: kept("crew.name"), version: null, verdict: "red", reasons: [kept("crew.reason")], asOf: 1_800_000_000_000 });
  });

  test("a reason that is not a string is dropped, and no crew in is an empty list out", () => {
    expect(localUpdateCheckView({ crew: [{ ...KEPT_CREW_ROW, reasons: [blob(), kept("crew.reason")] }] }).crew).toEqual([KEPT_CREW_ROW]);
    expect(localUpdateCheckView({ releaseNotes: blob() })).toEqual({ crew: [] });
  });
});

describe("localConfigView: the status alone", () => {
  test("the key gets an empty object, whatever the config holds", () => {
    expect(Object.keys(configWorld()).length).toBeGreaterThan(10);
    expect(localConfigView()).toEqual({});
  });
});

describe("the leak test: nothing planted reaches the local key", () => {
  const secret = mintLocalSecret();
  const bearer = { authorization: `Bearer ${secret}` };
  const gate: PairingGate = browserPairingGate(
    { resolve: () => null, expired: () => false },
    localCredentialOf(secret),
    () => "127.0.0.1",
    "127.0.0.1",
    () => new Set<string>(),
  );
  const cfg = loadConfig({ HOME: "/tmp/collie-local-key-home" });

  test("the marked routes that carry the world answer views with no planted value in them", () => {
    const answers = [localSnapshotView(world()), localTricksView(tricksWorld()), localUpdateCheckView(updateCheckWorld()), localConfigView()];
    for (const answer of answers) {
      const text = JSON.stringify(answer);
      for (const value of PLANTED) expect({ value, found: text.includes(value) }).toEqual({ value, found: false });
    }
    // The text that does come back is exactly the kept fields, each named.
    const said = answers.flatMap((a) => stringsOf(a)).filter((s) => s.startsWith("KEPT-"));
    expect([...new Set(said)].toSorted()).toEqual(
      [
        "agent", "crew.name", "crew.reason", "host", "lastRunAt", "model", "paneId", "path", "restartCommand", "runsOn.lead", "server.id", "server.mux", "server.name",
        "session", "session.host", "session.mux", "session.name", "trick.error", "trick.id", "workspaceLabel",
      ].map(kept).toSorted(),
    );
  });

  test("every refused route answers the key one fixed sentence, which holds no planted value", async () => {
    const paths = ["/api/pane/w1%3Ap1", "/api/pane/w1%3Ap1/history", "/api/pane/w1%3Ap1/chat", "/api/hill", "/api/trick-views", "/api/blobs/b1", "/api/durable/conversations", "/api/sent"];
    const bodies = new Set<string>();
    for (const path of paths) {
      const denied = apiFrontGate(new Request(`http://127.0.0.1:8787${path}?host=member-1`, { headers: { host: "127.0.0.1:8787", ...bearer } }), path, cfg, gate);
      expect(denied?.status).toBe(403);
      bodies.add((await denied?.text()) ?? "");
    }
    expect(bodies.size).toBe(1);
    for (const body of bodies) for (const value of PLANTED) expect(body.includes(value)).toBe(false);
  });

  test("the four marked routes with more than the CLI reads are the four with a view; the telemetry route carries none of it", () => {
    expect(LOCAL_KEY_ROUTES.filter((r) => /local\w+View/.test(r.reason)).map((r) => r.path)).toEqual(["/api/snapshot", "/api/tricks", "/api/update/check", "/api/config"]);
    expect(isLocalKeyRoute("/api/snapshot", "GET")).toBe(true);
    expect(isLocalKeyRoute("/api/snapshot", "POST")).toBe(false);
  });

  test("server.ts answers the key with the views on all four routes", () => {
    const src = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
    const snap = src.indexOf('if (pathname === "/api/snapshot")');
    const snapBody = src.slice(snap, src.indexOf("\n      }\n", snap));
    expect(snapBody).toContain("if (isLocalRequest(req, pairingGate)) {");
    expect(snapBody).toContain("localSnapshotView(");
    // The view is built from the body the phone would get, after the crew merge and the title mask.
    expect(snapBody.indexOf("localSnapshotView(")).toBeGreaterThan(snapBody.indexOf("maskSnapshotTitles(merged)"));
    const tricks = src.indexOf('if (pathname === "/api/tricks" && req.method === "GET")');
    const tricksBody = src.slice(tricks, src.indexOf("\n      }\n", tricks));
    expect(tricksBody).toContain("if (forCli) return json(localTricksView(");
    const check = src.indexOf('if (pathname === "/api/update/check" && req.method === "GET")');
    const checkBody = src.slice(check, src.indexOf("\n      }\n", check));
    expect(checkBody).toContain("localUpdateCheckView(");
    const config = src.indexOf('if (pathname === "/api/config") {');
    const configBody = src.slice(config, src.indexOf("\n      }\n", config));
    // The view comes after both 404s (unknown session, unknown host), so `collie durable list` still tells them apart.
    expect(configBody).toContain("if (isLocalRequest(req, pairingGate)) return json(localConfigView(),");
    expect(configBody.indexOf("localConfigView(")).toBeGreaterThan(configBody.indexOf('apiError("host.unknown"'));
    expect(configBody.indexOf("localConfigView(")).toBeGreaterThan(configBody.indexOf('apiError("session.unknown"'));
  });
});
