// The made-up world the places screens show: two agents in two projects, one agent session's screen,
// and the question Release Gates asks on the Hill. Plain data, written here, so the places figure needs
// no playground fixture: every name is fictional ("shop", "api", host "workshop").
// DEV-ONLY, like the rest of `src/playground/`.

import type { HillDecision } from "@/lib/hill/wire";
import type { HomeData } from "@/lib/loaders";
import type { AgentView, TabView, WorkspaceView } from "@/lib/types";

const NOW = Date.now();
const MIN = 60_000;

const SPACES: WorkspaceView[] = [
  { workspaceId: "w1", number: 1, label: "shop", focused: true, activeTabId: "w1:t1", tabCount: 2, paneCount: 2 },
  { workspaceId: "w2", number: 2, label: "api", focused: false, activeTabId: "w2:t1", tabCount: 1, paneCount: 1 },
];

const TABS: TabView[] = [
  { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "release/2.4.0", focused: true, paneCount: 1 },
  { tabId: "w1:t2", workspaceId: "w1", number: 2, label: "checkout", focused: false, paneCount: 1 },
  { tabId: "w2:t1", workspaceId: "w2", number: 1, label: "fix-login", focused: false, paneCount: 1 },
];

/** The agent session the session screen shows: a release being readied. */
export const SESSION_PANE: AgentView = {
  paneId: "w1:p1",
  workspaceId: "w1",
  workspaceLabel: "shop",
  workspaceNumber: 1,
  tabId: "w1:t1",
  tabLabel: "release/2.4.0",
  agent: "claude",
  status: "idle",
  cwd: "/home/you/src/shop",
  focused: true,
  hasSession: true,
  sessionName: "release 2.4.0",
  terminalTitle: "claude: release 2.4.0",
  lastActiveAt: NOW - 7 * MIN,
  lastSeenAt: NOW - 7 * MIN,
  readableLines: 400,
};

/** The Dashboard's agents: one waits on you, one works. */
export const AGENTS: AgentView[] = [
  {
    paneId: "w1:p2",
    workspaceId: "w1",
    workspaceLabel: "shop",
    workspaceNumber: 1,
    tabId: "w1:t2",
    tabLabel: "checkout",
    agent: "claude",
    status: "blocked",
    cwd: "/home/you/src/shop",
    focused: false,
    hasSession: true,
    sessionName: "checkout button",
    hint: "waiting on a permission prompt",
    lastActiveAt: NOW - 3 * MIN,
    lastSeenAt: NOW - 20 * MIN,
    readableLines: 400,
  },
  {
    paneId: "w2:p1",
    workspaceId: "w2",
    workspaceLabel: "api",
    workspaceNumber: 2,
    tabId: "w2:t1",
    tabLabel: "fix-login",
    agent: "codex",
    status: "working",
    cwd: "/home/you/src/api",
    focused: false,
    hasSession: true,
    sessionName: "fix login",
    lastActiveAt: NOW - 1 * MIN,
    lastSeenAt: NOW - 1 * MIN,
    readableLines: 400,
  },
];

/** The snapshot every screen reads: one machine, two projects. */
export const HOME: HomeData = {
  bridge: "connected",
  device: undefined,
  agents: [SESSION_PANE, ...AGENTS],
  shellPanes: [],
  workspaces: SPACES,
  tabs: TABS,
  sessions: [],
  servers: [],
  ts: NOW,
  scope: {},
  viewAll: false,
  snoozedUntil: null,
  update: undefined,
  error: false,
  authError: false,
};

const RULE = "─".repeat(44);

/** The session's screen: plain text, as a terminal shows it, with the input box empty. */
export const SESSION_TEXT = [
  "❯ Get 2.4.0 ready to tag.",
  "",
  "● Read(CHANGELOG.md)",
  "  ⎿  Read 212 lines",
  "",
  "● Update(package.json)",
  "  ⎿  Updated with 1 addition",
  "",
  "● Bash(bun run test)",
  "  ⎿  1,284 pass, 0 fail",
  "",
  "● The version files agree on 2.4.0",
  "  and the unit tests pass. The e2e",
  "  leg is red on one case. I wait",
  "  for the gates before I tag.",
  "",
  "✻ Worked for 3m 12s",
  "",
  RULE,
  "❯ ",
  RULE,
  "  ⏵⏵ accept edits on",
].join("\n");

/** The question Release Gates asks before a tag. Its answer goes back to the trick's program. */
export const GATES_DECISION: HillDecision = {
  v: 1,
  id: "hd_gates_tag_240",
  requestId: "0b6f2c1e-4a7d-4c1b-9e2f-000000000240",
  from: { kind: "trick", address: null, trickId: "release-gates", trickKey: "tag-2-4-0", memberId: null, harness: null, label: "Release Gates", host: null, trickHost: null },
  about: null,
  title: "Tag 2.4.0 with the e2e gate red?",
  summary: "Six of the seven gates are green. The e2e gate failed once, on a timing budget.",
  priority: "today",
  priorityAsked: "today",
  body: "",
  options: [
    { intent: "rerun", label: "Rerun e2e first" },
    { intent: "tag", label: "Tag it now", confirm: "Tag now" },
  ],
  text: "optional",
  recommends: { intent: "rerun", why: "The same case passed on the last two runs." },
  media: [],
  links: [],
  replyTo: null,
  target: null,
  supersedes: null,
  supersededBy: null,
  expiresAt: null,
  at: NOW - 5 * MIN,
  state: "open",
  closedAt: null,
  closedReason: null,
  answer: null,
  view: [
    {
      kind: "bar",
      kids: [
        { kind: "chip", text: "types", attrs: { tone: "ok", icon: "check" } },
        { kind: "chip", text: "lint", attrs: { tone: "ok", icon: "check" } },
        { kind: "chip", text: "unit", attrs: { tone: "ok", icon: "check" } },
        { kind: "chip", text: "e2e", attrs: { tone: "danger", icon: "x" } },
        { kind: "chip", text: "windows", attrs: { tone: "ok", icon: "check" } },
      ],
    },
    {
      kind: "list",
      kids: [{ kind: "row", text: "e2e: pane glide", attrs: { tone: "danger", end: "1 of 18" }, kids: [{ kind: "para", text: "612 ms against a 400 ms budget" }] }],
    },
  ],
};
