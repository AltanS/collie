import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { AuditLog, fileAuditAppender, formatAuditLine, type AuditEntry } from "./audit.ts";
import { ActivityLedger } from "./activity.ts";
import { loadConfig, type Config } from "./config.ts";
import { computeEtag } from "./http-cache.ts";
import { NotifyPrefsStore } from "./notify-prefs.ts";
import type { PushMessage } from "./push.ts";
import { TrustStore } from "./pack/trust-store.ts";
import { Snooze } from "./snooze.ts";
import {
  SessionRegistry,
  herdTagFor,
  type SessionFactory,
  type SessionParts,
} from "./sessions.ts";
import type { EngineSnapshot } from "./state-engine.ts";
import { toPaneWire } from "./types.ts";
import type {
  AgentView,
  DeviceAuth,
  PaneWire,
  SessionSummary,
  SnapshotResponse,
  TabView,
  UpdateStatus,
  WorkspaceView,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// SOLO ZERO-TAX BASELINE — you are not allowed to tax a solo user.
//
// Pack federation (M3/M4) is being built on top of this code. The contract in PACK_PROTOCOL.md §11
// says that with ZERO peers enrolled, Collie's observable behaviour stays byte-for-byte what it is
// TODAY: no added snapshot field, no shifted ETag, no new route, no new state file, no new env key,
// no changed notification tag or audit line.
//
// This file is a CHARACTERIZATION baseline, landed BEFORE any federation code exists. That timing is
// the whole point: written afterwards, it would only re-record whatever the new code does. A failure
// here does NOT mean "the golden is stale" — it means a solo instance's observable behaviour moved,
// and the change either has to become peer-conditional or the contract has to be renegotiated.
//
// REGENERATING A GOLDEN IS A DELIBERATE ACT:
//   COLLIE_REGEN_SOLO_BASELINE=1 bun test bridge/solo-baseline.test.ts
// rewrites the fixtures under bridge/fixtures/solo-baseline/. Any PR that does so MUST say so in its
// description, with the reason and the §11 row it renegotiates. Silent regeneration defeats the test.
//
// Two layers, deliberately:
//   • TYPE level — an exhaustive `satisfies Record<keyof T, true>` per wire type. `keyof` includes optional
//     keys, so adding `servers?:` or `host?:` to a wire type fails `bun run typecheck` at the exact
//     line the field was added. server.ts emits its snapshot `satisfies SnapshotResponse`, so a new
//     emitted key must first exist on the type — the chain has no gap.
//   • BYTE level — a golden body, deep-equalled and byte-compared, plus its ETag.
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURES = join(import.meta.dir, "fixtures", "solo-baseline");
const REGEN = process.env.COLLIE_REGEN_SOLO_BASELINE === "1";

function golden(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

/** Compare against a committed golden, or rewrite it under COLLIE_REGEN_SOLO_BASELINE=1. */
function expectGolden(name: string, actual: string): void {
  if (REGEN) {
    writeFileSync(join(FIXTURES, name), actual);
    console.warn(`[solo-baseline] REGENERATED ${name} — say so in the PR description, with a reason.`);
  }
  expect(actual).toBe(golden(name));
}

// ── The fixed fake herd ───────────────────────────────────────────────────────
// A solo instance: one herdr session (the primary), two agent panes, one shell pane, one space,
// one tab. Frozen inputs — every number here is arbitrary but must never change, or the golden
// stops being a comparison against yesterday.

const TS = 1_754_000_000_000;

const claudePane: AgentView = {
  paneId: "w1:p1",
  workspaceId: "w1",
  workspaceLabel: "collie",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "claude",
  status: "blocked",
  cwd: "/home/you/playground/collie",
  focused: true,
  kind: "agent",
  paneLabel: "guard work",
  sessionName: "guard-work",
  // Server-side only: toPaneWire must strip this to `hasSession` and never leak the value.
  agentSession: { kind: "id", value: "abc-123" },
  readableLines: 48,
  tabLabel: "collie",
  lastActiveAt: TS - 60_000,
  lastSeenAt: TS - 300_000,
};

const codexPane: AgentView = {
  paneId: "w1:p2",
  workspaceId: "w1",
  workspaceLabel: "collie",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "codex",
  status: "working",
  cwd: "/home/you/playground/collie",
  focused: false,
  kind: "agent",
};

const shellPane: AgentView = {
  paneId: "w1:p3",
  workspaceId: "w1",
  workspaceLabel: "collie",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "shell",
  status: "idle",
  cwd: "/home/you",
  focused: false,
  kind: "shell",
};

const workspaces: WorkspaceView[] = [
  {
    workspaceId: "w1",
    number: 1,
    label: "collie",
    focused: true,
    activeTabId: "w1:t1",
    tabCount: 1,
    paneCount: 3,
  },
];

const tabs: TabView[] = [
  { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "collie", focused: true, paneCount: 3 },
];

const engineSnapshot: EngineSnapshot = {
  agents: [claudePane, codexPane],
  shellPanes: [shellPane],
  workspaces,
  tabs,
  bridge: "connected",
};

const updateStatus: UpdateStatus = {
  current: "1.0.0-alpha.1",
  latest: null,
  latestUrl: null,
  releaseAvailable: false,
  majorAvailable: null,
  majorUrl: null,
  installKind: "detached-checkout",
  bridgeStale: false,
  checkedAt: null,
};

/**
 * Every member of {@link SessionParts} is a class with private fields, so no fake can ever *be* one
 * structurally. `Partial<T>` keeps the compiler checking each method a fake DOES supply against the
 * real class (a renamed or re-typed method still breaks this file); only the "the rest is never
 * reached" step is asserted.
 */
function stubPart<T>(impl: Partial<T>): T {
  // SAFETY: SessionRegistry only ever calls the methods these fakes implement — `engine.current()`
  // and the `stop()`/`clearAll()` disposal hooks. `herdr` is stored and handed back, never called,
  // on the paths this file drives (registry construction, `list()`, and the snapshot assembly).
  return impl as T;
}

/** Only claude has a journal adapter in this fixture — codex/shell must not advertise History. */
const hasJournal = (agent: string) => agent === "claude";

/**
 * A registry over exactly one session (the primary), built with the same fake-factory convention as
 * sessions.test.ts. `list()` is the REAL implementation — this pins what a solo `sessions` looks like.
 */
function soloRegistry(): SessionRegistry {
  const factory: SessionFactory = () => ({
    herdr: stubPart<SessionParts["herdr"]>({}),
    engine: stubPart<SessionParts["engine"]>({ current: () => engineSnapshot, stop: () => {} }),
    poker: stubPart<SessionParts["poker"]>({ stop: () => {} }),
    notifications: stubPart<SessionParts["notifications"]>({ clearAll: () => {} }),
  });
  return new SessionRegistry({
    configRoot: "/home/you/.config/herdr",
    primarySocketPath: "/home/you/.config/herdr/herdr.sock",
    factory,
    multiSession: true,
    listSessionDirs: () => [],
    exists: () => false,
  });
}

/**
 * Assemble the snapshot body exactly as the `/api/snapshot` handler does
 * (bridge/server.ts:193-212) for a solo instance: device auth off (so the key is absent), no peers.
 * Kept in lockstep with that handler by the `satisfies SnapshotResponse` on both sides plus the
 * exhaustive key assertions below — a key added there must exist on the type, which fails here.
 */
function soloSnapshot(registry: SessionRegistry): SnapshotResponse {
  const { agents, shellPanes, workspaces: ws, tabs: tb, bridge } = registry.get()!.engine.current();
  return {
    bridge,
    // device: omitted — COLLIE_DEVICE_HEADER unset is the default deployment.
    agents: agents.map((p) => toPaneWire(p, hasJournal)),
    shellPanes: shellPanes.map((p) => toPaneWire(p, hasJournal)),
    workspaces: ws,
    tabs: tb,
    sessions: registry.list(),
    notifications: { snoozedUntil: null },
    update: updateStatus,
    ts: TS,
  } satisfies SnapshotResponse;
}

// ── 1. Wire shapes: the pack dimension exists on the TYPE, never in solo's BYTES ──
// §11 rows: "Snapshot bytes", "?h=". These maps are exhaustive by construction — `satisfies
// Record<keyof T,…>` makes every key of T (optional ones included) required here and rejects any key
// that is NOT on T, so adding a federation field to a wire type is a TYPECHECK failure, not a silent
// widening.
//
// ── THE TRIPWIRE FIRED, ONCE, IN M4/04 ───────────────────────────────────────
// `servers?:` (SnapshotResponse) and `host?:` (SessionSummary, PaneWire) were added by the snapshot
// merge and are recorded below. Read that as what it is: the type-level guard doing its job, forcing
// the addition to be acknowledged here rather than slipping in. **No golden was regenerated and no
// byte moved** — all three are optional-and-absent, so a solo body still contains none of them,
// which §2/§3 below assert directly and which is why they are `?:` and not required (§11's "Why
// `servers` is optional-and-absent"). The key-LIST assertions in this section are therefore the one
// authorised change; every byte-level assertion in this file is untouched.

const SNAPSHOT_KEYS = {
  bridge: true,
  device: true,
  agents: true,
  shellPanes: true,
  workspaces: true,
  tabs: true,
  sessions: true,
  notifications: true,
  update: true,
  ts: true,
  // Present on the type since M4/04, absent from every solo body — see the section header.
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

const PANE_WIRE_KEYS = {
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
  readableLines: true,
  tabLabel: true,
  lastActiveAt: true,
  lastSeenAt: true,
  hasSession: true,
  host: true,
  // NOT a pack dimension — an ordinary optional feature field (0.29.0, panes named by their OSC
  // title). Recorded here because the tripwire is exhaustive over `keyof PaneWire`, not because it
  // carries a host: like the fields above it is optional-and-absent when the pane has no meaningful
  // title, and no golden byte moved.
  terminalTitle: true,
  // Also not a pack dimension: a presentation flag on the field above, set only when the title
  // outlived the program that printed it. Absent on every pane in this baseline, so no golden byte
  // moved.
  terminalTitleStale: true,
  // Also not a pack dimension: an optional sentence the bridge composes for one kind of pane
  // (M11/05). Absent on every pane in this baseline, so no golden byte moved.
  hint: true,
  // The OTHER half of a pane's address, and the one field here that is written by a request rather
  // than by the pane's own state: present only when the caller asked to widen (`?sessions=all`),
  // and then on every pane in the body. Nothing in this baseline asks, so it is absent on every
  // pane here and no golden byte moved — which is the claim, not an aside.
  session: true,
} satisfies Record<keyof PaneWire, true>;

const DEVICE_AUTH_KEYS = {
  enforced: true,
  device: true,
  authorized: true,
} satisfies Record<keyof DeviceAuth, true>;

const UPDATE_STATUS_KEYS = {
  current: true,
  latest: true,
  latestUrl: true,
  releaseAvailable: true,
  majorAvailable: true,
  majorUrl: true,
  installKind: true,
  bridgeStale: true,
  checkedAt: true,
} satisfies Record<keyof UpdateStatus, true>;

const WORKSPACE_KEYS = {
  workspaceId: true,
  number: true,
  label: true,
  focused: true,
  activeTabId: true,
  tabCount: true,
  paneCount: true,
  repoRoot: true,
  isWorktree: true,
  // A pack dimension, and the SAME one a pane and a session carry: Herdr numbers spaces per machine,
  // so `(host, workspaceId)` is a space's identity in a pack and `workspaceId` alone collides. Like
  // `PaneWire.host` it is present exactly when `servers` is, which is never in this baseline — the
  // golden bodies below are the proof that no byte moved for a solo instance.
  host: true,
} satisfies Record<keyof WorkspaceView, true>;

const TAB_KEYS = {
  tabId: true,
  workspaceId: true,
  number: true,
  label: true,
  focused: true,
  paneCount: true,
  /** Same dimension, same rule as {@link WORKSPACE_KEYS}'s — a tab id is `w1:t1` on every install. */
  host: true,
} satisfies Record<keyof TabView, true>;

describe("solo zero-tax — wire shapes carry no pack dimension", () => {
  test("SnapshotResponse carries `servers` as OPTIONAL and nothing else new", () => {
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

  test("SessionSummary gained `host` and nothing else", () => {
    expect(Object.keys(SESSION_SUMMARY_KEYS).toSorted()).toEqual([
      "agents",
      "blocked",
      "host",
      "isPrimary",
      "name",
      "reachable",
      "working",
    ]);
  });

  // `host` and `session` are the pane's ADDRESS — the `?h=` and `?s=` halves — and they are the only
  // two fields here a REQUEST can turn on. Both are optional-and-absent unless something asked: a
  // host tag exists only on a merged pack body, a session tag only on a widened one
  // (`?sessions=all`). Neither is asked for anywhere in this baseline, which is what the golden
  // bodies below prove; this list is the tripwire that a THIRD such field cannot be added quietly.
  test("PaneWire carries the two address dimensions and nothing else", () => {
    expect(Object.keys(PANE_WIRE_KEYS).toSorted()).toEqual([
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
      "session",
      "sessionName",
      "status",
      "tabId",
      "tabLabel",
      "terminalTitle",
      "terminalTitleStale",
      "workspaceId",
      "workspaceLabel",
      "workspaceNumber",
    ]);
  });

  test("the supporting wire types are unchanged too", () => {
    expect(Object.keys(DEVICE_AUTH_KEYS).toSorted()).toEqual(["authorized", "device", "enforced"]);
    expect(Object.keys(UPDATE_STATUS_KEYS).toSorted()).toEqual([
      "bridgeStale",
      "checkedAt",
      "current",
      "installKind",
      "latest",
      "latestUrl",
      "majorAvailable",
      "majorUrl",
      "releaseAvailable",
    ]);
    expect(Object.keys(WORKSPACE_KEYS).toSorted()).toEqual([
      "activeTabId",
      "focused",
      "host",
      "isWorktree",
      "label",
      "number",
      "paneCount",
      "repoRoot",
      "tabCount",
      "workspaceId",
    ]);
    expect(Object.keys(TAB_KEYS).toSorted()).toEqual([
      "focused",
      "host",
      "label",
      "number",
      "paneCount",
      "tabId",
      "workspaceId",
    ]);
  });
});

// ── 2. The golden snapshot body ──────────────────────────────────────────────

describe("solo zero-tax — the snapshot body is byte-for-byte today's", () => {
  const body = JSON.stringify(soloSnapshot(soloRegistry()), null, 2);

  test("assembles to the committed golden, byte for byte", () => {
    expectGolden("snapshot.json", `${body}\n`);
  });

  // Deep equality, not a subset match: an added key fails here even if the golden were regenerated
  // carelessly, because the parsed golden is compared BOTH ways.
  test("deep-equals the golden with no extra keys on either side", () => {
    // SAFETY: the golden is this file's own committed output — written by `expectGolden` from a
    // `satisfies SnapshotResponse` body — so its parse is a SnapshotResponse by construction. The
    // two-way `toEqual` below is what actually checks that, key for key.
    const parsed = JSON.parse(golden("snapshot.json")) as SnapshotResponse;
    const actual = soloSnapshot(soloRegistry());
    expect(actual).toEqual(parsed);
    expect(parsed).toEqual(actual);
  });

  test("a solo snapshot names no pack anywhere in its bytes", () => {
    expect(body).not.toMatch(/"servers"|"peers"|"pack"|"host":|"lead"/);
  });

  test("solo emits exactly one session, the primary, and never a session ref", () => {
    const snap = soloSnapshot(soloRegistry());
    expect(snap.sessions).toEqual([
      { name: "default", isPrimary: true, reachable: true, agents: 2, working: 1, blocked: 1 },
    ]);
    // hasSession is the flag; agentSession (a filesystem path for pi) must never reach the wire.
    // Asked with `hasOwn` rather than by reading the property, because it is not on PaneWire at all
    // — which is the point: an absent key, not an undefined value.
    expect(snap.agents.map((p) => Object.hasOwn(p, "agentSession"))).toEqual([false, false]);
    expect(snap.agents.map((p) => p.hasSession)).toEqual([true, undefined]);
  });
});

// ── 3. ETag stability ────────────────────────────────────────────────────────
// §11: the solo snapshot ETag is UNCHANGED — a hard requirement, not an accepted one-time break.
// The literal hash is deliberately NOT pinned: Bun.hash is a runtime implementation detail and a Bun
// upgrade legitimately moves it. What §11 actually promises is that the *body bytes* don't move, and
// that the ETag is a pure function of those bytes. Both are asserted; the negative control below
// proves the gate has teeth.

describe("solo zero-tax — ETag", () => {
  test("is a pure function of the body: identical bytes → identical ETag", () => {
    const a = JSON.stringify(soloSnapshot(soloRegistry()));
    const b = JSON.stringify(soloSnapshot(soloRegistry()));
    expect(a).toBe(b);
    expect(computeEtag(a)).toBe(computeEtag(b));
  });

  test("the golden body's ETag matches the assembled body's", () => {
    const fromGolden = JSON.stringify(JSON.parse(golden("snapshot.json")));
    const fromCode = JSON.stringify(soloSnapshot(soloRegistry()));
    expect(computeEtag(fromCode)).toBe(computeEtag(fromGolden));
  });

  // NEGATIVE CONTROL — this is the tax, measured. It is why `servers` is optional-and-absent rather
  // than an always-present empty array (PACK_PROTOCOL.md §11).
  test("adding an empty `servers: []` would move every solo ETag", () => {
    const today = JSON.stringify(soloSnapshot(soloRegistry()));
    const taxed = JSON.stringify({ ...soloSnapshot(soloRegistry()), servers: [] });
    expect(computeEtag(taxed)).not.toBe(computeEtag(today));
  });
});

// ── 4. Routes ────────────────────────────────────────────────────────────────
// §11: zero routes added, no `/pack` prefix registered. The dispatch lives inside `Bun.serve`, which
// `bun test` cannot stand up (CLAUDE.md), so the route table is pinned by reading the source's route
// literals. Crude, but it is the actual registration site — a new `if (pathname === "/pack/…")` in
// server.ts fails here even though no server was started.

function declaredRoutes(): string[] {
  const src = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
  const exact = [...src.matchAll(/pathname === "([^"]+)"/g)].map((m) => m[1]!);
  const prefixes = [...src.matchAll(/pathname\.startsWith\("([^"]+)"\)/g)].map((m) => `${m[1]}*`);
  const patterns = [...src.matchAll(/^const \w*ROUTE = (\/\^.+\/);$/gm)].map((m) => m[1]!);
  return [...new Set([...exact, ...prefixes, ...patterns])].toSorted();
}

describe("solo zero-tax — routes", () => {
  test("server.ts registers exactly today's routes", () => {
    expect(declaredRoutes()).toEqual([
      "/",
      // `focus` is the pane action that moves the OPERATOR's own terminal, and it is named here for
      // the reason every other one is: a route arrives on purpose or it does not arrive.
      "/^\\/api\\/pane\\/([^/]+)(?:\\/(reply|keys|upload|close|rename|history|focus))?$/",
      "/^\\/api\\/tab\\/([^/]+)\\/(rename|close)$/",
      "/^\\/api\\/workspace\\/([^/]+)\\/worktree(?:\\/(open))?$/",
      "/^\\/api\\/workspace\\/([^/]+)\\/worktrees$/",
      "/api/config",
      // Device pairing (bridge/pairing.ts) — a SOLO feature that legitimately extends this list.
      // It is named here, not exempted: the guard's job is that a route arrives on purpose.
      "/api/devices",
      "/api/devices/revoke",
      "/api/notifications/prefs",
      "/api/notifications/snooze",
      // The Pack overview (bridge/pack/status-wire.ts) — a FRONT-DOOR route, and it legitimately
      // extends this list rather than being exempted, exactly as pairing and STT do. It is not a
      // pack route: `/pack/v1/*` is the link a peer answers (ADR 0013), and this is the lead's own
      // browser answering its own operator. A solo instance registers it and 404s
      // (`pack.not_lead`) — the same shape `/api/stt` has when no provider is configured.
      "/api/pack",
      "/api/pair",
      // "Look now" (ADR 0031) — a SOLO route that legitimately extends this list, named here rather
      // than exempted. It is session-scoped and read-gated, and it registers no pack route of its
      // own: a lead reaches a peer's through the peer's existing `/pack/v1/*` dispatch.
      "/api/refresh",
      "/api/snapshot",
      // Speech-to-text (bridge/stt/) — a SOLO feature that legitimately extends this list, named
      // here rather than exempted, exactly as device pairing is. It is off until an operator
      // configures a provider, and it registers no pack route.
      "/api/stt",
      "/api/subscribe",
      "/api/tab",
      "/api/update/check",
      "/api/workspace",
      "/auth",
      "/auth/*",
    ]);
  });

  // §11's actual promise, and it is about the PREFIX: `/pack/v1/*` is not routed here on any
  // instance, solo or otherwise — it is declared in `bridge/pack/router.ts` and reached through the
  // `packRouter` closure, which is what lets this file prove by grep that server.ts names no pack
  // path. A front-door route whose NAME contains "pack" (`/api/pack`) is a different thing entirely
  // and is pinned by the list above; matching on the substring would have conflated the two.
  test("no /pack prefix is routed at all", () => {
    expect(declaredRoutes().filter((r) => r.startsWith("/pack"))).toEqual([]);
    expect(readFileSync(join(import.meta.dir, "server.ts"), "utf8")).not.toMatch(/"\/pack/);
  });
});

// ── 5. Config: no pack keys, no pack env ─────────────────────────────────────

const CONFIG_KEYS = {
  mux: true,
  muxEndpoint: true,
  tmuxBin: true,
  zellijBin: true,
  socketPath: true,
  dialMode: true,
  auditContent: true,
  commandsFile: true,
  keysFile: true,
  quickRepliesFile: true,
  themeFile: true,
  fontsDir: true,
  port: true,
  host: true,
  pollMs: true,
  pollIdleMs: true,
  notifyDelayMs: true,
  readLines: true,
  transcript: true,
  journalRoots: true,
  submitKeys: true,
  trustedUser: true,
  trustedUserOptional: true,
  deviceHeader: true,
  deviceAllowlist: true,
  allowedOrigins: true,
  publicHosts: true,
  tailscaleHosts: true,
  allowAnyHost: true,
  allowNonLoopbackBind: true,
  vapidPublic: true,
  vapidPrivate: true,
  vapidSubject: true,
  stateDir: true,
  multiSession: true,
  skipServe: true,
} satisfies Record<keyof Config, true>;

describe("solo zero-tax — config", () => {
  test("Config carries no pack/peer/lead key", () => {
    const keys = Object.keys(CONFIG_KEYS).toSorted();
    expect(keys).toEqual([
      "allowAnyHost",
      "allowNonLoopbackBind",
      "allowedOrigins",
      "auditContent",
      "commandsFile",
      "deviceAllowlist",
      "deviceHeader",
      "dialMode",
      "fontsDir",
      "host",
      "journalRoots",
      "keysFile",
      "multiSession",
      "mux",
      "muxEndpoint",
      "notifyDelayMs",
      "pollIdleMs",
      "pollMs",
      "port",
      "publicHosts",
      "quickRepliesFile",
      "readLines",
      "skipServe",
      "socketPath",
      "stateDir",
      "submitKeys",
      "tailscaleHosts",
      "themeFile",
      "tmuxBin",
      "transcript",
      "trustedUser",
      "trustedUserOptional",
      "vapidPrivate",
      "vapidPublic",
      "vapidSubject",
      "zellijBin",
    ]);
    expect(keys.filter((k) => /pack|peer|lead|federat/i.test(k))).toEqual([]);
  });

  test("loadConfig with a bare environment produces exactly those keys and one loopback port", () => {
    const cfg = loadConfig();
    expect(Object.keys(cfg).toSorted()).toEqual(Object.keys(CONFIG_KEYS).toSorted());
    // §11 "Ports opened": exactly one, loopback.
    expect(cfg.host).toBe("127.0.0.1");
    expect(Number.isInteger(cfg.port)).toBe(true);
  });

  test("the poll cadence defaults are unchanged — no second timer to configure", () => {
    // §11 "Poll cadence". Env is not scrubbed here (a deployment may override), so assert the
    // defaults from the source rather than from a live env.
    const src = readFileSync(join(import.meta.dir, "config.ts"), "utf8");
    expect(src).toContain('envInt("COLLIE_POLL_MS", 1500');
    expect(src).toContain('envInt("COLLIE_POLL_IDLE_MS", 12_000');
  });

  test("config.ts reads exactly today's COLLIE_* env keys — no pack enrollment key", () => {
    const src = readFileSync(join(import.meta.dir, "config.ts"), "utf8");
    const keys = [...new Set([...src.matchAll(/COLLIE_[A-Z0-9_]+/g)].map((m) => m[0]))].toSorted();
    expect(keys).toEqual([
      "COLLIE_ALLOWED_ORIGINS",
      "COLLIE_ALLOW_ANY_HOST",
      "COLLIE_ALLOW_NON_LOOPBACK_BIND",
      "COLLIE_AUDIT_CONTENT",
      "COLLIE_CODEX_ROOT",
      "COLLIE_DEVICE_ALLOWLIST",
      "COLLIE_DEVICE_HEADER",
      "COLLIE_GROK_ROOT",
      "COLLIE_HERDR_DIAL",
      "COLLIE_HOST",
      "COLLIE_MULTI_SESSION",
      "COLLIE_MUX",
      "COLLIE_MUX_ENDPOINT_",
      "COLLIE_NOTIFY_DELAY_MS",
      "COLLIE_OPENCODE_ROOT",
      "COLLIE_PI_ROOT",
      "COLLIE_POLL_IDLE_MS",
      "COLLIE_POLL_MS",
      "COLLIE_PORT",
      "COLLIE_PUBLIC_HOSTS",
      "COLLIE_READ_LINES",
      "COLLIE_SKIP_SERVE",
      "COLLIE_STATE_DIR",
      "COLLIE_SUBMIT_KEYS",
      "COLLIE_TAILSCALE_HOSTS",
      "COLLIE_TMUX_BIN",
      "COLLIE_TRANSCRIPT",
      "COLLIE_TRANSCRIPT_ROOT",
      "COLLIE_TRUSTED_USER",
      "COLLIE_TRUSTED_USER_OPTIONAL",
      "COLLIE_VAPID_PRIVATE",
      "COLLIE_VAPID_PUBLIC",
      "COLLIE_VAPID_SUBJECT",
      "COLLIE_ZELLIJ_BIN",
    ]);
  });
});

// ── 6. Files written ─────────────────────────────────────────────────────────
// §11: a solo instance writes exactly today's set — no key, no certificate, no trust store, no
// roster. Two assertions, because neither alone is enough: driving the stores proves what actually
// lands on disk; scanning the source proves no OTHER module has a `<stateDir>/…` writer at all.

/** Every `<stateDir>/…` path any bridge module names. `uploads` is a directory, the rest are files. */
const STATE_DIR_ENTRIES = [
  "activity.json",
  "audit.log",
  // Agent beacons (M11/01) — a directory, and one no bridge module ever writes: the bridge only ever
  // READS it, and the emitter that fills it is a CLI verb the operator installs a hook for. An
  // instance whose operator never ran `collie hooks install` never has this directory at all.
  "beacons",
  "notify-prefs.json",
  // Device pairing. Both are absent until the operator runs `collie pair`, and an install that
  // never does keeps writing exactly the six entries above it.
  "paired-devices.json",
  "pairing-pending.json",
  "push-subscriptions.json",
  "snooze.json",
  // Speech-to-text settings. Absent until the operator runs `collie stt setup`, and READ ONLY by
  // the bridge — `bridge/stt/config.ts` names this path and never writes it.
  "stt.json",
  "update-state.json",
  "uploads",
];

/**
 * The `<stateDir>` entries the FEDERATION modules name. Solo writes none of them — the whole point —
 * but the scan below must still see them, or it would stop guarding the moment federation code moved
 * one directory down.
 *
 * This list is a second allowlist, not an exemption: a new writer under `bridge/pack/` fails this
 * test until it is declared here, exactly as a new writer in `bridge/` fails against the list above.
 * The behavioural half of the guard — that an instance which never enrolled writes NONE of these —
 * is the `TrustStore` case in "driving every solo write path".
 */
const PACK_STATE_DIR_ENTRIES = [
  "pack-ops.json",
  "pack-runtime.json",
  "pack-trust.json",
  // The lead's paired-device registry, synced to the DEPUTY only (RFC §6.5, PACK_PROTOCOL.md §18.14).
  // **A solo instance can never have one**, and the reason is structural rather than a check anyone
  // has to remember: it is written on exactly one path — a `POST /pack/v1/pairing` that cleared the
  // pack's two factors, came from this collie's own pinned LEAD, and found a verified warrant naming
  // THIS machine as deputy. A solo instance has no trust store, so it registers no pack routes at all,
  // so none of those three can ever be true of it.
  //
  // It is a separate file from `paired-devices.json` on purpose and permanently: `enforced()` is "the
  // registry is non-empty", so merging the two would arm the deputy's own write gate for its own
  // operator (`bridge/pack/standby-devices.ts`).
  "standby-devices.json",
];

/** Every `.ts` module under `dir`, recursively, excluding tests. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Every `<stateDir>/…` entry a module names, however the state dir and the name reached it. */
function stateDirEntriesNamedBy(files: string[]): string[] {
  const named = new Set<string>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    // Broader than the original `cfg.stateDir` + string-literal scan, in two directions, because a
    // writer using either other form would have slipped past it entirely:
    //  • the state dir arrives as `cfg.stateDir`, `this.cfg.stateDir` or a bare `stateDir` param;
    //  • the entry name may be a string literal or a `const NAME = "…"` in the same module.
    const constants = new Map(
      [...src.matchAll(/^(?:export )?const ([A-Z][A-Z0-9_]*) = "([^"]+)";$/gm)].map((m) => [m[1]!, m[2]!]),
    );
    for (const m of src.matchAll(/join\([^)]*stateDir,\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\)/g)) {
      const literal = m[1] ?? (m[2] === undefined ? undefined : constants.get(m[2]));
      if (literal !== undefined) named.add(literal);
      else if (m[2] !== undefined) {
        throw new Error(`${f}: <stateDir>/${m[2]} — the scan cannot resolve that name, so it cannot guard it`);
      }
    }
  }
  return [...named].toSorted();
}

describe("solo zero-tax — the filesystem", () => {
  test("the bridge names exactly today's <stateDir> entries and nothing else", () => {
    const files = sourceFiles(import.meta.dir).filter((f) => !f.includes(`${sep}pack${sep}`));
    expect(stateDirEntriesNamedBy(files)).toEqual(STATE_DIR_ENTRIES);
  });

  test("the federation modules name only their own declared entries", () => {
    // Scanned separately rather than merged in, so the two sets can never be confused for each
    // other: anything here is a file a solo instance must be proven never to create.
    const files = sourceFiles(join(import.meta.dir, "pack"));
    expect(stateDirEntriesNamedBy(files)).toEqual(PACK_STATE_DIR_ENTRIES);
    expect(PACK_STATE_DIR_ENTRIES.filter((e) => STATE_DIR_ENTRIES.includes(e))).toEqual([]);
  });

  test("driving every solo write path produces only known files", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "collie-solo-baseline-"));
    try {
      const cfg: Config = { ...loadConfig(), stateDir };
      await new Snooze(cfg, () => TS).set(TS + 60_000);
      await new NotifyPrefsStore(cfg).set({ blocked: false });
      const ledger = new ActivityLedger({ stateDir }, () => TS, 60 * 60 * 1000);
      ledger.ensure("default", "w1:p1");
      await ledger.flush();
      new AuditLog(fileAuditAppender(join(stateDir, "audit.log")), { now: () => TS }).record({
        action: "reply",
        paneId: "w1:p1",
        detail: { text: "ok" },
      });
      // The trust store, resolved exactly as index.ts resolves it at startup. A solo instance has
      // never enrolled, so this must open a file that isn't there and create NOTHING — not the
      // store, not a key, not a default. §11's "Files written" row, driven rather than read.
      expect(await new TrustStore(stateDir).load()).toBeNull();
      // The audit append is fire-and-forget; let its microtask + write land.
      await Bun.sleep(20);
      const written = (await readdir(stateDir)).toSorted();
      expect(written).toEqual(["activity.json", "audit.log", "notify-prefs.json", "snooze.json"]);
      expect(written.filter((f) => !STATE_DIR_ENTRIES.includes(f))).toEqual([]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

// ── 7. Notification tags and push payload ────────────────────────────────────

describe("solo zero-tax — notifications", () => {
  test("the primary session keeps the bare collie:herd tag", () => {
    expect(herdTagFor(true, "default")).toBe("collie:herd");
    // Whatever the primary is NAMED, its tag stays bare — the name never enters the solo tag.
    expect(herdTagFor(true, "work")).toBe("collie:herd");
  });

  test("push.ts stamps `session` and `host` only when the message names one", () => {
    // Pinned at the source, because Push.send needs the web-push module to broadcast. The shape of
    // the `data` payload is the contract an installed service worker already caches.
    //
    // ── RENEGOTIATED BY M4/06, THE SAME WAY THE WIRE-TYPE ROWS WERE BY M4/04 ──
    // This assertion used to read `expect(src).not.toMatch(/data\.host/)`. It was a source-text
    // PROXY for the row it defends — "push payload unchanged: no `host` field, mirroring how
    // `session` is stamped only for non-primary" (§11) — written before there was a host to stamp.
    // The row itself is intact and is now pinned where it belongs: `host` is conditional exactly as
    // `session` is, so a solo instance (which never has a host) emits the identical bytes, and
    // `push.test.ts` asserts the produced `data` object for both cases rather than the source that
    // builds it. What would be a real regression is an UNCONDITIONAL stamp — hence the two
    // `if (… !== undefined)` lines below being the pinned form.
    const src = readFileSync(join(import.meta.dir, "push.ts"), "utf8");
    expect(src).toContain("if (msg.session !== undefined) data.session = msg.session;");
    expect(src).toContain("if (msg.host !== undefined) data.host = msg.host;");
    // Never stamped unconditionally: an unguarded assignment is what would change the solo payload.
    const stamps = src.split("\n").filter((l) => l.includes("data.host"));
    expect(stamps).toEqual(["    if (msg.host !== undefined) data.host = msg.host;"]);
  });

  test("a solo payload has no host: the sink stamps it only when a host is named", async () => {
    // The behavioural half of the row above, at the layer that decides: `makeNotifySink` is what
    // every local session's coordinator renders through, and a solo instance passes it no host.
    const { makeNotifySink } = await import("./notifications.ts");
    const sent: PushMessage[] = [];
    const sink = makeNotifySink({ send: (m: PushMessage) => sent.push(m) }, { isMuted: () => false }, "collie:herd");
    sink.render({ title: "claude needs you", body: "demo · /home/you", paneId: "p1", renotify: true });
    sink.clear();
    expect(sent).toEqual([
      { title: "claude needs you", body: "demo · /home/you", tag: "collie:herd", paneId: "p1", renotify: true },
      { type: "clear", tag: "collie:herd" },
    ]);
    expect(sent.every((m) => !("host" in m))).toBe(true);
  });
});

// ── 8. Audit lines ───────────────────────────────────────────────────────────

const AUDIT_ENTRIES: AuditEntry[] = [
  { action: "reply", paneId: "w1:p1", detail: { text: "ship it" } },
  { action: "keys", paneId: "w1:p1", detail: { keys: ["ctrl+c"] } },
  { action: "tab.create", detail: { workspaceId: "w1" } },
  { action: "pane.close", paneId: "w1:p3", session: "collie-demo", detail: {} },
  { action: "upload", paneId: "w1:p1", device: "phone", detail: { filename: "shot.png", size: 1234 } },
];

describe("solo zero-tax — audit lines", () => {
  test("format exactly as they do today: `host` absent, not null", () => {
    const lines = AUDIT_ENTRIES.map((e) => formatAuditLine(e, TS)).join("\n");
    expectGolden("audit.jsonl", `${lines}\n`);
    expect(lines).not.toMatch(/"host"/);
  });
});
