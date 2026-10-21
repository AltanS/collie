// Surface shadow mode (M56 spec 04) against a fake multiplexer: the read, the fold, the comparison
// with the old verdict, the journal line and the counters. No process runs: the version reader is
// injected and the screens are the committed pane fixtures.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../config.ts";
import type { MuxGrid, MuxGridRequest, MuxOutcome } from "../mux/types.ts";
import { guard, SURFACE_OFF_TEXT, surfaceRoute } from "../server.ts";
import type { AgentView } from "../types.ts";
import { askOf } from "../../web/src/lib/surface/surface.ts";
import { SurfaceLedger } from "./counters.ts";
import { DISAGREE_REPEAT_MS, DISAGREE_TAG, SurfaceShadow, freeOnOldAxis, maskSurface, surfaceRouteBody } from "./shadow.ts";

const PANES = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes");
const screen = (name: string): string => readFileSync(join(PANES, name), "utf8");

const IDLE = "claude-lab--idle-after-turn--w82.txt";
const PERMISSION = "claude-lab--permission-bash--w82.txt";
/** The /usage panel over a live box: a strong cue no reader lifts. (The rating survey stood here until
 *  2026-10-19, when it became a notice, ADR 0109.) */
const PANEL = "claude--v2301-usage-panel-over-box--w82.txt";
/** A dialog fixture whose screen still shows a live box: the Surface sees no modal, the old reader a block. */
const AGENTS = "claude-lab--agents-screen--w82.txt";
/** The harness id the fixtures were captured under; the profile is picked by it. Test files are
 *  outside the surface code's name ban (no-harness-names.test.ts). */
const HARNESS = "claude";

class FakeMux {
  screens = new Map<string, { text: string; revision: number }>();
  reads: { paneId: string; request: MuxGridRequest }[] = [];
  failing = new Set<string>();
  set(paneId: string, name: string, revision: number): void {
    this.screens.set(paneId, { text: screen(name), revision });
  }
  readGrid = async (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    this.reads.push({ paneId, request });
    const s = this.screens.get(paneId);
    if (s === undefined || this.failing.has(paneId)) return { ok: false, reason: "gone", detail: "no such pane" };
    return { ok: true, value: { paneId, text: s.text, truncated: false, revision: s.revision } };
  };
}

function agent(paneId: string, harness = HARNESS): AgentView {
  return { paneId, workspaceId: "w1", workspaceLabel: "one", workspaceNumber: 1, tabId: "w1:t1", agent: harness, status: "idle", cwd: "/x", focused: false };
}

function rig() {
  const mux = new FakeMux();
  const lines: string[] = [];
  let clock = 1_000_000;
  let versionReads = 0;
  const shadow = new SurfaceShadow({
    mux,
    pollMs: 1000,
    log: (line) => lines.push(line),
    now: () => clock,
    version: async () => {
      versionReads++;
      return "2.1.296";
    },
  });
  return {
    mux,
    lines,
    shadow,
    tick: (ms: number) => (clock += ms),
    versionReads: () => versionReads,
  };
}

describe("surface shadow", () => {
  test("reads the viewport and serves the Surface of an idle box as free, with no journal line", async () => {
    const r = rig();
    r.mux.set("w1:p1", IDLE, 7);
    await r.shadow.observe([agent("w1:p1")]);
    expect(r.mux.reads[0]!.request).toEqual({ scope: "viewport", lines: 120, styling: "preserve" });
    expect(r.shadow.surfaceOf("w1:p1")).toEqual({ revision: 7, turn: "idle", modal: "none", composer: "empty" });
    expect(r.lines).toEqual([]);
    const counters = r.shadow.report().counters[`${HARNESS}@2.1.296`]!;
    expect(counters).toEqual({ observed: 1, free: 1, unknown: {}, modal: {}, disagreements: 0 });
  });

  test("lifts a permission dialog as an ask and counts it by kind", async () => {
    const r = rig();
    r.mux.set("w1:p1", PERMISSION, 3);
    await r.shadow.observe([agent("w1:p1")]);
    const surface = r.shadow.surfaceOf("w1:p1")!;
    expect(askOf(surface.modal)?.kind).toBe("permission");
    expect(r.shadow.report().counters[`${HARNESS}@2.1.296`]!.modal).toEqual({ permission: 1 });
    expect(r.lines).toEqual([]);
  });

  test("a strong cue no reader lifted reads unreadable and is counted", async () => {
    const r = rig();
    r.mux.set("w1:p1", PANEL, 3);
    await r.shadow.observe([agent("w1:p1")]);
    expect(r.shadow.surfaceOf("w1:p1")!.modal).toBe("unreadable");
    expect(r.shadow.report().counters[`${HARNESS}@2.1.296`]!.modal).toEqual({ unreadable: 1 });
  });

  test("a disagreement writes one journal line with the verdicts and a cluster hash, never the rows", async () => {
    const r = rig();
    r.mux.set("w1:p1", AGENTS, 11);
    await r.shadow.observe([agent("w1:p1")]);
    expect(r.lines).toHaveLength(1);
    const line = r.lines[0]!;
    expect(line).toContain(DISAGREE_TAG);
    expect(line).toContain("pane=w1:p1");
    expect(line).toContain("rev=11");
    expect(line).toContain("new=free");
    expect(line).toContain("old=not-free");
    expect(line).toContain(`harness=${HARNESS} version=2.1.296`);
    expect(line).toMatch(/reason=\S+/);
    expect(line).toMatch(/cluster=[0-9a-f]{14}\b/);
    // No screen text reaches the journal: no word of the fixture's rows is in the line.
    const words = new Set(screen(AGENTS).split(/[^A-Za-z]+/).filter((w) => w.length >= 5));
    const ours = new Set(["surface", "shadow", "disagree", "draft", "empty", HARNESS]);
    expect([...words].filter((word) => line.includes(word) && !ours.has(word.toLowerCase()))).toEqual([]);
    expect(r.shadow.report().counters[`${HARNESS}@2.1.296`]!.disagreements).toBe(1);
  });

  test("with the comparison off (the Send Protocol on, M56 spec 06) the same screen counts and logs no disagreement", async () => {
    const lines: string[] = [];
    const mux = new FakeMux();
    const shadow = new SurfaceShadow({ mux, pollMs: 1000, log: (line) => lines.push(line), now: () => 1_000_000, version: async () => "2.1.296", compare: false });
    mux.set("w1:p1", AGENTS, 11);
    await shadow.observe([agent("w1:p1")]);
    expect(lines).toEqual([]);
    expect(shadow.report().counters[`${HARNESS}@2.1.296`]).toMatchObject({ observed: 1, disagreements: 0 });
    expect(shadow.surfaceOf("w1:p1")).toBeDefined();
  });

  test("the same revision is counted and logged once, however many polls see it", async () => {
    const r = rig();
    r.mux.set("w1:p1", AGENTS, 11);
    for (let i = 0; i < 5; i++) {
      await r.shadow.observe([agent("w1:p1")]);
      r.tick(1000);
    }
    expect(r.lines).toHaveLength(1);
    expect(r.shadow.report().counters[`${HARNESS}@2.1.296`]!.observed).toBe(1);
    expect(r.mux.reads).toHaveLength(5);
  });

  test("a multiplexer whose revision is a stub 0 still counts each new screen once", async () => {
    const r = rig();
    r.mux.set("w1:p1", IDLE, 0);
    await r.shadow.observe([agent("w1:p1")]);
    await r.shadow.observe([agent("w1:p1")]);
    r.mux.set("w1:p1", PERMISSION, 0);
    await r.shadow.observe([agent("w1:p1")]);
    const counters = r.shadow.report().counters[`${HARNESS}@2.1.296`]!;
    expect(counters.observed).toBe(2);
    expect(counters.modal).toEqual({ permission: 1 });
  });

  test("one class repeats on a pane at most once a minute; the counters count every read", async () => {
    const r = rig();
    for (let rev = 1; rev <= 4; rev++) {
      r.mux.set("w1:p1", AGENTS, rev);
      await r.shadow.observe([agent("w1:p1")]);
      r.tick(1000);
    }
    expect(r.lines).toHaveLength(1);
    expect(r.shadow.report().counters[`${HARNESS}@2.1.296`]!.disagreements).toBe(4);
    r.tick(DISAGREE_REPEAT_MS);
    r.mux.set("w1:p1", AGENTS, 5);
    await r.shadow.observe([agent("w1:p1")]);
    expect(r.lines).toHaveLength(2);
  });

  test("a pane that cannot be read is unreachable and never free", async () => {
    const r = rig();
    r.mux.set("w1:p1", IDLE, 2);
    await r.shadow.observe([agent("w1:p1")]);
    r.mux.failing.add("w1:p1");
    r.tick(1000);
    await r.shadow.observe([agent("w1:p1")]);
    expect(r.shadow.surfaceOf("w1:p1")).toMatchObject({ composer: "unreachable", modal: "unknown" });
  });

  test("a poll that lands during a slow read ticks, and a read older than two polls goes stale", async () => {
    const mux = new FakeMux();
    mux.set("w1:p1", IDLE, 2);
    let clock = 0;
    let release: () => void = () => {};
    const shadow = new SurfaceShadow({ mux, pollMs: 1000, log: () => {}, now: () => clock, version: async () => "2.1.296" });
    await shadow.observe([agent("w1:p1")]);
    expect(shadow.surfaceOf("w1:p1")!.composer).toBe("empty");
    const slow = mux.readGrid;
    mux.readGrid = (paneId, request) => new Promise((resolve) => (release = () => void slow(paneId, request).then(resolve)));
    clock = 1000;
    const first = shadow.observe([agent("w1:p1")]);
    await Promise.resolve();
    clock = 4000;
    await shadow.observe([agent("w1:p1")]);
    expect(shadow.surfaceOf("w1:p1")).toEqual({ revision: 2, turn: "unknown", modal: "unknown", composer: "unknown", reason: "stale" });
    release();
    await first;
  });

  test("a harness with no profile reads unknown with no version, under its own counter", async () => {
    const r = rig();
    r.mux.set("w1:p2", "codex--fresh-idle.txt", 1);
    // Codex has a profile since M56 spec 13, so its screen stands in here for a harness with none.
    await r.shadow.observe([agent("w1:p2", "nothing-known")]);
    expect(r.shadow.surfaceOf("w1:p2")).toMatchObject({ modal: "unknown", composer: "unknown" });
    expect(Object.keys(r.shadow.report().counters)).toEqual(["nothing-known@-"]);
    expect(r.versionReads()).toBe(0);
  });

  test("reads the version once per profile and forgets panes that are gone", async () => {
    const r = rig();
    r.mux.set("w1:p1", IDLE, 1);
    r.mux.set("w1:p3", IDLE, 1);
    await r.shadow.observe([agent("w1:p1"), agent("w1:p3")]);
    expect(r.versionReads()).toBe(1);
    await r.shadow.observe([agent("w1:p1")]);
    expect(r.shadow.surfaceOf("w1:p3")).toBeUndefined();
    expect(r.shadow.report().panes.map((p) => p.pane)).toEqual(["w1:p1"]);
  });

  test("never throws when a read rejects", async () => {
    const r = rig();
    r.mux.readGrid = async () => {
      throw new Error("socket closed");
    };
    await expect(r.shadow.observe([agent("w1:p1")])).resolves.toBeUndefined();
  });
});

describe("the old verdict's axis", () => {
  test("a draft and a running turn agree with the old reader; a modal or a lost box does not", () => {
    expect(freeOnOldAxis({ revision: 1, turn: "running", modal: "none", composer: "empty" })).toBe(true);
    expect(freeOnOldAxis({ revision: 1, turn: "idle", modal: "none", composer: "draft" })).toBe(true);
    expect(freeOnOldAxis({ revision: 1, turn: "idle", modal: "unreadable", composer: "empty" })).toBe(false);
    expect(freeOnOldAxis({ revision: 1, turn: "unknown", modal: "unknown", composer: "unknown", reason: "no-match" })).toBe(false);
  });
});

describe("the debug route body", () => {
  test("one pane with its counters, every pane without a pane, 404 for a pane not read", async () => {
    const r = rig();
    r.mux.set("w1:p1", IDLE, 4);
    await r.shadow.observe([agent("w1:p1")]);
    const one = surfaceRouteBody(r.shadow, "w1:p1", false);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ pane: "w1:p1", version: "2.1.296", status: "verified", surface: { revision: 4 }, counters: { observed: 1, free: 1 } });
    const all = surfaceRouteBody(r.shadow, null, false);
    expect(all.status).toBe(200);
    // SAFETY: a 200 with no pane asked is `{ panes, counters }` (surfaceRouteBody); the length check reads it.
    expect((all.body as { panes: unknown[] }).panes).toHaveLength(1);
    expect(surfaceRouteBody(r.shadow, "w9:p9", false).status).toBe(404);
  });

  test("the mask covers an ask's option labels and nothing else", () => {
    const ask = { id: "ask-1", kind: "permission" as const, options: [{ id: "1", label: "Yes, run password=placeholder1" }], channel: "keys" as const, hash: "0" };
    const masked = maskSurface({ revision: 1, turn: "idle", modal: { ask }, composer: "empty" });
    expect(askOf(masked.modal)?.options[0]?.label).not.toContain("placeholder1");
    expect(askOf(masked.modal)?.options[0]?.label).toContain("password=");
    const plain = { revision: 1, turn: "idle", modal: "none", composer: "empty" } as const;
    expect(maskSurface(plain)).toBe(plain);
  });
});

describe("the debug route", () => {
  // The handler in server.ts runs inside Bun.serve: the gate, then the session, then `surfaceRoute`.
  // The gate and `surfaceRoute` are run here for real; the order in the handler is read off the source,
  // as server.test.ts does for the other routes inside Bun.serve.
  const config = loadConfig({ COLLIE_STATE_DIR: "/nonexistent-m56-surface-state" });
  const gate = {
    enforced: () => true,
    resolve: (token: string | null) => (token === "tok-phone" ? { label: "phone" } : null),
  };
  const request = (headers: Record<string, string>): Request =>
    new Request("http://collie.invalid/api/surface?pane=w1:p1", { headers: { host: "127.0.0.1:8787", ...headers } });

  test("is token-gated as a read: no token or a wrong one is a 403, the paired token passes", async () => {
    const none = guard(request({}), config, "read", gate);
    expect(none?.status).toBe(403);
    expect(await none!.text()).toBe("device not paired");
    expect(guard(request({ authorization: "Bearer tok-other" }), config, "read", gate)?.status).toBe(403);
    expect(guard(request({ authorization: "Bearer tok-phone" }), config, "read", gate)).toBeNull();
  });

  test("the handler gates first, then resolves the session, then answers through surfaceRoute", () => {
    const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    const at = src.indexOf('if (pathname === "/api/surface" && req.method === "GET") {');
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, src.indexOf("\n      }\n", at));
    const gateAt = block.indexOf('const denied = guard(req, cfg, "read", pairingGate);');
    const deniedAt = block.indexOf("if (denied) return denied;");
    const sessionAt = block.indexOf("localRuntime(");
    const answerAt = block.indexOf("return surfaceRoute(rt.surface,");
    expect(gateAt).toBeGreaterThan(0);
    expect(deniedAt).toBeGreaterThan(gateAt);
    expect(sessionAt).toBeGreaterThan(deniedAt);
    expect(answerAt).toBeGreaterThan(sessionAt);
  });

  test("with the mode off the route is a 404 that says why", async () => {
    const off = surfaceRoute(undefined, "w1:p1", false, null);
    expect(off.status).toBe(404);
    expect(await off.text()).toBe(SURFACE_OFF_TEXT);
    expect(SURFACE_OFF_TEXT).toContain("COLLIE_SURFACE_SHADOW=1");
  });

  test("with the mode on it answers the shadow's body as JSON, and a pane not read is a 404", async () => {
    const r = rig();
    r.mux.set("w1:p1", IDLE, 4);
    await r.shadow.observe([agent("w1:p1")]);
    const on = surfaceRoute(r.shadow, "w1:p1", false, null);
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ pane: "w1:p1", surface: { revision: 4, modal: "none" } });
    expect(surfaceRoute(r.shadow, "w9:p9", false, null).status).toBe(404);
  });
});

describe("surface shadow: the persisted counters (M56 spec 09)", () => {
  test("every new read lands in the ledger under harness, version, profile and status; an unknown one files its cluster hash", async () => {
    const state = mkdtempSync(join(tmpdir(), "collie-shadow-ledger-"));
    try {
      const ledger = new SurfaceLedger(state, { now: () => 1_000_000, warn: () => undefined });
      const mux = new FakeMux();
      const shadow = new SurfaceShadow({ mux, pollMs: 1000, log: () => undefined, now: () => 1_000_000, version: async () => "2.1.296", ledger });
      mux.set("w1:p1", IDLE, 1);
      await shadow.observe([agent("w1:p1")]);
      // The same screen again is not a new read: counted once.
      await shadow.observe([agent("w1:p1")]);
      mux.set("w1:p1", PERMISSION, 2);
      await shadow.observe([agent("w1:p1")]);
      expect(ledger.rows()).toMatchObject([{ harness: HARNESS, version: "2.1.296", profileId: HARNESS, free: 1, modal: { permission: 1 } }]);
      // A pane of a harness with no profile counts under `-` for its profile and status.
      mux.set("w1:p2", IDLE, 3);
      await shadow.observe([agent("w1:p2", "nothing-known")]);
      const unknown = ledger.rows().find((row) => row.harness === "nothing-known");
      expect(unknown).toMatchObject({ version: "-", profileId: "-", status: "-" });
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("both names a multiplexer reports for a harness file under its profile id (M56 spec 14 review)", async () => {
    const state = mkdtempSync(join(tmpdir(), "collie-shadow-alias-"));
    try {
      const ledger = new SurfaceLedger(state, { now: () => 1_000_000, warn: () => undefined });
      const mux = new FakeMux();
      const shadow = new SurfaceShadow({ mux, pollMs: 1000, log: () => undefined, now: () => 1_000_000, version: async () => "1.1.17", ledger });
      mux.set("w1:p1", "agy--fresh-idle.txt", 1);
      mux.set("w1:p2", "agy--fresh-idle.txt", 2);
      await shadow.observe([agent("w1:p1", "agy"), agent("w1:p2", "antigravity")]);
      expect(ledger.rows()).toMatchObject([{ harness: "agy", version: "1.1.17", profileId: "agy", free: 2 }]);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("a ledger that throws leaves the Surface as it was", async () => {
    const mux = new FakeMux();
    const broken = {
      read: () => {
        throw new Error("disk full");
      },
    };
    const shadow = new SurfaceShadow({ mux, pollMs: 1000, log: () => undefined, now: () => 1_000_000, version: async () => "2.1.296", ledger: broken });
    mux.set("w1:p1", IDLE, 1);
    await shadow.observe([agent("w1:p1")]);
    expect(shadow.surfaceOf("w1:p1")).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "empty" });
  });
});
