// Durable home section of the states playground: a durable program's conversation list, which is the
// dashboard on a machine with no screen, and the pane header's two lines in each of their priorities. One list
// with no filter chips since durable-simple (2026-10-13). See app.tsx's header for the page's own rules: the
// REAL components with REAL props.
//
// DEV-ONLY, unreachable from the app entry.

import { ConversationList } from "@/components/conversation-list";
import { SpaceOverview } from "@/components/space-overview";
import { mergeConversations } from "@/lib/conversation-list";
import type { AgentView, DurableConversationRow, SessionSummary, WorkspaceView } from "@/lib/types";

import { TS, homeSolo, type PaneFixture } from "../fixtures";
import { PaneRouter } from "../harness";
import { Card, Group, Section, type SectionDef } from "../layout";
import { PhoneFrameCard } from "./shared";

export const DEF: SectionDef = {
  id: "durable",
  title: "Durable home",
  intent:
    "A durable program this collie carries is one more space in the dashboard's Spaces list, after the terminal spaces: its name with an Experimental badge, its runtime and where it runs under it, and its state as the shared mark, with Starting or Unreachable said in words. A tap opens its home. On a machine whose program has no screen, the Dashboard tab is the program's conversations, as a messaging app lists its chats: what waits on you first, then the other open ones, newest first, then the closed ones under their own label. A row carries its title, its state mark (working, waiting with the open-question count, idle, closed), the time of its last activity, and one line under it: the question that waits on you, else the program's subtitle. A tap on an open row opens its pane in Chat, a tap on a closed row opens the read-only view. The pane header is two lines: the title, and under it the running step, else the percent, else the subtitle, which also comes back once every step is done.",
};

const MIN = 60_000;

function convo(paneId: string, title: string, over: Partial<AgentView> = {}): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "support",
    workspaceNumber: 1,
    tabId: `${paneId}:t`,
    agent: "durable",
    status: "idle",
    cwd: "",
    focused: false,
    paneLabel: title,
    ...over,
  };
}

const ASK = { id: "a1", kind: "permission", toolCallId: "t1", revision: 1, title: "Save this note to the ticket?", itemId: "i1", options: [] };

/** The live panes the snapshot would hold: one working, one waiting on a question, one idle. */
const LIVE: AgentView[] = [
  convo("p1", "Jonas Berg", {
    status: "working",
    subtitle: "Charged twice for one order",
    lastActiveAt: TS - 1 * MIN,
    progress: {
      kind: "steps",
      steps: [
        { label: "Read the ticket", state: "done" },
        { label: "Save a note", state: "running" },
        { label: "Reply", state: "todo" },
      ],
    },
  }),
  convo("p2", "Maria Lopez", { status: "blocked", subtitle: "Can't sign in after a password reset", asks: [ASK], lastActiveAt: TS - 4 * MIN }),
  convo("p3", "Priya Shah", { status: "idle", subtitle: "New delivery address for two orders", lastActiveAt: TS - 52 * MIN }),
];

/** What the program's own list adds: the closed ones. */
const ROWS: DurableConversationRow[] = [
  { id: "c1", title: "Jonas Berg", state: "open", paneId: "p1", items: 9, startedAt: "2026-10-13T08:00:00Z" },
  { id: "c2", title: "Maria Lopez", state: "open", paneId: "p2", items: 4, startedAt: "2026-10-13T07:30:00Z" },
  { id: "c3", title: "Priya Shah", state: "open", paneId: "p3", items: 12, startedAt: "2026-10-13T07:00:00Z" },
  {
    id: "c0",
    title: "Tom Becker",
    subtitle: "Wants an invoice for last month",
    state: "closed",
    items: 15,
    startedAt: new Date(TS - 26 * 60 * MIN).toISOString(),
    endedAt: new Date(TS - 25 * 60 * MIN).toISOString(),
  },
  { id: "c-1", title: "", state: "closed", items: 2, startedAt: new Date(TS - 72 * 60 * MIN).toISOString() },
];

const WORKSPACES = [{ workspaceId: "w1", label: "support" }];

/** The real list over fixed rows. */
function Home({ live, rows }: { live: AgentView[]; rows: DurableConversationRow[] | null }) {
  return (
    <div className="mx-auto w-full max-w-[390px] rounded-sm border border-rule bg-background">
      <ConversationList items={mergeConversations(live, rows)} workspaces={WORKSPACES} onOpen={() => {}} now={TS} />
    </div>
  );
}

const header = (pane: AgentView): PaneFixture => ({ pane, text: "", revision: 1 });

/** One terminal space, the way the dashboard's Spaces list draws it. */
const TERMINAL_SPACE: WorkspaceView = {
  workspaceId: "w1",
  number: 1,
  label: "collie",
  focused: true,
  activeTabId: "w1:t1",
  tabCount: 2,
  paneCount: 3,
};

function programSession(name: string, over: Partial<SessionSummary>): SessionSummary {
  return {
    name,
    isPrimary: false,
    reachable: true,
    agents: 0,
    working: 0,
    blocked: 0,
    kind: "program",
    mux: "pi-durable",
    caps: { paneGrid: false },
    where: "local",
    state: "ready",
    experimental: true,
    ...over,
  };
}

/** Two program sessions: one ready, one that does not answer. */
const PROGRAMS: SessionSummary[] = [
  programSession("desk", {}),
  programSession("billing", { mux: "acme-billing", where: "remote", state: "unreachable", reachable: false }),
];

/** The real Spaces list, open, over one terminal space and the program sessions given. */
function Spaces({ programs }: { programs: SessionSummary[] }) {
  return (
    <div className="mx-auto w-full max-w-[390px] rounded-sm border border-rule bg-background">
      <SpaceOverview
        workspaces={[TERMINAL_SPACE]}
        agents={[]}
        onOpen={() => {}}
        onNewSpace={() => {}}
        open
        onOpenChange={() => {}}
        programs={programs}
        onOpenProgram={() => {}}
      />
    </div>
  );
}

export function DurableSection() {
  return (
    <Section def={DEF}>
      <Group title="A program is a space">
        <Card
          state="program-spaces"
          label="One terminal space, then two program spaces: ready and unreachable"
          reach="open the dashboard of a collie that carries a durable program beside its multiplexer (a source in sources.json)."
          note="Drawn from fixed session cards. The terminal row is the list's own; each program row is its name, the Experimental badge, and its runtime and place under it."
        >
          <Spaces programs={PROGRAMS} />
        </Card>
        <Card
          state="program-spaces-none"
          label="No program session: the Spaces list as before"
          reach="open the dashboard of a collie with no source."
        >
          <Spaces programs={[]} />
        </Card>
      </Group>

      <Group title="The conversation list">
        <Card
          state="durable-home"
          label="One list: what waits on you, the other open ones, then Closed"
          reach="open the dashboard on a machine whose program has no screen (its multiplexer declares paneGrid false)."
          note="Drawn from fixed rows; the live app draws the open ones from the snapshot on the first frame and fills in the closed ones from /api/durable/conversations. The waiting row's second line is its question, in the title's ink."
        >
          <Home live={LIVE} rows={ROWS} />
        </Card>
        <Card
          state="durable-home-open-only"
          label="A program that keeps no list: its open conversations alone"
          reach="open the dashboard on a machine whose program does not declare caps.history."
        >
          <Home live={LIVE} rows={null} />
        </Card>
        <Card state="durable-home-empty" label="No conversation yet" reach="open the dashboard before the program has made a conversation.">
          <Home live={[]} rows={[]} />
        </Card>
      </Group>

      <Group title="The two-line pane header">
        <Card
          state="durable-header-step"
          label="a step list: Step 2 of 3 and the running step's label"
          reach="open a durable conversation while its program reports progress as steps."
          note="The real pane over an empty mirror: this page has no durable bridge, so the body under the header is the terminal one. Only the header is the subject."
          span={2}
        >
          <PhoneFrameCard height={260}>
            <PaneRouter home={homeSolo} fixture={header(LIVE[0]!)} />
          </PhoneFrameCard>
        </Card>
        <Card
          state="durable-header-percent"
          label="a percent: the number and its label"
          reach="open a durable conversation while its program reports progress as a percent."
          span={2}
        >
          <PhoneFrameCard height={260}>
            <PaneRouter
              home={homeSolo}
              fixture={header(convo("p4", "Export last quarter", { status: "working", subtitle: "for the auditor", progress: { kind: "percent", value: 42, label: "uploading" } }))}
            />
          </PhoneFrameCard>
        </Card>
        <Card
          state="durable-header-all-done"
          label="every step done: the subtitle again"
          reach="open a durable conversation whose program marked every step done and has not cleared the progress yet."
          note="No step is left to name, so the line goes back to the subtitle."
          span={2}
        >
          <PhoneFrameCard height={260}>
            <PaneRouter
              home={homeSolo}
              fixture={header(
                convo("p5", "Refund for order 41", {
                  status: "working",
                  subtitle: "refunded, writing the reply",
                  progress: {
                    kind: "steps",
                    steps: [
                      { label: "look up the order", state: "done" },
                      { label: "refund", state: "done" },
                    ],
                  },
                }),
              )}
            />
          </PhoneFrameCard>
        </Card>
        <Card
          state="durable-header-subtitle"
          label="no progress: the program's subtitle"
          reach="open a durable conversation whose program sets a subtitle and no progress, or one that is idle."
          span={2}
        >
          <PhoneFrameCard height={260}>
            <PaneRouter home={homeSolo} fixture={header(LIVE[2]!)} />
          </PhoneFrameCard>
        </Card>
      </Group>
    </Section>
  );
}
