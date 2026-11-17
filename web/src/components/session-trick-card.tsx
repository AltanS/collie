import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type MutableRefObject } from "react";

import { AnswerStatus, lockedBy } from "@/components/decision-card";
import { scrollBoxOf } from "@/components/decision-group";
import { hillMediaSource, viewPictures, type HillMediaSource } from "@/components/hill-media";
import { Icon } from "@/components/icons/icon";
import { OptionButton, OptionGroupCaption, PromptPanel } from "@/components/option-button";
import { COLLAPSE_MS, usePrefersReducedMotion } from "@/components/ui/collapse";
import { FoldPanel } from "@/components/ui/fold-toggle";
import { useHillAnswer, type HillAnswerState } from "@/hooks/use-hill-answer";
import { useLocale } from "@/hooks/use-locale";
import { useStill } from "@/hooks/use-still";
import { singleCodeCard, trickCardDecline, viewHasCode } from "@/lib/hill/code-card";
import { useOpenedCards } from "@/lib/hill/group-opened";
import { linkHost, isWebLink } from "@/lib/hill/reader";
import { closeInSession, useSessionLater } from "@/lib/hill/session-later";
import { useHillAnswerHeld, useHillClosed, useHillOpen } from "@/lib/hill/store";
import type { HillDecision, HillGroupAnswer, HillOption } from "@/lib/hill/wire";
import { t } from "@/lib/i18n";
import { TrickBoundary } from "@/lib/tricks/boundary";
import { Placeholder, renderView, type LinkTarget, type RenderCtx } from "@/lib/tricks/render";
import type { View } from "@/lib/tricks/schema";
import { cn } from "@/lib/utils";

// A TRICK PROPOSAL IN THE SESSION THAT PROPOSED IT (package I, 2026-11-17). `collie trick propose` in an
// agent's pane makes a proposal card of Collie's own (bridge/tricks/proposals.ts), tied to that session:
// its `replyTo` is the session's walky address (bridge/hill/service.ts `postAny`, the card's `tellOf`).
// This draws that card in the session's chat view, so the person answers it where they talk to the agent.
// One component for every harness.
//
// ── IT LOOKS LIKE THE CHAT, NOT LIKE THE HILL (Altan, 2026-11-17: "yes, good idea") ───────────────────
// The Hill's card in the chat read as half Hill, half chat, and it split the screen with a scroll box of its
// own. So here it is ONE card in the chat's own panel look (option-button.tsx `PromptPanel`, as a held
// permission draws), last in the thread and in the thread's own scroll, like a message: no first line of
// the Hill, no Back and Next, no box that scrolls inside the page. Top to bottom: who draws it (Collie), the
// title (the trick's id), the summary, then Collie's facts as the bridge wrote them (the honest line "runs
// as you", the rights, the warnings, "Asks you for", for a version what changed and the new rights), then
// "Read the code", a fold of 44 px that opens in place with one tap, its code wrapping and never scrolling
// sideways, then the answer: "Switch it on" (or "Use the new version") and the decline, with the option
// labels the bridge sent. A group of cards (a trick too large for one) is still one card here: its cards
// without code stand with the facts, and its cards of code stand one under the other in the fold, each
// under its "Card N" label, because the facts table and the seam lines name cards by number.
//
// ── THE GUARDS (security reads of package I, review 7 and the read of f1d386c21) ─────────────────────
//   WHAT THE CHECK IS: the fold was opened and the end of each card's code was on screen. It is not proof
//   that a person read the code, and no text here or on the card claims that.
//   * The yes is off until the END of every card's code was on screen: a 1 px mark after the last line
//     of each, watched by an IntersectionObserver whose root is the scroll box the card flows in (the
//     chat's list, or an agent view's own scroller), with the room the floating composer cards and the
//     model tag take off its bottom (`--tail-room`) cut from that root; and when the observer reports, the
//     mark is looked at again against the tail room as it is NOW (`inView`), and on every scroll and resize
//     after, so a mark under a floating card that came later does not count. A closed fold never counts:
//     the marks of the code exist only while the fold is open and has finished opening (`useOpenWatch`), so
//     a fold still sliding, or one sliding shut, sees nothing. Closing the fold again keeps what was seen; a
//     card with other code (a new digest or hash) is a new card here (`key`) and starts again from nothing
//     (lib/hill/group-opened.ts).
//   * Opening the fold brings its row to the top of the chat and stops the chat following its tail
//     (`onReadCode`, agent-chat.tsx), so the code grows below the row instead of the list pinning its end.
//     A fling or "jump to latest" can still bring the end on screen at once; the wait below covers that.
//   * And the card has stood still for a second (hooks/use-still.ts): the yes's place on the SCREEN and the
//     card's place in the scroll box's content. Any move of either starts the second again, whoever caused
//     it: the person's own scroll, a dock card that comes or goes, the keyboard, a row put in above, the
//     card growing or shrinking (the fold). A scroll's wait ends a second after the scroll stops. The second
//     also starts again when the check above turns true (it is part of the wait's key), so an end seen last
//     by a jump arms only a second later.
//   * A press whose touch began before the yes was ready is not a tap on it (`pressedReady`), and "Try
//     again" asks the same: ready, and a press that began on a ready card. It is offered only on the card
//     this answer was sent from; a changed card offers the yes again, never a retry.
//   * A proposal whose card holds no code (no code card, no code in its view) offers no yes: it cannot show
//     what the yes would approve.
//   * Nothing is focused or recommended: the card has no recommendation line and no default.
//   * A view the phone cannot draw whole (a node it does not know, a part that throws) offers no yes at
//     all, only the decline and one line that says why.
//   * The yes goes through the one answer route (`POST /api/hill/answer`, `useHillAnswer`: a request id and
//     a receipt) with the digest and the opened cards, so it approves exactly the code the card showed.
//
// "Not now" here closes the card in this session only (lib/hill/session-later.ts) and sends nothing:
// Settings, Tricks keeps it under "Waiting for your yes". There is no Dismiss.
//
// Only a NEW trick's or a new version's proposal (`ref.type === "proposal"`) shows here; no agent text
// can make one, because only the bridge's own code posts a card of Collie's own.

/** The proposal's decline intent (bridge/tricks/proposal-card.ts PROPOSAL_LATER and PROPOSAL_KEEP). */
export const PROPOSAL_DECLINE = "later";

/** Whether `decision` is a proposal card tied to the session at walky address `self`. */
export function isSessionProposal(decision: HillDecision, self: string): boolean {
  const { from } = decision;
  if (from.kind !== "collie" || from.ref?.type !== "proposal" || decision.replyTo === null) return false;
  // The FULL address, with the instance token: a new session in the same pane has a new token, so an old card never shows in it (security read of package I, point 3).
  return decision.replyTo === self;
}

/** The cards one session shows: open ones not closed here, and closed ones while this phone holds their answer. */
export function sessionProposals(open: readonly HillDecision[], closed: readonly HillDecision[], self: string, later: readonly string[]): HillDecision[] {
  return [...open.filter((d) => isSessionProposal(d, self) && !later.includes(d.id)), ...closed.filter((d) => isSessionProposal(d, self))].toSorted((a, b) => a.at - b.at);
}

/**
 * Whether a proposal card waits, unanswered, in the session at walky address `self`: the chat's jump-to-latest
 * arrow wears its dot for it while the person is scrolled up, as it does for new output (read of f1d386c21, point 5).
 */
export function useSessionProposalWaiting(self: string): boolean {
  const open = useHillOpen();
  const later = useSessionLater();
  return open.some((d) => isSessionProposal(d, self) && !later.includes(d.id));
}

/** One piece of a card's view: the card of the group it belongs to (1 for a single card), and its nodes. */
interface ApprovalPiece {
  card: number;
  view: View;
}

/** A card's view as the chat draws it: the facts open, the code in the fold. */
export interface ApprovalPieces {
  facts: ApprovalPiece[];
  code: ApprovalPiece[];
}

/**
 * The card's view in two parts: the facts, drawn open, and the code, drawn in the fold. A group's card with
 * code goes into the fold whole, in order; a group's card without code stands with the facts. A single
 * card's nodes are split: every node with code goes into the fold, every other node stands with the facts.
 */
export function approvalPieces(decision: HillDecision): ApprovalPieces {
  const { group, view } = decision;
  if (group !== undefined) {
    const facts: ApprovalPiece[] = [];
    const code: ApprovalPiece[] = [];
    group.parts.forEach((part, i) => (viewHasCode(part.view) ? code : facts).push({ card: i + 1, view: part.view }));
    return { facts, code };
  }
  if (view === undefined) return { facts: [], code: [] };
  const lines = view.filter((node) => viewHasCode([node]));
  const rest = view.filter((node) => !viewHasCode([node]));
  return { facts: rest.length > 0 ? [{ card: 1, view: rest }] : [], code: lines.length > 0 ? [{ card: 1, view: lines }] : [] };
}

/** A no-op: a card's view has no button, so nothing in it can tap. */
const NO_TAP = (): void => undefined;

/** A link in the view opens a web page in a new tab; anything else opens nothing. */
function openViewLink(target: LinkTarget): void {
  if (target.url === undefined || !isWebLink(target.url)) return;
  window.open(target.url, "_blank", "noopener,noreferrer");
}

/** The room the floating composer cards and the model tag take off the bottom of a chat scroller, in px. */
function tailRoomOf(box: HTMLElement | null): number {
  if (box === null) return 0;
  const room = Number.parseFloat(getComputedStyle(box).getPropertyValue("--tail-room"));
  return Number.isFinite(room) && room > 0 ? room : 0;
}

/** Whether the mark lies inside the window and, where it sits in a scroll box, inside that box above its tail room. */
function inView(el: Element, box: HTMLElement | null): boolean {
  const mark = el.getBoundingClientRect();
  if (!(mark.bottom > 0 && mark.top < window.innerHeight)) return false;
  if (box === null) return true;
  const frame = box.getBoundingClientRect();
  return mark.bottom > frame.top && mark.top < frame.bottom - tailRoomOf(box);
}

/**
 * The mark after the last line of one card's code, or of a card's facts: tells `onSeen(card)` once it was on
 * screen while `live.current` is true. The root is the scroll box the card flows in (or the screen when there
 * is none), less its tail room. The observer only says the mark crossed into that root; the mark counts once
 * it is also inside the box above the tail room as it is NOW (`inView`, read of f1d386c21 point 3), looked at
 * then and on every scroll and resize while the observer holds it as crossing. Where there is no
 * IntersectionObserver, every scroll and resize looks with `inView` alone.
 */
function EndMark({ card, live, onSeen }: { card: number; live: MutableRefObject<boolean>; onSeen: (card: number) => void }) {
  const end = useRef<HTMLDivElement>(null);
  const call = useRef(onSeen);
  useLayoutEffect(() => {
    call.current = onSeen;
  });
  useEffect(() => {
    const mark = end.current;
    if (mark === null) return;
    const tail: HTMLDivElement = mark;
    const box = scrollBoxOf(tail);
    const hasObserver = globalThis.IntersectionObserver !== undefined;
    // Whether the observer last said the mark is inside its root; with no observer, every look decides alone.
    let crossing = !hasObserver;
    let done = false;
    const stop = () => {
      done = true;
      window.removeEventListener("scroll", look, true);
      window.removeEventListener("resize", look);
    };
    function look(): void {
      // A mark a closing fold still holds sees nothing: only a fold open and settled counts.
      if (done || !crossing || !live.current || !inView(tail, box)) return;
      stop();
      observer?.disconnect();
      call.current(card);
    }
    const observer = hasObserver
      ? new IntersectionObserver(
          (entries) => {
            crossing = entries.some((entry) => entry.isIntersecting);
            look();
          },
          { root: box, rootMargin: `0px 0px -${String(tailRoomOf(box))}px 0px` },
        )
      : null;
    window.addEventListener("scroll", look, true);
    window.addEventListener("resize", look);
    if (observer === null) look();
    else observer.observe(tail);
    return () => {
      stop();
      observer?.disconnect();
    };
  }, [card, live]);
  return <div ref={end} aria-hidden data-slot="chat-approval-end" data-card={card} className="h-px" />;
}

/**
 * True once the fold is open AND has finished opening, false the moment it starts to close. The marks of the
 * code are drawn only then, so a fold still sliding open (its content clipped) never reports an end.
 */
function useOpenWatch(open: boolean): boolean {
  const reduced = usePrefersReducedMotion();
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!open) {
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), reduced ? 0 : COLLAPSE_MS + 32);
    return () => clearTimeout(timer);
  }, [open, reduced]);
  return open && settled;
}

/** Draws one fallback and says so: a part of the view threw while it drew. */
function Unshown({ onUnshown }: { onUnshown: () => void }) {
  useLayoutEffect(() => onUnshown(), [onUnshown]);
  return <Placeholder />;
}

/** One piece of the view, with the renderer the Hill's card uses. Reports a node it could not draw. */
function Piece({ decisionId, view, ctx, onUnshown }: { decisionId: string; view: View; ctx: RenderCtx; onUnshown: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  // A node this phone does not know draws the placeholder: the card does not show everything, so no yes.
  useLayoutEffect(() => {
    if (box.current?.querySelector('[data-trick-node="placeholder"]') != null) onUnshown();
  });
  return (
    <div ref={box} className="font-content min-w-0">
      <TrickBoundary fallback="placeholder" fallbackNode={<Unshown onUnshown={onUnshown} />} resetKey={decisionId}>
        {renderView(view, ctx)}
      </TrickBoundary>
    </div>
  );
}

/** What the chat card needs from its caller: where its answer is, how to send one, how to close it here. */
export interface ChatApprovalCardProps {
  decision: HillDecision;
  answer: HillAnswerState;
  onSend: (intent: string, text: string | null, group?: HillGroupAnswer) => void;
  /** The decline: closes the card in this session, sends nothing. */
  onLater: () => void;
  /** Called with the fold's row as the fold opens: the chat brings it to the top and stops following its tail. */
  onReadCode?: (row: HTMLElement) => void;
  mediaSource?: HillMediaSource;
}

/** The key a card's marks and its fold are kept under: another digest is another card. */
function cardKey(decision: HillDecision): string {
  return `${decision.id}:${decision.group?.digest ?? singleCodeCard(decision)?.key ?? ""}`;
}

/**
 * A trick's proposal (or a new version's) as one card in the chat. A card with other code is drawn as a new
 * card, so nothing seen of the old code counts and its fold starts closed.
 */
export function ChatApprovalCard(props: ChatApprovalCardProps) {
  return <ApprovalBody key={cardKey(props.decision)} {...props} />;
}

function ApprovalBody({ decision, answer, onSend, onLater, onReadCode, mediaSource = hillMediaSource }: ChatApprovalCardProps) {
  useLocale();
  const foldId = useId();
  const row = useRef<HTMLButtonElement>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [within, setWithin] = useState<HTMLElement | null>(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const [unshown, setUnshown] = useState(false);
  const noteUnshown = useCallback(() => setUnshown(true), []);
  const watching = useOpenWatch(codeOpen);
  // Read by the marks' callbacks: a fold sliding shut still holds its marks for a moment, and they must see nothing.
  const watchingRef = useRef(false);
  const alwaysLive = useRef(true);
  useLayoutEffect(() => {
    watchingRef.current = watching;
  }, [watching]);

  const group = decision.group;
  const single = singleCodeCard(decision);
  const { opened, mark } = useOpenedCards(decision.id, group?.digest ?? single?.key ?? "");
  const needed = group !== undefined ? group.parts.map((_, i) => i + 1) : single !== null ? [1] : [];
  const unopened = needed.filter((card) => !opened.has(card));
  const pieces = useMemo(() => approvalPieces(decision), [decision]);
  const codeCards = new Set(pieces.code.map((piece) => piece.card));
  const decline = trickCardDecline(decision) ?? PROPOSAL_DECLINE;
  const yesOptions = decision.options.filter((option) => option.intent !== decline);
  const declineOption = decision.options.find((option) => option.intent === decline);
  const locked = lockedBy(answer);
  // A proposal whose card holds no code cannot show what its yes would approve: no yes (read of f1d386c21, point 5).
  const noCode = group === undefined && single === null;
  const blocked = unshown || noCode;
  // Whether this card, as drawn now, sent the answer that is on screen: only then is Try again offered.
  const [sentHere, setSentHere] = useState(false);

  // The scroll box the card flows in (the chat's list), once the card is in the page.
  useLayoutEffect(() => {
    if (root !== null) setWithin(scrollBoxOf(root));
  }, [root]);
  // The yes's place on the screen and the card's place in the scroll box's content: any move waits again. The
  // check below is part of the key, so the second starts again when it turns true (read of f1d386c21, point 2).
  const [optionsBox, setOptionsBox] = useState<HTMLDivElement | null>(null);
  // The check: the fold was opened and every card's end was on screen. Not proof that anyone read the code.
  const endsSeen = unopened.length === 0;
  const still = useStill(root, `${cardKey(decision)}:${endsSeen ? "seen" : "unseen"}`, within, optionsBox);
  const ready = !locked && !blocked && endsSeen && still;
  const pressedReady = useRef(false);
  // A touch that began before the yes was ready is not a tap on it, whichever condition was missing.
  useEffect(() => {
    pressedReady.current = false;
  }, [ready]);

  const groupAnswer: HillGroupAnswer | undefined =
    group !== undefined ? { digest: group.digest, opened: [...opened].toSorted((a, b) => a - b) } : single !== null && opened.has(1) ? { digest: single.digest, opened: [1] } : undefined;

  const pictures = useMemo(() => viewPictures(decision.id, decision.media, mediaSource), [decision.id, decision.media, mediaSource]);
  const ctx: RenderCtx = { partKey: `hill/${decision.id}`, stale: false, onTap: NO_TAP, onLink: openViewLink, hostOf: linkHost, wrap: true, pictures };

  function toggleCode() {
    if (!codeOpen && row.current !== null) onReadCode?.(row.current);
    setCodeOpen((open) => !open);
  }

  function choose(option: HillOption, event: MouseEvent<HTMLButtonElement>) {
    if (option.intent === decline) {
      if (!locked) onLater();
      return;
    }
    if (!ready) return;
    // A keyboard or assistive click has no touch (detail 0); a pointer's press must have begun on a ready yes.
    if (event.detail > 0 && !pressedReady.current) return;
    setSentHere(true);
    if (groupAnswer === undefined) onSend(option.intent, null);
    else onSend(option.intent, null, groupAnswer);
  }

  // Try again holds the yes's guards: ready, and a press that began on a ready card (read of f1d386c21, point 4).
  function retry() {
    if (answer.phase !== "failed" || !sentHere || !ready || !pressedReady.current) return;
    if (groupAnswer === undefined) onSend(answer.intent, answer.text);
    else onSend(answer.intent, answer.text, groupAnswer);
  }

  const sendingIntent = answer.phase === "sending" ? answer.intent : null;
  const hint = blocked ? null : endsSeen ? null : codeOpen ? "hill.single.readEnd" : "hill.chat.openCode";

  return (
    <div ref={setRoot} data-slot="chat-approval" data-id={decision.id} data-ready={ready ? "" : undefined}>
      <PromptPanel ariaLabel={t("hill.card.aria", { title: decision.title })}>
        <div className="flex flex-col gap-3 px-1.5 pt-1 pb-0.5">
          <OptionGroupCaption>{decision.from.label}</OptionGroupCaption>
          <div className="flex flex-col gap-1">
            <h3 data-slot="chat-approval-title" className="font-content break-words text-base font-semibold leading-snug text-balance">
              {decision.title}
            </h3>
            <p data-slot="chat-approval-summary" className="font-content whitespace-pre-wrap break-words text-sm leading-normal text-foreground">
              {decision.summary}
            </p>
          </div>

          {pieces.facts.map((piece) => (
            <div key={`facts:${String(piece.card)}`} data-slot="chat-approval-facts" data-card={piece.card} className="flex min-w-0 flex-col">
              <Piece decisionId={decision.id} view={piece.view} ctx={ctx} onUnshown={noteUnshown} />
              {/* A group's card of facts alone has its end here, open; a single card's end is the end of its code. */}
              {!codeCards.has(piece.card) && needed.includes(piece.card) && <EndMark card={piece.card} live={alwaysLive} onSeen={mark} />}
            </div>
          ))}

          {pieces.code.length > 0 && (
            <div data-slot="chat-approval-code-box" className="rounded-lg border border-border bg-background">
              <button
                ref={row}
                type="button"
                aria-expanded={codeOpen}
                aria-controls={codeOpen ? foldId : undefined}
                data-slot="chat-approval-code-toggle"
                onClick={toggleCode}
                className="flex min-h-11 w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span className="min-w-0 flex-1">{t("settings.tricks.about.code.title")}</span>
                <Icon name="expand" aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", codeOpen && "rotate-180")} />
              </button>
              <FoldPanel id={foldId} open={codeOpen} data-slot="chat-approval-code" className="flex min-w-0 flex-col gap-4 border-t border-border px-3 py-3">
                {pieces.code.map((piece) => (
                  <section key={`code:${String(piece.card)}`} data-slot="chat-approval-section" data-card={piece.card} className="flex min-w-0 flex-col gap-2">
                    {group !== undefined && <p className="text-xs font-medium text-muted-foreground tabular-nums">{t("hill.group.card", { index: piece.card })}</p>}
                    <Piece decisionId={decision.id} view={piece.view} ctx={ctx} onUnshown={noteUnshown} />
                    {watching && <EndMark card={piece.card} live={watchingRef} onSeen={mark} />}
                  </section>
                ))}
              </FoldPanel>
            </div>
          )}

          {locked ? (
            <AnswerStatus decision={decision} answer={answer} slot="chat-approval-status" />
          ) : (
            <div className="flex flex-col gap-2">
              {blocked && (
                <p data-slot="chat-approval-unshown" className="font-content text-xs text-muted-foreground">
                  {t("hill.chat.unshown")}
                </p>
              )}
              {hint !== null && (
                <p data-slot="chat-approval-wait" className="font-content text-xs text-muted-foreground">
                  {t(hint)}
                </p>
              )}
              <div
                ref={setOptionsBox}
                data-slot="chat-approval-options"
                className="flex flex-col gap-1.5"
                onPointerDownCapture={() => {
                  pressedReady.current = ready;
                }}
              >
                {!blocked &&
                  yesOptions.map((option, i) => (
                    <OptionButton
                      key={`${String(i)}:${option.intent}`}
                      data-slot="chat-approval-option"
                      data-intent={option.intent}
                      tone={sendingIntent === option.intent ? "busy" : "default"}
                      keyLabel={i + 1}
                      label={option.label}
                      description={option.detail}
                      disabled={!ready}
                      onClick={(event) => choose(option, event)}
                      className="min-h-11 items-center px-3"
                      trailing={sendingIntent === option.intent ? <Icon name="busy" aria-hidden className="size-3.5 animate-spin text-muted-foreground" /> : undefined}
                    />
                  ))}
                {declineOption !== undefined && (
                  <OptionButton
                    data-slot="chat-approval-option"
                    data-intent={declineOption.intent}
                    keyLabel={blocked ? 1 : yesOptions.length + 1}
                    label={declineOption.label}
                    onClick={(event) => choose(declineOption, event)}
                    className="min-h-11 items-center px-3"
                  />
                )}
                {/* Inside the options box, so a press on Try again is a press the box saw begin. A changed card,
                    or one not ready, offers no Try again: the yes is the way to send again. */}
                <AnswerStatus decision={decision} answer={answer} onRetry={sentHere && ready ? retry : undefined} slot="chat-approval-status" />
              </div>
            </div>
          )}
        </div>
      </PromptPanel>
    </div>
  );
}

/** One card wired to the bridge: an answered card stays with what its answer did while this phone holds the receipt. */
function SessionTrickCard({ decision, onReadCode }: { decision: HillDecision; onReadCode?: (row: HTMLElement) => void }) {
  const { state, send } = useHillAnswer(decision.id);
  const held = useHillAnswerHeld(decision.id);
  if (decision.state !== "open" && held === null) return null;
  return (
    <div data-slot="session-trick-card" data-card={decision.id} className="my-2">
      <ChatApprovalCard
        decision={decision}
        answer={state}
        onSend={(intent, text, group) => void send(intent, text, group)}
        onLater={() => closeInSession(decision.id)}
        onReadCode={onReadCode}
      />
    </div>
  );
}

/** The proposal cards of the session at walky address `self`, oldest first, last in the chat. Nothing while none waits. */
export function SessionTrickCards({ self, onReadCode }: { self: string; onReadCode?: (row: HTMLElement) => void }) {
  const open = useHillOpen();
  const closed = useHillClosed();
  const later = useSessionLater();
  const cards = sessionProposals(open, closed, self, later);
  if (cards.length === 0) return null;
  return (
    <>
      {cards.map((decision) => (
        <SessionTrickCard key={decision.id} decision={decision} onReadCode={onReadCode} />
      ))}
    </>
  );
}
