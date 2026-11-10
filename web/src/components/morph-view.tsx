import { useCallback, useMemo, useState } from "react";

import { UserTurn } from "@/components/chat-cards";
import { HillImageStrip, viewPictures, type HillMediaSource } from "@/components/hill-media";
import { MarkdownText } from "@/components/markdown-text";
import { MorphChoiceBlock } from "@/components/morph-choice";
import { StatusDot } from "@/components/status-badge";
import { OneOf } from "@/components/ui/one-of";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import {
  choiceControl,
  isUnanswered,
  morphRequestOf,
  morphStateOf,
  morphStatusOf,
  pickedOption,
  pickTextOf,
  previewRefs,
  tapTextOf,
  textAnswerAfter,
  withPressed,
  type MorphRequest,
  type MorphStatus,
} from "@/lib/morph/reader";
import { useMorphLive } from "@/lib/morph/store";
import { morphMediaPath, type MorphDrawing, type MorphView as MorphScreen } from "@/lib/morph/wire";
import { TrickBoundary } from "@/lib/tricks/boundary";
import { useBridgeNow } from "@/lib/tricks/clock";
import { viewImageRefs } from "@/lib/tricks/layout";
import { renderView, type LinkTarget, type RenderCtx } from "@/lib/tricks/render";
import type { TapValue } from "@/lib/tricks/schema";
import type { TapState } from "@/lib/tricks/store";
import { trickTimeText } from "@/lib/tricks/time";
import type { TranscriptEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

// THE MORPH BODY: the third body of an agent session, beside Terminal and Chat. The agent answers a
// request by drawing ONE screen (`collie morph show`), and this body shows only that screen. It swaps
// in for the Chat stream or the mirror inside the pane's reading box (components/agent-chat.tsx); the
// Header, the Belt, the composer and the Dock with its cards stay where they are, so Morph never hides a
// prompt card.
//
// Top to bottom: the operator's own request (the Chat look of a person's turn, without the hint, four
// lines at most, a tap opens it) with ONE quiet status line under it, the screen's title, a quiet caption
// ("Drawn by the agent" and its age), the screen drawn by the trick renderer inside the trick boundary,
// and, when the agent answered a later request in text, that text under a small line. The request block
// is there as soon as a send starts, before any screen, so an empty body never reads as "nothing
// happened". Which state is on screen, and where the request stands, is lib/morph/reader.ts's call.
//
// PICTURES ARE THE HILL'S. A screen's pictures are drawn by the hill's own pieces (components/hill-media.tsx)
// with Morph's media route as their source: a view's `image` by `ref` and its `compare` through the
// renderer's `pictures` (crop by `focus`, near-screen loading, the authed fetch, tap to zoom), and the
// pictures the view does not place, nor the decision block as a preview, in the hill's row under the
// title, as the Decision card does.
//
// THE DECISION BLOCK (components/morph-choice.tsx) sits under the view. A pick sends `picked "<label>"`
// through the same path as a tap, and is marked the same way until the next screen.
//
// A TAP SENDS A MESSAGE. A button's tap goes to `onSend`, which is the composer's own send path
// (`ComposerHandle.sendLine`): one Send Protocol request with its request id, the composer's refusal
// notice on a failure, and the session's hint appended. The words are the button's `value`, else its
// label. `confirm` arms on the first tap and `does: copy` copies, both in the renderer, exactly as for
// a trick. While a send is in flight every button waits. A tap the bridge confirmed is a pick: the
// button stays marked (`pressed`) until the agent's next screen arrives.

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
  /** The control paths the operator picked on this screen. */
  pressed?: readonly string[] | undefined;
  /** A tap the bridge confirmed: the control path to mark. */
  onPressed?: ((control: string) => void) | undefined;
  /** The agent's turn runs: the pane's own status, the signal Chat reads. */
  working: boolean;
  /** The Chat window's turns, as the session screen already holds them. */
  entries: readonly TranscriptEntry[];
  /** A tap may send: a live pane on a device that may write. False: every button waits. */
  canAct: boolean;
  /** Send one line through the composer. True on a send the bridge confirmed. */
  onSend: (text: string) => Promise<boolean>;
  /** A row's `href` or a link was tapped. */
  onLink: (target: LinkTarget) => void;
  /** Pin the clock (epoch ms on the bridge's clock), for a test. */
  now?: number;
}

/** Where a Morph picture's bytes are: the set id stands where the hill's source takes a decision id. */
export const morphMediaSource: HillMediaSource = (set, media) => morphMediaPath(set, media.id);

/** A tap state that makes every button wait, with no spinner on any. */
const NO_CONTROLS: readonly string[] = [];

const ALL_WAIT: TapState = { phase: "busy", rid: "morph", control: "", intent: "" };

/** Longer than this (or more than four lines) and the request is clamped to four lines; a tap opens it. */
const REQUEST_CLAMP_CHARS = 140;

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
      return t("morph.request.sending");
    case "notSent":
      return status.reason === null ? t("morph.request.notSent") : t("morph.request.notSentWhy", { reason: status.reason });
    case "sent":
      return t("morph.request.sent");
    case "working":
      return t("morph.request.working");
    case "morphing":
      return status.note === null ? t("morph.request.morphing") : t("morph.request.morphingNote", { note: status.note });
    case "answered": {
      const age = trickTimeText(status.at, "ago", clock);
      return age === null ? t("morph.request.answered") : t("morph.request.answeredAt", { time: age });
    }
  }
}

/** The operator's request and the one line that says where it stands. */
function MorphRequestBlock({ text, status, clock }: { text: string; status: MorphStatus | null; clock: number }) {
  const [open, setOpen] = useState(false);
  const long = text.length > REQUEST_CLAMP_CHARS || text.split("\n").length > 4;
  const turn = <UserTurn text={text} clamp={long && !open} />;
  const live = status?.kind === "working" || status?.kind === "morphing";
  return (
    <div data-slot="morph-request" className="mb-3 min-w-0">
      {long ? (
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
      ) : (
        turn
      )}
      {/* One line, a fixed height: the words change, nothing under it moves. */}
      <p data-slot="morph-status" data-kind={status?.kind} role="status" className="mt-1 flex h-5 min-w-0 items-center gap-2 text-xs text-muted-foreground">
        {live && <StatusDot status="working" live className="size-2.5" />}
        <span className={cn("truncate", live && "font-medium")}>{status === null ? "" : statusWords(status, clock)}</span>
      </p>
    </div>
  );
}

function MorphCaption({ view, working, now }: { view: MorphScreen | undefined; working: boolean; now?: number }) {
  const clock = useBridgeNow(now);
  const age = view === undefined ? null : trickTimeText(view.at, "ago", clock);
  const drawn = age === null ? t("morph.drawn") : t("morph.drawnAt", { time: age });
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

export function MorphView({ session, view, request: told, head, hint, drawing, pressed = NO_CONTROLS, onPressed, working, entries, canAct, onSend, onLink, now }: MorphViewProps) {
  useLocale();
  const clock = useBridgeNow(now);
  const [busyControl, setBusyControl] = useState<string | null>(null);
  const request = useMemo(() => morphRequestOf({ local: told, entries, wording: { head, hint } }), [told, entries, head, hint]);
  // With no screen yet, a text answer is read against the request: it is the only answer there is.
  const since = view?.at ?? (request === null ? null : new Date(request.at - 1).toISOString());
  const answer = useMemo(() => (since === null ? null : textAnswerAfter(entries, since)), [entries, since]);
  const state = morphStateOf({ view, working, answer });
  const status = useMemo(() => morphStatusOf({ request, view, drawing, working, entries, now: clock }), [request, view, drawing, working, entries, clock]);
  const dimmed = state === "working" || isUnanswered(status);
  // While the session is in work, the store reads the screen fast, so blocks land as they are set.
  useMorphLive(working || isUnanswered(status));
  const partKey = `morph:${session}`;

  const onTap = useCallback(
    (_key: string, _intent: string, _value: TapValue | undefined, control: string) => {
      if (view === undefined || busyControl !== null || !canAct) return;
      const text = tapTextOf({ view: view.view, control });
      if (text === null) throw new Error(`morph: the tapped control ${control} names no button`);
      setBusyControl(control);
      void onSend(text)
        .then((sent) => {
          if (sent) onPressed?.(control);
          return sent;
        })
        .finally(() => setBusyControl(null));
    },
    [view, busyControl, canAct, onSend, onPressed],
  );

  const tap = useMemo((): TapState | undefined => {
    if (busyControl !== null) return { phase: "busy", rid: "morph", control: busyControl, intent: "" };
    return canAct ? undefined : ALL_WAIT;
  }, [busyControl, canAct]);

  const pictures = useMemo(() => (view?.set === undefined || view.media === undefined ? undefined : viewPictures(view.set, view.media, morphMediaSource)), [view?.set, view?.media]);
  // The pictures neither the view places nor the decision block previews: the row under the title.
  const stripMedia = useMemo(() => {
    if (view?.media === undefined) return [];
    const placed = viewImageRefs(view.view);
    const previews = previewRefs(view.choice);
    return view.media.filter((_, i) => !placed.has(i) && !previews.has(i));
  }, [view]);

  const onPick = useCallback(
    (index: number) => {
      const choice = view?.choice;
      if (choice === undefined || busyControl !== null || !canAct) return;
      const text = pickTextOf(choice, index);
      if (text === null) throw new Error(`morph: the picked option ${String(index)} is not in the choice`);
      const control = choiceControl(index);
      setBusyControl(control);
      void onSend(text)
        .then((sent) => {
          if (sent) onPressed?.(control);
          return sent;
        })
        .finally(() => setBusyControl(null));
    },
    [view?.choice, busyControl, canAct, onSend, onPressed],
  );

  const drawn = useMemo(() => {
    if (view === undefined) return null;
    const ctx: RenderCtx = { partKey, stale: false, onTap, onLink, wrap: true };
    if (tap !== undefined) ctx.tap = tap;
    if (now !== undefined) ctx.now = now;
    if (pictures !== undefined) ctx.pictures = pictures;
    return renderView(withPressed(view.view, pressed), ctx);
  }, [view, pressed, partKey, onTap, onLink, tap, now, pictures]);

  const busyOption = busyControl === null ? null : pickedOption([busyControl]);

  return (
    <div data-slot="morph-view" data-state={state} className="relative h-full w-full min-w-0">
      <div className="h-full min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain px-4 pt-3 pb-4">
        {request !== null && <MorphRequestBlock key={`${String(request.at)}:${request.text}`} text={request.text} status={status} clock={clock} />}
        {view?.title !== undefined && (
          <h2 data-slot="morph-title" className="truncate text-base font-semibold tracking-tight">
            {view.title}
          </h2>
        )}
        {/* The request's status line carries the working mark once there is a request. */}
        <MorphCaption view={view} working={working && request === null} now={now} />
        {view?.set !== undefined && stripMedia.length > 0 && (
          <HillImageStrip decisionId={view.set} media={stripMedia} source={morphMediaSource} className="-mx-4 mt-2" scrollerClassName="px-4" />
        )}
        {view === undefined && request === null && (
          <p data-slot="morph-empty" className="py-16 text-center text-sm text-muted-foreground">
            {t("morph.empty")}
          </p>
        )}
        {view !== undefined && (
          <div data-slot="morph-screen" className={cn("mt-2 min-w-0 transition-opacity", MORPH_SCREEN_CLASS, dimmed && "opacity-60")}>
            {/* A screen that throws draws the placeholder; the next show tries again. */}
            <TrickBoundary fallback="placeholder" resetKey={`${partKey}@${view.rev}`}>
              {drawn}
            </TrickBoundary>
            {view.choice !== undefined && (
              <MorphChoiceBlock
                key={view.rev}
                choice={view.choice}
                pictures={pictures}
                media={view.media ?? []}
                picked={pickedOption(pressed)}
                busy={busyOption}
                canAct={canAct}
                onPick={onPick}
              />
            )}
          </div>
        )}
        {state === "text" && answer !== null && (
          <div data-slot="morph-text" className="mt-4 min-w-0 border-t border-rule pt-3">
            <p className="mb-2 text-xs text-muted-foreground">{t("morph.textAnswer")}</p>
            <MarkdownText text={answer.text} stretches />
          </div>
        )}
      </div>
    </div>
  );
}
