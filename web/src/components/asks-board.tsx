import { Icon } from "@/components/icons/icon";
import { Badge } from "@/components/ui/badge";
import { Button, FOCUS_RING_INSET, HOVER_FILL } from "@/components/ui/button";
import { OneOf } from "@/components/ui/one-of";
import { useLocale } from "@/hooks/use-locale";
import { markedAnswer, sessionFacts, type AskDecision, type AskSession } from "@/lib/hill/asks";
import { boardCountWords, clockWords, isUnchecked, sessionClock } from "@/lib/hill/asks-board";
import type { AskDraft } from "@/lib/hill/asks-drafts";
import { NO_DRAFT } from "@/lib/hill/asks-drafts";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { livePaneAt, type WalkyLivePanes } from "@/lib/walky-names";

// THE SESSIONS OF THE BOARD (Asks build 2, 2026-11-23): one card for each session that has an open ask, in the order of the
// cache clock (lib/hill/asks-board.ts). A card says the session's name and where it works, what its cache is in words, how
// many questions it holds and how many of them are answered here (and how many the agent has not checked), and then one
// row for each question. A row opens the ask. An answered row wears the neutral "Answered" badge in a slot that is always
// reserved (`OneOf`), so an answer made on the next screen moves nothing here. The asks the agent has not checked sink to
// the end of the card and are muted. A plain "Answer next" button above the first card opens the first ask of the first
// session. The cards of other kinds are not drawn here: `HillView` draws them in its own last group, unchanged.

/** The one-line question of a row: the agent's title, whitespace folded. */
export function questionLine(ask: Pick<AskDecision, "title">): string {
  return ask.title.replace(/\s+/gu, " ").trim();
}

function AskRow({ ask, number, answered, onOpen }: { ask: AskDecision; number: number; answered: boolean; onOpen: (id: string) => void }) {
  const muted = isUnchecked(ask);
  return (
    <li>
      <button
        type="button"
        data-slot="asks-row"
        data-id={ask.id}
        data-state={answered ? "answered" : muted ? "unchecked" : "open"}
        onClick={() => onOpen(ask.id)}
        className={cn("flex min-h-11 w-full items-center gap-2.5 px-3.5 py-2 text-left", FOCUS_RING_INSET, HOVER_FILL, muted && "text-muted-foreground")}
      >
        <span className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums">{number}</span>
        <span className="font-content line-clamp-2 min-w-0 flex-1 text-sm leading-snug">{questionLine(ask)}</span>
        <OneOf
          active={answered ? "answered" : null}
          className="inline-grid shrink-0 justify-items-end"
          options={[
            {
              key: "answered",
              node: (
                <Badge variant="value">
                  <Icon name="done" aria-hidden className="size-3.5 shrink-0" />
                  {t("asks.board.rowAnswered")}
                </Badge>
              ),
            },
          ]}
        />
      </button>
    </li>
  );
}

/** One session's card. */
export function SessionCard({ session, live, now, drafts, onOpen }: { session: AskSession; live: WalkyLivePanes; now: number; drafts: ReadonlyMap<string, AskDraft>; onOpen: (id: string) => void }) {
  useLocale();
  const facts = sessionFacts(session, live);
  const cache = clockWords(sessionClock(livePaneAt(session.key, live), now));
  const marks = session.asks.map((ask) => markedAnswer(ask, drafts.get(ask.id) ?? NO_DRAFT) !== null);
  const answered = marks.filter(Boolean).length;
  const unchecked = session.asks.filter(isUnchecked).length;
  return (
    <section data-slot="asks-session" data-key={session.key} className="flex min-w-0 flex-col overflow-hidden rounded-md border border-border bg-card">
      <div className="flex min-w-0 flex-col gap-0.5 px-3.5 pt-3 pb-2">
        <div className="flex min-w-0 items-baseline justify-between gap-3">
          <h2 data-slot="asks-session-name" className="min-w-0 truncate text-base font-semibold leading-6">
            {facts.name}
          </h2>
          <span data-slot="asks-session-cache" className="shrink-0 text-xs text-muted-foreground">
            {cache}
          </span>
        </div>
        <p data-slot="asks-session-place" className="min-h-4 truncate text-xs leading-4 text-muted-foreground">
          {facts.line}
        </p>
        <p data-slot="asks-session-count" className="text-xs leading-4 text-muted-foreground tabular-nums">
          {boardCountWords(session.asks.length, answered, unchecked)}
        </p>
      </div>
      <ul className="flex flex-col divide-y divide-border border-t border-border">
        {session.asks.map((ask, index) => (
          <AskRow key={ask.id} ask={ask} number={index + 1} answered={marks[index] === true} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

/** The "Answer next" button and the session cards. The empty board is the view's own words, not drawn here. */
export function AsksBoard({ sessions, live, now, drafts, onOpen }: { sessions: readonly AskSession[]; live: WalkyLivePanes; now: number; drafts: ReadonlyMap<string, AskDraft>; onOpen: (id: string) => void }) {
  useLocale();
  const first = sessions[0]?.asks[0];
  return (
    <div data-slot="asks-board" className="flex flex-col gap-3">
      <Button type="button" data-slot="asks-answer-next" className="h-11 w-full" disabled={first === undefined} onClick={() => first !== undefined && onOpen(first.id)}>
        {t("asks.board.answerNext")}
      </Button>
      {sessions.map((session) => (
        <SessionCard key={session.key} session={session} live={live} now={now} drafts={drafts} onOpen={onOpen} />
      ))}
    </div>
  );
}
