import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { lockedBy, trickAnswerMarks } from "@/components/decision-card";
import { hillMediaSource, viewPictures, type HillMediaSource } from "@/components/hill-media";
import { HoldToApprove, holdLabel } from "@/components/hold-to-approve";
import { Icon } from "@/components/icons/icon";
import { OptionButton, OptionGroupCaption, PromptPanel } from "@/components/option-button";
import { TrickApprovalLine } from "@/components/trick-approval-line";
import { FoldPanel } from "@/components/ui/fold-toggle";
import { useHillAnswer, type HillAnswerState } from "@/hooks/use-hill-answer";
import { useLocale } from "@/hooks/use-locale";
import { singleCodeCard, trickCardDecline, trickYesAnswer, viewHasCode } from "@/lib/hill/code-card";
import { linkHost, isWebLink } from "@/lib/hill/reader";
import { useAnswerRowDrawn } from "@/lib/hill/answer-rows";
import { closeInSession, useSessionLater } from "@/lib/hill/session-later";
import { useHillAnswerHeld, useHillClosed, useHillOpen } from "@/lib/hill/store";
import type { HillDecision, HillGroupAnswer, HillOption } from "@/lib/hill/wire";
import { t } from "@/lib/i18n";
import { TrickBoundary } from "@/lib/tricks/boundary";
import { Placeholder, renderView, type LinkTarget, type RenderCtx } from "@/lib/tricks/render";
import type { View } from "@/lib/tricks/schema";
import { cn } from "@/lib/utils";
import { FOCUS_RING, HOVER_FILL } from "@/components/ui/button";

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
// ── ITS OWN SURFACE (Altan, 2026-11-17) ───────────────────────────────────────────────────────────────
// While the card WAITS for the person it wears a uniform border on all four sides and a low tint of the "needs you"
// red-orange (`--status-blocked`, the tint an agent card that needs you wears), never a left accent. The first
// build's amber tint read as the person's own message bubbles and was dropped.
//
// ── ANSWERED, IT IS ONE LINE (Altan, 2026-11-18) ──────────────────────────────────────────────────────
// A card whose answer landed (see {@link approvalTone}) is no card any more: it collapses into the one small line of
// components/trick-approval-line.tsx, the tricks glyph, "Collie tricks", the trick's name and what happened, which
// flows in the conversation like a message so the person scrolls past it. The card is tall only while it asks.
//
// ── THE GUARDS (ADR 0156, the operator's decision of 2026-11-17) ─────────────────────────────────────
//   * The yes is a HOLD of 1.5 seconds (components/hold-to-approve.tsx): the finger stays down while a
//     fill grows across the button, and the yes goes out once at the end. A lift, a move off the button,
//     the page hidden, or a changed card ends the hold with no yes; the chat's own scroll does not, and the
//     chat does not follow its tail while a finger holds (lib/hold-flag.ts). A key
//     presses twice. A hold starts only with a press on the rendered, enabled button, so a touch that began
//     before the yes was there is no yes.
//   * Reading is offered, not required: "Read the code" opens in place and brings its row to the top of the
//     chat (`onReadCode`, agent-chat.tsx), and the yes does not wait for it.
//   * A proposal whose card holds no code (no code card, no code in its view) offers no yes: it cannot show
//     what the yes would approve.
//   * Nothing is focused or recommended: the card has no recommendation line and no default.
//   * A view the phone cannot draw whole (a node it does not know, a part that throws) offers no yes at
//     all, only the decline and one line that says why.
//   * The yes goes through the one answer route (`POST /api/hill/answer`, `useHillAnswer`: a request id and
//     a receipt) with the digest of the code the card showed, so it approves exactly that code. A changed
//     card is drawn as a new card. A yes that got no answer offers no Try again: the hold is the way to
//     send again.
//
// "Not now" here closes the card in this session only (lib/hill/session-later.ts) and sends nothing:
// Settings, Tricks and the Hill keeps it under "Waiting for your yes". There is no Dismiss.
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

/** Where a trick's approval card stands, for its colour: waiting for the person, approved, or declined. */
export type ApprovalTone = "waiting" | "approved" | "declined";

/**
 * The card's standing: an `ok` receipt for the decline or a Dismiss is declined, for any other option approved;
 * a card dismissed elsewhere is declined; everything else (no answer yet, one in flight, one refused or lost)
 * still waits for the person.
 */
export function approvalTone(decision: HillDecision, answer: HillAnswerState): ApprovalTone {
  if (answer.phase === "answered" && answer.receipt.code === "ok") {
    const decline = trickCardDecline(decision) ?? PROPOSAL_DECLINE;
    return answer.intent === decline || answer.intent === "dismiss" ? "declined" : "approved";
  }
  if (decision.state === "dismissed") return "declined";
  return "waiting";
}

/** The panel's surface while the card waits: a uniform border and a low tint of the "needs you" hue. */
const WAITING_SURFACE = "border-status-blocked/50 bg-status-blocked/8";

/** The key a card and its fold are kept under: another digest is another card. */
function cardKey(decision: HillDecision): string {
  return `${decision.id}:${decision.group?.digest ?? singleCodeCard(decision)?.key ?? ""}`;
}

/**
 * A trick's proposal (or a new version's) as one card in the chat. A card with other code is drawn as a new
 * card, so a hold on the old one ends and its fold starts closed.
 */
export function ChatApprovalCard(props: ChatApprovalCardProps) {
  const tone = approvalTone(props.decision, props.answer);
  // An answered card has nothing left to ask: it collapses into one line that flows with the conversation (Altan, 2026-11-18).
  if (tone !== "waiting") return <TrickApprovalLine decision={props.decision} approved={tone === "approved"} />;
  return <ApprovalBody key={cardKey(props.decision)} {...props} />;
}

function ApprovalBody({ decision, answer, onSend, onLater, onReadCode, mediaSource = hillMediaSource }: ChatApprovalCardProps) {
  useLocale();
  const foldId = useId();
  const row = useRef<HTMLButtonElement>(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const [unshown, setUnshown] = useState(false);
  const noteUnshown = useCallback(() => setUnshown(true), []);

  const group = decision.group;
  const single = singleCodeCard(decision);
  const pieces = useMemo(() => approvalPieces(decision), [decision]);
  const decline = trickCardDecline(decision) ?? PROPOSAL_DECLINE;
  const yesOptions = decision.options.filter((option) => option.intent !== decline);
  const declineOption = decision.options.find((option) => option.intent === decline);
  const locked = lockedBy(answer);
  // A proposal whose card holds no code cannot show what its yes would approve: no yes (read of f1d386c21, point 5).
  const noCode = group === undefined && single === null;
  const blocked = unshown || noCode;
  const ready = !locked && !blocked;
  // The yes names the digest of the code this card showed, so it approves exactly that code (plus the legacy `opened`).
  const groupAnswer = trickYesAnswer(decision);

  const pictures = useMemo(() => viewPictures(decision.id, decision.media, mediaSource), [decision.id, decision.media, mediaSource]);
  const ctx: RenderCtx = { partKey: `hill/${decision.id}`, stale: false, onTap: NO_TAP, onLink: openViewLink, hostOf: linkHost, wrap: true, pictures };

  function toggleCode() {
    if (!codeOpen && row.current !== null) onReadCode?.(row.current);
    setCodeOpen((open) => !open);
  }

  function approve(option: HillOption) {
    if (!ready) return;
    if (groupAnswer === undefined) onSend(option.intent, null);
    else onSend(option.intent, null, groupAnswer);
  }

  const sendingIntent = answer.phase === "sending" ? answer.intent : null;
  // The option that was the answer, once it landed: it keeps its place with a check mark.
  const marks = trickAnswerMarks(answer);
  const chosenIntent = marks.chosen;

  return (
    <div data-slot="chat-approval" data-id={decision.id} data-ready={ready ? "" : undefined}>
      <PromptPanel ariaLabel={t("hill.card.aria", { title: decision.title })} className={WAITING_SURFACE}>
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
                className={cn("flex min-h-11 w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm font-medium", FOCUS_RING, HOVER_FILL)}
              >
                <span className="min-w-0 flex-1">{t("settings.tricks.about.code.title")}</span>
                <Icon name="expand" aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", codeOpen && "rotate-180")} />
              </button>
              <FoldPanel id={foldId} open={codeOpen} data-slot="chat-approval-code" className="flex min-w-0 flex-col gap-4 border-t border-border px-3 py-3">
                {pieces.code.map((piece) => (
                  <section key={`code:${String(piece.card)}`} data-slot="chat-approval-section" data-card={piece.card} className="flex min-w-0 flex-col gap-2">
                    {group !== undefined && <p className="text-xs font-medium text-muted-foreground tabular-nums">{t("hill.group.card", { index: piece.card })}</p>}
                    <Piece decisionId={decision.id} view={piece.view} ctx={ctx} onUnshown={noteUnshown} />
                  </section>
                ))}
              </FoldPanel>
            </div>
          )}

          {/* THE OPTIONS STAY while the answer is in flight or did not land (Altan, 2026-11-17 and 2026-11-18, "no new
              boxes"): no row, line or box comes or goes. The option in flight shows a spinner (a check mark for a
              yes with no word back), every other one is disabled. A yes that did not land says "Not sent. Hold
              again" in its own label, sized for those words from the first frame; the reason goes to a screen
              reader only. Once the answer landed the whole card is one line (trick-approval-line.tsx). */}
          <div className="flex flex-col gap-2">
            {blocked && (
              <p data-slot="chat-approval-unshown" className="font-content text-xs text-muted-foreground">
                {t("hill.chat.unshown")}
              </p>
            )}
            <div data-slot="chat-approval-options" className="flex flex-col gap-1.5">
              {!blocked &&
                yesOptions.map((option, i) => (
                  <HoldToApprove
                    key={`${String(i)}:${option.intent}`}
                    data-slot="chat-approval-option"
                    data-intent={option.intent}
                    keyLabel={i + 1}
                    label={holdLabel(decision, option)}
                    description={option.detail}
                    enabled={ready}
                    busy={sendingIntent === option.intent}
                    chosen={chosenIntent === option.intent}
                    notSent={marks.notSent === option.intent}
                    problem={marks.problem}
                    resetKey={cardKey(decision)}
                    onApprove={() => approve(option)}
                    className="min-h-11 items-center px-3"
                  />
                ))}
              {declineOption !== undefined && (
                <OptionButton
                  data-slot="chat-approval-option"
                  data-intent={declineOption.intent}
                  data-chosen={chosenIntent === declineOption.intent ? "" : undefined}
                  tone={chosenIntent === declineOption.intent ? "busy" : "default"}
                  keyLabel={blocked ? 1 : yesOptions.length + 1}
                  label={declineOption.label}
                  disabled={locked}
                  onClick={() => {
                    if (!locked) onLater();
                  }}
                  className="min-h-11 items-center px-3"
                  trailing={
                    // One 16px slot, as on the yes, so the mark arriving moves no label.
                    <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
                      {chosenIntent === declineOption.intent && <Icon name="done" data-slot="option-chosen-mark" className="size-4 text-primary" />}
                    </span>
                  }
                />
              )}
            </div>
          </div>
        </div>
      </PromptPanel>
    </div>
  );
}

/** One card wired to the bridge: an answered card stays, as its one line, while this phone holds the receipt. */
function SessionTrickCard({ decision, onReadCode }: { decision: HillDecision; onReadCode?: (row: HTMLElement) => void }) {
  const { state, send } = useHillAnswer(decision.id);
  const held = useHillAnswerHeld(decision.id);
  // The answer reached the transcript as its own row (components/trick-answer-row.tsx): that row says what this line says.
  const rowDrawn = useAnswerRowDrawn(decision.id);
  if (decision.state !== "open" && held === null) return null;
  if (decision.state !== "open" && rowDrawn) return null;
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
