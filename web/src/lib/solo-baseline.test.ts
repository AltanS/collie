import { readFileSync } from "node:fs";
import { join } from "node:path";

import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { fetchSnapshot } from "./api";
import { healthFor, hostHealthMap, writeRefusal } from "./host-health";
import { HOST_PARAM, normalizeSession, scopeSearch, SESSION_PARAM, sessionSearch } from "./session";
import type {
  AgentView,
  DeviceAuth,
  SessionSummary,
  SnapshotResponse,
  UpdateInfo,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// SOLO ZERO-TAX BASELINE — the client half.
//
// The bridge half lives in `bridge/solo-baseline.test.ts` and owns the contract (PACK_PROTOCOL.md
// §11). This file pins the two things only the frontend can answer: that the hand-mirrored wire
// types here gained no pack dimension either (they would otherwise drift into accepting a `servers`
// the bridge must then emit), and that a solo client puts NO host param on the wire — §11's `?h=`
// row: "never emitted by the client, never present in a URL".
//
// The golden snapshot is read from the BRIDGE's fixture on purpose, the same way
// `bridge/prompt-binding.test.ts` reads a web fixture: one committed body, both sides pinned to it.
// A failure here is not a stale golden — it is a solo user being taxed.
// ─────────────────────────────────────────────────────────────────────────────

const GOLDEN = join(__dirname, "..", "..", "..", "bridge", "fixtures", "solo-baseline", "snapshot.json");
// SAFETY: the golden is the bridge's own committed solo body — `bridge/prompt-binding.test.ts`
// reads the same file and pins it from the other side, so its shape IS `SnapshotResponse`. The
// assertions below are what would fail if it ever stopped being.
const goldenSnapshot = JSON.parse(readFileSync(GOLDEN, "utf8")) as SnapshotResponse;

// Exhaustive by construction: `Record<keyof T, true>` makes every key of T — optional ones included —
// required here, so adding `servers?:` or `host?:` to a mirror type fails `bun run typecheck`.
//
// ── THE TRIPWIRE FIRED, IN M5/02 — THE CLIENT HALF OF M4/04 ──────────────────
// `servers?:` (SnapshotResponse) and `host?:` (SessionSummary, AgentView) are the frontend mirrors of
// the fields the snapshot merge added bridge-side; `bridge/solo-baseline.test.ts` recorded the same
// three, the same way, in M4/04. Read it as the type-level guard working: the mirror cannot grow a
// pack dimension without an author acknowledging it HERE.
//
// **No golden was regenerated and no byte moved.** All three are optional-and-absent, so the bridge's
// committed solo body still contains none of them — which the golden assertion below now states
// positively, not just as "no unknown keys". Only the key-LIST assertions in this file changed; every
// byte-level and wire-level assertion is untouched. (§11's "Why `servers` is optional-and-absent".)
const SNAPSHOT_KEYS = {
  bridge: true,
  device: true,
  agents: true,
  shellPanes: true,
  workspaces: true,
  tabs: true,
  notifications: true,
  sessions: true,
  update: true,
  ts: true,
  // Present on the type since M5/02, absent from every solo body — see the section header.
  servers: true,
} satisfies Record<keyof SnapshotResponse, true>;

const SESSION_SUMMARY_KEYS = {
  name: true,
  isPrimary: true,
  reachable: true,
  agents: true,
  working: true,
  blocked: true,
  host: true,
} satisfies Record<keyof SessionSummary, true>;

const AGENT_VIEW_KEYS = {
  paneId: true,
  workspaceId: true,
  workspaceLabel: true,
  workspaceNumber: true,
  tabId: true,
  agent: true,
  status: true,
  cwd: true,
  focused: true,
  kind: true,
  paneLabel: true,
  sessionName: true,
  hasSession: true,
  readableLines: true,
  tabLabel: true,
  lastActiveAt: true,
  lastSeenAt: true,
  host: true,
  // NOT a pack dimension — an ordinary optional feature field (0.29.0, panes named by their OSC
  // title). Recorded here because the tripwire is exhaustive over `keyof AgentView`, not because it
  // carries a host.
  terminalTitle: true,
  // Also not a pack dimension: an optional sentence the bridge composes about one kind of pane
  // (M11/05), rendered as text and absent everywhere else.
  hint: true,
} satisfies Record<keyof AgentView, true>;

const DEVICE_AUTH_KEYS = {
  enforced: true,
  device: true,
  authorized: true,
} satisfies Record<keyof DeviceAuth, true>;

const UPDATE_INFO_KEYS = {
  current: true,
  latest: true,
  latestUrl: true,
  releaseAvailable: true,
  majorAvailable: true,
  majorUrl: true,
  bridgeStale: true,
  checkedAt: true,
} satisfies Record<keyof UpdateInfo, true>;

describe("solo zero-tax — the client's mirror types carry no pack dimension", () => {
  it("SnapshotResponse mirrors the bridge's field set exactly", () => {
    expect(Object.keys(SNAPSHOT_KEYS).toSorted()).toEqual([
      "agents",
      "bridge",
      "device",
      "notifications",
      "servers",
      "sessions",
      "shellPanes",
      "tabs",
      "ts",
      "update",
      "workspaces",
    ]);
  });

  it("the pack dimension is on the mirror types, and every field of it is optional", () => {
    // Renegotiated in M5/02 (see the header above the key maps): `servers`/`host` EXIST here now,
    // mirroring bridge/types.ts. What must never change is that they are optional — a solo bridge
    // emits none of them, so a snapshot literal without them still satisfies the type.
    const solo: SnapshotResponse = {
      bridge: "connected",
      agents: [],
      shellPanes: [],
      workspaces: [],
      tabs: [],
      ts: 0,
    };
    expect(Object.keys(solo)).not.toContain("servers");
    expect(SNAPSHOT_KEYS.servers).toBe(true);
    expect(SESSION_SUMMARY_KEYS.host).toBe(true);
    expect(AGENT_VIEW_KEYS.host).toBe(true);
    expect(Object.keys(AGENT_VIEW_KEYS).toSorted()).toEqual([
      "agent",
      "cwd",
      "focused",
      "hasSession",
      "hint",
      "host",
      "kind",
      "lastActiveAt",
      "lastSeenAt",
      "paneId",
      "paneLabel",
      "readableLines",
      "sessionName",
      "status",
      "tabId",
      "tabLabel",
      "terminalTitle",
      "workspaceId",
      "workspaceLabel",
      "workspaceNumber",
    ]);
    expect(Object.keys(DEVICE_AUTH_KEYS).toSorted()).toEqual(["authorized", "device", "enforced"]);
    expect(Object.keys(UPDATE_INFO_KEYS).toSorted()).toEqual([
      "bridgeStale",
      "checkedAt",
      "current",
      "latest",
      "latestUrl",
      "majorAvailable",
      "majorUrl",
      "releaseAvailable",
    ]);
  });

  it("every key in the bridge's golden solo snapshot is one the client already knows", () => {
    const known = new Set(Object.keys(SNAPSHOT_KEYS));
    expect(Object.keys(goldenSnapshot).filter((k) => !known.has(k))).toEqual([]);
    const paneKeys = new Set(Object.keys(AGENT_VIEW_KEYS));
    for (const pane of [...goldenSnapshot.agents, ...goldenSnapshot.shellPanes]) {
      expect(Object.keys(pane).filter((k) => !paneKeys.has(k))).toEqual([]);
    }
    const sessionKeys = new Set(Object.keys(SESSION_SUMMARY_KEYS));
    for (const s of goldenSnapshot.sessions ?? []) {
      expect(Object.keys(s).filter((k) => !sessionKeys.has(k))).toEqual([]);
    }
  });

  it("the golden solo body carries NONE of the pack fields the types now allow", () => {
    // The half the key maps can no longer state on their own, now that `servers`/`host` are known
    // keys: a solo BODY still has none of them. This is the byte-level claim §11 actually makes, and
    // it is why M5/02 renegotiated the key lists without regenerating a single golden.
    expect(goldenSnapshot).not.toHaveProperty("servers");
    for (const pane of [...goldenSnapshot.agents, ...goldenSnapshot.shellPanes]) {
      expect(pane).not.toHaveProperty("host");
    }
    for (const s of goldenSnapshot.sessions ?? []) {
      expect(s).not.toHaveProperty("host");
    }
  });
});

describe("solo zero-tax — a solo client puts no host on the wire", () => {
  it("the session param is `s`, and a solo scope emits no host param at all", () => {
    expect(SESSION_PARAM).toBe("s");
    expect(sessionSearch(undefined)).toBe("");
    expect(sessionSearch("collie-demo")).toBe("?s=collie-demo");
    expect(normalizeSession("")).toBeUndefined();
    // The host param EXISTS (the addressing dimension shipped), but a solo client never produces it:
    // no host means no `?h=`, so every URL a solo install builds is byte-identical to before.
    expect(HOST_PARAM).toBe("h");
    expect(scopeSearch({})).toBe("");
    expect(scopeSearch({ host: undefined, session: undefined })).toBe("");
    expect(scopeSearch({ session: "collie-demo" })).toBe("?s=collie-demo");
    expect(scopeSearch({ session: "collie-demo" })).toBe(sessionSearch("collie-demo"));
  });

  it("fetchSnapshot on a solo install requests a bare /api/snapshot — no query at all", async () => {
    const urls: string[] = [];
    server.use(
      http.get("/api/snapshot", ({ request }) => {
        urls.push(new URL(request.url).search);
        return HttpResponse.json(goldenSnapshot);
      }),
    );
    const snap = await fetchSnapshot();
    expect(urls).toEqual([""]);
    // Round-trips the bridge's golden body untouched.
    expect(snap).toEqual(goldenSnapshot);
  });

  it("a named session still only ever adds `session=` — never `h=` or `host=`", async () => {
    const urls: string[] = [];
    server.use(
      http.get("/api/snapshot", ({ request }) => {
        urls.push(new URL(request.url).search);
        return HttpResponse.json(goldenSnapshot);
      }),
    );
    await fetchSnapshot({ session: "collie-demo" });
    expect(urls).toEqual(["?session=collie-demo"]);
    expect(urls[0]).not.toMatch(/\b(h|host)=/);
  });
});

// TIER 2 (lead↔peer health) is the newest thing that could tax a solo install, because it is the
// first pack feature that DERIVES rather than merely labels — and a derivation that produces an
// entry for "here" would give a one-machine install a peer-health dimension it has no peers for.
describe("solo runs no per-host health machinery at all", () => {
  it("derives an empty health map from the golden solo snapshot", () => {
    // `servers` is optional-and-absent in the committed solo body (§11), which is the whole input.
    expect(goldenSnapshot.servers).toBeUndefined();
    const map = hostHealthMap(goldenSnapshot.servers, { at: goldenSnapshot.ts, pollMs: 1500 });
    expect(map.size).toBe(0);
  });

  it("answers 'nothing to say' for every lookup, so no surface can render host chrome or refuse a write", () => {
    const map = hostHealthMap(goldenSnapshot.servers, { at: goldenSnapshot.ts, pollMs: 1500 });
    // `undefined` (no host in hand) and a named host both answer the same on solo — there is no
    // host dimension to be wrong about, which is what makes the hide rule data rather than a flag.
    expect(healthFor(map, undefined)).toBeUndefined();
    expect(healthFor(map, "anything")).toBeUndefined();
    expect(writeRefusal(healthFor(map, "anything"))).toBeUndefined();
  });
});
