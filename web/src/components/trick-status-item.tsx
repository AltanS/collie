import type { ReactNode } from "react";

import { sessionOfMark } from "@/components/belt-trick-mark";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { setStatus } from "@/lib/status";
import { useBridgeNow } from "@/lib/tricks/clock";
import { isPastWindow } from "@/lib/tricks/frame";
import { trickIconOf } from "@/lib/tricks/icons";
import { TrickBoundary } from "@/lib/tricks/boundary";
import { TrickClock } from "@/lib/tricks/render";
import { partKey, type WireTrickPart } from "@/lib/tricks/schema";
import { useTrickPart, tricksStore, type TricksStore } from "@/lib/tricks/store";
import { trickTimeText } from "@/lib/tricks/time";
import { inkOf } from "@/lib/tricks/tone";
import type { AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";

// A TRICK'S ITEM IN THE STATUS LINE (M94 re-cut, the `status` place): one chip in the usage row above the
// Belt (components/model-tag.tsx), after Collie's own items, in the same 10px type and the same 12px line,
// so it reads as one more figure of the row and never as a pill dropped into it. The row gives way to it
// first (lib/tricks/status.ts); `ModelTag` measures and hides.
//
// THE CHIP IS NOT A CONTROL. It has no `intent` and no status shape. A tap opens the trick's own session
// when it has one, one level down, as a belt mark with no intent does. With none, a fresh chip takes no tap
// and is a span, never a disabled button. A chip past its fresh window loses its tone, and its tap says its
// age (lib/tricks/frame.ts), whether or not a session opens beside it.

/** One item for the row: the part's key, its trick (the order is the caller's), and its face. */
export interface StatusItem {
  id: string;
  trick: string;
  face: ReactNode;
}

/** The tap's reach: the 12px line is far below the 44px floor (DESIGN.md section 6), so the button reaches 16px above and below. */
const REACH = "relative pointer-events-auto before:absolute before:-inset-x-1 before:-inset-y-4 before:content-['']";

function TrickStatusItem({
  partKey: key,
  session,
  onOpenSession,
  store,
}: {
  partKey: string;
  session: AgentView | undefined;
  onOpenSession: (pane: AgentView) => void;
  store: TricksStore;
}) {
  useLocale();
  const { part, trick } = useTrickPart(key, store);
  const now = useBridgeNow();
  const value = part?.value;
  if (part === undefined || value?.at !== "status") return null;
  const chip = value.chip;
  // A status part with no `chip` draws nothing.
  if (chip === undefined || chip === null) return null;
  const trickName = trick?.name ?? part.trick;
  const stale = part.stale === true || isPastWindow(part, now);
  const ink = inkOf(chip.tone, stale);
  const Icon = chip.icon === undefined ? null : trickIconOf(chip.icon);
  const age = stale && part.asOf !== undefined ? trickTimeText(part.asOf, "ago", now) : null;
  const tapped = session !== undefined || age !== null;
  const onTap = () => {
    if (age !== null) setStatus(t("tricks.frame.updated", { time: age }), "info");
    if (session !== undefined) onOpenSession(session);
  };
  const face = (
    <>
      {Icon !== null && <Icon aria-hidden className={cn("size-2.5 shrink-0", ink)} />}
      <span className={cn("whitespace-nowrap", ink)}>{chip.text}</span>
      {chip.at !== undefined && chip.clock !== undefined && <TrickClock at={chip.at} clock={chip.clock} now={now} />}
    </>
  );
  const frame = "inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap tabular-nums";
  if (!tapped) {
    return (
      <span data-slot="trick-status" data-trick={part.trick} className={frame}>
        <span className="sr-only">{t("tricks.mark.named", { trick: trickName, face: chip.text })}</span>
        <span aria-hidden className="inline-flex items-center gap-0.5">
          {face}
        </span>
      </span>
    );
  }
  const name = t("tricks.mark.named", { trick: trickName, face: chip.text });
  return (
    <button
      type="button"
      data-slot="trick-status"
      data-trick={part.trick}
      data-stale={stale || undefined}
      aria-label={session === undefined ? name : `${name}. ${t("tricks.mark.open", { trick: trickName })}`}
      onClick={onTap}
      className={cn(frame, REACH, "cursor-pointer p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring")}
    >
      {face}
    </button>
  );
}

/** The status line's trick items, ready for `ModelTag` `trailing`, in the caller's order (the manifest order of `useTrickParts`). */
export function statusItemsOf(opts: {
  parts: readonly WireTrickPart[];
  sessions: readonly AgentView[];
  onOpenSession: (pane: AgentView) => void;
  store?: TricksStore;
}): StatusItem[] {
  const store = opts.store ?? tricksStore;
  return opts.parts.map((part) => {
    const key = partKey(part);
    return {
      id: key,
      trick: part.trick,
      // One boundary per item: an item that throws leaves the row's other items drawn, and draws nothing itself.
      face: (
        <TrickBoundary fallback="none" resetKey={`${key}@${part.rev}`}>
          <TrickStatusItem partKey={key} session={sessionOfMark(part, opts.sessions)} onOpenSession={opts.onOpenSession} store={store} />
        </TrickBoundary>
      ),
    };
  });
}
