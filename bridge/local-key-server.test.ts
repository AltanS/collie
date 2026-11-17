import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActivityLedger } from "./activity.ts";
import { AuditLog } from "./audit.ts";
import { loadConfig } from "./config.ts";
import { CrewLead } from "./crew/lead.ts";
import { member, neverProxy } from "./crew/fixtures.ts";
import type { CrewLink, PeerOutcome } from "./crew/peer-client.ts";
import { CrewRegistry } from "./crew/registry.ts";
import { asJsonObject, asJsonString } from "../web/src/lib/json.ts";
import type { JsonValue } from "./json.ts";
import { localCredentialOf, mintLocalSecret } from "./local-secret.ts";
import { muxOk } from "./mux/types.ts";
import { NotifyPrefsStore } from "./notify-prefs.ts";
import { filePairingIo, PairingStore } from "./pairing.ts";
import { Push } from "./push.ts";
import { startServer } from "./server.ts";
import { SessionRegistry, type SessionParts } from "./sessions.ts";
import { Snooze } from "./snooze.ts";
import type { UpdateMonitor } from "./update.ts";
import { DEFAULT_MAX_UPLOAD_BYTES } from "./uploads.ts";

// The local key against the REAL front door: `startServer` on an ephemeral loopback port, a lead with
// one member whose cached body is full of planted text, and real HTTP requests carrying the key. The
// pure views are pinned in local-key.test.ts; this proves the route answers the view on the paths that
// carry a member's body, `?host=<member>` and `?sessions=all`, and that a paired phone still gets it all.

const PLANTED = [
  "PLANTED terminal title of a build",
  "PLANTED held send: push it to main",
  "/home/someone/private-project",
  "Shall I delete the production database now?",
] as const;

const MEMBER = "member-1";

/** The member's own snapshot body, as its `/crew/v1/snapshot` would send it: one pane, text everywhere. */
const memberBody = {
  sessions: [{ name: "default", isPrimary: true, reachable: true, agents: 1, working: 0, blocked: 1 }],
  agents: [
    {
      paneId: "w1:p1",
      workspaceId: "w1",
      workspaceLabel: "kept-label",
      workspaceNumber: 1,
      tabId: "w1:t1",
      tabLabel: PLANTED[0],
      agent: "claude",
      status: "blocked",
      cwd: PLANTED[2],
      focused: false,
      kind: "agent",
      terminalTitle: PLANTED[0],
      held: [{ id: "h1", text: PLANTED[1] }],
      asks: [{ id: "a1", question: PLANTED[3] }],
      draft: PLANTED[1],
    },
  ],
  shellPanes: [],
};

/**
 * A session runtime with no panes of its own. Every member of {@link SessionParts} is a class with
 * private fields, so no fake can be one structurally; `Partial<T>` keeps each supplied method checked.
 */
function stubPart<T>(impl: Partial<T>): T {
  // SAFETY: on a session with no panes the snapshot route asks the engine for `current()` and
  // `noteAttention()`, the config route reads the adapter's `herdr` block only as an optional value,
  // and the registry asks the adapter only `listSessions`; each is supplied here.
  return impl as T;
}

const emptyParts = (): SessionParts => ({
  herdr: stubPart<SessionParts["herdr"]>({ listSessions: () => Promise.resolve(muxOk([])) }),
  engine: stubPart<SessionParts["engine"]>({ current: () => ({ agents: [], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" }), noteAttention: () => undefined, stop: () => undefined }),
  poker: stubPart<SessionParts["poker"]>({ stop: () => undefined }),
  notifications: stubPart<SessionParts["notifications"]>({ clearAll: () => undefined }),
});

/** Every string anywhere in a JSON value. */
function stringsOf(value: JsonValue | undefined): string[] {
  const s = asJsonString(value);
  if (s !== undefined) return [s];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  const o = asJsonObject(value);
  return o === undefined ? [] : Object.values(o).flatMap(stringsOf);
}

describe("the local key on the real snapshot route: a member's body reaches it only as the view", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "collie-local-key-server-"));
  const secret = mintLocalSecret();
  let base = "";
  let stop: () => void = () => undefined;
  let phoneToken = "";

  beforeAll(async () => {
    const cfg = { ...loadConfig({ HOME: stateDir, COLLIE_STATE_DIR: stateDir }), host: "127.0.0.1", port: 0 };
    const roster = [member({ memberId: MEMBER })];
    const crewRegistry = new CrewRegistry({ sessions: { get: () => undefined }, self: "desk", members: () => roster });
    const crewLead = new CrewLead({
      log: () => undefined,
      registry: crewRegistry,
      snapshot: async (_link: CrewLink): Promise<PeerOutcome<unknown>> => ({
        ok: true,
        value: memberBody,
        status: 200,
        member: null,
        receivedAt: Date.now(),
        date: null,
      }),
      proxy: neverProxy,
      self: { id: "desk", name: "desk" },
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
    });
    // One sweep banks the member's body; the route then answers from the cache and dials nobody.
    await crewLead.sweep();

    const pairing = new PairingStore(filePairingIo(stateDir));
    phoneToken = (await pairing.enrolApproved("phone")).token;
    // `latest` is set, so the update check takes no on-demand look; the notes carry planted text.
    const updateMonitor: Pick<UpdateMonitor, "status" | "notes"> = {
      status: () => ({
        current: "1.0.0",
        latest: "1.0.0",
        latestUrl: null,
        releaseAvailable: false,
        majorAvailable: null,
        majorUrl: null,
        installKind: "binary",
        dismissedVersion: null,
        dismissedCrewVersion: null,
        bridgeStale: false,
        restartNeeded: false,
        checkedAt: null,
      }),
      notes: () => Promise.resolve({ current: { version: "1.0.0", url: PLANTED[2], groups: [{ name: "Fixed", leads: [PLANTED[3]] }] }, offered: [] }),
    };
    const server = startServer({
      cfg,
      registry: new SessionRegistry({ configRoot: stateDir, primarySocketPath: join(stateDir, "herdr.sock"), factory: emptyParts, multiSession: false }),
      push: new Push(cfg),
      snooze: new Snooze(cfg),
      notifyPrefs: new NotifyPrefsStore(cfg),
      // SAFETY: the snapshot route reads `status()` (`updateStatusWithPeers`) and the update check reads
      // `status()` and `notes()`, `checkRelease()` only while `latest` is null; no other route is asked here.
      updateMonitor: updateMonitor as UpdateMonitor,
      version: "1.0.0",
      audit: new AuditLog(() => undefined),
      activity: new ActivityLedger(cfg),
      crew: { mode: "lead", peerServesBrowser: false, conflict: null, trickReads: false },
      crewLead,
      pairing,
      localCredential: localCredentialOf(secret),
    });
    base = `http://127.0.0.1:${String(server.port)}`;
    stop = () => void server.stop(true);
  });

  afterAll(() => {
    stop();
    rmSync(stateDir, { recursive: true, force: true });
  });

  const get = async (path: string, token: string): Promise<{ status: number; body: JsonValue }> => {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    // SAFETY: every answer of this route is a JSON document; the test reads it as data only.
    return { status: res.status, body: (await res.json()) as JsonValue };
  };

  test("a paired phone gets the member's full pane, so the planted text is really on the route", async () => {
    const { status, body } = await get(`/api/snapshot?host=${MEMBER}`, phoneToken);
    expect(status).toBe(200);
    const said = stringsOf(body);
    for (const value of PLANTED) expect({ value, found: said.includes(value) }).toEqual({ value, found: true });
  });

  for (const path of [`/api/snapshot?host=${MEMBER}`, "/api/snapshot?sessions=all", `/api/snapshot?host=${MEMBER}&sessions=all`]) {
    test(`the key on ${path} gets the member's pane as the view, with none of its text`, async () => {
      const { status, body } = await get(path, secret);
      expect(status).toBe(200);
      const said = stringsOf(body);
      for (const value of PLANTED) expect({ value, found: said.includes(value) }).toEqual({ value, found: false });
      const agents = asJsonObject(body)?.agents;
      expect(Array.isArray(agents) ? agents.map((p) => Object.keys(asJsonObject(p) ?? {}).toSorted()) : null).toEqual([
        ["agent", "host", "kind", "paneId", "status", "workspaceLabel", "workspaceNumber"],
      ]);
    });
  }

  test("the key on the update check gets the crew rows and no release note; a phone gets the notes", async () => {
    const phone = await get("/api/update/check", phoneToken);
    expect(stringsOf(phone.body)).toContain(PLANTED[3]);
    const { status, body } = await get("/api/update/check", secret);
    expect(status).toBe(200);
    // The member sent no update report, so its row is `unknown` with `asOf: null`, which the view drops.
    expect(body).toEqual({ crew: [{ name: MEMBER, verdict: "unknown", reasons: [`we could not check ${MEMBER}`] }] });
  });

  test("the key on the config gets an empty body for a known session and the 404 for an unknown one", async () => {
    expect(await get("/api/config", secret)).toEqual({ status: 200, body: {} });
    const unknown = await get("/api/config?session=no-such-session", secret);
    expect(unknown.status).toBe(404);
  });
});
