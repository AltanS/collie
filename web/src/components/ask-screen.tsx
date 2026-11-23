import { useEffect, useRef, useState, type ReactNode } from "react";

import { RouteHeader } from "@/components/app-header";
import { AskAnswerCard } from "@/components/ask-answer-card";
import { AskConfirmSheet, type AskPick } from "@/components/ask-confirm-sheet";
import { AskSendSheet } from "@/components/ask-send-sheet";
import { Icon } from "@/components/icons/icon";
import { Button, FOCUS_RING, HOVER_FILL } from "@/components/ui/button";
import { BottomBar } from "@/components/ui/bottom-bar";
import { Collapse } from "@/components/ui/collapse";
import { Notice } from "@/components/ui/notice";
import { BandMain } from "@/components/ui/strip-host";
import type { AsksSend } from "@/hooks/use-asks-send";
import { useLocale } from "@/hooks/use-locale";
import { useWidthClass } from "@/hooks/use-width-class";
import { markedAnswer, optionCost, recommendedOption, type AskDecision, type AsksReview, type SessionFacts } from "@/lib/hill/asks";
import type { AskDraft } from "@/lib/hill/asks-drafts";
import { contextFacts, contextSummary, headerLine, markWords, sendLineWords, type SessionClock } from "@/lib/hill/asks-board";
import { askKeyAction, isTypingTarget } from "@/lib/hill/asks-keys";
import { HILL_MORE_CONTEXT, HILL_OWN_ANSWER } from "@/lib/hill/wire";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// THE ASK SCREEN (Asks build 2, 2026-11-23), `/hill/ask/:id`: one ask, top to bottom. The header (Back up one level, the
// session's name, "asked 14 h ago · warm, 38 min left", "ask 1 of 13"); the question, first; one line for what the
// bridge knows of the ask's freshness; the situation, only when the agent sent it; the Context row, only when there is a
// background, a picture or a file behind it; the line "<session> suggests: <option>"; the hint; the answer cards; and
// "Your own answer" last. The foot is the send line, which always holds its place, and the bar: Previous, Ask back, Next.
//
// NOTHING MOVES WHEN A STATE CHANGES (DESIGN.md §2). The send line is drawn with no answers too; the three bar buttons are
// disabled, never removed; a card's border is one pixel in every state. The only things that come in below the cards are a
// notice (a Send's word about this ask, or "You asked the agent for more context"), through `Collapse`.
//
// KEYS. ← → j k move between asks and REPLACE the entry (the deck is a level, not a stack), 1 to 9 pick an answer, Escape goes
// up one level. A key never acts while a field has the focus or a sheet is up, and every key has a button.

/** One card of the ask, before it is drawn. */
interface CardSpec {
  kind: "option" | "own" | "words";
  intent: string;
  number: number;
  title: string;
  does?: string;
  cost?: string;
  why?: string;
  recommended: boolean;
  line?: string;
}

/** The cards of an ask, in order: its options, then "Your own answer"; or the one card of a `--words` ask. */
export function cardsOf(ask: AskDecision): CardSpec[] {
  if (ask.ask.words) return [{ kind: "words", intent: "answer", number: 1, title: t("asks.words.title"), line: t("asks.words.line"), recommended: false }];
  const recommended = recommendedOption(ask);
  const options = ask.options.map((option, index): CardSpec => {
    const spec: CardSpec = { kind: "option", intent: option.intent, number: index + 1, title: option.label, recommended: recommended?.intent === option.intent };
    if (option.detail !== undefined) spec.does = option.detail;
    const cost = optionCost(option);
    if (cost !== undefined) spec.cost = cost;
    if (spec.recommended && ask.recommends !== null && ask.recommends.why !== "") spec.why = ask.recommends.why;
    return spec;
  });
  return [...options, { kind: "own", intent: HILL_OWN_ANSWER, number: options.length + 1, title: t("asks.own.title"), line: t("asks.own.line"), recommended: false }];
}

/** The header: Back up one level, the session, when it asked and what its cache is, and the place in the deck. */
export function AskHeader({ name, line, place, backLabel, onBack }: { name: string; line: string; place: string | null; backLabel: string; onBack: () => void }) {
  useLocale();
  return (
    <RouteHeader
      width="column"
      override={
        <>
          <Button variant="ghost" size="icon" className="size-11 shrink-0" onClick={onBack} aria-label={backLabel}>
            <Icon name="back" className="size-5" />
          </Button>
          <div className="ml-1 flex min-w-0 flex-1 flex-col">
            <h1 data-slot="ask-session" className="min-w-0 truncate text-lg font-semibold leading-tight tracking-tight">
              {name}
            </h1>
            <p data-slot="ask-header-line" className="truncate text-xs text-muted-foreground">
              {line}
            </p>
          </div>
          <span data-slot="ask-place" className="shrink-0 pl-2 text-xs text-muted-foreground tabular-nums">
            {place}
          </span>
        </>
      }
    />
  );
}

/** The Context row: one bordered row, "Context" and what is behind it, and a chevron. A real button; the page below is its child route. */
export function ContextRow({ summary, onOpen }: { summary: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      data-slot="ask-context-row"
      onClick={onOpen}
      className={cn("flex min-h-13 w-full items-center gap-3 rounded-md border border-border bg-card px-3.5 py-2 text-left", FOCUS_RING, HOVER_FILL)}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-semibold">{t("asks.context.row")}</span>
        <span className="truncate text-xs text-muted-foreground tabular-nums">{summary}</span>
      </span>
      <Icon name="row-go" aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

export interface AskScreenProps {
  ask: AskDecision;
  facts: SessionFacts;
  clock: SessionClock;
  now: number;
  /** Where the ask sits in the deck: 1-based, and how many there are. Null when it is not in the deck. */
  place: { index: number; count: number } | null;
  previous: string | null;
  next: string | null;
  /** The answer marked on this phone for this ask, or the empty one. */
  draft: AskDraft;
  /** The review of the SESSION's marks: what Send would send. */
  review: AsksReview;
  /** How many open asks the session holds ("2 of 4 answered"). */
  sessionOpen: number;
  /** What the last Send said about this ask (it closed first, it was refused), or null. */
  note: string | null;
  send: AsksSend;
  onBack: () => void;
  onMove: (id: string) => void;
  onContext: () => void;
  onDraft: (draft: AskDraft) => void;
}

/** What a card shows of the answer marked on this phone. */
interface CardState {
  answered: boolean;
  note?: string;
  text?: string;
}

/** Whether the card of this spec is the answer marked in `draft`, and its note or words. */
function stateOf(spec: CardSpec, ask: AskDecision, draft: AskDraft): CardState {
  const answer = markedAnswer(ask, draft);
  if (answer === null) return { answered: false };
  if (spec.kind === "words") return { answered: true, text: answer.text ?? "" };
  if (spec.kind === "own") return answer.intent === HILL_OWN_ANSWER ? { answered: true, text: answer.text ?? "" } : { answered: false };
  if (answer.intent !== spec.intent) return { answered: false };
  return answer.text === null ? { answered: true } : { answered: true, note: answer.text };
}

export function AskScreen({ ask, facts, clock, now, place, previous, next, draft, review, sessionOpen, note, send, onBack, onMove, onContext, onDraft }: AskScreenProps) {
  useLocale();
  const wide = useWidthClass() === "expanded";
  const [pick, setPick] = useState<AskPick | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const cards = cardsOf(ask);
  const answer = markedAnswer(ask, draft);
  const mark = ask.ask.mark;
  const summary = contextSummary(contextFacts(ask));
  const recommended = recommendedOption(ask);
  const sheetUp = pick !== null || sendOpen;
  const line = sendLineWords(review.count, sessionOpen);

  // The keys. Heard on the window, and only while no sheet is up and no field has the focus.
  const keys = useRef({ cards, previous, next, sheetUp });
  keys.current = { cards, previous, next, sheetUp };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const held = keys.current;
      const action = askKeyAction({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey, isComposing: event.isComposing, typing: isTypingTarget(event.target), sheet: held.sheetUp });
      if (action === null) return;
      switch (action.kind) {
        case "previous":
          if (held.previous !== null) onMove(held.previous);
          return;
        case "next":
          if (held.next !== null) onMove(held.next);
          return;
        case "up":
          onBack();
          return;
        case "pick": {
          const spec = held.cards[action.number - 1];
          if (spec === undefined) return;
          event.preventDefault();
          setPick(pickOf(spec, true));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack, onMove]);

  // On a phone the chosen card stays visible above the sheet: it scrolls to the top of the page, and the page gets room
  // under its last card for the sheet to cover (it is only blank paper under the scrim, and goes when the sheet does).
  // Where the page stood goes back when the sheet closes, so a Confirm or a Cancel moves nothing.
  const scroller = useRef<HTMLElement>(null);
  const stood = useRef(0);
  const picking = pick !== null;
  useEffect(() => {
    const page = scroller.current;
    if (!picking || wide || page === null) return;
    stood.current = page.scrollTop;
    return () => {
      page.scrollTop = stood.current;
    };
  }, [picking, wide]);
  useEffect(() => {
    if (pick === null || wide) return;
    const card = scroller.current?.querySelector<HTMLElement>(`[data-slot="ask-card"][data-intent="${CSS.escape(pick.kind === "option" ? pick.intent : pick.kind === "own" ? HILL_OWN_ANSWER : pick.kind === "words" ? "answer" : "")}"]`);
    card?.scrollIntoView({ block: "start" });
  }, [pick, wide]);

  const confirm = (marked: AskDraft) => {
    onDraft(marked);
    setPick(null);
  };
  const submit = async () => {
    if (await send.send(review.answers)) {
      setSendOpen(false);
      send.reset();
    }
  };

  const picked = pick === null ? null : pick.kind === "option" ? pick.intent : pick.kind === "own" ? HILL_OWN_ANSWER : pick.kind === "words" ? "answer" : null;
  const moreContext = draft.intent === HILL_MORE_CONTEXT && !ask.ask.words;
  const below: ReactNode = note !== null ? <Notice tone="caution" variant="box" announce="status">{note}</Notice> : moreContext ? <Notice tone="neutral" variant="box" action={<Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => setPick({ kind: "more", byKey: false })}>{t("asks.confirm.change")}</Button>}>{draft.text.trim() === "" ? t("asks.moreContext") : `${t("asks.moreContext")}: ${draft.text.trim()}`}</Notice> : null;

  return (
    <div data-slot="ask-screen" data-id={ask.id} className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <AskHeader
        name={facts.name}
        line={headerLine(ask.at, clock, now)}
        place={place === null ? null : t("asks.position", { index: place.index, count: place.count })}
        backLabel={t("asks.back")}
        onBack={onBack}
      />
      <BandMain base={16} scrollRef={scroller} data-slot="ask-scroll" className={cn("relative flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pt-4 pb-4", pick !== null && !wide && "pb-[60dvh]")}>
        <h2 data-slot="ask-question" className="font-content text-xl font-semibold leading-snug text-balance">
          {ask.title}
        </h2>
        <p data-slot="ask-mark" data-mark={mark} className="text-xs text-muted-foreground">
          {markWords(mark, ask)}
        </p>
        {ask.summary !== "" && (
          <p data-slot="ask-situation" className="font-content text-[15px] leading-relaxed text-foreground">
            {ask.summary}
          </p>
        )}
        {summary !== null && <ContextRow summary={summary} onOpen={onContext} />}
        {recommended !== undefined && (
          <p data-slot="ask-suggests" className="flex items-start gap-1.5 text-sm">
            <Icon name="recommended" aria-hidden className="mt-0.5 size-3.5 shrink-0 text-status-working" />
            <span className="min-w-0 break-words">{t("asks.suggests", { from: facts.name, label: recommended.label })}</span>
          </p>
        )}
        <p data-slot="ask-hint" className="text-xs text-muted-foreground">
          {t("asks.hint")}
        </p>
        <div data-slot="ask-cards" className="flex flex-col gap-5 pt-2">
          {cards.map((spec) => {
            const state = stateOf(spec, ask, draft);
            return (
              <AskAnswerCard
                key={spec.intent}
                kind={spec.kind}
                number={spec.number}
                title={spec.title}
                does={spec.does}
                cost={spec.cost}
                why={spec.why}
                recommended={spec.recommended}
                answered={state.answered}
                note={state.note}
                text={state.text}
                line={spec.line}
                picked={picked === spec.intent}
                intent={spec.intent}
                onPick={() => setPick(pickOf(spec, false))}
              />
            );
          })}
        </div>
        <Collapse open={below !== null}>{below}</Collapse>
      </BandMain>
      <BottomBar className="flex flex-col gap-2">
        <Button
          type="button"
          variant="ghost"
          data-slot="ask-send-line"
          disabled={line.action === null}
          onClick={() => setSendOpen(true)}
          aria-label={line.action === null ? undefined : t("asks.send.open")}
          className="h-11 w-full justify-center text-muted-foreground disabled:opacity-100 data-[ready]:text-foreground"
          data-ready={line.action === null ? undefined : ""}
        >
          <span className="tabular-nums">{line.words}</span>
          {line.action !== null && (
            <>
              <span aria-hidden>{"·"}</span>
              <b className="font-semibold tabular-nums">{line.action}</b>
              <Icon name="row-go" aria-hidden className="size-4" />
            </>
          )}
        </Button>
        <div data-slot="ask-actions" className="grid grid-cols-3 gap-2">
          <Button type="button" variant="outline" data-slot="ask-previous" className="h-11" title={t("asks.previous.title")} disabled={previous === null} onClick={() => previous !== null && onMove(previous)}>
            <Icon name="back" aria-hidden className="size-4" />
            {t("asks.previous")}
          </Button>
          <Button type="button" variant="outline" data-slot="ask-back" className="h-11" disabled={ask.ask.words} onClick={() => setPick({ kind: "more", byKey: false })}>
            {t("asks.askBack")}
          </Button>
          <Button type="button" variant="outline" data-slot="ask-next" className="h-11" title={t("asks.next.title")} disabled={next === null} onClick={() => next !== null && onMove(next)}>
            {t("asks.next")}
            <Icon name="row-go" aria-hidden className="size-4" />
          </Button>
        </div>
      </BottomBar>
      <AskConfirmSheet ask={ask} pick={pick} draft={draft} onConfirm={confirm} onClose={() => setPick(null)} />
      <AskSendSheet
        open={sendOpen}
        onClose={() => {
          setSendOpen(false);
          send.reset();
        }}
        name={facts.name}
        review={review}
        clock={clock}
        state={send.state}
        onSend={() => void submit()}
      />
      {answer === null ? null : <span hidden data-slot="ask-answered" data-intent={answer.intent} />}
    </div>
  );
}

/** What a tap or a key on a card opens. */
function pickOf(spec: CardSpec, byKey: boolean): AskPick {
  if (spec.kind === "option") return { kind: "option", intent: spec.intent, byKey };
  return { kind: spec.kind, byKey };
}
