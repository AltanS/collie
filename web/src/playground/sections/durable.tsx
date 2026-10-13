// Durable home section of the states playground (M53 spec 12): a durable program's conversation list, which
// is the dashboard on a machine with no screen, in each of its four filter states, and the pane header's two
// lines in each of their priorities. See app.tsx's header for the page's own rules: the REAL components
// with REAL props.
//
// DEV-ONLY, unreachable from the app entry.

import { useState } from "react";

import { ConversationList } from "@/components/conversation-list";
import { mergeConversations, type ConversationFilter } from "@/lib/conversation-list";
import type { AgentView, DurableConversationRow } from "@/lib/types";

import { TS, homeSolo, type PaneFixture } from "../fixtures";
import { PaneRouter } from "../harness";
import { Card, Group, Section, type SectionDef } from "../layout";
import { PhoneFrameCard } from "./shared";

export const DEF: SectionDef = {
  id: "durable",
  title: "Durable home",
  intent:
    "On a machine whose program has no screen, the Dashboard tab is the program's conversations, open and closed, newest first, with All, Open, Needs you and Closed over them. A row carries its title, its subtitle, its state mark (working, waiting with the open-question count, idle, closed), the time of its last activity and its item count; a working row keeps the hairline bar, which fills by the steps that are done. A tap on an open row opens its pane in Chat, a tap on a closed row opens the read-only view. The pane header is two lines: the title, and under it the running step, else the percent, else the subtitle, which also comes back once every step is done.",
};

const MIN = 60_000;

function convo(paneId: string, title: string, over: Partial<AgentView> = {}): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "support",
    workspaceNumber: 1,
    tabId: `${paneId}:t`,
    agent: "pi",
    status: "idle",
    cwd: "",
    focused: false,
    paneLabel: title,
    ...over,
  };
}

const ASK = { id: "a1", kind: "permission", toolCallId: "t1", revision: 1, title: "Refund 42 euros?", itemId: "i1", options: [] };

/** The live panes the snapshot would hold: one working, one waiting on two questions, one idle. */
const LIVE: AgentView[] = [
  convo("p1", "Refund for order 42", {
    status: "working",
    subtitle: "checking the order history",
    lastActiveAt: TS - 1 * MIN,
    progress: {
      kind: "steps",
      steps: [
        { label: "look up the order", state: "done" },
        { label: "write a note", state: "running" },
        { label: "reply to the customer", state: "todo" },
      ],
    },
  }),
  convo("p2", "Login fails on Safari", { status: "blocked", asks: [ASK, { ...ASK, id: "a2" }], lastActiveAt: TS - 4 * MIN }),
  convo("p3", "Shipping to Norway", { status: "idle", subtitle: "waiting for the warehouse", lastActiveAt: TS - 52 * MIN }),
];

/** What the program's own list adds: the counts of the open ones, and the closed ones. */
const ROWS: DurableConversationRow[] = [
  { id: "c1", title: "Refund for order 42", state: "open", paneId: "p1", items: 9, startedAt: "2026-10-13T08:00:00Z" },
  { id: "c2", title: "Login fails on Safari", state: "open", paneId: "p2", items: 4, startedAt: "2026-10-13T07:30:00Z" },
  { id: "c3", title: "Shipping to Norway", state: "open", paneId: "p3", items: 12, startedAt: "2026-10-13T07:00:00Z" },
  {
    id: "c0",
    title: "Invoice address change",
    subtitle: "done by hand",
    state: "closed",
    items: 15,
    startedAt: new Date(TS - 26 * 60 * MIN).toISOString(),
    endedAt: new Date(TS - 25 * 60 * MIN).toISOString(),
  },
  { id: "c-1", title: "", state: "closed", items: 2, startedAt: new Date(TS - 72 * 60 * MIN).toISOString() },
];

const ITEMS = mergeConversations(LIVE, ROWS);
const WORKSPACES = [{ workspaceId: "w1", label: "support" }];

/** The real list, with its chips live, starting on the chip the card is about. */
function Home({ start }: { start: ConversationFilter }) {
  const [filter, setFilter] = useState<ConversationFilter>(start);
  return (
    <div className="mx-auto w-full max-w-[390px] rounded-sm border border-rule bg-background">
      <ConversationList
        items={ITEMS}
        workspaces={WORKSPACES}
        filter={filter}
        onFilterChange={setFilter}
        onOpen={() => {}}
        now={TS}
      />
    </div>
  );
}

const header = (pane: AgentView): PaneFixture => ({ pane, text: "", revision: 1 });

export function DurableSection() {
  return (
    <Section def={DEF}>
      <Group title="The conversation list">
        <Card
          state="durable-home-all"
          label="All: open ones first, then closed, newest first"
          reach="open the dashboard on a machine whose program has no screen (its multiplexer declares paneGrid false)."
          note="Drawn from fixed rows; the live app draws the open ones from the snapshot on the first frame and fills in the closed ones and the counts from /api/durable/conversations. The chips are live here."
        >
          <Home start="all" />
        </Card>
        <Card
          state="durable-home-open"
          label="Open: the program's conversations that still run"
          reach="tap Open on that dashboard."
        >
          <Home start="open" />
        </Card>
        <Card
          state="durable-home-needs-you"
          label="Needs you: the ones waiting on a person, counted on the chip"
          reach="tap Needs you while a conversation is blocked or holds an open question."
        >
          <Home start="needsYou" />
        </Card>
        <Card
          state="durable-home-closed"
          label="Closed: read-only, a tap opens the conversation's items"
          reach="tap Closed on a machine whose program serves its history (caps.history)."
        >
          <Home start="closed" />
        </Card>
      </Group>

      <Group title="The two-line pane header">
        <Card
          state="durable-header-step"
          label="a step list: Step 2 of 3 and the running step's label"
          reach="open a durable conversation while its program reports progress as steps."
          note="The real pane over an empty mirror: this page has no durable bridge, so the body under the header is the terminal one. Only the header is the subject. No bar under it; the dashboard row keeps the hairline, here at one third: one of three steps is done."
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
          note="No step is left to name, so the line goes back to the subtitle. On the dashboard the same row's hairline is full."
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
