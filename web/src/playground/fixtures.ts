// Fixture data for the states playground — a believable herd, four rosters, three panes, so the page
// shows what Collie looks like on a working day instead of on a two-row test snapshot.
//
// DEV-ONLY, like the rest of `src/playground/`: this module is only ever reached from
// `playground.html`, which is not a build input.
//
// ── The rules this file keeps ────────────────────────────────────────────────────────────────────
//
//  1. **Every shape is the app's own type.** Nothing here is a loose object literal cast into place:
//     `AgentView`, `ServerSummary`, `PackStatusResponse`, `SessionSummary`, `UpdateInfo`,
//     `HostHealth`, `DevicesData` and `HomeData` are all imported and annotated, so a wire change
//     breaks this file at `tsc` rather than at a confusing render.
//
//  2. **It EXTENDS `@/test/handlers`, it does not replace it.** The test suite's fixtures are still
//     re-exported below and still used where a card wants to show exactly what a test asserts. The
//     richer set lives alongside them because a two-agent herd cannot show a four-section triage,
//     a nine-machine formation, or a "needs you" count that means anything.
//
//  3. **ONE clock anchor, {@link TS}, and every timestamp is expressed as an offset from it.** No
//     fixture calls `Date.now()` for itself. That matters twice over: the pack surfaces date their
//     `lastSeenAt` values against the snapshot's own `ts` (PACK_PROTOCOL.md §10.2), so a roster and
//     a census built off different anchors would disagree about the same machine; and the herd rows
//     render "how long ago" through `timeAgo`, so a scattered set of anchors would make two agents
//     that are meant to be four minutes apart read as four months apart.
//
//     The anchor is captured ONCE, at module load, from the wall clock — see the constant's own
//     note for why that is the right shape for a page and not a violation of the rule above.

import type { HostHealth } from "@/lib/host-health";
import type { DevicesData, HomeData } from "@/lib/loaders";
import type {
  AgentView,
  DeviceAuth,
  PackMemberStatus,
  PackStatusResponse,
  ServerSummary,
  SessionSummary,
  TabView,
  UpdateInfo,
  WorkspaceView,
} from "@/lib/types";

// Three real pane captures out of the byte-faithful corpus (web/src/fixtures/panes/*.txt). Imported
// `?raw` so the browser gets the same bytes the harness conformance suite reads off disk with
// `node:fs` — the playground's mirror is therefore the exact screen the grammar tests run against,
// escape sequences and all, rather than a re-typed approximation of one.
import claudePermissionBash from "@/fixtures/panes/claude--permission-bash.txt?raw";
import claudeWorking from "@/fixtures/panes/claude--working.txt?raw";

export {
  fixtureAgents,
  fixturePackStatus,
  fixtureServers,
  fixtureSessions,
  fixtureShellPanes,
} from "@/test/handlers";

// ── The one clock ────────────────────────────────────────────────────────────────────────────────

/**
 * The lead's clock at "snapshot time" — the single anchor every timestamp in this file is an offset
 * from.
 *
 * It is read from the wall clock EXACTLY ONCE, when the module is first evaluated, and then frozen
 * for the life of the page. That is deliberate, and it is not the thing the "no `Date.now()` in
 * fixtures" rule forbids:
 *
 *  • The rule exists to stop a *drifting* set of anchors — twelve fixtures each calling `Date.now()`
 *    at their own moment, so ages that are supposed to be four minutes apart come out inconsistent,
 *    and a re-render moves a stamp that is meant to be still. One frozen constant has neither
 *    problem: `TS - 4 * MIN` is four minutes before `TS` on every render, forever.
 *
 *  • The pack surfaces date against the snapshot's own `ts` and would be happy with any fixed
 *    number. The HERD rows are not: `components/agent-card.tsx` renders its "since" through
 *    `timeAgo`, whose default `now` is the wall clock. Anchored to a hard-coded epoch, all fourteen
 *    agents would read "8 months ago" and the whole point of "varied since ages" would be lost.
 *
 * So: one wall-clock read, at the top of the file, named — and every fixture below measured from it.
 */
export const TS = Date.now();

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Kept under its old name: the pack cards that mount the TEST suite's census need its `ts`. */
export const FIXTURE_TS = 400_000;

// ── The spaces and tabs the herd lives in ────────────────────────────────────────────────────────
//
// Four projects, because triage only starts to look like triage when a "Needs you" list spans more
// than one of them. Herdr numbers spaces per machine, which is why the ids repeat across hosts in
// the pack snapshot below — that collision is the reason a pane row carries its own host.

export const spaces: WorkspaceView[] = [
  { workspaceId: "w1", number: 1, label: "collie", focused: true, activeTabId: "w1:t1", tabCount: 3, paneCount: 4 },
  { workspaceId: "w2", number: 2, label: "sprqvntrs-api", focused: false, activeTabId: "w2:t1", tabCount: 3, paneCount: 4 },
  { workspaceId: "w3", number: 3, label: "nixcfg", focused: false, activeTabId: "w3:t1", tabCount: 2, paneCount: 3 },
  { workspaceId: "w4", number: 4, label: "blog", focused: false, activeTabId: "w4:t1", tabCount: 2, paneCount: 2 },
];

export const tabs: TabView[] = [
  { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "feat/pack-overview", focused: true, paneCount: 2 },
  { tabId: "w1:t2", workspaceId: "w1", number: 2, label: "docs", focused: false, paneCount: 1 },
  { tabId: "w1:t3", workspaceId: "w1", number: 3, label: "shell", focused: false, paneCount: 1 },
  { tabId: "w2:t1", workspaceId: "w2", number: 1, label: "fix-deploy", focused: false, paneCount: 1 },
  { tabId: "w2:t2", workspaceId: "w2", number: 2, label: "migrate-users", focused: false, paneCount: 1 },
  { tabId: "w2:t3", workspaceId: "w2", number: 3, label: "billing-webhooks", focused: false, paneCount: 2 },
  { tabId: "w3:t1", workspaceId: "w3", number: 1, label: "flake-bump", focused: false, paneCount: 2 },
  { tabId: "w3:t2", workspaceId: "w3", number: 2, label: "hosts", focused: false, paneCount: 1 },
  { tabId: "w4:t1", workspaceId: "w4", number: 1, label: "post/collie-launch", focused: false, paneCount: 1 },
  { tabId: "w4:t2", workspaceId: "w4", number: 2, label: "seo-pass", focused: false, paneCount: 1 },
];

// ── The herd ─────────────────────────────────────────────────────────────────────────────────────
//
// Fourteen panes across those four spaces and four harnesses, laid out so every triage section has
// enough rows to have a shape: three that need you, two finished-and-unseen, five working at five
// different ages, and four resting. `agent` values are what Herdr actually reports, so `gemini` lands
// on `AgentIcon`'s initials tile — the honest rendering for a harness with no bundled logo, and a
// state worth being able to look at.
//
// Sorting facts, in the app's own terms:
//  • `blocked` is "needs you"; a `done` pane whose `lastActiveAt > lastSeenAt` is "ready · unseen";
//    a `done` pane you have already opened falls to Recent.
//  • `lastActiveAt` is the last status transition — what a Working row's "since" counts from.
//  • `lastSeenAt` is when YOU last drove the pane through Collie — what Recent is ordered on.

/** Three panes waiting on the operator, each stuck on a different kind of question. */
const needsYou: AgentView[] = [
  {
    paneId: "w1:p1",
    workspaceId: "w1",
    workspaceLabel: "collie",
    workspaceNumber: 1,
    tabId: "w1:t1",
    tabLabel: "feat/pack-overview",
    agent: "claude",
    status: "blocked",
    cwd: "/home/you/src/collie",
    focused: true,
    hasSession: true,
    sessionName: "pack overview",
    terminalTitle: "claude — pack overview",
    hint: "waiting on a permission prompt: run `bun run build` in /home/you/src/collie",
    lastActiveAt: TS - 90 * SEC,
    lastSeenAt: TS - 26 * MIN,
    readableLines: 400,
  },
  {
    paneId: "w2:p3",
    workspaceId: "w2",
    workspaceLabel: "sprqvntrs-api",
    workspaceNumber: 2,
    tabId: "w2:t1",
    tabLabel: "fix-deploy",
    agent: "codex",
    status: "blocked",
    cwd: "/home/you/src/sprqvntrs-api",
    focused: false,
    hasSession: true,
    hint: "asked you a question and is waiting for the answer",
    lastActiveAt: TS - 7 * MIN,
    lastSeenAt: TS - 55 * MIN,
    readableLines: 400,
  },
  {
    paneId: "w3:p2",
    workspaceId: "w3",
    workspaceLabel: "nixcfg",
    workspaceNumber: 3,
    tabId: "w3:t1",
    tabLabel: "flake-bump",
    agent: "claude",
    status: "blocked",
    cwd: "/home/you/src/nixcfg",
    focused: false,
    // ADR 0017: recognising a password prompt changes what Collie SAYS, never what it sends. The
    // bridge composes this sentence; the phone prints it and offers no shortcut past it.
    hint: "a password prompt is on screen — Collie will not type into it; tap Type to answer yourself",
    lastActiveAt: TS - 19 * MIN,
    lastSeenAt: TS - 3 * HOUR,
    readableLines: 400,
  },
];

/** Two finished runs you have not looked at yet — `lastActiveAt` is ahead of `lastSeenAt`. */
const readyUnseen: AgentView[] = [
  {
    paneId: "w2:p4",
    workspaceId: "w2",
    workspaceLabel: "sprqvntrs-api",
    workspaceNumber: 2,
    tabId: "w2:t3",
    tabLabel: "billing-webhooks",
    agent: "claude",
    status: "done",
    cwd: "/home/you/src/sprqvntrs-api",
    focused: false,
    hasSession: true,
    sessionName: "billing webhooks",
    hint: "finished: 4 files changed, tests green",
    lastActiveAt: TS - 11 * MIN,
    lastSeenAt: TS - 2 * HOUR,
    readableLines: 400,
  },
  {
    paneId: "w4:p2",
    workspaceId: "w4",
    workspaceLabel: "blog",
    workspaceNumber: 4,
    tabId: "w4:t2",
    tabLabel: "seo-pass",
    // No bundled logo for this one — `AgentIcon` falls back to the neutral initials tile, which is
    // exactly what an unknown harness looks like in the real list.
    agent: "gemini",
    status: "done",
    cwd: "/home/you/src/blog",
    focused: false,
    lastActiveAt: TS - 48 * MIN,
    lastSeenAt: TS - 5 * HOUR,
  },
];

/** Five running, at five deliberately different ages — seconds, minutes, half an hour, hours. */
const working: AgentView[] = [
  {
    paneId: "w1:p2",
    workspaceId: "w1",
    workspaceLabel: "collie",
    workspaceNumber: 1,
    tabId: "w1:t2",
    tabLabel: "docs",
    agent: "claude",
    status: "working",
    cwd: "/home/you/src/collie",
    focused: false,
    hasSession: true,
    terminalTitle: "rewriting ARCHITECTURE.md",
    lastActiveAt: TS - 40 * SEC,
    lastSeenAt: TS - 40 * SEC,
    readableLines: 400,
  },
  {
    paneId: "w2:p1",
    workspaceId: "w2",
    workspaceLabel: "sprqvntrs-api",
    workspaceNumber: 2,
    tabId: "w2:t2",
    tabLabel: "migrate-users",
    agent: "codex",
    status: "working",
    cwd: "/home/you/src/sprqvntrs-api",
    focused: false,
    terminalTitle: "running drizzle-kit generate",
    lastActiveAt: TS - 4 * MIN,
    lastSeenAt: TS - 12 * MIN,
  },
  {
    paneId: "w3:p1",
    workspaceId: "w3",
    workspaceLabel: "nixcfg",
    workspaceNumber: 3,
    tabId: "w3:t2",
    tabLabel: "hosts",
    agent: "pi",
    status: "working",
    cwd: "/home/you/src/nixcfg",
    focused: false,
    hasSession: true,
    lastActiveAt: TS - 12 * MIN,
    lastSeenAt: TS - 40 * MIN,
  },
  {
    paneId: "w4:p1",
    workspaceId: "w4",
    workspaceLabel: "blog",
    workspaceNumber: 4,
    tabId: "w4:t1",
    tabLabel: "post/collie-launch",
    agent: "opencode",
    status: "working",
    cwd: "/home/you/src/blog",
    focused: false,
    paneLabel: "launch post",
    lastActiveAt: TS - 38 * MIN,
    lastSeenAt: TS - 38 * MIN,
  },
  {
    paneId: "w2:p2",
    workspaceId: "w2",
    workspaceLabel: "sprqvntrs-api",
    workspaceNumber: 2,
    tabId: "w2:t3",
    tabLabel: "billing-webhooks",
    agent: "claude",
    status: "working",
    cwd: "/home/you/src/sprqvntrs-api",
    focused: false,
    hasSession: true,
    terminalTitle: "waiting on CI",
    lastActiveAt: TS - 2 * HOUR - 20 * MIN,
    lastSeenAt: TS - 2 * HOUR - 20 * MIN,
  },
];

/** Four at rest: two idle agents, two bare shells. Recent is ordered on `lastSeenAt`. */
const resting: AgentView[] = [
  {
    paneId: "w3:p3",
    workspaceId: "w3",
    workspaceLabel: "nixcfg",
    workspaceNumber: 3,
    tabId: "w3:t1",
    tabLabel: "flake-bump",
    agent: "claude",
    status: "idle",
    cwd: "/home/you/src/nixcfg",
    focused: false,
    hasSession: true,
    lastActiveAt: TS - 4 * HOUR,
    lastSeenAt: TS - 34 * MIN,
  },
  {
    paneId: "w1:p3",
    workspaceId: "w1",
    workspaceLabel: "collie",
    workspaceNumber: 1,
    tabId: "w1:t1",
    tabLabel: "feat/pack-overview",
    agent: "codex",
    status: "idle",
    cwd: "/home/you/src/collie",
    focused: false,
    // A title the program that printed it has already exited under: it demotes to the muted line and
    // stops being the pane's NAME (see `paneDisplayName`), which is a state worth being able to see.
    terminalTitle: "pnpm test --watch",
    terminalTitleStale: true,
    lastActiveAt: TS - 6 * HOUR,
    lastSeenAt: TS - 3 * HOUR,
  },
  {
    paneId: "w1:p4",
    workspaceId: "w1",
    workspaceLabel: "collie",
    workspaceNumber: 1,
    tabId: "w1:t3",
    tabLabel: "shell",
    agent: "shell",
    status: "unknown",
    cwd: "/home/you/src/collie",
    focused: false,
    kind: "shell",
    lastActiveAt: TS - 9 * HOUR,
    lastSeenAt: TS - 6 * HOUR,
  },
  {
    paneId: "w2:p5",
    workspaceId: "w2",
    workspaceLabel: "sprqvntrs-api",
    workspaceNumber: 2,
    tabId: "w2:t3",
    tabLabel: "billing-webhooks",
    agent: "shell",
    status: "unknown",
    cwd: "/home/you/src/sprqvntrs-api",
    focused: false,
    kind: "shell",
    paneLabel: "logs",
    lastActiveAt: TS - DAY,
    lastSeenAt: TS - 20 * HOUR,
  },
];

/** The agent-bearing panes — what `SnapshotResponse.agents` carries. Ten of the fourteen. */
export const herd: AgentView[] = [...needsYou, ...readyUnseen, ...working, ...resting.slice(0, 2)];

/** The bare shells — what `SnapshotResponse.shellPanes` carries. The other four... two of them. */
export const shells: AgentView[] = resting.slice(2);

/** All fourteen in one list, for the cards that render a single flat roster. */
export const allPanes: AgentView[] = [...herd, ...shells];

// ── Sessions ─────────────────────────────────────────────────────────────────────────────────────
//
// Primary-first, then alphabetical — the bridge's own order. Counts are per session, which is why
// the switcher lists one host's sessions at a time: a flat merged list would offer "default" twice.

export const sessionsSolo: SessionSummary[] = [
  { name: "default", isPrimary: true, reachable: true, agents: 8, working: 4, blocked: 3 },
  { name: "nightly", isPrimary: false, reachable: true, agents: 2, working: 1, blocked: 0 },
  // A named session whose socket has gone: zeroed counts, greyed-out and non-clickable in the switcher.
  { name: "spike", isPrimary: false, reachable: false, agents: 0, working: 0, blocked: 0 },
];

/** The same three on the lead, plus one per peer. Every machine calls its primary "default". */
export const sessionsPack: SessionSummary[] = [
  ...sessionsSolo.map((s) => ({ ...s, host: "bluefin" })),
  { name: "default", isPrimary: true, reachable: true, agents: 3, working: 1, blocked: 1, host: "workshop" },
  { name: "default", isPrimary: true, reachable: true, agents: 1, working: 0, blocked: 0, host: "attic" },
  { name: "default", isPrimary: true, reachable: false, agents: 0, working: 0, blocked: 0, host: "cellar" },
];

// ── Rosters (`SnapshotResponse.servers`) ─────────────────────────────────────────────────────────
//
// The hot-path roster: what every host-aware surface polls. Lead first. `lastSeenAt` is stamped by
// the LEAD on receipt, so it is comparable to `ts` and to nothing else (PACK_PROTOCOL.md §10.2).

const lead: ServerSummary = {
  id: "bluefin",
  name: "bluefin",
  isLead: true,
  reachable: true,
  protocol: "ok",
  lastSeenAt: TS - 2 * SEC,
};

/** Solo: no pack at all. A snapshot from a solo bridge emits no `servers` key (§11). */
export const rosterSolo: ServerSummary[] = [];

/** Lead + deputy + one more, all healthy — the smallest pack that draws a full formation. */
export const rosterTrio: ServerSummary[] = [
  lead,
  { id: "workshop", name: "workshop", isLead: false, reachable: true, protocol: "ok", lastSeenAt: TS - 3 * SEC },
  { id: "attic", name: "attic", isLead: false, reachable: true, protocol: "ok", lastSeenAt: TS - 4 * SEC },
];

/** Five machines, three of them unhappy in three different ways. */
export const rosterFive: ServerSummary[] = [
  lead,
  { id: "workshop", name: "workshop", isLead: false, reachable: true, protocol: "ok", lastSeenAt: TS - 3 * SEC },
  // Stale: it answered once and has not answered since.
  { id: "attic", name: "attic", isLead: false, reachable: false, protocol: "ok", lastSeenAt: TS - 14 * MIN },
  // Never seen: enrolled, never reached, so nothing about it has ever been confirmed. `0`, not a date.
  { id: "cellar", name: "cellar", isLead: false, reachable: false, protocol: "unknown", lastSeenAt: 0 },
  {
    id: "garage",
    name: "garage",
    isLead: false,
    reachable: true,
    protocol: "incompatible",
    // Verbatim, from the peer's own refusal — rendered as text, never paraphrased.
    protocolDetail: "pack protocol 2 (this collie speaks 1)",
    lastSeenAt: TS - 6 * SEC,
  },
];

/** Nine machines — enough that the formation's V has to wrap onto a third and fourth row. */
export const rosterNine: ServerSummary[] = [
  lead,
  ...["workshop", "attic", "cellar", "garage", "loft", "shed", "barn", "kennel"].map(
    (id, i): ServerSummary => ({
      id,
      name: id,
      isLead: false,
      reachable: i !== 5,
      protocol: "ok",
      lastSeenAt: i === 5 ? TS - 22 * MIN : TS - (3 + i) * SEC,
    }),
  ),
];

// ── The census (`GET /api/pack`) ─────────────────────────────────────────────────────────────────
//
// One page's worth of paperwork per machine: enrolment, warrant and secret generations, versions.
// Every timestamp is on the LEAD's clock — the same `TS` as the rosters above, so a card can mount
// a roster and a census together and the two never disagree about a machine.

const LEAD_VERSION = "0.31.0";

function member(
  id: string,
  health: PackMemberStatus["health"],
  extra: Partial<PackMemberStatus> = {},
): PackMemberStatus {
  return {
    id,
    name: id,
    isLead: false,
    address: `${id}.tail1a2b.ts.net:8787`,
    enrolledAt: TS - 40 * DAY,
    health,
    lastSeenAt: TS - 4 * SEC,
    version: LEAD_VERSION,
    secretBehind: false,
    provisional: false,
    ...extra,
  };
}

const selfMember: PackMemberStatus = {
  id: "bluefin",
  name: "bluefin",
  isLead: true,
  health: "reachable",
  lastSeenAt: TS - 2 * SEC,
  version: LEAD_VERSION,
  secretBehind: false,
  provisional: false,
};

const packMeta = { id: "pk1", name: "kennel", secretGeneration: 4, rotatedAt: TS - 9 * DAY };
const packSelf = { id: "bluefin", name: "bluefin", version: LEAD_VERSION };

/** One machine, leading nobody but itself — the smallest census a lead can serve. */
export const censusSolo: PackStatusResponse = {
  pack: { ...packMeta, name: "bluefin" },
  self: packSelf,
  deputy: null,
  members: [selfMember],
  ts: TS,
};

/** Lead + a named deputy + one ordinary peer. Everything healthy. */
export const censusTrio: PackStatusResponse = {
  pack: packMeta,
  self: packSelf,
  deputy: { id: "workshop", warrantGeneration: 3 },
  members: [
    selfMember,
    member("workshop", "reachable", { enrolledAt: TS - 120 * DAY }),
    member("attic", "reachable", { version: "0.30.2" }),
  ],
  ts: TS,
};

/**
 * Five machines and three separate problems, which is the census this page exists to make legible:
 * a peer that has gone quiet, a peer that was enrolled and never once answered, and a peer running a
 * protocol this lead cannot speak — with its refusal quoted word for word.
 */
export const censusFive: PackStatusResponse = {
  pack: packMeta,
  self: packSelf,
  deputy: { id: "workshop", warrantGeneration: 3 },
  members: [
    selfMember,
    member("workshop", "reachable", { enrolledAt: TS - 120 * DAY }),
    member("attic", "unreachable", {
      reason: "connect ECONNREFUSED 100.71.4.9:8787",
      lastSeenAt: TS - 14 * MIN,
      version: "0.30.2",
    }),
    member("cellar", "unreachable", {
      reason: "no answer since enrolment",
      lastSeenAt: 0,
      enrolledAt: TS - 2 * DAY,
      version: undefined,
      provisional: true,
    }),
    member("garage", "incompatible", {
      reason: "pack protocol 2 (this collie speaks 1)",
      version: "0.34.0",
      secretBehind: true,
    }),
  ],
  ts: TS,
};

/** Nine machines. The formation wraps its V; the list below it stays one column. */
export const censusNine: PackStatusResponse = {
  pack: packMeta,
  self: packSelf,
  deputy: { id: "workshop", warrantGeneration: 3 },
  members: [
    selfMember,
    ...["workshop", "attic", "cellar", "garage", "loft", "shed", "barn", "kennel"].map((id, i) =>
      member(id, i === 5 ? "unreachable" : "reachable", {
        lastSeenAt: i === 5 ? TS - 22 * MIN : TS - (3 + i) * SEC,
        version: i % 3 === 0 ? "0.30.2" : LEAD_VERSION,
      }),
    ),
  ],
  ts: TS,
};

/**
 * The loud one: `attic` believes ANOTHER collie leads this pack, under a warrant generation higher
 * than the deputy's. Two collies both convinced they are the lead is not a transient the next poll
 * clears, so the page names it rather than folding it into "unreachable".
 */
export const censusConflicted: PackStatusResponse = {
  pack: packMeta,
  self: packSelf,
  deputy: { id: "workshop", warrantGeneration: 3 },
  members: [
    selfMember,
    member("workshop", "reachable"),
    member("attic", "conflicted", {
      reason: "this member is enrolled in a pack led by cellar",
      lastSeenAt: TS - 40 * SEC,
      secretBehind: true,
      conflict: { leadMemberId: "cellar", warrantGeneration: 7 },
    }),
  ],
  ts: TS,
};

// ── Snapshots (`HomeData`, as the root loader hands it down) ─────────────────────────────────────

/** A healthy solo snapshot: the full herd, one machine, three sessions. */
export const homeSolo: HomeData = {
  bridge: "connected",
  device: undefined,
  agents: herd,
  shellPanes: shells,
  workspaces: spaces,
  tabs,
  sessions: sessionsSolo,
  servers: rosterSolo,
  ts: TS,
  scope: {},
  snoozedUntil: null,
  update: undefined,
  error: false,
  authError: false,
};

/**
 * The same pane, tagged with the machine it lives on.
 *
 * Cloned and assigned rather than spread inside the `map` body — the shape `@/test/handlers` uses
 * for `fixturePackShellPanes`, and for its reason: one clone per row instead of an object literal
 * plus a spread, and it says plainly that `host` is the ONLY difference from the solo pane.
 */
function onHost(pane: AgentView, host: string): AgentView {
  // SAFETY: `structuredClone` of an `AgentView` — a plain data record of strings, numbers and
  // booleans — is an `AgentView`. There is no function, class instance or cycle in the shape.
  const packed: AgentView = structuredClone(pane);
  packed.host = host;
  return packed;
}

/**
 * Which machine each herd row lands on. Written out rather than round-robined so the counts are
 * CHOSEN: rows 0 and 1 are the first two blocked panes and land on `bluefin` and `workshop`, which
 * is what gives exactly two machines a non-zero "needs you" number in the server switcher.
 */
const PACK_HOST_BY_INDEX: readonly string[] = [
  "bluefin", // needs-you #1
  "workshop", // needs-you #2
  "bluefin", // needs-you #3
  "bluefin", // ready · unseen
  "attic", // ready · unseen
  "bluefin", // working
  "workshop", // working
  "attic", // working
  "bluefin", // working
  "workshop", // working
];

/**
 * The same herd spread over a five-machine pack. Host-tagging is what makes the per-host counts in
 * the server switcher (and the "needs you" numbers on two of the machines) mean anything: the
 * switcher derives them client-side from the merged `agents` array, never from the roster.
 */
export const homePack: HomeData = {
  ...homeSolo,
  agents: herd.map((a, i) => onHost(a, PACK_HOST_BY_INDEX[i % PACK_HOST_BY_INDEX.length]!)),
  shellPanes: shells.map((p) => onHost(p, "bluefin")),
  sessions: sessionsPack,
  servers: rosterFive,
};

/** A three-machine pack, on the trio roster — pairs with {@link censusTrio}. */
export const homeTrio: HomeData = { ...homePack, servers: rosterTrio };

/** A nine-machine pack — pairs with {@link censusNine}. */
export const homeNine: HomeData = { ...homePack, servers: rosterNine };

// ── Update info ──────────────────────────────────────────────────────────────────────────────────
//
// `updateNotice`'s precedence: a stale running PROCESS outranks an available release, which outranks
// a major that needs the operator's explicit consent (ADR 0020).

export const updateRestart: UpdateInfo = {
  current: "0.31.0",
  latest: "0.31.0",
  latestUrl: null,
  releaseAvailable: false,
  majorAvailable: null,
  majorUrl: null,
  bridgeStale: true,
  checkedAt: TS - 6 * MIN,
};

export const updateRelease: UpdateInfo = {
  current: "0.31.0",
  latest: "0.32.1",
  latestUrl: "https://github.com/AltanS/collie/releases/tag/v0.32.1",
  releaseAvailable: true,
  majorAvailable: null,
  majorUrl: null,
  bridgeStale: false,
  checkedAt: TS - 6 * MIN,
};

export const updateMajor: UpdateInfo = {
  current: "0.31.0",
  latest: "0.32.1",
  latestUrl: "https://github.com/AltanS/collie/releases/tag/v0.32.1",
  releaseAvailable: false,
  majorAvailable: "1.0.0",
  majorUrl: "https://github.com/AltanS/collie/releases/tag/v1.0.0",
  bridgeStale: false,
  checkedAt: TS - 6 * MIN,
};

// ── The write gates ──────────────────────────────────────────────────────────────────────────────

/** A device the fronting proxy named and the bridge does not allowlist. Nothing on the phone fixes it. */
export const deviceRefused: DeviceAuth = {
  enforced: true,
  device: "kitchen-phone",
  authorized: false,
};

/** Nothing paired: writes are ungated, exactly as on a fresh install. */
export const devicesUnpaired: DevicesData = {
  enforced: false,
  current: null,
  devices: [],
  error: false,
};

/** Three paired devices, one of them the phone you are holding. */
export const devicesPaired: DevicesData = {
  enforced: true,
  current: "pixel",
  devices: [
    { label: "pixel", createdAt: TS - 90 * DAY, lastSeenAt: TS - 30 * SEC, current: true },
    { label: "ipad", createdAt: TS - 60 * DAY, lastSeenAt: TS - 2 * DAY, current: false },
    { label: "kitchen-tablet", createdAt: TS - 5 * DAY, lastSeenAt: TS - 5 * DAY, current: false },
  ],
  error: false,
};

// ── Tier-2 host health ───────────────────────────────────────────────────────────────────────────
//
// Hand-built rather than derived: `HostStaleBanner`'s table is keyed on `state` and `writable`
// TOGETHER, and stating both directly is the only way to put a row of it on screen at will.

export const hostUnreachable: HostHealth = {
  host: "attic",
  name: "attic",
  state: "stale",
  writable: false,
  incompatible: false,
  lastSeenAt: TS - 14 * MIN,
  lastSeenLabel: "last seen 14m ago",
  isLead: false,
};

export const hostNeverSeen: HostHealth = {
  host: "cellar",
  name: "cellar",
  state: "unknown",
  writable: false,
  incompatible: false,
  lastSeenAt: 0,
  lastSeenLabel: "never seen",
  isLead: false,
};

export const hostIncompatible: HostHealth = {
  host: "garage",
  name: "garage",
  state: "stale",
  writable: false,
  incompatible: true,
  protocolDetail: "pack protocol 2 (this collie speaks 1)",
  lastSeenAt: TS - 6 * SEC,
  lastSeenLabel: "last seen just now",
  isLead: false,
};

// ── Panes ────────────────────────────────────────────────────────────────────────────────────────
//
// Each one is a real capture plus the `AgentView` the pane route would have looked up for it out of
// the snapshot, so a pane card can mount the whole view with nothing missing.

/** A shell pane. Synthesised rather than captured — the corpus is a corpus of AGENT screens, and a
 *  bare shell has no grammar to pin, so there is nothing on disk to reuse. Real ANSI, hand-written. */
const ESC = "";
const shellPaneText = [
  `${ESC}[1;32myou@bluefin${ESC}[0m:${ESC}[1;34m~/src/collie${ESC}[0m$ bun run test`,
  "",
  `${ESC}[32m✓${ESC}[0m web/src/lib/triage.test.ts (14 tests) 41ms`,
  `${ESC}[32m✓${ESC}[0m web/src/lib/host-health.test.ts (22 tests) 63ms`,
  `${ESC}[32m✓${ESC}[0m web/src/components/agent-list.test.tsx (9 tests) 118ms`,
  `${ESC}[31m✗${ESC}[0m web/src/components/pack-formation.test.tsx (11 tests | 1 failed) 92ms`,
  `  ${ESC}[31m→ expected 9 nodes, received 8${ESC}[0m`,
  "",
  ` Test Files  ${ESC}[31m1 failed${ESC}[0m | ${ESC}[32m3 passed${ESC}[0m (4)`,
  `      Tests  ${ESC}[31m1 failed${ESC}[0m | ${ESC}[32m55 passed${ESC}[0m (56)`,
  "",
  `${ESC}[1;32myou@bluefin${ESC}[0m:${ESC}[1;34m~/src/collie${ESC}[0m$ `,
].join("\n");

/** A pane, and the screen it is showing. */
export interface PaneFixture {
  readonly pane: AgentView;
  readonly text: string;
  readonly revision: number;
}

/** Blocked on Claude's y/n permission prompt — the screen the prompt grammar lifts a dialog out of. */
export const paneBlocked: PaneFixture = {
  pane: needsYou[0]!,
  text: claudePermissionBash,
  revision: 812,
};

/** Mid-tool-run, with the ANSI the mirror actually has to colour. */
export const paneWorking: PaneFixture = {
  pane: working[0]!,
  text: claudeWorking,
  revision: 4_517,
};

/** A bare shell — no agent, no grammar, a ShellBadge in place of the status chip. */
export const paneShell: PaneFixture = {
  pane: shells[0]!,
  text: shellPaneText,
  revision: 96,
};
