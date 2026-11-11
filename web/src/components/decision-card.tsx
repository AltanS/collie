import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { AgentIcon } from "@/components/agent-icon";
import { BrandMark } from "@/components/brand-mark";
import { DecisionGroupPager, GroupCount } from "@/components/decision-group";
import { DecisionView } from "@/components/decision-view";
import { HillPriorityMark } from "@/components/hill-priority";
import { HillImageStrip, hillMediaSource, type HillMediaSource } from "@/components/hill-media";
import { Icon } from "@/components/icons/icon";
import { MarkdownText } from "@/components/markdown-text";
import { NoPromptsBadge } from "@/components/no-prompts-badge";
import { OptionButton } from "@/components/option-button";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapse } from "@/components/ui/collapse";
import { CopyableBlock } from "@/components/ui/copyable-block";
import { FoldPanel, MoreToggle, NoteToggle } from "@/components/ui/fold-toggle";
import { Notice, type NoticeTone } from "@/components/ui/notice";
import { OneOf } from "@/components/ui/one-of";
import { HeightSwap } from "@/components/ui/presence";
import { useArm } from "@/hooks/use-arm";
import type { HillAnswerState } from "@/hooks/use-hill-answer";
import { useLocale } from "@/hooks/use-locale";
import { cacheClockNow, subscribeCacheClock } from "@/lib/cache-clock";
import { hasResizeObserver, pageFonts } from "@/lib/env";
import { HILL_ACK_MS } from "@/lib/hill/motion";
import { linkHost } from "@/lib/hill/reader";
import { useOpenedCards } from "@/lib/hill/group-opened";
import type { HillDecision, HillGroupAnswer, HillOption, HillReceipt } from "@/lib/hill/wire";
import { HILL_ANSWER_TEXT_MAX } from "@/lib/hill/wire";
import { ageWords, collieOkWords, receiptWords, targetLabel, targetLine } from "@/lib/hill/words";
import { HOST_TEXT_CLASSES } from "@/lib/hosts";
import { t, tn } from "@/lib/i18n";
import { onBridgeClock } from "@/lib/server-clock";
import { trickIconOf } from "@/lib/tricks/icons";
import { viewImageRefs } from "@/lib/tricks/layout";
import { cn } from "@/lib/utils";

// A DECISION, AS A CARD ON THE HILL (M96).
//
// An agent, or a trick, posted a question with its options, and the person answers it here. The look
// is calm and typographic (the owner's pick, B1, 2026-11-09). Top to bottom: the first line (the
// priority as three peaks and a word, who asked with their mark, the machine, how old it is), the title
// in a reading size, the summary, the images as one sideways row, the poster's view of the facts in a
// quiet frame (decision-view.tsx), the recommendation as a quote between
// two rules, a row of two quiet taps ("More" for the body and the links, "Add a note" for an optional
// note), the options numbered 1, 2, 3 like the terminal's own menu, a required answer's field, what
// happened after the tap, and the line that says where the answer goes with a quiet Dismiss beside it.
//
// ── IT WEARS THE APP'S OWN PIECES ──────────────────────────────────────────────────────────────────
// The card is `ui/card.tsx`; its options are the `OptionButton` rows a program's ask and a permission
// card answer with, so a question from an agent reads the same wherever it is asked; More and Add a
// note are `ui/fold-toggle.tsx`; the images `ui/image-strip.tsx`; the priority `ui/peak-glyph.tsx`;
// what happened after a tap is a `Notice` box in the card (DESIGN.md §11, a contextual notice); the
// body is Chat's own Markdown, with its link rules. Every string the poster wrote is `font-content`,
// never the app's face (DESIGN.md §5). The numbers on the options are display only: no key sends one.
//
// ── NOTHING IS CHOSEN FOR THE PERSON ───────────────────────────────────────────────────────────────
// The recommended option carries a small star, and the quote above says which one and why, with the
// same star. It is never pre-selected and never focused: a recommendation the person does not read must
// not become the answer by default. Both stars wear the warm accent (`--status-working`), as the chosen
// option B1 draws them: the owner's exception to "a status colour is never an accent", 2026-11-10
// (DESIGN.md §4, "The Hill's warm accent").
//
// ── THE LOOK IS THE OPTION'S, TO THE PIXEL ─────────────────────────────────────────────────────────
// Sizes, inks and spacing are option B1's own (web/src/playground/hill-look/cards.tsx), free sizes
// included (the 15px summary and quote, the 11px caption): the owner chose that card by name, so a
// nearest Tailwind step is a deviation. One change since, on the owner's word of 2026-11-10 ("this needs
// your attention, it's a question/summary"): the head reads as one unit, a question with its why. The
// title is 17px (B1 had 19px), semibold, with tight leading and balanced lines; the summary sits 4px
// under it in the foreground ink at 1.5 leading (B1 had the muted ink, 6px and 1.625). The summary shows
// three lines; the rest opens with More, which is offered whenever the three lines hide some of it.
//
// ── A NOTE IS OFFERED, AN ANSWER IN WORDS IS ASKED ─────────────────────────────────────────────────
// An optional note sits behind "Add a note"; a required answer, and the words of a Decision with no
// options, are drawn open, because they are the answer. A note with words in it stays open (its toggle
// rests disabled until the field is empty), so words the person typed never ride on a tap unseen.
//
// ── ARM, THEN SEND ─────────────────────────────────────────────────────────────────────────────────
// An option with `confirm` asks for a second tap: the first one arms it, the button shows the confirm
// word in the armed tint (DESIGN.md §4) for ARM_MS, a tap inside ARM_DWELL_MS is the same touch landing
// twice, and the second tap after it sends (`useArm`, the belt Stop's rule). One button of a card is
// armed at a time, Dismiss included, which asks for its own second tap the same way. New words in the
// field drop an armed option: the arm was for the answer as it read when it was armed.
//
// ── THE CARD SAYS WHAT HAPPENED, IN PLACE ──────────────────────────────────────────────────────────
// After a tap the card says "Sending…", then the receipt in words. An answer that landed leaves the
// open list when the next list arrives.
//
// THE MOMENT OF ANSWERING IS ONE MOTION (2026-11-10, lib/hill/motion.ts). The tapped option (or Dismiss)
// takes the chosen look in place and the others dim, for HILL_ACK_MS; then the options and the field give
// way to the one status line in the same band (`HeightSwap`), its height easing between the two, and
// "Sending…" gives way to the receipt the same way. The list then lets the card leave
// (ui/presence.tsx). A card that takes answers again (a refusal, `denied`, a request that got no answer)
// gets its options back the same way, with the notice under them. A refusal, and the bridge's `denied` (this device may not
// answer), keep the card open and take a new answer. A gone target keeps the person's words on screen
// with Copy, so nothing they wrote is lost. A request that got no answer says "Not sent." with Try
// again, which sends the same attempt with the same request id (`useHillAnswer`). The card owns no
// network: `onSend` is the caller's.
//
// A GROUP OF CARDS (crew slice 8, decision-group.tsx). Collie's own Decision whose code does not fit one
// card shows its cards one at a time in the view's place, always from card 1: the page is this card's
// state, never restored, so a link, a push or a second phone cannot open it past the facts. The first
// line carries "4 cards". The options show on the last card only; the decline ("Not now") shows on
// every card, quiet. A yes stays off until every card was on screen, with "Open all 4 cards first." and
// a "Card 3" tap for each card not yet opened (lib/hill/group-opened.ts keeps the marks). Every answer
// to a group carries its digest and the cards opened; the bridge refuses a yes without them.

/** The bridge's clock, ticked once a second by the page's one shared clock (lib/cache-clock.ts). */
function hillClockNow(): number {
  return onBridgeClock(cacheClockNow());
}

/** The age on the first line, against the bridge's clock. */
function Age({ at }: { at: number }) {
  const now = useSyncExternalStore(subscribeCacheClock, hillClockNow, hillClockNow);
  return <span className="ml-auto shrink-0 tabular-nums">{ageWords(at, now)}</span>;
}

/**
 * Who asks, as a 16px mark: the agent's own logo tile, the trick's glyph on a neutral tile of the same
 * size, or the app's own mark for a Decision of Collie's own. Decorative: the name follows.
 */
function SenderMark({ decision, trickIcon }: { decision: HillDecision; trickIcon: string | undefined }) {
  if (decision.from.kind === "collie") {
    return (
      <span aria-hidden data-slot="decision-collie-mark" className="flex shrink-0">
        <BrandMark size={16} weight="header" state="rest" />
      </span>
    );
  }
  if (decision.from.kind === "agent") {
    return (
      <span aria-hidden className="flex shrink-0">
        <AgentIcon agent={decision.from.harness} className="size-4 rounded-sm" />
      </span>
    );
  }
  const Glyph = trickIconOf(trickIcon);
  return (
    <span aria-hidden data-slot="decision-trick-mark" className="flex size-4 shrink-0 items-center justify-center rounded-sm border border-border bg-secondary text-foreground">
      <Glyph className="size-[60%]" />
    </span>
  );
}

/**
 * The first line: priority, a bar, who asked, the word trick with its plug for a trick, the machine with
 * its glyph in the machine's tint, the age. Every piece sits 8px from the next (B1's `gap-2`).
 */
function MetaLine({ decision, hostSlot, trickIcon }: { decision: HillDecision; hostSlot: number | null; trickIcon: string | undefined }) {
  const { from } = decision;
  const hostInk = hostSlot === null ? "text-muted-foreground" : (HOST_TEXT_CLASSES[hostSlot] ?? "text-muted-foreground");
  return (
    <div data-slot="decision-meta" className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <HillPriorityMark priority={decision.priority} />
      {/* B1's divider is the bar character in the border ink, as tall as the line's own type. */}
      <span aria-hidden className="text-border">
        |
      </span>
      <SenderMark decision={decision} trickIcon={trickIcon} />
      <span className="min-w-0 truncate text-foreground">{from.label}</span>
      {from.kind === "trick" && (
        <span data-slot="decision-trick-word" className="inline-flex min-w-0 shrink items-center gap-1">
          <Icon name="mod-icon-plug" aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{t("hill.trick")}</span>
        </span>
      )}
      {from.host !== null && (
        <span data-slot="decision-host" className="inline-flex min-w-0 shrink items-center gap-1">
          {/* The tint lands on the glyph only, and only on a crew (DESIGN.md §4). */}
          <Icon name="machine" aria-hidden className={cn("size-3 shrink-0", hostInk)} />
          <span className="truncate">{from.host}</span>
        </span>
      )}
      {decision.group !== undefined && <GroupCount count={decision.group.parts.length} />}
      <Age at={decision.at} />
    </div>
  );
}

/** "collie lead suggests Yes, Edge first", the option's label in the heavier weight, in any word order a language puts them. */
function Suggests({ from, label }: { from: string; label: string }) {
  const MARK = "\u0000";
  const [before = "", after = ""] = t("hill.suggests", { from, label: MARK }).split(MARK);
  return (
    <span>
      {before}
      <span className="font-semibold text-foreground">{label}</span>
      {after}
    </span>
  );
}

/** The poster's why between quote marks, the marks in the muted ink and a hair off the words (B1). The marks come from `hill.why`, so a language keeps its own. */
function Why({ why }: { why: string }) {
  const MARK = "\u0000";
  const [open = "", close = ""] = t("hill.why", { why: MARK }).split(MARK);
  return (
    <>
      {open !== "" && (
        <span aria-hidden className="mr-0.5 text-muted-foreground">
          {open}
        </span>
      )}
      {why}
      {close !== "" && (
        <span aria-hidden className="ml-0.5 text-muted-foreground">
          {close}
        </span>
      )}
    </>
  );
}

/**
 * Whether a clamped block hides some of its lines: read on mount and whenever it changes size. Off while
 * `clamped` is false (the block shows everything then). Guarded for jsdom, where nothing has a size.
 */
function useHidesLines<T extends HTMLElement>(clamped: boolean) {
  const ref = useRef<T>(null);
  const [hides, setHides] = useState(false);
  const measure = useCallback(() => {
    const el = ref.current;
    if (el === null || !clamped) return;
    setHides(el.scrollHeight > el.clientHeight + 1);
  }, [clamped]);
  useLayoutEffect(measure);
  useEffect(() => {
    const el = ref.current;
    if (el === null || !hasResizeObserver()) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  // A web font that lands after the first draw can turn three lines into four inside the same clamped
  // box, which no resize reports: read again once the page's fonts are ready, so More is offered then.
  useEffect(() => {
    const fonts = pageFonts();
    if (fonts === null) return;
    let live = true;
    void fonts.ready.then(() => (live ? measure() : undefined));
    return () => {
      live = false;
    };
  }, [measure]);
  return { ref, hides };
}

/** Which notice tone a receipt wears: it landed, it may have, or it did not. */
function receiptTone(receipt: HillReceipt): NoticeTone {
  if (receipt.code === "ok") {
    if (receipt.trick === "failed") return "info";
    return receipt.delivery === "typed" || receipt.delivery === "none" ? "success" : "info";
  }
  if (receipt.code === "unknown") return "info";
  return "danger";
}

/**
 * `locked`, a moment late: true HILL_ACK_MS after `locked` turns true, so the chosen option is seen in
 * place before the options give way; false the moment it turns false. True at once when the card is
 * born locked, which is part of its first frame.
 */
function useSettled(locked: boolean): boolean {
  const [settled, setSettled] = useState(locked);
  useEffect(() => {
    if (!locked) {
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), HILL_ACK_MS);
    return () => clearTimeout(timer);
  }, [locked]);
  return settled && locked;
}

/** True when the card takes no more answers: one is in flight, or the bridge took or closed it. */
function lockedBy(answer: HillAnswerState): boolean {
  if (answer.phase === "sending") return true;
  if (answer.phase !== "answered") return false;
  // A refusal is an answer that changed nothing: the card stays open for another one. The bridge's
  // `denied` (this device may not answer) changes nothing either, and says so in the notice.
  return answer.receipt.code !== "rejected" && answer.receipt.code !== "denied";
}

/** The words the person sent with an answer that did not reach its target, kept with Copy. */
export function KeptWords({ text }: { text: string }) {
  useLocale();
  return (
    <div data-slot="decision-kept" className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{t("hill.kept")}</span>
      <CopyableBlock text={text} label={t("hill.copy")}>
        <p className="font-content whitespace-pre-wrap break-words rounded-sm border border-border px-3 py-2 pr-9 text-sm">{text}</p>
      </CopyableBlock>
    </div>
  );
}

/** What happened after the tap, in the card's own chrome. Null while nothing has been sent. */
function AnswerStatus({ decision, answer, onRetry, slot }: { decision: HillDecision; answer: HillAnswerState; onRetry: () => void; slot: string }) {
  if (answer.phase === "idle") return null;
  return (
    <div data-slot={slot}>
      <AnswerNotice decision={decision} answer={answer} onRetry={onRetry} />
    </div>
  );
}

function AnswerNotice({ decision, answer, onRetry }: { decision: HillDecision; answer: Exclude<HillAnswerState, { phase: "idle" }>; onRetry: () => void }) {
  if (answer.phase === "sending") {
    return (
      <Notice variant="box" tone="neutral" announce="status" icon={<Icon name="busy" className="animate-spin" />}>
        {t("hill.sending")}
      </Notice>
    );
  }
  if (answer.phase === "failed") {
    return (
      <Notice
        variant="box"
        tone="danger"
        announce="alert"
        icon={<Icon name="error" />}
        action={
          <Button type="button" variant="outline" size="sm" data-slot="decision-retry" className="h-8" onClick={onRetry}>
            <Icon name="retry" aria-hidden />
            {t("hill.retry")}
          </Button>
        }
      >
        {t("hill.receipt.failed")}
      </Notice>
    );
  }
  const { receipt } = answer;
  const tone = receiptTone(receipt);
  const kept = receipt.code === "gone" && answer.text !== null && answer.text.trim() !== "" ? answer.text : null;
  return (
    <div className="flex flex-col gap-2">
      <Notice
        variant="box"
        tone={tone}
        announce={tone === "danger" ? "alert" : "status"}
        icon={<Icon name={tone === "danger" ? "error" : "answered"} />}
      >
        <span data-slot="decision-receipt" data-code={receipt.code}>
          {decision.from.kind === "collie" && receipt.code === "ok"
            ? collieOkWords(decision.from, answer.intent)
            : receiptWords(receipt, answer.intent, targetLabel(decision), decision.from.kind === "trick" ? decision.from.label : null)}
        </span>
      </Notice>
      {kept !== null && <KeptWords text={kept} />}
    </div>
  );
}

/**
 * One Decision. `answer` is where this card's answer is (`useHillAnswer`, or a fixed state in the
 * playground), `onSend` sends one: an option's intent, `answer` for words alone, or `dismiss`.
 * `mediaSource` says where an image's bytes are: the bridge's route unless the playground says otherwise.
 * `hostSlot` is the poster's machine tint on a crew (`lib/hosts.ts`), null on a solo install;
 * `trickIcon` a trick's own icon word, when the caller knows it. A group of cards opens on card 1.
 */
export function DecisionCard({
  decision,
  answer,
  onSend,
  mediaSource = hillMediaSource,
  hostSlot = null,
  trickIcon,
  playgroundCard,
}: {
  decision: HillDecision;
  answer: HillAnswerState;
  onSend: (intent: string, text: string | null, group?: HillGroupAnswer) => void;
  mediaSource?: HillMediaSource;
  hostSlot?: number | null;
  trickIcon?: string;
  /**
   * The playground's way to draw a group on a later card, without the cards before it marked opened.
   * The live card never passes it: a group always opens on card 1.
   */
  playgroundCard?: number;
}) {
  useLocale();
  const [draft, setDraft] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const { armed, tap, disarm } = useArm<string>();
  const bodyId = useId();
  const summaryId = useId();
  const noteId = useId();
  const hintId = useId();
  const locked = lockedBy(answer);
  const settled = useSettled(locked);
  const group = decision.group;
  const [page, setPage] = useState(() => (playgroundCard === undefined ? 0 : playgroundCard - 1));
  const { opened, mark } = useOpenedCards(decision.id, group?.digest ?? "");
  useEffect(() => {
    if (group !== undefined) mark(page + 1);
  }, [group, page, mark]);
  const cardCount = group?.parts.length ?? 0;
  const lastCard = group === undefined || page >= cardCount - 1;
  const unopened = group === undefined ? [] : group.parts.map((_, i) => i + 1).filter((card) => !opened.has(card));
  const groupAnswer: HillGroupAnswer | undefined = group === undefined ? undefined : { digest: group.digest, opened: [...opened].toSorted((a, b) => a - b) };
  const declineOption = group === undefined ? undefined : decision.options.find((option) => option.intent === group.decline);
  // An image the view places among its facts is drawn there, not again in the row above it.
  const stripMedia = useMemo(() => {
    const placed = decision.view === undefined ? new Set<number>() : viewImageRefs(decision.view);
    return decision.media.filter((_, i) => !placed.has(i));
  }, [decision.media, decision.view]);

  // A card that takes no more answers holds no armed button: the arm was for an answer not yet given.
  useEffect(() => {
    if (locked) disarm();
  }, [locked, disarm]);

  const words = draft.trim();
  const text = words === "" ? null : words;
  const required = decision.text === "required";
  const hasOptions = decision.options.length > 0;
  // An optional note beside options waits behind "Add a note". A required answer, or the words of a
  // Decision with no options, ARE the answer, so they are drawn open.
  const noteBehindTap = decision.text === "optional" && hasOptions;
  const fieldOpen = decision.text !== "none" && !noteBehindTap;
  const optionsBlocked = locked || (required && text === null);
  const hasBody = decision.body.trim() !== "" || decision.links.length > 0;
  // The summary shows three lines while More is closed (B1); More opens the rest of it with the body.
  const summary = useHidesLines<HTMLParagraphElement>(!moreOpen);
  const summaryHides = summary.hides;
  const hasMore = hasBody || summaryHides;
  const recommended = decision.options.find((o) => o.intent === decision.recommends?.intent);
  const sendingIntent = answer.phase === "sending" ? answer.intent : null;
  const target = decision.target;
  const goesTo = targetLine(decision);

  // An answer to a group carries its digest and the cards opened; any other answer is as it was.
  function answerWith(intent: string, answerText: string | null) {
    if (groupAnswer === undefined) onSend(intent, answerText);
    else onSend(intent, answerText, groupAnswer);
  }

  function choose(option: HillOption) {
    if (optionsBlocked) return;
    if (option.confirm !== undefined) {
      if (tap(`option:${option.intent}`) !== "fire") return;
    } else disarm();
    answerWith(option.intent, text);
  }

  function sendWords() {
    if (locked || text === null) return;
    disarm();
    answerWith("answer", text);
  }

  function dismiss() {
    if (locked) return;
    if (tap("dismiss") !== "fire") return;
    answerWith("dismiss", null);
  }

  function retry() {
    if (answer.phase !== "failed") return;
    answerWith(answer.intent, answer.text);
  }

  const dismissArmed = armed === "dismiss";
  // Dismiss was the answer: it keeps the armed tint, undimmed, as the chosen option keeps its own.
  const dismissChosen = locked && answer.phase !== "idle" && answer.phase !== "failed" && answer.intent === "dismiss";
  // The options and the field are the band the status line takes over. A card with neither keeps the
  // status in its own Collapse under everything, as before.
  const hasAnswerBlock = hasOptions || fieldOpen;
  const band = !settled ? "answer" : answer.phase === "sending" ? "sending" : "receipt";
  const statusBelow = answer.phase !== "idle" && !(hasAnswerBlock && locked);

  const field = (
    <textarea
      data-slot="decision-text"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        // An armed confirm was for the answer as it read when it was armed: new words need a new first tap.
        if (armed?.startsWith("option:")) disarm();
      }}
      placeholder={t(required ? "hill.text.required" : "hill.text.optional")}
      aria-label={t("hill.text.aria")}
      maxLength={HILL_ANSWER_TEXT_MAX}
      rows={2}
      disabled={locked}
      // Off, as the composer has it: on Android Chrome a tap on a marked word opens the
      // browser's suggestion menu, which takes the focus and hides the keyboard.
      spellCheck={false}
      className="min-h-11 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-base text-foreground placeholder:text-muted-foreground disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    />
  );

  const send = (
    <Button
      type="button"
      variant={hasOptions ? "outline" : "default"}
      data-slot="decision-send"
      disabled={locked || text === null}
      onClick={sendWords}
      className="h-11 w-full"
    >
      {sendingIntent === "answer" ? <Icon name="busy" aria-hidden className="animate-spin" /> : <Icon name="send" aria-hidden />}
      {t("hill.send")}
    </Button>
  );

  return (
    <Card
      role="group"
      aria-label={t("hill.card.aria", { title: decision.title })}
      data-slot="decision-card"
      data-id={decision.id}
      data-phase={answer.phase}
      className="gap-4 p-5"
    >
      <MetaLine decision={decision} hostSlot={hostSlot} trickIcon={trickIcon} />

      <div className="flex flex-col gap-1">
        <h3 data-slot="decision-title" className="font-content break-words text-[17px] font-semibold leading-tight text-balance">
          {decision.title}
        </h3>
        <p
          ref={summary.ref}
          id={summaryId}
          data-slot="decision-summary"
          className={cn("font-content whitespace-pre-wrap break-words text-[15px] leading-normal text-foreground", !moreOpen && "line-clamp-3")}
        >
          {decision.summary}
        </p>
      </div>

      {stripMedia.length > 0 && (
        // B1's row: 16px past the text's edge on each side, its first picture on the text's edge.
        <HillImageStrip decisionId={decision.id} media={stripMedia} source={mediaSource} className="-mx-4" scrollerClassName="px-4" />
      )}

      {group !== undefined ? (
        <DecisionGroupPager decisionId={decision.id} group={group} page={page} onPage={setPage} sender={decision.from.label} mediaSource={mediaSource} />
      ) : (
        decision.view !== undefined && <DecisionView decisionId={decision.id} view={decision.view} sender={decision.from.label} media={decision.media} mediaSource={mediaSource} />
      )}

      {decision.recommends !== null && recommended !== undefined && (
        <figure data-slot="decision-recommends" className="flex flex-col gap-1.5 border-y border-border py-3">
          <blockquote className="font-content text-[15px] leading-relaxed text-foreground">
            <Why why={decision.recommends.why} />
          </blockquote>
          <figcaption className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {/* The warm accent, as B1 draws it (DESIGN.md §4, "The Hill's warm accent"). */}
            <Icon name="recommended" aria-hidden className="size-3.5 shrink-0 text-status-working" />
            <Suggests from={decision.from.label} label={recommended.label} />
          </figcaption>
        </figure>
      )}

      {(hasMore || noteBehindTap) && (
        <div className="-my-2 flex flex-col">
          <div className="-mx-3 flex items-center justify-between">
            {hasMore ? (
              <MoreToggle
                data-slot="decision-more"
                open={moreOpen}
                onToggle={() => setMoreOpen((open) => !open)}
                controls={hasBody ? bodyId : summaryId}
                more={t("hill.more")}
                less={t("hill.less")}
              />
            ) : (
              <span />
            )}
            {noteBehindTap && (
              <NoteToggle
                data-slot="decision-note"
                open={noteOpen}
                onToggle={() => setNoteOpen((open) => !open)}
                controls={noteId}
                // Words in the note keep it open: they go with the next tap, so they stay in sight.
                disabled={locked || (noteOpen && text !== null)}
                label={t("hill.note")}
              />
            )}
          </div>
          {hasBody && (
            <FoldPanel id={bodyId} open={moreOpen} data-slot="decision-body" className="flex flex-col gap-2 pb-2">
              {decision.body.trim() !== "" && <MarkdownText text={decision.body} showLinkTargets />}
              {decision.links.length > 0 && (
                <ul className="flex flex-col">
                  {decision.links.map((link, i) => (
                    <li key={`${i}:${link.href}`}>
                      {/* B1's bare link row. The host after the words is the build's: where a tap goes, before it goes. */}
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-slot="decision-link"
                        className="flex min-h-11 min-w-0 items-center gap-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        <Icon name="open-external" aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                        <span className="font-content min-w-0 truncate">{link.label}</span>
                        <span className="ml-auto min-w-0 max-w-[45%] shrink truncate pl-2 font-mono text-[11px] font-normal text-muted-foreground">{linkHost(link.href)}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </FoldPanel>
          )}
          {noteBehindTap && (
            <FoldPanel id={noteId} open={noteOpen} data-slot="decision-note-panel" className="flex flex-col gap-2 pb-2">
              {field}
              <p data-slot="decision-note-hint" className="text-xs text-muted-foreground">
                {t("hill.note.hint")}
              </p>
              {send}
            </FoldPanel>
          )}
        </div>
      )}

      {hasAnswerBlock && (
        <HeightSwap
          data-slot="decision-answer"
          active={band}
          options={[
            {
              key: "answer",
              node: (
                <div className="flex flex-col gap-4">
                  {hasOptions && !lastCard && declineOption !== undefined && (
                    // Before the last card only the decline is offered, quiet: the yes waits on the last card.
                    <div data-slot="decision-options" className="flex justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        data-slot="decision-option"
                        data-intent={declineOption.intent}
                        disabled={optionsBlocked}
                        onClick={() => choose(declineOption)}
                        className="-mr-3 h-11 px-3 text-muted-foreground"
                      >
                        {sendingIntent === declineOption.intent && <Icon name="busy" aria-hidden className="size-3.5 animate-spin" />}
                        {declineOption.label}
                      </Button>
                    </div>
                  )}
                  {hasOptions && lastCard && (
                    <div data-slot="decision-options" className="flex flex-col gap-2">
                      {decision.options.map((option, i) => {
                        const isArmed = armed === `option:${option.intent}`;
                        const busy = sendingIntent === option.intent;
                        const isRecommended = recommended?.intent === option.intent;
                        return (
                          <OptionButton
                            key={`${i}:${option.intent}`}
                            data-slot="decision-option"
                            data-intent={option.intent}
                            tone={busy ? "busy" : isArmed ? "armed" : "default"}
                            // The terminal menu's own numbers. Display only: no key sends one.
                            keyLabel={i + 1}
                            label={
                              option.confirm === undefined ? (
                                option.label
                              ) : (
                                // The label and the confirm word in one slot, sized by the larger, cross-fading
                                // in place: arming never changes the row's height (DESIGN.md §2).
                                <OneOf
                                  active={isArmed ? "confirm" : "label"}
                                  layerClassName="transition-opacity duration-150 ease-out motion-reduce:transition-none"
                                  options={[
                                    { key: "label", node: option.label },
                                    { key: "confirm", node: option.confirm },
                                  ]}
                                />
                              )
                            }
                            aria-label={isArmed && option.confirm !== undefined ? t("hill.armed", { label: option.confirm }) : undefined}
                            aria-describedby={required ? hintId : undefined}
                            description={option.detail}
                            disabled={optionsBlocked || (group !== undefined && option.intent !== group.decline && unopened.length > 0)}
                            onClick={() => choose(option)}
                            className="min-h-12 items-center px-3"
                            trailing={
                              // One 16px slot on every option, so the spinner or the mark arriving moves no label.
                              // The star in the warm accent, as B1 draws it (DESIGN.md §4, "The Hill's warm accent").
                              <span aria-hidden className="flex size-4 shrink-0 items-center justify-center text-status-working">
                                {busy ? (
                                  <Icon name="busy" className="size-3.5 animate-spin text-muted-foreground" />
                                ) : isRecommended ? (
                                  <Icon name="recommended" data-slot="decision-recommended-mark" className="size-3.5" />
                                ) : null}
                              </span>
                            }
                          />
                        );
                      })}
                      {/* The mark is decorative; a reader hears which option it is here. */}
                      {recommended !== undefined && <span className="sr-only">{t("hill.recommended", { label: recommended.label })}</span>}
                      {group !== undefined && unopened.length > 0 && (
                        <div data-slot="decision-group-unopened" className="flex flex-col">
                          <p className="text-xs text-muted-foreground">{tn("hill.group.openAll", cardCount)}</p>
                          <div className="-mx-3 flex flex-wrap">
                            {unopened.map((card) => (
                              <Button key={card} type="button" variant="ghost" data-slot="decision-group-goto" className="h-11 px-3" onClick={() => setPage(card - 1)}>
                                {t("hill.group.card", { index: card })}
                              </Button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {fieldOpen && (
                    <div className="flex flex-col gap-2">
                      {field}
                      {required && hasOptions && (
                        <p id={hintId} data-slot="decision-required-hint" className="text-xs text-muted-foreground">
                          {t("hill.text.requiredHint")}
                        </p>
                      )}
                      {send}
                    </div>
                  )}
                </div>
              ),
            },
            { key: "sending", node: <AnswerStatus decision={decision} answer={answer} onRetry={retry} slot="decision-status" /> },
            { key: "receipt", node: <AnswerStatus decision={decision} answer={answer} onRetry={retry} slot="decision-status" /> },
          ]}
        />
      )}
      {/* A live region on the button itself is unreliable; this one announces the armed wording. */}
      <span className="sr-only" aria-live="polite">
        {armed === null ? "" : armed === "dismiss" ? t("hill.dismissArmed") : t("hill.armed", { label: decision.options.find((o) => `option:${o.intent}` === armed)?.confirm ?? "" })}
      </span>

      <Collapse open={statusBelow}>
        <AnswerStatus decision={decision} answer={answer} onRetry={retry} slot="decision-status" />
      </Collapse>

      <div className="-mb-2 flex min-w-0 items-center gap-2">
        {goesTo !== null ? (
          <p data-slot="decision-target" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="min-w-0 break-words">{goesTo}</span>
            {target?.unattended === true && <NoPromptsBadge label={t("hill.unattended")} className="h-5 px-1.5 py-0 text-[11px] leading-none" />}
          </p>
        ) : (
          <span className="flex-1" />
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-slot="decision-dismiss"
          disabled={locked}
          onClick={dismiss}
          className={cn(
            "-mr-3 h-11 shrink-0 px-3",
            // The armed tint on the box it already has: the border is reserved by the button's base string.
            dismissArmed || dismissChosen ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/10 hover:text-destructive" : "text-muted-foreground",
            // The chosen answer is not dimmed while the card is locked, as the chosen option is not.
            dismissChosen && "disabled:opacity-100",
          )}
        >
          {/* Both words in one slot, sized by the wider, so arming moves nothing beside it (DESIGN.md §2),
              and the two cross-fade in place. */}
          <OneOf
            active={dismissArmed ? "armed" : "rest"}
            className="inline-grid"
            layerClassName="transition-opacity duration-150 ease-out motion-reduce:transition-none"
            options={[
              { key: "rest", node: t("hill.dismiss") },
              { key: "armed", node: t("hill.dismissArmed") },
            ]}
          />
        </Button>
      </div>
    </Card>
  );
}
