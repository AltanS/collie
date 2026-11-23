// The Asks section of the states playground (Asks build 2, 2026-11-23): the board, the ask screen in each of its states,
// and the closed ask. Every state mounts the REAL component (`AsksBoard` inside `HillView`, `AskScreen`, `AskClosed`) with
// fixtures shaped by the wire (`fixtures/hill/asks-states.ts`). No bridge sits behind it: a tap on a card opens the real
// sheet and Confirm marks the card in this page's own state; Send sends nothing.
//
// States are numbered 1 to 17.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { AppHeaderHost } from "@/components/app-header";
import { AskClosed } from "@/components/ask-closed";
import { AskScreen } from "@/components/ask-screen";
import { AsksBoard } from "@/components/asks-board";
import { HillCrewStateMenu } from "@/components/hill-crew-state";
import { HillHeader, HillView } from "@/components/hill-view";
import type { AsksSend } from "@/hooks/use-asks-send";
import { closedAskWhy, groupAsks, openAsksOf, reviewOf, sessionFacts, type AskDecision } from "@/lib/hill/asks";
import { askedWords, deckOf, neighboursOf, orderByClock, sessionClock } from "@/lib/hill/asks-board";
import type { HillCrewState, HillDecision } from "@/lib/hill/wire";
import { NO_DRAFT, type AskDraft } from "@/lib/hill/asks-drafts";
import { positionOf } from "@/lib/hill/asks";
import { livePaneAt } from "@/lib/walky-names";

import { homeSolo } from "../fixtures";
import { askCarried, askFresh, askFull, askPlain, askReviewer, askScout, askUnchecked, askWords, boardAsks, closedAnsweredHere, closedCleared, PLAY_LIVE, PLAY_NOW } from "../fixtures/hill/asks-states";
import { RootRouter } from "../harness";
import { Card, Group, Section, type SectionDef } from "../layout";

export const DEF: SectionDef = {
  id: "asks",
  title: "Asks",
  intent: "The board of sessions with open asks, the ask screen and its states, and an ask that closed.",
};

const noop = () => {};
const NO_DRAFTS: ReadonlyMap<string, AskDraft> = new Map();
const IDLE_SEND: AsksSend = { state: { phase: "idle" }, send: () => Promise.resolve(false), reset: noop };

/** A phone-wide box on the page colour, as the other sections draw one. */
function Phone({ height, children }: { height: number; children: ReactNode }) {
  const box: CSSProperties & { "--app-h"?: string } = { width: 390, height, transform: "translate(0)", "--app-h": `${height}px` };
  return (
    <div data-pg-frame="" className="relative isolate flex max-w-full flex-col overflow-hidden rounded-sm bg-background ring-1 ring-rule" style={box}>
      {children}
    </div>
  );
}

const SESSIONS = orderByClock(groupAsks(openAsksOf(boardAsks)), PLAY_LIVE, PLAY_NOW);
const DECK = deckOf(SESSIONS);

/** The sessions of a board made from some of the asks, in board order. */
function sessionsOf(asks: readonly HillDecision[]) {
  return orderByClock(groupAsks(openAsksOf(asks)), PLAY_LIVE, PLAY_NOW);
}

/** The mode control as the page draws it, live in the card: the bell, the crossed bell with the word in Quiet or Away. */
function ModeDemo({ initial }: { initial: HillCrewState }) {
  const [value, setValue] = useState<HillCrewState>(initial);
  return (
    <HillCrewStateMenu value={value} saved={value} told={null} setBy={{ by: "Pixel 9", at: PLAY_NOW - 12 * 60_000 }} canWrite busy={false} failed={false} telling={false} tellFailed={false} onChange={setValue} onTell={noop} />
  );
}

/** The board: the Asks header with its mode control and the page under it, with the answers marked so far. `menu` opens the mode menu once mounted. */
function BoardPhone({ drafts = NO_DRAFTS, sessions = SESSIONS, mode = "here", menu = false }: { drafts?: ReadonlyMap<string, AskDraft>; sessions?: typeof SESSIONS; mode?: HillCrewState; menu?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const id = window.setTimeout(() => root.current?.querySelector<HTMLButtonElement>('[data-slot="hill-crew-state-button"]')?.click(), 400);
    return () => window.clearTimeout(id);
  }, [menu]);
  const count = deckOf(sessions).length;
  return (
    <div ref={root}>
      <Phone height={menu ? 860 : 900}>
        <RootRouter data={homeSolo}>
          <AppHeaderHost bridge="connected" error={false}>
            <HillHeader count={count} onBack={noop} asks={{ count, sessions: sessions.length }} mode={<ModeDemo initial={mode} />} />
            <div data-pg-scroll className="min-h-0 flex-1 overflow-y-auto p-4">
              <HillView open={[]} closed={[]} kept={new Map()} renderCard={() => null} asks={{ count, node: <AsksBoard sessions={sessions} live={PLAY_LIVE} now={PLAY_NOW} drafts={drafts} send={IDLE_SEND} onOpen={noop} /> }} />
            </div>
          </AppHeaderHost>
        </RootRouter>
      </Phone>
    </div>
  );
}

/** The empty board, with the two closed asks under it. */
function EmptyPhone() {
  return (
    <Phone height={560}>
      <RootRouter data={homeSolo}>
        <AppHeaderHost bridge="connected" error={false}>
          <HillHeader count={0} onBack={noop} />
          <div data-pg-scroll className="min-h-0 flex-1 overflow-y-auto p-4">
            <HillView open={[]} closed={[closedAnsweredHere, closedCleared]} kept={new Map()} renderCard={() => null} />
          </div>
        </AppHeaderHost>
      </RootRouter>
    </Phone>
  );
}

/** The ask screen for one ask of the deck. The mark in it is this page's own state. */
function AskBody({ id, start = NO_DRAFT, note = null }: { id: string; start?: AskDraft; note?: string | null }) {
  const [draft, setDraft] = useState<AskDraft>(start);
  const session = SESSIONS.find((candidate) => candidate.asks.some((item) => item.id === id));
  const ask: AskDecision | undefined = session?.asks.find((item) => item.id === id);
  if (session === undefined || ask === undefined) return null;
  const neighbours = neighboursOf(DECK, id);
  return (
    <AppHeaderHost bridge="connected" error={false}>
      <AskScreen
        ask={ask}
        facts={sessionFacts(session, PLAY_LIVE)}
        clock={sessionClock(livePaneAt(session.key, PLAY_LIVE), PLAY_NOW)}
        now={PLAY_NOW}
        place={positionOf(DECK, id)}
        previous={neighbours.previous}
        next={neighbours.next}
        draft={draft}
        review={reviewOf(session.asks, new Map([[id, draft]]))}
        sessionOpen={session.asks.length}
        note={note}
        send={IDLE_SEND}
        onBack={noop}
        onMove={noop}
        onContext={noop}
        onDraft={setDraft}
      />
    </AppHeaderHost>
  );
}

function AskPhone({ id, start, note }: { id: string; start?: AskDraft; note?: string | null }) {
  return (
    <Phone height={820}>
      <RootRouter data={homeSolo}>
        <AskBody id={id} start={start} note={note} />
      </RootRouter>
    </Phone>
  );
}

function ClosedPhone() {
  const why = closedAskWhy(closedCleared);
  return (
    <Phone height={420}>
      <RootRouter data={homeSolo}>
        <AppHeaderHost bridge="connected" error={false}>
          <AskClosed name="builder" line={askedWords(closedCleared.at, PLAY_NOW)} title={closedCleared.title} why={why} newer={false} onBack={noop} onNewer={noop} />
        </AppHeaderHost>
      </RootRouter>
    </Phone>
  );
}

export function AsksSection() {
  return (
    <Section def={DEF}>
      <Group title="The board">
        <Card state="asks-board" label="1: four sessions, warm, working, unknown, cold" span={2}>
          <BoardPhone />
        </Card>
        <Card state="asks-board-answered" label="2: warm, two rows answered, Next up on the next ask, Send 2" span={2}>
          <BoardPhone
            drafts={
              new Map<string, AskDraft>([
                [askFull.id, { intent: "keep", text: "" }],
                [askPlain.id, { intent: "yes", text: "after the patch" }],
              ])
            }
          />
        </Card>
        <Card state="asks-board-working" label="3: Next up on a session that works" span={2}>
          <BoardPhone sessions={sessionsOf([askFresh, askCarried, askUnchecked, askReviewer])} />
        </Card>
        <Card state="asks-board-cold" label="4: a cold session, no fill" span={2}>
          <BoardPhone sessions={sessionsOf([askReviewer, askScout])} />
        </Card>
        <Card state="asks-board-send" label="5: every ask answered, Next up offers Send" span={2}>
          <BoardPhone
            sessions={sessionsOf([askFull, askPlain, askWords])}
            drafts={
              new Map<string, AskDraft>([
                [askFull.id, { intent: "keep", text: "" }],
                [askPlain.id, { intent: "yes", text: "" }],
                [askWords.id, { intent: null, text: "Say that no asks wait." }],
              ])
            }
          />
        </Card>
        <Card state="asks-board-mode-menu" label="6: the Mode menu, Here chosen" span={2}>
          <BoardPhone menu />
        </Card>
        <Card state="asks-board-quiet" label="7: Quiet, the crossed bell and the word in the header" span={2}>
          <BoardPhone mode="quiet" />
        </Card>
        <Card state="asks-board-empty" label="8: no ask waits, and two closed ones" span={2}>
          <EmptyPhone />
        </Card>
      </Group>
      <Group title="The ask screen">
        <Card state="asks-ask-full" label="9: every line, recommended, carried" span={2}>
          <AskPhone id={askFull.id} />
        </Card>
        <Card state="asks-ask-plain" label="10: no optional line" span={2}>
          <AskPhone id={askPlain.id} />
        </Card>
        <Card state="asks-ask-words" label="11: a words ask" span={2}>
          <AskPhone id={askWords.id} />
        </Card>
        <Card state="asks-ask-answered" label="12: answered with a note" span={2}>
          <AskPhone id={askFull.id} start={{ intent: "keep", text: "for the next minor only" }} />
        </Card>
        <Card state="asks-ask-own" label="13: Your own answer, written" span={2}>
          <AskPhone id={askPlain.id} start={{ intent: "own", text: "Ship it, and tell me when the tag is out." }} />
        </Card>
        <Card state="asks-ask-fresh" label="14: mark fresh" span={2}>
          <AskPhone id={askFresh.id} />
        </Card>
        <Card state="asks-ask-carried" label="15: mark carried" span={2}>
          <AskPhone id={askCarried.id} />
        </Card>
        <Card state="asks-ask-unchecked" label="16: mark unchecked, and a refused send" span={2}>
          <AskPhone id={askUnchecked.id} note="This ask closed before your answer arrived." />
        </Card>
      </Group>
      <Group title="Closed">
        <Card state="asks-closed-cleared" label="17: the conversation was cleared" span={2}>
          <ClosedPhone />
        </Card>
      </Group>
    </Section>
  );
}
