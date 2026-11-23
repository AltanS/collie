import { useEffect, useState } from "react";

import { AskSendSheet } from "@/components/ask-send-sheet";
import { CacheClockView } from "@/components/asks-clock";
import { Icon } from "@/components/icons/icon";
import { StatusDot } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button, FOCUS_RING_INSET, HOVER_FILL } from "@/components/ui/button";
import type { AsksSend } from "@/hooks/use-asks-send";
import { useLocale } from "@/hooks/use-locale";
import { answerLabel, markedAnswer, recommendedOption, reviewOf, sessionFacts, type AskDecision, type AskSession, type SessionFacts } from "@/lib/hill/asks";
import { boardCountWords, cacheClockOf, isUnchecked, nextUpLine, sectionCountWords, sessionClock } from "@/lib/hill/asks-board";
import { NO_DRAFT, type AskDraft } from "@/lib/hill/asks-drafts";
import { nextUpOf, openAskCount, type NextUp } from "@/lib/hill/asks-next";
import { t } from "@/lib/i18n";
import { shortcutTarget } from "@/lib/shortcuts/target";
import { cn } from "@/lib/utils";
import { livePaneAt, type WalkyLivePanes } from "@/lib/walky-names";

// THE ASKS LIST PAGE (Asks build 6, 2026-11-23), the part under the header, top to bottom.
//
//  1. "Next up": one card with the first open ask that has no answer marked here: the session, the question, the
//     agent's suggestion, and "Answer", the one filled button of the page. When every ask has an answer marked and only
//     Send is left, the card offers the first session's Send instead (`nextUpOf`, lib/hill/asks-next.ts).
//  2. The section line: what the list is ordered by, and how many asks are open and answered here.
//  3. One card for each session that has an open ask, in the order of the cache clock (lib/hill/asks-board.ts): its
//     status mark, name, place and state words, its cache clock, one row for each question, and only when answers
//     are marked a foot with the count and that session's Send. A cold session has no fill and muted questions.
//
// COLOUR IS STATE ONLY: the mark is the Dashboard's, the clock is `--status-info`, a marked answer is `Badge ok`, the
// agent's suggestion is the warm star. The row numbers are plain muted numbers in a fixed slot, never a box: they
// count within a card and are not keys. The page's one key is the action `answer_next_ask` (the prefix and `a`): the
// button names it with `shortcutTarget`, so its cap shows while the prefix waits and the box never changes.
//
// The other cards (`HillView`'s last group), the Answered fold and Clear stay under this, unchanged. The Send sheet is
// the very one the ask screen opens (`AskSendSheet`), for one session's marks.

const NO_DONE = (): void => undefined;

/** The one-line question of a row: the agent's title, whitespace folded. */
export function questionLine(ask: Pick<AskDecision, "title">): string {
  return ask.title.replace(/\s+/gu, " ").trim();
}

/** A session's status mark in a 12px slot that is always there, so names align: empty for a session with no status here. */
function SessionMark({ facts, surface }: { facts: SessionFacts; surface: string }) {
  if (facts.status === null) return <span aria-hidden data-slot="asks-mark" data-status="none" className="size-3 shrink-0" />;
  return <StatusDot status={facts.status} surface={surface} />;
}

/** "<place> · <state words>", whichever parts the session has. */
function placeLine(facts: SessionFacts): string {
  return [facts.line, facts.stateWord].filter((part): part is string => part !== null && part !== "").join(" · ");
}

/** What a row says at its right end: the badge of a marked answer, "Next", or the chevron. */
function RowEnd({ answer, next }: { answer: string | null; next: boolean }) {
  if (answer !== null) {
    return (
      <Badge variant="ok" data-slot="asks-row-answered" className="max-w-[45%]">
        <span className="truncate">{t("asks.board.rowAnsweredWith", { option: answer })}</span>
      </Badge>
    );
  }
  if (next) {
    return (
      <span data-slot="asks-row-next" className="shrink-0 text-xs font-medium text-muted-foreground">
        {t("asks.next")}
      </span>
    );
  }
  return <Icon name="row-go" aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
}

function AskRow({ ask, number, answer, next, onOpen }: { ask: AskDecision; number: number; answer: string | null; next: boolean; onOpen: (id: string) => void }) {
  const unchecked = isUnchecked(ask);
  const answered = answer !== null;
  return (
    <li>
      <button
        type="button"
        data-slot="asks-row"
        data-id={ask.id}
        data-state={answered ? "answered" : unchecked ? "unchecked" : next ? "next" : "open"}
        onClick={() => onOpen(ask.id)}
        className={cn("flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left", FOCUS_RING_INSET, HOVER_FILL)}
      >
        <span data-slot="asks-row-number" className={cn("w-5 shrink-0 text-center text-xs tabular-nums", next ? "font-semibold text-foreground" : "text-muted-foreground")}>
          {number}
        </span>
        <span className={cn("font-content line-clamp-2 min-w-0 flex-1 text-[15px] leading-snug", (answered || unchecked) && "text-muted-foreground")}>{questionLine(ask)}</span>
        <RowEnd answer={answer} next={next} />
      </button>
    </li>
  );
}

/** One session's card. `nextId` is the ask the Next up card offers, when it is one of this card's. */
export function SessionCard({
  session,
  live,
  now,
  drafts,
  nextId,
  onOpen,
  onSend,
}: {
  session: AskSession;
  live: WalkyLivePanes;
  now: number;
  drafts: ReadonlyMap<string, AskDraft>;
  nextId: string | null;
  onOpen: (id: string) => void;
  onSend: (key: string) => void;
}) {
  useLocale();
  const facts = sessionFacts(session, live);
  const pane = livePaneAt(session.key, live);
  const cold = sessionClock(pane, now).kind === "cold";
  const answers = session.asks.map((ask) => markedAnswer(ask, drafts.get(ask.id) ?? NO_DRAFT));
  const answered = answers.filter((answer) => answer !== null).length;
  const unchecked = session.asks.filter(isUnchecked).length;
  return (
    <section data-slot="asks-session" data-key={session.key} data-clock={cold ? "cold" : "live"} className={cn("flex min-w-0 flex-col overflow-hidden rounded-md border border-border", cold ? "bg-transparent" : "bg-card")}>
      <div className="flex min-w-0 items-start gap-2.5 px-4 py-3">
        <span className="mt-[5px] flex shrink-0">
          <SessionMark facts={facts} surface={cold ? "bg-background" : "bg-card"} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 data-slot="asks-session-name" className="min-w-0 truncate text-base leading-[22px]">
            {facts.name}
          </h2>
          <p data-slot="asks-session-place" className="min-h-4 truncate text-xs leading-4 text-muted-foreground">
            {placeLine(facts)}
          </p>
        </div>
        <CacheClockView clock={cacheClockOf(pane, now)} className="mt-[3px] shrink-0" />
      </div>
      <ul className="flex flex-col divide-y divide-border border-t border-border">
        {session.asks.map((ask, index) => {
          const answer = answers[index];
          return <AskRow key={ask.id} ask={ask} number={index + 1} answer={answer === null || answer === undefined ? null : answerLabel(answer)} next={ask.id === nextId} onOpen={onOpen} />;
        })}
      </ul>
      {answered > 0 && (
        <div data-slot="asks-session-foot" className="flex min-h-12 items-center justify-between gap-3 border-t border-border px-4 py-2">
          <span data-slot="asks-session-count" className="min-w-0 text-[13px] text-muted-foreground tabular-nums">
            {boardCountWords(session.asks.length, answered, unchecked)}
          </span>
          <Button type="button" variant="outline" size="sm" data-slot="asks-session-send" className="shrink-0" onClick={() => onSend(session.key)}>
            {t("asks.send.action", { count: answered })}
          </Button>
        </div>
      )}
    </section>
  );
}

/** The Next up card: the one place to start, and the page's one filled button. */
export function NextUpCard({ next, sessionCount, live, now, onOpen, onSend }: { next: NextUp; sessionCount: number; live: WalkyLivePanes; now: number; onOpen: (id: string) => void; onSend: (key: string) => void }) {
  useLocale();
  const facts = sessionFacts(next.session, live);
  const pane = livePaneAt(next.session.key, live);
  const line = nextUpLine(sessionCount, sessionClock(pane, now));
  const suggested = next.kind === "ask" ? recommendedOption(next.ask) : undefined;
  const heading = next.kind === "ask" ? next.ask.title : t("asks.send.progress", { answered: next.answered, total: next.total });
  return (
    <section data-slot="asks-next" data-kind={next.kind} aria-labelledby="asks-next-heading" className="flex min-w-0 flex-col rounded-md border border-rule bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium leading-4 text-muted-foreground">{t("asks.board.nextUp")}</span>
        <CacheClockView clock={cacheClockOf(pane, now)} className="shrink-0" />
      </div>
      <div data-slot="asks-next-who" className="mt-3 flex min-w-0 items-center gap-2">
        <SessionMark facts={facts} surface="bg-card" />
        <span className="min-w-0 truncate text-sm [font-family:var(--font-display)]">{facts.name}</span>
        {facts.stateWord !== null && <span className="shrink-0 text-xs text-muted-foreground">{`· ${facts.stateWord}`}</span>}
      </div>
      <h2 id="asks-next-heading" data-slot="asks-next-question" className="font-content mt-2 text-lg leading-snug font-semibold text-balance min-[480px]:text-xl">
        {heading}
      </h2>
      {suggested !== undefined && (
        <p data-slot="asks-next-suggests" className="mt-2 flex items-start gap-1.5 text-[13px] text-muted-foreground">
          <Icon name="recommended" aria-hidden className="mt-0.5 size-3.5 shrink-0 text-status-working" />
          <span className="min-w-0 break-words">{t("asks.suggests", { from: facts.name, label: suggested.label })}</span>
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          type="button"
          data-slot="asks-answer-next"
          {...shortcutTarget("answer_next_ask")}
          className="h-11 px-5"
          onClick={() => (next.kind === "ask" ? onOpen(next.ask.id) : onSend(next.session.key))}
        >
          {next.kind === "ask" ? t("asks.board.answer") : t("asks.send.action", { count: next.answered })}
        </Button>
        {next.kind === "ask" && line !== null && (
          <p data-slot="asks-next-line" className="min-w-0 flex-1 basis-48 text-[13px] text-muted-foreground">
            {line}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * The Next up card, the section line and the session cards, and the Send sheet of one session. The empty board is the
 * view's own words, not drawn here. `sendRequest` is a session key a shortcut asked this page to send: it is answered
 * once, and `onSendRequestDone` forgets it.
 */
export function AsksBoard({
  sessions,
  live,
  now,
  drafts,
  onOpen,
  send,
  sendRequest = null,
  onSendRequestDone = NO_DONE,
  loaded = true,
}: {
  sessions: readonly AskSession[];
  live: WalkyLivePanes;
  now: number;
  drafts: ReadonlyMap<string, AskDraft>;
  onOpen: (id: string) => void;
  send: AsksSend;
  sendRequest?: string | null;
  onSendRequestDone?: () => void;
  /** False while the list the sessions come from has not landed: a Send request waits instead of being dropped. */
  loaded?: boolean;
}) {
  useLocale();
  const [sending, setSending] = useState<string | null>(null);
  const next = nextUpOf(sessions, drafts);
  const open = openAskCount(sessions);
  const answered = sessions.reduce((sum, session) => sum + session.asks.filter((ask) => markedAnswer(ask, drafts.get(ask.id) ?? NO_DRAFT) !== null).length, 0);
  const sendSession = sessions.find((session) => session.key === sending);
  const review = sendSession === undefined ? null : reviewOf(sendSession.asks, drafts);

  // A shortcut asked for a session's Send: open it when the session still holds a mark. The request waits while the deck is
  // loading (the session may not be in it yet); once the deck has loaded it is answered or dropped.
  useEffect(() => {
    if (sendRequest === null) return;
    const target = sessions.find((session) => session.key === sendRequest);
    if (target !== undefined && reviewOf(target.asks, drafts).count > 0) {
      setSending(target.key);
      onSendRequestDone();
      return;
    }
    if (!loaded) return;
    onSendRequestDone();
  }, [sendRequest, sessions, drafts, onSendRequestDone, loaded]);

  const close = () => {
    setSending(null);
    send.reset();
  };
  const submit = async (answers: Parameters<AsksSend["send"]>[0]) => {
    if (await send.send(answers)) close();
  };
  return (
    <div data-slot="asks-board" className="flex flex-col">
      {next !== null && <NextUpCard next={next} sessionCount={sessions.length} live={live} now={now} onOpen={onOpen} onSend={setSending} />}
      <div data-slot="asks-section" className="mt-7 mb-2 flex items-baseline justify-between gap-3 text-xs leading-4 font-medium text-muted-foreground">
        <span>{t("asks.board.section")}</span>
        <span data-slot="asks-section-count" className="shrink-0 tabular-nums">
          {sectionCountWords(open, answered)}
        </span>
      </div>
      <div className="flex flex-col gap-3">
        {sessions.map((session) => (
          <SessionCard key={session.key} session={session} live={live} now={now} drafts={drafts} nextId={next?.kind === "ask" ? next.ask.id : null} onOpen={onOpen} onSend={setSending} />
        ))}
      </div>
      {sendSession !== undefined && review !== null && (
        <AskSendSheet
          open
          onClose={close}
          name={sessionFacts(sendSession, live).name}
          review={review}
          clock={sessionClock(livePaneAt(sendSession.key, live), now)}
          state={send.state}
          onSend={() => void submit(review.answers)}
        />
      )}
    </div>
  );
}
