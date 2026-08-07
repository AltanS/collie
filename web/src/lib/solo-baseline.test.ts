import { readFileSync } from "node:fs";
import { join } from "node:path";

import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { fetchSnapshot } from "./api";
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
const goldenSnapshot = JSON.parse(readFileSync(GOLDEN, "utf8")) as SnapshotResponse;

// Exhaustive by construction: `Record<keyof T, true>` makes every key of T — optional ones included —
// required here, so adding `servers?:` or `host?:` to a mirror type fails `bun run typecheck`.
const SNAPSHOT_KEYS: Record<keyof SnapshotResponse, true> = {
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
};

const SESSION_SUMMARY_KEYS: Record<keyof SessionSummary, true> = {
  name: true,
  isPrimary: true,
  reachable: true,
  agents: true,
  working: true,
  blocked: true,
};

const AGENT_VIEW_KEYS: Record<keyof AgentView, true> = {
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
};

const DEVICE_AUTH_KEYS: Record<keyof DeviceAuth, true> = {
  enforced: true,
  device: true,
  authorized: true,
};

const UPDATE_INFO_KEYS: Record<keyof UpdateInfo, true> = {
  current: true,
  latest: true,
  latestUrl: true,
  releaseAvailable: true,
  bridgeStale: true,
  checkedAt: true,
};

describe("solo zero-tax — the client's mirror types carry no pack dimension", () => {
  it("SnapshotResponse mirrors the bridge's field set exactly", () => {
    expect(Object.keys(SNAPSHOT_KEYS).sort()).toEqual([
      "agents",
      "bridge",
      "device",
      "notifications",
      "sessions",
      "shellPanes",
      "tabs",
      "ts",
      "update",
      "workspaces",
    ]);
  });

  it("SessionSummary, AgentView and the supporting types gained no `host`", () => {
    expect(Object.keys(SESSION_SUMMARY_KEYS)).not.toContain("host");
    expect(Object.keys(AGENT_VIEW_KEYS)).not.toContain("host");
    expect(Object.keys(AGENT_VIEW_KEYS).sort()).toEqual([
      "agent",
      "cwd",
      "focused",
      "hasSession",
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
      "workspaceId",
      "workspaceLabel",
      "workspaceNumber",
    ]);
    expect(Object.keys(DEVICE_AUTH_KEYS).sort()).toEqual(["authorized", "device", "enforced"]);
    expect(Object.keys(UPDATE_INFO_KEYS).sort()).toEqual([
      "bridgeStale",
      "checkedAt",
      "current",
      "latest",
      "latestUrl",
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
