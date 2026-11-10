import { useCallback, useMemo, useState } from "react";

import { MarkdownText } from "@/components/markdown-text";
import { StatusDot } from "@/components/status-badge";
import { OneOf } from "@/components/ui/one-of";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { morphStateOf, tapTextOf, textAnswerAfter } from "@/lib/morph/reader";
import type { MorphView as MorphScreen } from "@/lib/morph/wire";
import { TrickBoundary } from "@/lib/tricks/boundary";
import { useBridgeNow } from "@/lib/tricks/clock";
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
// Top to bottom: the screen's title, a quiet caption ("Drawn by the agent" and its age, or Collie's
// working mark while the turn runs, in one cell so neither moves the screen), the screen drawn by the
// trick renderer inside the trick boundary, and, when the agent answered a later request in text, that
// text under a small line. Which state is on screen is lib/morph/reader.ts's call.
//
// A TAP SENDS A MESSAGE. A button's tap goes to `onSend`, which is the composer's own send path
// (`ComposerHandle.sendLine`): one Send Protocol request with its request id, the composer's refusal
// notice on a failure, and the session's hint appended. The words are the button's `value`, else its
// label. `confirm` arms on the first tap and `does: copy` copies, both in the renderer, exactly as for
// a trick. While a send is in flight every button waits.

export interface MorphViewProps {
  /** The session's walky address: the part key the renderer files taps under. */
  session: string;
  /** The screen the agent drew last, or undefined before the first. */
  view: MorphScreen | undefined;
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

/** A tap state that makes every button wait, with no spinner on any. */
const ALL_WAIT: TapState = { phase: "busy", rid: "morph", control: "", intent: "" };

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

export function MorphView({ session, view, working, entries, canAct, onSend, onLink, now }: MorphViewProps) {
  useLocale();
  const [busyControl, setBusyControl] = useState<string | null>(null);
  const answer = useMemo(() => (view === undefined ? null : textAnswerAfter(entries, view.at)), [entries, view]);
  const state = morphStateOf({ view, working, answer });
  const partKey = `morph:${session}`;

  const onTap = useCallback(
    (_key: string, _intent: string, _value: TapValue | undefined, control: string) => {
      if (view === undefined || busyControl !== null || !canAct) return;
      const text = tapTextOf({ view: view.view, control });
      if (text === null) throw new Error(`morph: the tapped control ${control} names no button`);
      setBusyControl(control);
      void onSend(text).finally(() => setBusyControl(null));
    },
    [view, busyControl, canAct, onSend],
  );

  const tap = useMemo((): TapState | undefined => {
    if (busyControl !== null) return { phase: "busy", rid: "morph", control: busyControl, intent: "" };
    return canAct ? undefined : ALL_WAIT;
  }, [busyControl, canAct]);

  const drawn = useMemo(() => {
    if (view === undefined) return null;
    const ctx: RenderCtx = { partKey, stale: false, onTap, onLink, wrap: true };
    if (tap !== undefined) ctx.tap = tap;
    if (now !== undefined) ctx.now = now;
    return renderView(view.view, ctx);
  }, [view, partKey, onTap, onLink, tap, now]);

  return (
    <div data-slot="morph-view" data-state={state} className="relative h-full w-full min-w-0">
      <div className="h-full min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain px-4 pt-3 pb-4">
        {view?.title !== undefined && (
          <h2 data-slot="morph-title" className="truncate text-base font-semibold tracking-tight">
            {view.title}
          </h2>
        )}
        <MorphCaption view={view} working={working} now={now} />
        {view === undefined ? (
          <p data-slot="morph-empty" className="py-16 text-center text-sm text-muted-foreground">
            {t("morph.empty")}
          </p>
        ) : (
          <div data-slot="morph-screen" className={cn("mt-2 min-w-0 transition-opacity", state === "working" && "opacity-60")}>
            {/* A screen that throws draws the placeholder; the next show tries again. */}
            <TrickBoundary fallback="placeholder" resetKey={`${partKey}@${view.rev}`}>
              {drawn}
            </TrickBoundary>
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
