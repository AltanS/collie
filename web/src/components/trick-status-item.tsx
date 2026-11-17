import type { ReactNode } from "react";

import { USAGE_FIGURE, USAGE_ICON, USAGE_TYPE } from "@/components/usage-type";
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
import { rowInkOf } from "@/lib/tricks/tone";
import type { AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";

// A TRICK'S ITEM IN THE STATUS LINE (M94 re-cut, the `status` place): one chip in the usage row above the
// Belt (components/model-tag.tsx), at the row's LEFT end (the model and the usage end the row at the right), in the
// same type as the usage figures beside it (components/usage-type.ts: size, line, weight, colour, tabular digits,
// icon size), so it reads as one more figure of the row and never as a pill dropped into it. It has no ground of its
// own: the left end of the row has the same ground as the right end. Only the tones `warn` and `danger` change
// the colour (lib/tricks/tone.ts `rowInkOf`); the trick sets no size. The model name gives way to it first
// (lib/tricks/status.ts); `ModelTag` measures and hides.
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

/**
 * The tap's reach: the documented exception of DESIGN.md section 6, about 28px high like the cache reading's
 * in `pane-meta.tsx`. The 12px line reaches 4px down, which is all the air the tag owns under it (its own
 * `bottom-1`: further down is the Belt's block, whose touches it must not take), and 12px up into the
 * mirror's last rows. The box is 28px high and 4px wider each side.
 */
const REACH = "relative pointer-events-auto before:absolute before:-inset-x-1 before:-top-3 before:-bottom-1 before:content-['']";

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
  const ink = rowInkOf(chip.tone, stale);
  const Icon = chip.icon === undefined ? null : trickIconOf(chip.icon);
  const age = stale && part.asOf !== undefined ? trickTimeText(part.asOf, "ago", now) : null;
  const tapped = session !== undefined || age !== null;
  const onTap = () => {
    if (age !== null) setStatus(t("tricks.frame.updated", { time: age }), "info");
    if (session !== undefined) onOpenSession(session);
  };
  const face = (
    <>
      {Icon !== null && <Icon aria-hidden className={cn(USAGE_ICON, "shrink-0", ink)} />}
      <span className={cn("whitespace-nowrap", ink)}>{chip.text}</span>
      {chip.at !== undefined && chip.clock !== undefined && <TrickClock at={chip.at} clock={chip.clock} now={now} />}
    </>
  );
  const frame = cn("inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap", USAGE_TYPE, USAGE_FIGURE);
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
