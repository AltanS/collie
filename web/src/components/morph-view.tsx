import { useCallback, useMemo, useState, type ReactNode } from "react";

import { UserTurn } from "@/components/chat-cards";
import { HillImageStrip, viewPictures, type HillMediaSource } from "@/components/hill-media";
import { MarkdownText } from "@/components/markdown-text";
import { useMorphLinkText } from "@/components/morph-links";
import { MorphEarlier, MorphPendingBlock, MorphReceiptCard } from "@/components/morph-blocks";
import { MorphChoiceBlock, MorphChoiceDone } from "@/components/morph-choice";
import { StatusDot } from "@/components/status-badge";
import { KeyedFlow, type FlowItem } from "@/components/ui/keyed-flow";
import { OneOf } from "@/components/ui/one-of";
import { PresenceList } from "@/components/ui/presence";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import {
  blockControl,
  blockTapTextOf,
  choiceControl,
  isUnanswered,
  morphRequestOf,
  morphStateOf,
  morphStatusOf,
  pickedOption,
  pickReceiptOf,
  pickTextOf,
  pressedNode,
  previewRefs,
  renderedControl,
  requestNotes,
  splitScreen,
  textAnswerAfter,
  type MorphBlockView,
  type MorphRequest,
  type MorphStatus,
} from "@/lib/morph/reader";
import { useMorphLive } from "@/lib/morph/store";
import { morphMediaPath, type MorphDrawing, type MorphMedia, type MorphNote, type MorphView as MorphScreen } from "@/lib/morph/wire";
import { TrickBoundary } from "@/lib/tricks/boundary";
import { useBridgeNow } from "@/lib/tricks/clock";
import { groupHasHead, viewImageRefs } from "@/lib/tricks/layout";
import { renderView, type LinkTarget, type RenderCtx, type ViewPictures } from "@/lib/tricks/render";
import type { TapValue } from "@/lib/tricks/schema";
import type { TapState } from "@/lib/tricks/store";
import { trickTimeText } from "@/lib/tricks/time";
import type { TranscriptEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

// THE MORPH BODY: the third body of an agent session, beside Terminal and Chat. The agent answers a
// request by drawing ONE screen, block by block (`collie morph show`, `set`, `pending`), and this body
// shows that screen. It swaps in for the Chat stream or the mirror inside the pane's reading box
// (components/agent-chat.tsx); the Header, the Belt, the composer and the Dock with its cards stay where
// they are, so Morph never hides a prompt card.
//
// Top to bottom: the operator's own request (the Chat look of a person's turn, without the hint, four
// lines at most, a tap opens it; or, for a pick or a tap, the receipt card) with ONE status line under
// it; while the agent works, the notes of its `morph start` calls under that line; then the blocks the
// agent drew FOR THIS REQUEST, and last the blocks it drew before, folded under "Earlier screen". Which
// block is fresh and where the request stands is lib/morph/reader.ts's call ("FRESH AND STALE BLOCKS").
//
// NO GREY WASH. Nothing on this body is dimmed while the agent works or after a send: an old screen
// folds away (and comes back when the send failed), it never fades in place.
//
// BLOCKS MOVE THROUGH `KeyedFlow` (ui/keyed-flow.tsx): a block arrives and leaves with the presence
// motion, a changed block cross-fades, a moved one glides, the first blocks of a screen come in one
// after another, and a finger down holds the column still. Each block is drawn on its own by the trick
// renderer, inside its own trick boundary, so a block that throws costs only itself.
//
// PICTURES ARE THE HILL'S. A screen's pictures are drawn by the hill's own pieces (components/hill-media.tsx)
// with Morph's media route as their source: a view's `image` by `ref` and its `compare` through the
// renderer's `pictures`, and the pictures the view does not place, nor the decision block as a preview, in
// the hill's row under the title, as the Decision card does.
//
// A TAP SENDS A MESSAGE. A button's tap goes to `onSend`, which is the composer's own send path
// (`ComposerHandle.sendLine`): one Send Protocol request with its request id, the composer's refusal
// notice on a failure, and the session's hint appended. `confirm` arms on the first tap and `does: copy`
// copies, both in the renderer. While a send is in flight every button waits. A tap the bridge confirmed
// is a pick, filed under its block (lib/morph/reader.ts, "controls, keyed by block"): the button stays
// marked while its block holds the same content, in the Earlier fold too.

export interface MorphViewProps {
  /** The session's walky address: the part key the renderer files taps under. */
  session: string;
  /** The screen the agent drew last, or undefined before the first. */
  view: MorphScreen | undefined;
  /** The latest send that carried the hint, as the composer told it, or undefined (then the chat's latest person turn stands in). */
  request?: MorphRequest | undefined;
  /** The head and the tail the session's bridge serves, taken off the chat's copy of a request. */
  head?: string | undefined;
  hint?: string | undefined;
  /** The agent's `morph start`, or undefined. */
  drawing?: MorphDrawing | undefined;
  /** The controls the operator picked on this screen, each filed under its block. */
  pressed?: readonly string[] | undefined;
  /** A tap the bridge confirmed: the control to mark. */
  onPressed?: ((control: string) => void) | undefined;
  /** The agent's turn runs: the pane's own status, the signal Chat reads. */
  working: boolean;
  /** The Chat window's turns, as the session screen already holds them. */
  entries: readonly TranscriptEntry[];
  /** A tap may send: a live pane on a device that may write. False: every button waits. */
  canAct: boolean;
  /**
   * Send one line through the composer. True on a send the bridge confirmed. TODO(agent-view web): a tap
   * carries the screen's rev and the control path the bridge reads (`v/<index>/...` or `choice/<index>`).
   */
  onSend: (text: string, tap?: { readonly rev: number; readonly control: string }) => Promise<boolean>;
  /** A row's `href` or a link was tapped. */
  onLink: (target: LinkTarget) => void;
  /** Pin the clock (epoch ms on the bridge's clock), for a test. */
  now?: number;
}

/** Where a Morph picture's bytes are: the set id stands where the hill's source takes a decision id. */
export const morphMediaSource: HillMediaSource = (set, media) => morphMediaPath(set, media.id);

const NO_CONTROLS: readonly string[] = [];

/** A tap state that makes every button wait, with no spinner on any. */
const ALL_WAIT: TapState = { phase: "busy", rid: "morph", control: "", intent: "" };

/** Longer than this (or more than four lines) and the request is clamped to four lines; a tap opens it. */
const REQUEST_CLAMP_CHARS = 140;

/** The gap between two blocks of the screen, in px: the renderer's own gap between top-level nodes. */
const BLOCK_GAP = 8;

/**
 * What the Morph screen's container does to the renderer's own nodes, from this side (render.tsx is the
 * tricks'): a `line` wraps instead of scrolling sideways and takes the height its words need, so no
 * sentence is ever cut at the right edge, and a pressed button is filled, which the renderer marks with
 * `aria-pressed` only.
 */
export const MORPH_SCREEN_CLASS = cn(
  "[&_[data-trick-node=line]]:h-auto!",
  "[&_[data-trick-node=line]_span]:whitespace-pre-wrap [&_[data-trick-node=line]_span]:break-words",
  "[&_button[aria-pressed=true]]:border-primary [&_button[aria-pressed=true]]:bg-primary [&_button[aria-pressed=true]]:text-primary-foreground",
);

function statusWords(status: MorphStatus, clock: number): string {
  switch (status.kind) {
    case "sending":
      return t("view.request.sending");
    case "notSent":
      return status.reason === null ? t("view.request.notSent") : t("view.request.notSentWhy", { reason: status.reason });
    case "sent":
      return t("view.request.sent");
    case "working":
      return t("view.request.working");
    case "morphing":
      return t("view.request.drawing");
    case "answered": {
      const age = trickTimeText(status.at, "ago", clock);
      return age === null ? t("view.request.answered") : t("view.request.answeredAt", { time: age });
    }
  }
}

/** The status kinds of a request still in work: the line is in the foreground, with the live mark. */
function isLiveStatus(status: MorphStatus | null): boolean {
  return status?.kind === "sent" || status?.kind === "working" || status?.kind === "morphing";
}

/**
 * The one line that says where the request stands, and under it, while the agent works, the notes of
 * its `morph start` calls for this request (newest last, the older ones muted), each arriving through
 * the presence motion. One fixed line: the words change, nothing under it moves.
 */
function MorphProgress({ status, notes, clock }: { status: MorphStatus | null; notes: readonly MorphNote[]; clock: number }) {
  const live = isLiveStatus(status);
  const linkText = useMorphLinkText();
  return (
    <div data-slot="morph-progress" className="mt-1 min-w-0">
      <p data-slot="morph-status" data-kind={status?.kind} role="status" className={cn("flex h-6 min-w-0 items-center gap-2 text-sm", live ? "text-foreground" : "text-muted-foreground")}>
        {live && <StatusDot status="working" live className="size-2.5" />}
        <span className={cn("truncate", live && "font-medium")}>{status === null ? "" : statusWords(status, clock)}</span>
      </p>
      <ul data-slot="morph-notes" className="flex min-w-0 flex-col pl-[18px]">
        <PresenceList itemAs="li">
          {(live ? notes : []).map((note, i, all) => (
            <span key={`${note.at}:${note.note}`} data-slot="morph-note" className={cn("block truncate text-sm", i === all.length - 1 ? "text-foreground" : "text-muted-foreground")}>
              {linkText(note.note)}
            </span>
          ))}
        </PresenceList>
      </ul>
    </div>
  );
}

/** The operator's request: its own words in the Chat look of a person's turn. */
function MorphRequestBubble({ text }: { text: string }) {
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

function MorphCaption({ view, working, now }: { view: MorphScreen | undefined; working: boolean; now?: number }) {
  const clock = useBridgeNow(now);
  const age = view === undefined ? null : trickTimeText(view.at, "ago", clock);
  const drawn = age === null ? t("view.drawn") : t("view.drawnAt", { time: age });
  return (
    <div data-slot="morph-caption" className="flex h-6 min-w-0 items-center text-xs text-muted-foreground">
      <OneOf
        active={working ? "working" : "drawn"}
        className="min-w-0 justify-items-start"
        options={[
          { key: "drawn", node: <span className="truncate tabular-nums">{view === undefined ? "" : drawn}</span> },
          {
            key: "working",
            node: (
              <span data-slot="morph-working" role="status" className="inline-flex min-w-0 items-center gap-2 font-medium">
                <StatusDot status="working" live className="size-2.5" />
                <span className="truncate">{t("chat.stream.working")}</span>
              </span>
            ),
          },
        ]}
      />
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
  view: MorphScreen;
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
  if (picked !== null) return <MorphChoiceDone choice={choice} picked={picked} pictures={pictures} />;
  return (
    <MorphChoiceBlock
      choice={choice}
      pictures={pictures}
      media={view.media ?? []}
      picked={pickedOption(pressed)}
      busy={busy}
      canAct={canAct !== false}
      onPick={canAct === "stale" ? () => undefined : onPick}
    />
  );
}

/** The pictures neither the view places nor the decision block previews: the row under the title. */
function stripMediaOf(view: MorphScreen | undefined): MorphMedia[] {
  if (view?.media === undefined) return [];
  const placed = viewImageRefs(view.view);
  const previews = previewRefs(view.choice);
  return view.media.filter((_, i) => !placed.has(i) && !previews.has(i));
}

// TODO(agent-view web): SECURITY rule 8, a band the agent cannot draw over: "Drawn by the agent in
// <session>, <trick name>" (the name from the tricks list, the served view carries the id). Rule 4: after a
// tap, show the served `sent` line (or the send answer's `view.line`) under "Sent to this session". Lead
// addition 5: a `stale_view` refusal refetches and shows the new screen, with no retry of the tap.
// Lead addition 4: buttons are held while a turn runs. The served `stale` and `question` flags still need
// their own look here.
export function MorphView({ session, view, request: told, head, hint, drawing, pressed = NO_CONTROLS, onPressed, working, entries, canAct, onSend, onLink, now }: MorphViewProps) {
  useLocale();
  const clock = useBridgeNow(now);
  const [busyControl, setBusyControl] = useState<string | null>(null);
  const request = useMemo(() => morphRequestOf({ local: told, entries, wording: { head, hint } }), [told, entries, head, hint]);
  const status = useMemo(() => morphStatusOf({ request, view, drawing, working, entries, now: clock }), [request, view, drawing, working, entries, clock]);
  const state = morphStateOf({ view, status });
  // While the session is in work, the store reads the screen fast, so blocks land as they are set.
  useMorphLive(working || isUnanswered(status));
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
  const partKey = `morph:${session}`;
  const pictures = useMemo(() => (view?.set === undefined || view.media === undefined ? undefined : viewPictures(view.set, view.media, morphMediaSource)), [view?.set, view?.media]);
  const stripMedia = useMemo(() => stripMediaOf(view), [view]);
  // The screen's free text carries the links Chat's text carries (components/morph-links.tsx).
  const linkText = useMorphLinkText();

  /** Send one line for a control, mark the control once the bridge confirmed it. */
  const send = useCallback(
    (control: string, text: string, tap?: { readonly rev: number; readonly control: string }) => {
      setBusyControl(control);
      void onSend(text, tap)
        .then((sent) => {
          if (sent) onPressed?.(control);
          return sent;
        })
        .finally(() => setBusyControl(null));
    },
    [onSend, onPressed],
  );

  const onBlockTap = useCallback(
    (block: MorphBlockView, rendered: string) => {
      if (view === undefined || busyControl !== null || !canAct) return;
      const text = blockTapTextOf({ view: view.view, block, rendered });
      if (text === null) throw new Error(`morph: the tapped control ${rendered} in block ${block.id} names no button`);
      // TODO(agent-view web): the bridge's own control path over the whole screen, for the line it builds.
      send(blockControl(block.prefix, rendered), text, { rev: view.rev, control: `v/${String(block.index)}${rendered.slice("v/0".length)}` });
    },
    [view, busyControl, canAct, send],
  );

  const onPick = useCallback(
    (index: number) => {
      const choice = view?.choice;
      if (choice === undefined || busyControl !== null || !canAct) return;
      const text = pickTextOf(choice, index);
      if (text === null) throw new Error(`morph: the picked option ${String(index)} is not in the choice`);
      send(choiceControl(choice, index), text, view === undefined ? undefined : { rev: view.rev, control: `choice/${String(index)}` });
    },
    [view, busyControl, canAct, send],
  );

  /**
   * One block, drawn on its own. A stale block is drawn as it was, and its taps go nowhere. `isAfter`: a
   * block stands above it in its list, so a headed group gets the renderer's own section space.
   */
  const drawBlock = useCallback(
    (block: MorphBlockView, { isLive, isAfter }: { isLive: boolean; isAfter: boolean }): ReactNode => {
      if (block.pending !== undefined) return <MorphPendingBlock label={block.pending} isLive={isLive} />;
      const ctx: RenderCtx = { partKey, stale: false, onTap: isLive ? (_key, _intent, _value: TapValue | undefined, control) => onBlockTap(block, control) : () => undefined, onLink, wrap: true, linkText };
      const busyHere = busyControl === null ? null : renderedControl(block.prefix, busyControl);
      if (isLive && busyHere !== null) ctx.tap = { phase: "busy", rid: "morph", control: busyHere, intent: "" };
      if (isLive && busyHere === null && (busyControl !== null || !canAct)) ctx.tap = ALL_WAIT;
      if (now !== undefined) ctx.now = now;
      if (pictures !== undefined) ctx.pictures = pictures;
      return (
        <div data-trick-section={isAfter && block.node.kind === "group" && groupHasHead(block.node) ? "" : undefined} className="min-w-0 data-[trick-section]:pt-2">
          <TrickBoundary fallback="placeholder" resetKey={`${partKey}@${block.prefix}`}>
            {renderView(pressedNode(block, pressed), ctx)}
          </TrickBoundary>
        </div>
      );
    },
    [partKey, onBlockTap, onLink, busyControl, canAct, now, pictures, pressed, linkText],
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
    view?.set !== undefined && stripMedia.length > 0 ? <HillImageStrip decisionId={view.set} media={stripMedia} source={morphMediaSource} className="-mx-4 mt-2" scrollerClassName="px-4" /> : null;
  const staleAt = split.stale.reduce<string | null>((newest, block) => (newest === null || Date.parse(block.at) > Date.parse(newest) ? block.at : newest), split.isChoiceStale ? (view?.choiceAt ?? view?.at ?? null) : null);
  // A receipt carries "Sending…" and "Not sent" itself; the line under it then waits for the agent.
  const showsLine = receipt === null || (status?.kind !== "sending" && status?.kind !== "notSent");

  return (
    <div data-slot="morph-view" data-state={state} className="relative h-full w-full min-w-0">
      <div className="h-full min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain px-4 pt-3 pb-4">
        {request !== null && (
          <div data-slot="morph-request" key={`${String(request.at)}:${request.text}`} className="mb-3 min-w-0">
            {receipt === null ? <MorphRequestBubble text={request.text} /> : <MorphReceiptCard receipt={receipt} phase={request.phase} reason={request.reason} pictures={pictures} />}
            {showsLine && <MorphProgress status={status} notes={notes} clock={clock} />}
          </div>
        )}
        {isTopOwner && view?.title !== undefined && (
          <h2 data-slot="morph-title" className="truncate text-base font-semibold tracking-tight">
            {view.title}
          </h2>
        )}
        {/* With a request, its status line carries the time and the working mark. */}
        {request === null && <MorphCaption view={view} working={working} now={now} />}
        {isTopOwner && strip}
        {view === undefined && request === null && (
          <p data-slot="morph-empty" className="py-16 text-center text-sm text-muted-foreground">
            {t("view.empty")}
          </p>
        )}
        {view !== undefined && (
          <div data-slot="morph-screen" className={cn("mt-2 min-w-0", MORPH_SCREEN_CLASS)}>
            <KeyedFlow items={freshItems} gap={BLOCK_GAP} data-slot="morph-blocks" />
            {split.isChoiceFresh && <ChoicePart key={view.rev} view={view} pictures={pictures} pressed={pressed} busy={busyOption} canAct={canAct} onPick={onPick} />}
          </div>
        )}
        {answer !== null && (
          <div data-slot="morph-text" className="mt-4 min-w-0 border-t border-rule pt-3">
            <p className="mb-2 text-xs text-muted-foreground">{t("view.textAnswer")}</p>
            <MarkdownText text={answer.text} stretches />
          </div>
        )}
        {view !== undefined && hasEarlier && (
          <MorphEarlier key={request === null ? "none" : String(request.at)} title={isTopOwner ? undefined : view.title} age={staleAt === null ? null : trickTimeText(staleAt, "ago", clock)}>
            {!isTopOwner && strip}
            <div data-slot="morph-earlier-blocks" className={cn("flex min-w-0 flex-col", MORPH_SCREEN_CLASS)} style={{ gap: BLOCK_GAP }}>
              {split.stale.map((block, i) => (
                <div key={block.id} className="min-w-0">
                  {drawBlock(block, { isLive: false, isAfter: i > 0 })}
                </div>
              ))}
            </div>
            {split.isChoiceStale && <ChoicePart view={view} pictures={pictures} pressed={pressed} busy={null} canAct="stale" onPick={onPick} />}
          </MorphEarlier>
        )}
      </div>
    </div>
  );
}
