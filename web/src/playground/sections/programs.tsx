// Programs home section of the states playground: a durable program's conversation list, which is the
// dashboard on a machine with no screen, and the pane header's two lines in each of their priorities. One list
// with no filter chips since durable-simple (2026-10-13). See app.tsx's header for the page's own rules: the
// REAL components with REAL props.
//
// DEV-ONLY, unreachable from the app entry.

import { useEffect, useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { AskCard, AskCardFace } from "@/components/ask-card";
import { ConversationList } from "@/components/conversation-list";
import { DurableHome } from "@/components/durable-home";
import { ProgramSection } from "@/components/program-section";
import { SpaceOverview } from "@/components/space-overview";
import { answered, freshCard, tapped } from "@/lib/ask";
import { mergeConversations } from "@/lib/conversation-list";
import { noteSessionCards, programsAbove } from "@/lib/session-cards";
import type { AgentView, Ask, AskDecided, DurableConversationRow, ServerSummary, SessionSummary, WorkspaceView } from "@/lib/types";

import { TS, homeSolo, type PaneFixture } from "../fixtures";
import { PaneRouter } from "../harness";
import { Card, Group, Section, type SectionDef } from "../layout";
import { PhoneFrameCard } from "./shared";

export const DEF: SectionDef = {
  id: "programs",
  title: "Durable agents home",
  intent:
    "A durable agent this collie or a crew member carries is a row of the dashboard's Durable agents section, apart from the Spaces list: its name with an Experimental badge, its runtime and where it runs under it (and the member, on another machine), its state as the shared mark, and at the right its open conversations and, when any, the ones that wait on you in the needs-you ink. Starting or Unreachable is said in words there instead. The section sits above the spaces while a question waits, below them otherwise, and draws nothing with no durable agent. A tap opens its home. On a machine whose durable agent has no screen, the Dashboard tab is the durable agent's conversations, as a messaging app lists its chats: what waits on you first, then the other open ones, newest first, then the closed ones under their own label. A row carries its title, its state mark (working, waiting with the open-question count, idle, closed), the time of its last activity, and one line under it: the question that waits on you, else the durable agent's subtitle. A tap on an open row opens its pane in Chat, a tap on a closed row opens the read-only view. The pane header is two lines: the title, and under it the running step, else the percent, else the subtitle, which also comes back once every step is done. A durable agent's question is a card that names the durable agent in its caption and, when the durable agent set an expiry, shows the time left under its title; an answer that comes too late says who decided first. A durable agent refused for its wire version says why above its list.",
};

const MIN = 60_000;

function convo(paneId: string, title: string, over: Partial<AgentView> = {}): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "support",
    workspaceNumber: 1,
    tabId: `${paneId}:t`,
    agent: "program",
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

/** Card 1: two ready programs, nothing waits. */
const PROGRAMS_QUIET: SessionSummary[] = [
  programSession("desk", { agents: 3, working: 1 }),
  programSession("billing", { mux: "acme-billing", where: "remote", agents: 1 }),
];

/** Card 2: the same two, and two conversations of desk wait on you. */
const PROGRAMS_WAITING: SessionSummary[] = [
  programSession("desk", { agents: 3, working: 1, blocked: 2 }),
  programSession("billing", { mux: "acme-billing", where: "remote", agents: 1 }),
];

/** Card 3: one program that does not answer. */
const PROGRAMS_UNREACHABLE: SessionSummary[] = [
  programSession("billing", { mux: "acme-billing", where: "remote", state: "unreachable", reachable: false }),
];

/** Card 4: a crew of two machines, each running a program. */
const CREW: ServerSummary[] = [
  { id: "bluefin", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: TS },
  { id: "minibuch", name: "minibuch", isLead: false, reachable: true, protocol: "ok", lastSeenAt: TS },
];
const PROGRAMS_CREW: SessionSummary[] = [
  programSession("desk", { host: "bluefin", agents: 3, working: 1 }),
  programSession("support", { host: "minibuch", agents: 2, blocked: 1 }),
];

/**
 * The bottom of the dashboard: the real Spaces list, open, over one terminal space, and the real
 * Programs section above or below it, placed by the same rule the home route uses (`programsAbove`).
 */
function Dashboard({ programs, servers }: { programs: SessionSummary[]; servers?: ServerSummary[] }) {
  const above = programsAbove(programs);
  const section = <ProgramSection programs={programs} servers={servers} onOpen={() => {}} />;
  return (
    <div className="mx-auto w-full max-w-[390px] rounded-sm border border-rule bg-background">
      {above && section}
      <SpaceOverview
        workspaces={[TERMINAL_SPACE]}
        agents={[]}
        host={servers === undefined ? undefined : "bluefin"}
        onOpen={() => {}}
        onNewSpace={() => {}}
        open
        onOpenChange={() => {}}
      />
      {!above && section}
    </div>
  );
}

// ── The ask card (M55 spec 14) ────────────────────────────────────────────────

/** A program's permission question, as the pane carries it. */
const PROGRAM_ASK: Ask = {
  id: "ask-desk-1",
  kind: "permission",
  toolCallId: "call-desk-1",
  revision: 1,
  title: "Refund 42.00 EUR to Jonas Berg?",
  itemId: "tool-desk-1",
  reason: "The order was charged twice.",
  tool: { name: "refund", summary: "order=4711 amount=42.00" },
  options: [
    { id: "allow", label: "Refund it", effect: "allow" },
    { id: "deny", label: "Do not refund", effect: "deny" },
  ],
};

/** The program session the ask cards belong to: its card names it in the caption. */
const DESK: SessionSummary = programSession("desk", { agents: 3, working: 1, blocked: 1 });

/** The program refused for its wire version, as its session card carries it. */
const REFUSED: SessionSummary = programSession("billing", {
  mux: "acme-billing",
  where: "remote",
  state: "unreachable",
  reachable: false,
  notice: "The durable agent speaks wire v2, this Collie speaks v1. Update Collie, or the agent's SDK.",
});

/**
 * Files the two session cards through the store's own mutator, the way the root loader does on every
 * snapshot, so the real card reads its program's name and the real home reads the refusal.
 */
function useFiledCards(): void {
  useEffect(() => {
    noteSessionCards([DESK, REFUSED], undefined);
  }, []);
}

/** The real card over a live ask whose expiry is `offsetMs` from the moment the card mounts. */
function LiveAsk({ offsetMs }: { offsetMs: number }) {
  useFiledCards();
  const [ask] = useState<Ask>(() => ({ ...PROGRAM_ASK, expiresAt: new Date(Date.now() + offsetMs).toISOString() }));
  return (
    <div className="mx-auto w-full max-w-[390px]">
      <AskCard ask={ask} paneId="conv-02" scope={{ session: DESK.name }} />
    </div>
  );
}

/** The face of a card the program answered too late, built by lib/ask.ts's own steps: a fresh card, a tap, the answer. */
function LateAsk({ by }: { by: AskDecided["by"] }) {
  const card = answered(tapped(freshCard(PROGRAM_ASK), "allow", "pg-request"), {
    outcome: "too-late",
    decided: { by, at: new Date(TS - 2 * MIN).toISOString() },
  });
  return (
    <div className="mx-auto w-full max-w-[390px]">
      <AskCardFace card={card} program={DESK.name} onPress={() => {}} onSend={() => {}} />
    </div>
  );
}

/** The real durable home of the refused program, on a memory router. */
function RefusedHome() {
  useFiledCards();
  const [router] = useState(() =>
    createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <DurableHome
              scope={{ session: REFUSED.name }}
              panes={[]}
              workspaces={[]}
              paneOpen={{ glideKeyOf: (pane) => pane.paneId, press: () => {}, open: () => {} }}
            />
          ),
        },
      ],
      { initialEntries: ["/"] },
    ),
  );
  return (
    <div className="mx-auto w-full max-w-[390px] rounded-sm border border-rule bg-background">
      <RouterProvider router={router} />
    </div>
  );
}

export function DurableSection() {
  return (
    <Section def={DEF}>
      <Group title="Durable agents">
        <Card
          state="programs-below"
          label="1: no waiting question, the Durable agents section below the spaces"
          reach="open the dashboard of a collie that carries durable agents beside its multiplexer (sources in sources.json), while no conversation waits on you."
          note="Drawn from fixed session cards over the real Spaces list. Each row: name, Experimental badge, runtime and place, the open conversations at the right."
        >
          <Dashboard programs={PROGRAMS_QUIET} />
        </Card>
        <Card
          state="programs-above"
          label="2: one durable agent with two waiting, the section above the spaces"
          reach="the same dashboard while two conversations of one durable agent wait on you with a question."
          note="On the dashboard the section moves above Launch and the Spaces on the snapshot that brings the first waiting question, and back under the Spaces on the one that clears the last."
        >
          <Dashboard programs={PROGRAMS_WAITING} />
        </Card>
        <Card
          state="programs-unreachable"
          label="3: one durable agent unreachable"
          reach="stop a remote durable agent, or take its URL offline, and open the dashboard."
          note="No counts: the word Unreachable in the muted ink where they would be. The row still opens the durable agent's list."
        >
          <Dashboard programs={PROGRAMS_UNREACHABLE} />
        </Card>
        <Card
          state="programs-crew"
          label="4: two machines, one section"
          reach="open the dashboard of a crew whose lead and member each run a durable agent."
          note="The member's durable agent names the member after its place; the lead's own names no machine. A waiting question on any machine moves the one section."
        >
          <Dashboard programs={PROGRAMS_CREW} servers={CREW} />
        </Card>
      </Group>

      <Group title="The conversation list">
        <Card
          state="durable-home"
          label="One list: what waits on you, the other open ones, then Closed"
          reach="open the dashboard on a machine whose durable agent has no screen (its multiplexer declares paneGrid false)."
          note="Drawn from fixed rows; the live app draws the open ones from the snapshot on the first frame and fills in the closed ones from /api/durable/conversations. The waiting row's second line is its question, in the title's ink."
        >
          <Home live={LIVE} rows={ROWS} />
        </Card>
        <Card
          state="durable-home-open-only"
          label="A durable agent that keeps no list: its open conversations alone"
          reach="open the dashboard on a machine whose durable agent does not declare caps.history."
        >
          <Home live={LIVE} rows={null} />
        </Card>
        <Card state="durable-home-empty" label="No conversation yet" reach="open the dashboard before the program has made a conversation.">
          <Home live={[]} rows={[]} />
        </Card>
      </Group>

      <Group title="The ask card">
        <Card
          state="ask-expires-in"
          label="1: a question with 4 min left"
          reach="open a durable conversation whose durable agent raised a question with expiresAt a few minutes ahead."
          note="The real card over a live ask: the line ticks on the page's one clock and says Expired after four minutes. The caption names the durable agent from its session card. A tap posts for real, and with no bridge behind this page it ends as not sure the answer arrived."
        >
          <LiveAsk offsetMs={4 * MIN + 30_000} />
        </Card>
        <Card
          state="ask-expired"
          label="2: a question past its expiry"
          reach="leave a durable question with expiresAt open on the phone until the time passes, before the next read drops it."
          note="The buttons stay: the durable agent answers a late tap with its 409, and the card then says it timed out."
        >
          <LiveAsk offsetMs={-30_000} />
        </Card>
        <Card
          state="ask-decided-in-program"
          label="3: decided in the durable agent"
          reach="answer a question in the durable agent's own window, then tap an answer on the phone before the next read drops the card."
          note="The card's face from a state lib/ask.ts's own steps built (a tap, then a too-late answer naming the durable agent), because this page has no bridge to answer a tap. The card stays frozen."
        >
          <LateAsk by="program" />
        </Card>
        <Card
          state="ask-timed-out"
          label="4: timed out"
          reach="tap an answer on a question whose expiresAt passed, before the next read drops the card."
          note="Built the same way as card 3, with the answer naming the clock."
        >
          <LateAsk by="timeout" />
        </Card>
        <Card
          state="ask-program-refused"
          label="5: a durable agent refused for its wire version"
          reach="list a durable agent in sources.json whose hello names a wire version this Collie does not speak, and open its home."
          note="The real durable home over the durable agent's session card, which carries the refusal sentence. The durable agent row on the dashboard keeps the word Unreachable."
        >
          <RefusedHome />
        </Card>
      </Group>

      <Group title="The two-line pane header">
        <Card
          state="durable-header-step"
          label="a step list: Step 2 of 3 and the running step's label"
          reach="open a durable conversation while its durable agent reports progress as steps."
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
          reach="open a durable conversation while its durable agent reports progress as a percent."
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
          reach="open a durable conversation whose durable agent marked every step done and has not cleared the progress yet."
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
          label="no progress: the durable agent's subtitle"
          reach="open a durable conversation whose durable agent sets a subtitle and no progress, or one that is idle."
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
