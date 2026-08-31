import { http, HttpResponse } from "msw";

import type {
  AgentView,
  PackStatusResponse,
  ServerSummary,
  SessionSummary,
  SnapshotResponse,
  TabView,
  TranscriptEntry,
  WorkspaceView,
} from "@/lib/types";

// A couple of fixture agents covering the triage groups, reused across tests.
export const fixtureAgents: AgentView[] = [
  {
    paneId: "w1:p1",
    workspaceId: "w1",
    workspaceLabel: "webapp",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "blocked",
    cwd: "/home/you/webapp",
    focused: false,
  },
  {
    paneId: "w2:p1",
    workspaceId: "w2",
    workspaceLabel: "collie",
    workspaceNumber: 2,
    tabId: "w2:t1",
    agent: "codex",
    status: "working",
    cwd: "/home/you/collie",
    focused: true,
  },
];

export const fixtureShellPanes: AgentView[] = [
  {
    paneId: "w2:p2",
    workspaceId: "w2",
    workspaceLabel: "collie",
    workspaceNumber: 2,
    tabId: "w2:t2",
    agent: "shell",
    status: "unknown",
    cwd: "/home/you/collie",
    focused: false,
    kind: "shell",
  },
];

export const fixtureWorkspaces: WorkspaceView[] = [
  {
    workspaceId: "w1",
    number: 1,
    label: "webapp",
    focused: false,
    activeTabId: "w1:t1",
    tabCount: 1,
    paneCount: 1,
  },
  {
    workspaceId: "w2",
    number: 2,
    label: "collie",
    focused: true,
    activeTabId: "w2:t1",
    tabCount: 2,
    paneCount: 2,
  },
];

export const fixtureTabs: TabView[] = [
  { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "1", focused: false, paneCount: 1 },
  { tabId: "w2:t1", workspaceId: "w2", number: 1, label: "code", focused: true, paneCount: 1 },
  { tabId: "w2:t2", workspaceId: "w2", number: 2, label: "shell", focused: false, paneCount: 1 },
];

// A two-session registry: the primary "default" plus a named "collie-demo". Order is primary-first,
// then alphabetical — matching the bridge contract.
export const fixtureSessions: SessionSummary[] = [
  { name: "default", isPrimary: true, reachable: true, agents: 2, working: 1, blocked: 1 },
  { name: "collie-demo", isPrimary: false, reachable: true, agents: 1, working: 1, blocked: 0 },
];

export const fixtureSnapshot: SnapshotResponse = {
  bridge: "connected",
  agents: fixtureAgents,
  shellPanes: fixtureShellPanes,
  workspaces: fixtureWorkspaces,
  tabs: fixtureTabs,
  notifications: { snoozedUntil: null },
  sessions: fixtureSessions,
  ts: 0,
};

// ── The pack fixtures ────────────────────────────────────────────────────────
// Everything above is the SOLO snapshot, and it stays that way: no `servers`, no `host` anywhere, so
// every existing test keeps asserting the one-host world and any host chrome that leaks into it
// fails loudly. The pack fixtures below are opt-in — a test that wants two machines asks for them.
//
// Shapes mirror what the lead's merge actually emits (bridge/pack/merge.ts): the lead's OWN panes and
// sessions are host-tagged too (not left bare), workspace ids repeat across machines because Herdr
// numbers them per machine, and the roster's first entry is the lead.

/** Lead + one reachable peer + one that is up but speaking another protocol version. */
export const fixtureServers: ServerSummary[] = [
  { id: "bluefin", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 1_000 },
  { id: "workshop", name: "workshop", isLead: false, reachable: true, protocol: "ok", lastSeenAt: 990 },
  {
    id: "attic",
    name: "attic",
    isLead: false,
    reachable: false,
    protocol: "incompatible",
    protocolDetail: "pack protocol 2 (this collie speaks 1)",
    lastSeenAt: 500,
  },
];

/**
 * Agents across two machines, with `w1` deliberately used on BOTH — the id collision that makes a
 * host-blind space key merge two projects. One blocked agent per host, so "Needs you" is provably a
 * single cross-host list.
 */
export const fixturePackAgents: AgentView[] = [
  { ...fixtureAgents[0]!, host: "bluefin" },
  { ...fixtureAgents[1]!, host: "bluefin" },
  {
    paneId: "w1:p1",
    workspaceId: "w1",
    workspaceLabel: "moonward",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "codex",
    status: "blocked",
    cwd: "/home/you/moonward",
    focused: false,
    host: "workshop",
  },
];

export const fixturePackShellPanes: AgentView[] = fixtureShellPanes.map((p) => {
  // Built by mutating a copy rather than by spreading in the map body: one clone per row instead of
  // a fresh object literal plus a spread, and it says plainly that `host` is the ONLY difference
  // from the solo fixture.
  const packed = structuredClone(p);
  packed.host = "bluefin";
  return packed;
});

/** Both machines run a session called "default" — which is why the switchers stay separate. */
export const fixturePackSessions: SessionSummary[] = [
  { ...fixtureSessions[0]!, host: "bluefin" },
  { ...fixtureSessions[1]!, host: "bluefin" },
  { name: "default", isPrimary: true, reachable: true, agents: 1, working: 0, blocked: 1, host: "workshop" },
];

/**
 * Spaces and tabs across two machines, host-tagged the way the lead's merge emits them — and with
 `w1` deliberately used on BOTH, because Herdr numbers spaces per machine and two default installs
 * both call theirs `w1` / `w1:t1`. An untagged merge collapsed those into one row carrying one
 * machine's counts; `(host, workspaceId)` is what keeps them apart.
 */
export const fixturePackWorkspaces: WorkspaceView[] = [
  ...fixtureWorkspaces.map((w) => Object.assign({}, w, { host: "bluefin" })),
  {
    workspaceId: "w1",
    number: 1,
    label: "moonward",
    focused: false,
    activeTabId: "w1:t1",
    tabCount: 1,
    paneCount: 1,
    host: "workshop",
  },
];

export const fixturePackTabs: TabView[] = [
  ...fixtureTabs.map((t) => Object.assign({}, t, { host: "bluefin" })),
  { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "1", focused: false, paneCount: 1, host: "workshop" },
];

/**
 * The merged snapshot a lead serves. `workspaces`/`tabs` are unioned and host-tagged, exactly as
 * `bridge/pack/merge.ts` emits them; `lib/hosts.ts`'s `ambientSpaces` is what narrows them back to
 * the one machine the URL is on, which is where the navigator's tree belongs.
 */
export const fixturePackSnapshot: SnapshotResponse = {
  ...fixtureSnapshot,
  agents: fixturePackAgents,
  shellPanes: fixturePackShellPanes,
  workspaces: fixturePackWorkspaces,
  tabs: fixturePackTabs,
  sessions: fixturePackSessions,
  servers: fixtureServers,
};

/**
 * The `/api/pack` census the LEAD serves, matching `fixtureServers` machine for machine — the two
 * describe the same pack, so a test can mount the roster and the page together without them
 * disagreeing. `attic` carries the loud pair: an incompatible protocol AND a second lead claiming
 * the pack, which is what the page has to shout about.
 *
 * `ts` is the LEAD's clock and every timestamp here is stamped on it. It is deliberately AHEAD of
 * the roster's `lastSeenAt` values by a realistic margin so the ages render as ages rather than
 * as "now" — the page must never date anything against `Date.now()`.
 */
export const fixturePackStatus: PackStatusResponse = {
  pack: { id: "pk1", name: "home", secretGeneration: 3, rotatedAt: 100_000 },
  self: { id: "bluefin", name: "bluefin", version: "0.30.0" },
  deputy: { id: "workshop", warrantGeneration: 2 },
  members: [
    {
      id: "bluefin",
      name: "bluefin",
      isLead: true,
      health: "reachable",
      lastSeenAt: 1_000,
      version: "0.30.0",
      secretBehind: false,
      provisional: false,
    },
    {
      id: "workshop",
      name: "workshop",
      isLead: false,
      address: "workshop.tail1234.ts.net:8787",
      enrolledAt: 50_000,
      health: "reachable",
      lastSeenAt: 990,
      version: "0.29.0",
      secretBehind: false,
      provisional: false,
    },
    {
      id: "attic",
      name: "attic",
      isLead: false,
      address: "attic.tail1234.ts.net:8787",
      enrolledAt: 60_000,
      health: "conflicted",
      reason: "pack protocol 2 (this collie speaks 1)",
      lastSeenAt: 500,
      secretBehind: true,
      provisional: true,
      conflict: { leadMemberId: "cellar", warrantGeneration: 7 },
    },
  ],
  ts: 400_000,
};

/** A minimal two-turn transcript: a human ask and the agent's tool-call-plus-answer reply. */
export const fixtureTranscript: TranscriptEntry[] = [
  {
    uuid: "t1",
    ts: "2026-07-25T06:22:21.253Z",
    role: "user",
    parts: [{ kind: "text", text: "what changed today?" }],
  },
  {
    uuid: "t2",
    ts: "2026-07-25T06:22:24.093Z",
    role: "assistant",
    parts: [
      { kind: "tool", name: "Bash", summary: "git log --oneline", result: { text: "abc1234 fix" } },
      { kind: "text", text: "One commit: abc1234." },
    ],
  },
];

// ── The fake pane's input box ────────────────────────────────────────────────────────────────────
// A guarded reply (lib/reply-action.ts) types with submit:false and then polls pane reads until the
// adapter can see that text on the "❯" line — only then does it send the submit key. So the fake
// pane has to behave like a real TUI (text typed → it appears on the prompt line; submit → the line
// clears) or no guarded send would ever verify and every send test would stall.
let typedDraft = "";
/** Reset between tests (setup.ts afterEach) so a draft can't leak into the next case. */
export function resetTypedDraft(): void {
  typedDraft = "";
}
/** Record what a reply POST did to the input line — exported so tests that override the reply
 *  handler with their own can keep the fake pane honest. */
export function recordReply(body: { text?: string; submit?: boolean }): void {
  typedDraft = body.submit ? "" : body.text ?? "";
}
// 40 box glyphs is comfortably above isBoxBorder's BARE_BORDER_MIN floor (8, harness/claude/markers.ts).
const BOX_RULE = "─".repeat(40);
/**
 * `base` output with the current draft rendered inside a Claude-shaped input box below it. The box is
 * ALWAYS drawn, empty draft included — that is what a real idle Claude pane looks like, and the reply
 * path's pre-flight (`composerReady`) now reads it: a fake pane that only grew a box once text had
 * been typed would report "no input box" and refuse every send before it started.
 */
export function paneTextWithDraft(base = "hello from the pane"): string {
  return `${base}\n${BOX_RULE}\n❯ ${typedDraft}\n${BOX_RULE}`;
}

// Default happy-path handlers; individual tests can override via server.use(...).
export const handlers = [
  http.get("/api/snapshot", () => HttpResponse.json(fixtureSnapshot)),
  http.get(/\/api\/pane\/[^/]+$/, () =>
    HttpResponse.json({ paneId: "w1:p1", text: paneTextWithDraft(), truncated: false, revision: 1 }),
  ),
  // Pane transcript history. Two turns, newest-anchored, with nothing older behind them.
  http.get(/\/api\/pane\/[^/]+\/history/, () =>
    HttpResponse.json({
      paneId: "w1:p1",
      available: true,
      entries: fixtureTranscript,
      hasMore: false,
      total: fixtureTranscript.length,
      fileTruncated: false,
    }),
  ),
  http.post<never, { text?: string; submit?: boolean }>(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
    recordReply(await request.json());
    return HttpResponse.json({ ok: true });
  }),
  http.post(/\/api\/pane\/[^/]+\/keys$/, () => HttpResponse.json({ ok: true })),
  http.post(/\/api\/pane\/[^/]+\/close$/, () => HttpResponse.json({ ok: true })),
  http.post(/\/api\/pane\/[^/]+\/rename$/, () => HttpResponse.json({ ok: true })),
  http.post("/api/tab", () =>
    HttpResponse.json({
      ok: true,
      pane: {
        paneId: "w2:p9",
        workspaceId: "w2",
        workspaceLabel: "collie",
        tabId: "w2:t9",
        cwd: "/home/you/collie",
      },
    }),
  ),
  http.post("/api/workspace", () =>
    HttpResponse.json({
      ok: true,
      pane: {
        paneId: "w9:p1",
        workspaceId: "w9",
        workspaceLabel: "new-space",
        tabId: "w9:t1",
        cwd: "/home/you",
      },
    }),
  ),
  // The DEFAULT world is solo, so the census refuses exactly as a non-lead bridge does: 404 with the
  // app's ordinary JSON error shape. Every pre-existing test therefore keeps asserting the one-host
  // world, and a test that wants a pack overrides this with `fixturePackStatus`.
  http.get("/api/pack", () =>
    HttpResponse.json(
      { error: "this collie is not the lead of a pack", code: "pack.not_lead" },
      { status: 404 },
    ),
  ),
  http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "" })),
  http.post<never, { snoozedUntil: number | null }>("/api/notifications/snooze", async ({ request }) => {
    const { snoozedUntil } = await request.json();
    return HttpResponse.json({ snoozedUntil });
  }),
  http.get("/api/notifications/prefs", () =>
    HttpResponse.json({ blocked: true, done: false, updates: true }),
  ),
  http.post<never, Partial<{ blocked: boolean; done: boolean; updates: boolean }>>("/api/notifications/prefs", async ({ request }) => {
    const patch = await request.json();
    return HttpResponse.json({ blocked: true, done: false, updates: true, ...patch });
  }),
  // Device pairing. The default world has NOTHING paired — writes are ungated, exactly like a
  // fresh install — so every pre-existing test keeps asserting the unpaired-and-unenforced bridge,
  // and a test that wants pairing on overrides these two.
  http.get("/api/devices", () =>
    HttpResponse.json({ enforced: false, current: null, devices: [] }),
  ),
  http.post("/api/devices/revoke", () =>
    HttpResponse.json({ enforced: false, current: null, devices: [] }),
  ),
  http.post("/api/pair", () =>
    HttpResponse.json({ error: "no-pending" }, { status: 400 }),
  ),
  http.post("/api/update/check", () =>
    HttpResponse.json({
      current: "0.11.0",
      latest: "0.11.0",
      latestUrl: null,
      releaseAvailable: false,
      majorAvailable: null,
      majorUrl: null,
      bridgeStale: false,
      checkedAt: Date.now(),
    }),
  ),
];
