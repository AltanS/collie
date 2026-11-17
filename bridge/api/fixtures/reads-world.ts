// INVENTED DATA for the five reads' tests (reads.test.ts, leak.test.ts): a bridge with two multiplexer
// sessions, a few panes, accounts and Hill cards. Every name, host, address and path is made up and
// ends `.invalid` or sits under `/home/ada`. The NEEDLES are the five things no answer may carry (an
// email, a folder path, a pairing code, a sign-in address, a message text), and `world()` puts them in
// every field the phone's bodies carry them in.

import { EventBus } from "../../events/bus.ts";
import type { HillDecision } from "../../../web/src/lib/hill/wire.ts";
import type { AccountRow, AgentView } from "../../types.ts";
import type { PaneSource, ReadsDeps, ScreenRead } from "../reads.ts";

export const MACHINE = "inst-fixture-a1";

/** What must never reach an answer. `folderName` is the one part of the path that `sessions` may carry. */
export const NEEDLES = {
  email: "ada@example.invalid",
  path: "/home/ada/secret-project",
  parent: "/home/ada",
  folderName: "secret-project",
  pairing: "ABCD-1234-EFGH",
  signIn: "https://login.example.invalid/device?code=QWERTY",
  message: "please deploy the vault",
  plan: "enterprise-secret-tier",
} as const;

/** One pane of the fixture bridge: the needles are in every field but the ones an answer may carry. */
export function pane(paneId: string, overrides: Partial<AgentView> = {}): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: NEEDLES.path,
    workspaceNumber: 1,
    tabId: "t1",
    tabLabel: NEEDLES.parent,
    agent: "claude",
    status: "idle",
    cwd: NEEDLES.path,
    focused: false,
    agentTitle: `${NEEDLES.message} for ${NEEDLES.email}`,
    terminalTitle: `${NEEDLES.pairing} ${NEEDLES.signIn}`,
    subtitle: NEEDLES.message,
    badge: { text: NEEDLES.pairing },
    hint: NEEDLES.signIn,
    agentSession: { kind: "path", value: `${NEEDLES.path}/session.jsonl` },
    todos: [{ id: "1", text: NEEDLES.message, status: "pending", activeForm: NEEDLES.email }],
    subagents: [{ agentId: "a1", description: `${NEEDLES.message} ${NEEDLES.path}` }],
    jobs: [{ id: "j1", label: NEEDLES.email, command: `cat ${NEEDLES.path}`, startedAt: "2026-11-17T10:00:00.000Z" }],
    model: "model-x",
    ...overrides,
  };
}

/** An added account row with the needles in every field that holds a person's data. */
export function accountRow(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "acc_fixture1",
    harness: "claude",
    label: "work",
    kind: "own",
    folder: NEEDLES.path,
    startLine: `CLAUDE_CONFIG_DIR=${NEEDLES.path} claude`,
    windows: [],
    seenAt: null,
    live: true,
    running: 2,
    unlinked: [NEEDLES.path],
    identity: { signedIn: true, email: NEEDLES.email, plan: NEEDLES.plan },
    ...overrides,
  };
}

/** A Hill decision with the needles in its body, options, answer, links, media and view. */
export function decision(overrides: Partial<HillDecision> = {}): HillDecision {
  return {
    v: 1,
    id: "dc_fixture00001",
    requestId: "00000000-0000-4000-8000-000000000001",
    from: { kind: "agent", address: `${MACHINE}/w1:p1#k3f9`, trickId: null, trickKey: null, memberId: MACHINE, harness: "claude", label: "build box", host: NEEDLES.path, trickHost: null },
    about: `${MACHINE}/w1:p1#k3f9`,
    priority: "today",
    priorityAsked: "now",
    title: "Deploy window",
    summary: NEEDLES.message,
    body: `${NEEDLES.message}\n\n${NEEDLES.path}\n${NEEDLES.email}\n${NEEDLES.signIn}`,
    options: [{ intent: "go", label: NEEDLES.email, detail: NEEDLES.path, confirm: NEEDLES.pairing }],
    text: "optional",
    recommends: { intent: "go", why: NEEDLES.message },
    media: [{ id: "im_0123456789abcdef", kind: "image", mime: "image/png", bytes: 10, width: 1, height: 1, caption: NEEDLES.path }],
    links: [{ label: NEEDLES.email, href: NEEDLES.signIn }],
    replyTo: null,
    target: { label: NEEDLES.path, host: NEEDLES.parent, unattended: false },
    supersedes: null,
    supersededBy: null,
    expiresAt: null,
    at: Date.UTC(2026, 10, 17, 9, 30, 0),
    state: "open",
    closedAt: null,
    closedReason: null,
    answer: null,
    ...overrides,
  };
}

/** A decision that is answered: its answer text and its title carry needles and must not be listed. */
export function answeredDecision(): HillDecision {
  return decision({
    id: "dc_fixture00002",
    title: `${NEEDLES.message} (closed)`,
    state: "answered",
    closedAt: Date.UTC(2026, 10, 17, 9, 45, 0),
    answer: { rid: "r1", intent: "answer", label: NEEDLES.email, text: NEEDLES.message, by: NEEDLES.pairing, at: 1, delivery: "typed", trick: "none" },
  });
}

/** What the fixture bridge is made of; a test sets the fields it changes. */
export interface World {
  panes: PaneSource[];
  instances: Map<string, string>;
  accounts: AccountRow[] | null;
  accountLabels: Map<string, string>;
  drafts: Map<string, boolean | null>;
  screens: Map<string, ScreenRead>;
  hill: HillDecision[] | null;
  bus: EventBus;
  defaultLines: number;
  /** The `(muxSession, paneId, lines)` of every screen read, in order. */
  screenAsks: { muxSession: string; paneId: string; lines: number }[];
}

export function newBus(): EventBus {
  return new EventBus({ machine: () => MACHINE, bootId: "bootfx" });
}

/** The key the maps of a world use for one pane. */
export function keyOf(muxSession: string, paneId: string): string {
  return `${muxSession}\u0000${paneId}`;
}

/** A world of two multiplexer sessions: an agent in `main`, an agent and a shell in `side`. */
export function world(): World {
  const w: World = {
    panes: [
      { muxSession: "main", pane: pane("w1:p1", { status: "blocked", paneLabel: undefined }) },
      { muxSession: "side", pane: pane("w2:p1", { status: "working", agent: "codex", paneLabel: "review box" }) },
      { muxSession: "side", pane: pane("w2:p2", { kind: "shell", agent: "shell" }) },
    ],
    instances: new Map([
      [keyOf("main", "w1:p1"), "k3f9"],
      [keyOf("side", "w2:p1"), "m4n8"],
      [keyOf("side", "w2:p2"), "q7r2"],
    ]),
    accounts: [accountRow()],
    accountLabels: new Map([[keyOf("main", "w1:p1"), "work"]]),
    drafts: new Map([[keyOf("main", "w1:p1"), true]]),
    screens: new Map(),
    hill: [decision(), answeredDecision()],
    bus: newBus(),
    defaultLines: 200,
    screenAsks: [],
  };
  return w;
}

/** The deps of a world: getters over its maps, as the bridge's own are over its objects. */
export function depsOf(w: World): ReadsDeps {
  return {
    machine: () => MACHINE,
    panes: () => w.panes,
    instanceOf: (muxSession, paneId) => w.instances.get(keyOf(muxSession, paneId)) ?? null,
    bus: w.bus,
    paneAccount: (muxSession, source) => {
      const label = w.accountLabels.get(keyOf(muxSession, source.paneId));
      return label === undefined ? undefined : { id: "acc_fixture1", label };
    },
    accountsBody: async () => (w.accounts === null ? null : { accounts: w.accounts }),
    draftState: (muxSession, paneId) => w.drafts.get(keyOf(muxSession, paneId)) ?? null,
    readScreen: async (muxSession, paneId, lines) => {
      w.screenAsks.push({ muxSession, paneId, lines });
      return w.screens.get(keyOf(muxSession, paneId)) ?? { ok: false };
    },
    hillOpen: () => w.hill,
    defaultLines: w.defaultLines,
  };
}
