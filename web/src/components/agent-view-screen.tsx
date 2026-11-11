import { useCallback, useMemo, useState, type ReactNode } from "react";

import { ViewEarlier, ViewPendingBlock, ViewReceiptCard, ViewSentLine } from "@/components/agent-view-blocks";
import { ViewChoiceBlock, ViewChoiceDone } from "@/components/agent-view-choice";
import { useViewLinkText } from "@/components/agent-view-links";
import { BrandMark } from "@/components/brand-mark";
import { UserTurn } from "@/components/chat-cards";
import type { ViewSendResult, ViewTap } from "@/components/composer";
import { HillImageStrip, viewPictures, type HillMediaSource } from "@/components/hill-media";
import { MarkdownText } from "@/components/markdown-text";
import { StatusDot } from "@/components/status-badge";
import { KeyedFlow, type FlowItem } from "@/components/ui/keyed-flow";
import { OneOf } from "@/components/ui/one-of";
import { PresenceList } from "@/components/ui/presence";
import { useLocale } from "@/hooks/use-locale";
import {
  blockControl,
  choiceControl,
  isUnanswered,
  optionControl,
  pickedOption,
  pickReceiptOf,
  pressedNode,
  previewRefs,
  renderedControl,
  requestNotes,
  screenControl,
  splitScreen,
  textAnswerAfter,
  viewRequestOf,
  viewStateOf,
  viewStatusOf,
  withTrueLinks,
  type ScreenBlock,
  type ViewRequest,
  type ViewStatus,
} from "@/lib/agent-view/reader";
import { useAgentViewLive } from "@/lib/agent-view/store";
import { viewMediaPath, viewTapWords, type ViewDrawing, type ViewMedia, type ViewNote, type ViewScreen, type ViewSent } from "@/lib/agent-view/wire";
import { linkHost } from "@/lib/hill/reader";
import { t } from "@/lib/i18n";
import { TrickBoundary } from "@/lib/tricks/boundary";
import { useBridgeNow } from "@/lib/tricks/clock";
import { groupHasHead, viewImageRefs } from "@/lib/tricks/layout";
import { renderView, type LinkTarget, type RenderCtx, type ViewPictures } from "@/lib/tricks/render";
import type { TapValue } from "@/lib/tricks/schema";
import type { TapState } from "@/lib/tricks/store";
import { trickTimeText } from "@/lib/tricks/time";
import type { TranscriptEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

// AN AGENT VIEW: the third body of an agent session, beside Terminal and Chat, that the session's own
// agent draws for a trick (lib/agent-view/wire.ts). The agent answers a request by drawing ONE screen,
// block by block (`collie trick view <id> show`, `set`, `pending`), and this body shows that screen. It
// swaps in for the Chat stream or the mirror inside the pane's reading box (components/agent-chat.tsx);
// the Header, the Belt, the composer and the Dock with its cards stay where they are, so a view never
// hides a prompt card.
//
// COLLIE'S BAND (agent views SECURITY rule 8). Above the screen, outside the area that scrolls, a band
// Collie owns: Collie's mark, the trick's name and "Drawn by this session's agent", and under them one
// line of Collie's own: why the buttons wait (a question in the session, a screen from an earlier
// conversation, a screen that changed under a tap, the agent at work), else how old the screen is. It
// stands on the page colour with a rule under it (DESIGN.md §4), and no node an agent draws takes that
// look: a node cannot draw Collie's mark, cannot sit outside the scroller, and its own nodes are cards,
// rows and lines. The second line always holds its height, so a notice arriving moves nothing.
//
// Top to bottom under the band: the operator's own request (the Chat look of a person's turn, four
// lines at most, a tap opens it; or, for a pick or a tap, the receipt card) with ONE status line under
// it and, once the bridge answered, the exact line it typed under "Sent to this session" (rule 4); while
// the agent works, the notes of its `start` calls; then the blocks the agent drew FOR THIS REQUEST, and
// last the blocks it drew before, folded under "Earlier screen". Which block is fresh and where the
// request stands is lib/agent-view/reader.ts's call.
//
// NO GREY WASH. Nothing is dimmed while the agent works or after a send: an old screen folds away (and
// comes back when the send failed), it never fades in place.
//
// A TAP SENDS A MESSAGE IN THE PERSON'S NAME, and the BRIDGE writes it (rules 2, 3). A button's tap goes
// to `onTap` with the screen's rev and the control path over the whole screen; the composer posts it with
// no text, and the bridge builds the line from its own stored screen. A button shows its label alone (an
// agent view's button carries no value). Buttons wait while a send is in flight, while a turn runs (rule
// 5), while a question waits in the session (the person's typing answers it, not the screen), and on a
// screen from an earlier conversation (rule 6). A tap the bridge refused as `stale_view` reads the screen
// again (`onStale`) and is never sent again on its own. A `confirm` arms in Collie's words. A tap the
// bridge confirmed is a pick, filed under its block: the button stays marked while its block holds the
// same content, in the Earlier fold too.
//
// LINKS SHOW THEIR HOST (N1), as a Decision's view does, and a link's words that read as an address are
// its own address. Free text carries Chat's links (components/agent-view-links.tsx).

export interface AgentViewScreenProps {
  /** The trick's name, whole: the band names it. */
  name: string;
  /** The session's walky address: the part key the renderer files taps under. */
  session: string;
  /** The screen the agent drew last, or undefined before the first. */
  view: ViewScreen | undefined;
  /** The latest send from this view, as the composer told it, or undefined (then the bridge's sent lines and the chat stand in). */
  request?: ViewRequest | undefined;
  /** The lines the bridge typed for this view, newest last. */
  sent?: readonly ViewSent[] | undefined;
  /** The agent's `start`, or undefined. */
  drawing?: ViewDrawing | undefined;
  /** The controls the operator picked on this screen, each filed under its block. */
  pressed?: readonly string[] | undefined;
  /** A tap the bridge confirmed: the control to mark. */
  onPressed?: ((control: string) => void) | undefined;
  /** The agent's turn runs: the pane's own status, the signal Chat reads. Buttons wait. */
  working: boolean;
  /** A question, a dialog or an answer box shows in the session: buttons wait, typing answers the question. */
  question?: boolean | undefined;
  /** The screen was drawn in an earlier conversation: old, no live buttons. */
  stale?: boolean | undefined;
  /** The bridge refused the last tap because the screen changed: the band says so, once. */
  changed?: boolean | undefined;
  /** The Chat window's turns, as the session screen already holds them. */
  entries: readonly TranscriptEntry[];
  /** A tap may send: a live pane on a device that may write. False: every button waits. */
  canAct: boolean;
  /** Send one tap through the composer: the bridge builds the line. Answers how it ended. */
  onTap: (tap: ViewTap) => Promise<ViewSendResult>;
  /** The bridge refused a tap as `stale_view`: read the screen again. */
  onStale?: (() => void) | undefined;
  /** A row's `href` or a link was tapped. */
  onLink: (target: LinkTarget) => void;
  /** Pin the clock (epoch ms on the bridge's clock), for a test. */
  now?: number;
}

/** Where a view's picture bytes are: the set id stands where the hill's source takes a decision id. */
export const viewMediaSource: HillMediaSource = (set, media) => viewMediaPath(set, media.id);

const NO_CONTROLS: readonly string[] = [];
const NO_SENT: readonly ViewSent[] = [];

/** A tap state that makes every button wait, with no spinner on any. */
const ALL_WAIT: TapState = { phase: "busy", rid: "agent-view", control: "", intent: "" };

/** Longer than this (or more than four lines) and the request is clamped to four lines; a tap opens it. */
const REQUEST_CLAMP_CHARS = 140;

/** The gap between two blocks of the screen, in px: the renderer's own gap between top-level nodes. */
const BLOCK_GAP = 8;

/**
 * Collie's words on an armed `confirm` button. A button in a bar is a third of the screen wide, so the
 * words are short; the button's label, which the person just tapped, is what the second tap sends.
 */
function armedLabel(): string {
  return t("view.armed.short");
}

/**
 * What the screen's container does to the renderer's own nodes, from this side (render.tsx is the
 * tricks'): a `line` wraps instead of scrolling sideways and takes the height its words need, so no
 * sentence is ever cut at the right edge; a pressed button is filled, which the renderer marks with
 * `aria-pressed` only; and an armed button (`data-armed`, which only the renderer sets, never an agent)
 * takes Collie's armed edge, so the armed state is Collie's look and not the agent's label alone.
 */
export const VIEW_SCREEN_CLASS = cn(
  "[&_[data-trick-node=line]]:h-auto!",
  "[&_[data-trick-node=line]_span]:whitespace-pre-wrap [&_[data-trick-node=line]_span]:break-words",
  "[&_button[aria-pressed=true]]:border-primary [&_button[aria-pressed=true]]:bg-primary [&_button[aria-pressed=true]]:text-primary-foreground",
  "[&_button[data-armed]]:border-status-blocked",
);

function statusWords(status: ViewStatus, clock: number): string {
  switch (status.kind) {
    case "sending":
      return t("view.request.sending");
    case "notSent":
      return status.reason === null ? t("view.request.notSent") : t("view.request.notSentWhy", { reason: status.reason });
    case "sent":
      return t("view.request.sent");
    case "working":
      return t("view.request.working");
    case "drawing":
      return t("view.request.drawing");
    case "answered": {
      const age = trickTimeText(status.at, "ago", clock);
      return age === null ? t("view.request.answered") : t("view.request.answeredAt", { time: age });
    }
  }
}

/** The status kinds of a request still in work: the line is in the foreground, with the live mark. */
function isLiveStatus(status: ViewStatus | null): boolean {
  return status?.kind === "sent" || status?.kind === "working" || status?.kind === "drawing";
}

/** Why the band's second line speaks, most pressing first; null: it says how old the screen is. */
export type BandLine = "question" | "old" | "changed" | "working";

/** The band's second line, from the view's facts. */
export function bandLineOf({ question, stale, changed, working }: { question: boolean; stale: boolean; changed: boolean; working: boolean }): BandLine | null {
  if (question) return "question";
  if (stale) return "old";
  if (changed) return "changed";
  if (working) return "working";
  return null;
}

const BAND_WORDS = {
  question: "view.band.question",
  old: "view.band.old",
  changed: "view.band.changed",
  working: "view.band.working",
} as const;

/**
 * COLLIE'S BAND over an agent view (see the header): the mark, the trick's name and "Drawn by this
 * session's agent", and one line of Collie's under them. Exported for the playground.
 */
export function ViewBand({ name, line, age }: { name: string; line: BandLine | null; age: string | null }) {
  useLocale();
  return (
    <header data-slot="view-band" data-line={line ?? undefined} className="shrink-0 border-b border-rule bg-background px-4 py-2">
      <p className="flex min-w-0 items-center gap-2 text-sm">
        <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
          <BrandMark size={16} weight="header" state="rest" />
        </span>
        <span data-slot="view-band-name" className="min-w-0 shrink truncate font-semibold">
          {name}
        </span>
        <span className="min-w-0 truncate text-muted-foreground">{t("view.band.by")}</span>
      </p>
      <div data-slot="view-band-line" role="status" className="mt-0.5 flex min-h-5 min-w-0 items-start pl-6 text-xs">
        <OneOf
          active={line ?? "age"}
          className="min-w-0 justify-items-start"
          options={[
            { key: "age", node: <span className="truncate text-muted-foreground tabular-nums">{age ?? ""}</span> },
            {
              key: "working",
              node: (
                <span className="inline-flex min-w-0 items-center gap-2 font-medium text-foreground">
                  <StatusDot status="working" live className="size-2.5" />
                  <span className="min-w-0 break-words">{t(BAND_WORDS.working)}</span>
                </span>
              ),
            },
            ...(["question", "old", "changed"] as const).map((key) => ({
              key,
              node: <span className={cn("min-w-0 break-words", key === "question" ? "font-medium text-foreground" : "text-muted-foreground")}>{t(BAND_WORDS[key])}</span>,
            })),
          ]}
        />
      </div>
    </header>
  );
}

/**
 * The one line that says where the request stands, and under it, while the agent works, the notes of
 * its `start` calls for this request (newest last, the older ones muted), each arriving through the
 * presence motion. One fixed line: the words change, nothing under it moves.
 */
function ViewProgress({ status, notes, clock }: { status: ViewStatus | null; notes: readonly ViewNote[]; clock: number }) {
  const live = isLiveStatus(status);
  const linkText = useViewLinkText();
  return (
    <div data-slot="view-progress" className="mt-1 min-w-0">
      <p data-slot="view-status" data-kind={status?.kind} role="status" className={cn("flex h-6 min-w-0 items-center gap-2 text-sm", live ? "text-foreground" : "text-muted-foreground")}>
        {live && <StatusDot status="working" live className="size-2.5" />}
        <span className={cn("truncate", live && "font-medium")}>{status === null ? "" : statusWords(status, clock)}</span>
      </p>
      <ul data-slot="view-notes" className="flex min-w-0 flex-col pl-[18px]">
        <PresenceList itemAs="li">
          {(live ? notes : []).map((note, i, all) => (
            <span key={`${note.at}:${note.note}`} data-slot="view-note" className={cn("block truncate text-sm", i === all.length - 1 ? "text-foreground" : "text-muted-foreground")}>
              {linkText(note.note)}
            </span>
          ))}
        </PresenceList>
      </ul>
    </div>
  );
}

/** The operator's request: its own words in the Chat look of a person's turn. */
function ViewRequestBubble({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > REQUEST_CLAMP_CHARS || text.split("\n").length > 4;
  const turn = <UserTurn text={text} clamp={long && !open} />;
  if (!long) return turn;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={open}
      className="min-w-0 cursor-pointer"
      onClick={() => setOpen((was) => !was)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        setOpen((was) => !was);
      }}
    >
      {turn}
    </div>
  );
}

/** The decision block as it stands: settled when the agent sent `picked` or the operator picked it, live otherwise. */
function ChoicePart({
  view,
  pictures,
  pressed,
  busy,
  canAct,
  onPick,
}: {
  view: ViewScreen;
  pictures: ViewPictures | undefined;
  pressed: readonly string[];
  busy: number | null;
  /** A pick may send. Stale (in the Earlier fold): never. */
  canAct: boolean | "stale";
  onPick: (index: number) => void;
}) {
  const choice = view.choice;
  if (choice === undefined) return null;
  const picked = choice.picked ?? (canAct === "stale" ? pickedOption(pressed) : null);
  if (picked !== null) return <ViewChoiceDone choice={choice} picked={picked} pictures={pictures} />;
  return (
    <ViewChoiceBlock
      choice={choice}
      pictures={pictures}
      media={view.media ?? []}
      picked={pickedOption(pressed)}
      busy={busy}
      canAct={canAct === true}
      onPick={canAct === "stale" ? () => undefined : onPick}
    />
  );
}

/** The pictures neither the view places nor the decision block previews: the row under the title. */
function stripMediaOf(view: ViewScreen | undefined): ViewMedia[] {
  if (view?.media === undefined) return [];
  const placed = viewImageRefs(view.view);
  const previews = previewRefs(view.choice);
  return view.media.filter((_, i) => !placed.has(i) && !previews.has(i));
}

export function AgentViewScreen({
  name,
  session,
  view,
  request: told,
  sent = NO_SENT,
  drawing,
  pressed = NO_CONTROLS,
  onPressed,
  working,
  question = false,
  stale = false,
  changed = false,
  entries,
  canAct,
  onTap,
  onStale,
  onLink,
  now,
}: AgentViewScreenProps) {
  useLocale();
  const clock = useBridgeNow(now);
  const [busyControl, setBusyControl] = useState<string | null>(null);
  const request = useMemo(() => viewRequestOf({ local: told, entries, sent }), [told, entries, sent]);
  const status = useMemo(() => viewStatusOf({ request, view, drawing, working, entries, now: clock }), [request, view, drawing, working, entries, clock]);
  const state = viewStateOf({ view, status });
  // While the session is in work, the store reads the screen fast, so blocks land as they are set.
  useAgentViewLive(working || isUnanswered(status));
  // A request that was not sent splits nothing: the screen is live again, whole.
  const requestAt = request === null || request.phase === "failed" ? null : request.at;
  const split = useMemo(() => splitScreen(view, requestAt), [view, requestAt]);
  const hasFresh = split.fresh.length > 0 || split.isChoiceFresh;
  const answer = useMemo(() => {
    if (state !== "answered" || hasFresh || request === null) return null;
    return textAnswerAfter(entries, new Date(request.at - 1).toISOString());
  }, [state, hasFresh, request, entries]);
  const notes = useMemo(() => (request === null ? [] : requestNotes(drawing, request.at)), [drawing, request]);
  const receipt = useMemo(() => (request === null ? null : pickReceiptOf(request.text, view)), [request, view]);
  const partKey = `agent-view:${session}`;
  const pictures = useMemo(() => (view?.set === undefined || view.media === undefined ? undefined : viewPictures(view.set, view.media, viewMediaSource)), [view?.set, view?.media]);
  const stripMedia = useMemo(() => stripMediaOf(view), [view]);
  // The screen's free text carries the links Chat's text carries (components/agent-view-links.tsx).
  const linkText = useViewLinkText();
  // Every button waits: nothing may act here, a turn runs, a question waits, or the screen is old.
  const held = !canAct || working || question || stale;

  /** Send one tap, mark the control once the bridge confirmed it, read again on a stale refusal. */
  const send = useCallback(
    (control: string, tap: ViewTap) => {
      setBusyControl(control);
      void onTap(tap)
        .then((result) => {
          if (result.sent) onPressed?.(control);
          if (result.code === "stale_view") onStale?.();
          return result;
        })
        .finally(() => setBusyControl(null));
    },
    [onTap, onPressed, onStale],
  );

  const onBlockTap = useCallback(
    (block: ScreenBlock, rendered: string) => {
      if (view === undefined || busyControl !== null || held) return;
      const control = screenControl(block, rendered);
      // The words this tap names on the screen the phone holds: the receipt's, while it is in flight. The
      // bridge builds the line from its own stored screen and answers it.
      const words = viewTapWords(view, control);
      if (words === null) return;
      send(blockControl(block.prefix, rendered), { rev: view.rev, control, words });
    },
    [view, busyControl, held, send],
  );

  const onPick = useCallback(
    (index: number) => {
      const choice = view?.choice;
      if (view === undefined || choice === undefined || busyControl !== null || held) return;
      const control = optionControl(index);
      const words = viewTapWords(view, control);
      if (words === null) return;
      send(choiceControl(choice, index), { rev: view.rev, control, words });
    },
    [view, busyControl, held, send],
  );

  /**
   * One block, drawn on its own. A stale block is drawn as it was, and its taps go nowhere. `isAfter`: a
   * block stands above it in its list, so a headed group gets the renderer's own section space.
   */
  const drawBlock = useCallback(
    (block: ScreenBlock, { isLive, isAfter }: { isLive: boolean; isAfter: boolean }): ReactNode => {
      if (block.pending !== undefined) return <ViewPendingBlock label={block.pending} isLive={isLive} />;
      const ctx: RenderCtx = {
        partKey,
        stale: false,
        onTap: isLive ? (_key, _intent, _value: TapValue | undefined, control) => onBlockTap(block, control) : () => undefined,
        onLink,
        hostOf: linkHost,
        wrap: true,
        linkText,
        armedLabel,
      };
      const busyHere = busyControl === null ? null : renderedControl(block.prefix, busyControl);
      if (isLive && busyHere !== null) ctx.tap = { phase: "busy", rid: "agent-view", control: busyHere, intent: "" };
      if (isLive && busyHere === null && (busyControl !== null || held)) ctx.tap = ALL_WAIT;
      if (now !== undefined) ctx.now = now;
      if (pictures !== undefined) ctx.pictures = pictures;
      return (
        <div data-trick-section={isAfter && block.node.kind === "group" && groupHasHead(block.node) ? "" : undefined} className="min-w-0 data-[trick-section]:pt-2">
          <TrickBoundary fallback="placeholder" resetKey={`${partKey}@${block.prefix}`}>
            {renderView(withTrueLinks(pressedNode(block, pressed)), ctx)}
          </TrickBoundary>
        </div>
      );
    },
    [partKey, onBlockTap, onLink, busyControl, held, now, pictures, pressed, linkText],
  );

  const freshItems = useMemo(
    (): FlowItem[] => split.fresh.map((block, i) => ({ key: block.id, version: `${block.prefix}:${block.pending ?? ""}`, node: drawBlock(block, { isLive: true, isAfter: i > 0 }) })),
    [split.fresh, drawBlock],
  );

  const busyOption = busyControl === null || view?.choice === undefined ? null : pickedOption([busyControl]);
  // The title and the picture row belong to the part that holds the answer: on top while anything is
  // fresh, inside the Earlier fold when nothing is.
  const isTopOwner = hasFresh || requestAt === null;
  const hasEarlier = split.stale.length > 0 || split.isChoiceStale;
  const strip =
    view?.set !== undefined && stripMedia.length > 0 ? <HillImageStrip decisionId={view.set} media={stripMedia} source={viewMediaSource} className="-mx-4 mt-2" scrollerClassName="px-4" /> : null;
  const staleAt = split.stale.reduce<string | null>((newest, block) => (newest === null || Date.parse(block.at) > Date.parse(newest) ? block.at : newest), split.isChoiceStale ? (view?.choiceAt ?? view?.at ?? null) : null);
  // A receipt carries "Sending…" and "Not sent" itself; the line under it then waits for the agent.
  const showsLine = receipt === null || (status?.kind !== "sending" && status?.kind !== "notSent");
  const bandLine = bandLineOf({ question, stale: stale && view !== undefined, changed, working });
  const age = view === undefined ? null : trickTimeText(view.at, "ago", clock);

  return (
    <div data-slot="agent-view" data-state={state} data-held={held ? "" : undefined} className="flex h-full w-full min-w-0 flex-col">
      <ViewBand name={name} line={bandLine} age={age} />
      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 pt-3 pb-4">
        {request !== null && (
          <div data-slot="view-request" key={`${String(request.at)}:${request.text}`} className="mb-3 min-w-0">
            {receipt === null ? <ViewRequestBubble text={request.text} /> : <ViewReceiptCard receipt={receipt} phase={request.phase} reason={request.reason} pictures={pictures} />}
            {request.phase === "sent" && request.line !== null && <ViewSentLine line={request.line} />}
            {showsLine && <ViewProgress status={status} notes={notes} clock={clock} />}
          </div>
        )}
        {isTopOwner && view?.title !== undefined && (
          <h2 data-slot="view-title" className="truncate text-base font-semibold tracking-tight">
            {view.title}
          </h2>
        )}
        {isTopOwner && strip}
        {view === undefined && request === null && (
          <p data-slot="view-empty" className="py-16 text-center text-sm text-muted-foreground">
            {t("view.empty")}
          </p>
        )}
        {view !== undefined && (
          <div data-slot="view-screen" className={cn("mt-2 min-w-0", VIEW_SCREEN_CLASS)}>
            <KeyedFlow items={freshItems} gap={BLOCK_GAP} data-slot="view-blocks" />
            {split.isChoiceFresh && <ChoicePart key={view.rev} view={view} pictures={pictures} pressed={pressed} busy={busyOption} canAct={!held} onPick={onPick} />}
          </div>
        )}
        {answer !== null && (
          <div data-slot="view-text" className="mt-4 min-w-0 border-t border-rule pt-3">
            <p className="mb-2 text-xs text-muted-foreground">{t("view.textAnswer")}</p>
            <MarkdownText text={answer.text} stretches />
          </div>
        )}
        {view !== undefined && hasEarlier && (
          <ViewEarlier key={request === null ? "none" : String(request.at)} title={isTopOwner ? undefined : view.title} age={staleAt === null ? null : trickTimeText(staleAt, "ago", clock)}>
            {!isTopOwner && strip}
            <div data-slot="view-earlier-blocks" className={cn("flex min-w-0 flex-col", VIEW_SCREEN_CLASS)} style={{ gap: BLOCK_GAP }}>
              {split.stale.map((block, i) => (
                <div key={block.id} className="min-w-0">
                  {drawBlock(block, { isLive: false, isAfter: i > 0 })}
                </div>
              ))}
            </div>
            {split.isChoiceStale && <ChoicePart view={view} pictures={pictures} pressed={pressed} busy={null} canAct="stale" onPick={onPick} />}
          </ViewEarlier>
        )}
      </div>
    </div>
  );
}
