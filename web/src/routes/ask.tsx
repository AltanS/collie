import { useCallback } from "react";
import { useParams } from "react-router";

import { AskClosed } from "@/components/ask-closed";
import { AskScreen } from "@/components/ask-screen";
import { useAsksDeck } from "@/hooks/use-asks-deck";
import { useAsksSend } from "@/hooks/use-asks-send";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { useBoundedHold } from "@/hooks/use-bounded-hold";
import { closedAskWhy, positionOf, reviewOf, sessionFacts } from "@/lib/hill/asks";
import { askedWords, neighboursOf, sessionClock } from "@/lib/hill/asks-board";
import { NO_DRAFT, setAskDraft, useAskDrafts, type AskDraft } from "@/lib/hill/asks-drafts";
import { useAskNote } from "@/lib/hill/asks-notes";
import { useHillClosed, useHillHeld, useHillOpen } from "@/lib/hill/store";
import { askContextPath, askPath, hillPath } from "@/lib/nav";
import { useOptionalRootData } from "@/lib/route-data";
import { useScope } from "@/lib/session";
import { livePaneAt } from "@/lib/walky-names";

// THE ASK'S ROUTE (Asks build 2, 2026-11-23), `/hill/ask/:id`: one level below the board, the place Back goes up to. The
// deck (every open ask in board order, lib/hill/asks-board.ts) comes from the same hook as the board, so Next here is the
// row below on the board. Moving between asks REPLACES the history entry (`nav.side`): the deck is a level, so one Back
// leaves it, never walks it. The context page is one level further down (`nav.down`).
//
// The marks (the person's picks, not yet sent) are drafts in `lib/hill/asks-drafts.ts`, kept on this phone. A Send is
// one request for the session; a success clears the drafts it named, and an ask it closed shows its sentence here
// (`AskClosed`) because this address stays valid after the ask closes.
//
// A COLD OPEN does not say "not on the board": the store is memory only, so a notification tap starts with no list. While
// the snapshot says the Hill exists and no list has landed, the route draws nothing under a held header, for at most the
// calm-load bound, as the board does.

export function AskRoute() {
  useLocale();
  const { id = "" } = useParams();
  const nav = useNav();
  const scope = useScope();
  const root = useOptionalRootData();
  const listed = useHillHeld();
  const holding = useBoundedHold(root?.hill === true && !listed);
  const open = useHillOpen();
  const closed = useHillClosed();
  const { sessions, deck, live, now } = useAsksDeck();
  const drafts = useAskDrafts();
  const send = useAsksSend();
  const note = useAskNote(id);

  const back = useCallback(() => nav.up(hillPath(scope)), [nav, scope]);
  const move = useCallback((to: string) => nav.side(askPath(to, scope)), [nav, scope]);
  const context = useCallback(() => nav.down(askContextPath(id, scope)), [nav, scope, id]);
  const mark = useCallback((draft: AskDraft) => setAskDraft(id, draft), [id]);

  const session = sessions.find((candidate) => candidate.asks.some((ask) => ask.id === id));
  const ask = session?.asks.find((candidate) => candidate.id === id);
  if (session !== undefined && ask !== undefined) {
    const neighbours = neighboursOf(deck, id);
    return (
      <AskScreen
        ask={ask}
        facts={sessionFacts(session, live)}
        clock={sessionClock(livePaneAt(session.key, live), now)}
        now={now}
        place={positionOf(deck, id)}
        previous={neighbours.previous}
        next={neighbours.next}
        draft={drafts.get(id) ?? NO_DRAFT}
        review={reviewOf(session.asks, drafts)}
        sessionOpen={session.asks.length}
        note={note}
        send={send}
        onBack={back}
        onMove={move}
        onContext={context}
        onDraft={mark}
      />
    );
  }

  if (holding) return <AskClosed name={" "} line={" "} title={null} why={null} newer={false} onBack={back} onNewer={back} hold />;

  const decision = [...closed, ...open].find((candidate) => candidate.id === id);
  const why = decision === undefined ? null : closedAskWhy(decision);
  const facts = decision === undefined ? null : sessionFacts({ key: decision.from.address ?? decision.from.label, label: decision.from.label }, live);
  const newerId = why !== null && why.kind === "replaced" ? why.by : null;
  return (
    <AskClosed
      name={facts?.name ?? ""}
      line={decision === undefined ? " " : askedWords(decision.at, now)}
      title={decision?.title ?? null}
      why={why}
      newer={newerId !== null && deck.some((candidate) => candidate.id === newerId)}
      onBack={back}
      onNewer={() => newerId !== null && move(newerId)}
    />
  );
}
