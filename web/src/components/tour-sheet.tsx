import * as React from "react";
import { Bell, ChevronLeft, ChevronRight, Smartphone, SquareTerminal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/sheet";
import { CollieMark } from "@/components/collie-mark";
import { useLocale } from "@/hooks/use-locale";
import { usePushControl } from "@/hooks/use-push";
import { t } from "@/lib/i18n";
import { availabilityNote, reasonText } from "@/lib/push-copy";
import type { EnableResult, PushState } from "@/lib/push";
import type { HomeData } from "@/lib/loaders";
import { isReadOnly } from "@/lib/types";
import { markTourSeen, shouldShowTour, useTourSeen } from "@/lib/tour";
import { cn } from "@/lib/utils";

// THE FIRST-LAUNCH TOUR. Three slides, one full-height sheet, shown once per device on the first
// render where a REAL snapshot is in hand, and never again on its own.
//
// The file holds two components and the split is deliberate. `TourSheet` is controlled and knows
// nothing about storage, the snapshot or the browser's push permission, which is what lets the
// states playground mount every slide as a plain prop combination. `TourHost` is the gate: it reads
// the store, decides once, and tells `RootLayout` what it decided.
//
// WHY THE TOUR IS MARKED SEEN ON OPEN, NOT ON CLOSE. A phone that loses the tab on slide 2 is never
// shown the tour again on its own, and that is the price on purpose: marking on close hands a flaky
// link the power to replay the same three slides on every load, which is the worse failure. The
// Settings row ("Show the tour again") is the whole recovery path.
//
// THE FOCUS TRAP LIVES HERE, NOT IN `ui/sheet.tsx`. `useDialogFocus` moves focus in and restores it
// out and says in its own comment that it does not trap. The router behind this sheet is still
// fully focusable, so the tour is the first modal in this app that must trap. One caller does not
// earn a promotion; the second one does.

/** What a slide is. There is no per-slide component and no carousel — one slide renders at a time. */
interface Slide {
  readonly icon: typeof Bell;
  readonly titleKey: "tour.slide1.title" | "tour.slide2.title" | "tour.slide3.title";
  readonly bodyKey: "tour.slide1.body" | "tour.slide2.body" | "tour.slide3.body";
}

const SLIDES: readonly Slide[] = [
  { icon: Smartphone, titleKey: "tour.slide1.title", bodyKey: "tour.slide1.body" },
  { icon: SquareTerminal, titleKey: "tour.slide2.title", bodyKey: "tour.slide2.body" },
  { icon: Bell, titleKey: "tour.slide3.title", bodyKey: "tour.slide3.body" },
];

export const TOUR_SLIDE_COUNT = SLIDES.length;

/** Everything in the panel a Tab can land on, in DOM order, with the disabled ones left out. */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface TourSheetProps {
  open: boolean;
  /** The slide on screen, 0-based. The app holds it in state; the playground sets it per card. */
  index: number;
  onIndex: (next: number) => void;
  /**
   * Skip, Escape, the backdrop and the ✕ all close with `"skip"`; the last slide's Start closes
   * with `"start"`. Nothing in the app branches on it — the tour is marked seen when it OPENS — but
   * the playground prints it, and a later count of "skipped on slide 1" costs nothing to keep.
   */
  onClose: (reason: "skip" | "start") => void;
  /** Device pairing is enforced and this device is not paired: slide 2 swaps its last sentence. */
  readOnly?: boolean;
  /**
   * `undefined` means "ask `usePushControl` yourself", which is what the app passes. The playground
   * passes a literal so its cards touch no browser push API at all.
   */
  pushState?: PushState | null;
}

export function TourSheet({ open, index, onIndex, onClose, readOnly = false, pushState }: TourSheetProps) {
  useLocale();
  const slide = SLIDES[Math.min(Math.max(index, 0), SLIDES.length - 1)]!;
  const position = SLIDES.indexOf(slide);
  const last = position === SLIDES.length - 1;

  // THE FOCUS TRAP. Bound to the whole dialog the primitive renders, not to the tour's own body:
  // the sheet's ✕ lives in the primitive's sticky header, outside these children, and a trap that
  // only knew the body would make that ✕ unreachable by keyboard. Tab off the last control wraps to
  // the first, Shift+Tab off the first wraps to the last, and focus sitting on the panel itself
  // (where `useDialogFocus` puts it on open) counts as "before the first".
  const panelRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const dialog = panelRef.current?.closest<HTMLElement>("[role='dialog']");
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const at = items.findIndex((el) => el === document.activeElement);
      if (e.shiftKey) {
        if (at > 0) return;
        e.preventDefault();
        items[items.length - 1]!.focus();
        return;
      }
      if (at !== -1 && at < items.length - 1) return;
      e.preventDefault();
      items[0]!.focus();
    };
    dialog.addEventListener("keydown", onKey);
    return () => dialog.removeEventListener("keydown", onKey);
  }, [open, index]);

  // A horizontal swipe moves the slide. It must not fight the primitive's own vertical
  // drag-to-dismiss (ui/sheet.tsx), so it engages only once horizontal travel beats vertical travel
  // and passes the same 6px slop the primitive uses.
  const swipe = React.useRef({ x: 0, y: 0, live: false });
  const onTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    swipe.current = { x: touch.clientX, y: touch.clientY, live: true };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = swipe.current;
    swipe.current = { x: 0, y: 0, live: false };
    const touch = e.changedTouches[0];
    if (!s.live || !touch) return;
    const dx = touch.clientX - s.x;
    const dy = touch.clientY - s.y;
    if (Math.abs(dx) <= 6 || Math.abs(dx) <= Math.abs(dy)) return;
    if (dx < 0 && position < SLIDES.length - 1) onIndex(position + 1);
    if (dx > 0 && position > 0) onIndex(position - 1);
  };

  const Icon = slide.icon;
  const body =
    position === 1 && readOnly ? t("tour.slide2.bodyReadOnly") : t(slide.bodyKey);

  return (
    <BottomSheet
      open={open}
      onClose={() => onClose("skip")}
      title={t(slide.titleKey)}
      // Full height, overriding the primitive's `max-h-[82dvh]`: the tour is the whole screen while
      // it is up, and a sheet that leaves the dashboard peeking above it invites a tap on a control
      // the operator has not been told about yet.
      className="h-[100dvh] max-h-[100dvh] rounded-t-none"
    >
      <div ref={panelRef} data-slot="tour-panel" className="flex h-full flex-col">
        {/* Skip is text, on every slide, top-left. Never only an X: the ✕ in the sheet's own header
            reads as "close a dialog", and the operator needs to be told the tour is optional. */}
        <div className="flex justify-start">
          <Button variant="ghost" className="min-h-11 px-3 text-muted-foreground" onClick={() => onClose("skip")}>
            {t("tour.skip")}
          </Button>
        </div>

        <div
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-2 text-center"
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          {/* Slide 1 only: the same drawn mark the boot splash uses, so the first thing the operator
              sees on the tour is the thing they just watched bloom. No new asset. */}
          {position === 0 && <CollieMark size={64} weight="header" paper="var(--background)" />}
          <Icon className="size-8 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-xl font-semibold tracking-tight">{t(slide.titleKey)}</h2>
          <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{body}</p>
          {last && <TourPushSlot pushState={pushState} />}
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              disabled={position === 0}
              onClick={() => onIndex(position - 1)}
              aria-label={t("tour.dot", { n: Math.max(position, 1) })}
            >
              <ChevronLeft className="size-5" />
            </Button>
            <div className="flex items-center gap-2">
              {SLIDES.map((s, i) => (
                <button
                  key={s.titleKey}
                  type="button"
                  onClick={() => onIndex(i)}
                  aria-label={t("tour.dot", { n: i + 1 })}
                  aria-current={i === position ? "step" : undefined}
                  className={cn(
                    "size-2.5 rounded-md",
                    i === position ? "bg-foreground" : "bg-muted-foreground/40",
                  )}
                />
              ))}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              disabled={last}
              onClick={() => onIndex(position + 1)}
              aria-label={t("tour.dot", { n: Math.min(position + 2, SLIDES.length) })}
            >
              <ChevronRight className="size-5" />
            </Button>
          </div>
          <Button
            className="min-h-11 w-full"
            onClick={() => (last ? onClose("start") : onIndex(position + 1))}
          >
            {last ? t("tour.start") : t("tour.next")}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

/** Slide 3's push block, in whichever flavour the caller asked for. A controlled `pushState` keeps
 *  the playground off the browser's push API entirely; `undefined` wires the live hook up. */
function TourPushSlot({ pushState }: { pushState?: PushState | null }) {
  if (pushState === undefined) return <TourPushLive />;
  return <TourPushBlock state={pushState} busy={false} onEnable={async () => ({ ok: true })} />;
}

function TourPushLive() {
  const { state, busy, setEnabled } = usePushControl();
  return <TourPushBlock state={state} busy={busy} onEnable={() => setEnabled(true)} />;
}

/** The four outcomes slide 3 can be in, and nothing else: loading, not available, already decided,
 *  and the live offer. */
function TourPushBlock({
  state,
  busy,
  onEnable,
}: {
  state: PushState | null;
  busy: boolean;
  onEnable: () => Promise<EnableResult>;
}) {
  useLocale();
  const [note, setNote] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  // The first `getPushState()` has not resolved. One tick, so the button is simply disabled and
  // says nothing — a sentence here would be a claim we cannot back yet.
  if (state === null) {
    return (
      <Button className="min-h-11" disabled>
        {t("tour.push.enable")}
      </Button>
    );
  }
  if (state.availability !== "ready") {
    return <p className="text-xs text-muted-foreground">{availabilityNote(state.availability)}</p>;
  }
  if (state.subscribed) {
    return <p className="text-xs text-muted-foreground">{t("tour.push.subscribed")}</p>;
  }
  if (state.userDisabled) {
    return <p className="text-xs text-muted-foreground">{t("tour.push.userDisabled")}</p>;
  }
  if (done) {
    return <p className="text-xs text-muted-foreground">{t("tour.push.enabled")}</p>;
  }
  return (
    <div className="flex flex-col items-center gap-2">
      <Button
        className="min-h-11"
        disabled={busy}
        onClick={() => {
          setNote(null);
          void (async () => {
            const res = await onEnable();
            if (res.ok) setDone(true);
            else setNote(reasonText(res.reason));
          })();
        }}
      >
        {t("tour.push.enable")}
      </Button>
      {note !== null && <p className="text-xs text-status-blocked">{note}</p>}
    </div>
  );
}

export interface TourHostProps {
  /** The root snapshot, read once by `RootLayout` and passed down rather than re-read here. */
  home: HomeData;
  /** Told exactly once when the gate decides, and again when the sheet closes. */
  onDecision: (decision: "open" | "closed") => void;
}

/**
 * The gate. Mounted once, at the data root, inside `CrewProvider`. It opens the sheet on the first
 * render where the tour is unseen AND the snapshot on screen is real, and it never re-opens on its
 * own for the life of the document — a poll revalidation that flips `error` true and back must not
 * bring the tour back over a dashboard the operator is already using.
 *
 * A READ-ONLY DEVICE SEES THE TOUR. There is deliberately no fourth clause on `isReadOnly`: a family
 * tablet left on the dashboard is exactly the device that needs to be told what it is looking at.
 * Slide 2 branches its copy instead.
 */
export function TourHost({ home, onDecision }: TourHostProps) {
  useLocale();
  const seen = useTourSeen();
  const [open, setOpen] = React.useState(false);
  const [index, setIndex] = React.useState(0);
  const decided = React.useRef(false);

  React.useEffect(() => {
    if (decided.current) return;
    // Not a live snapshot: this render is the last-good one after a failed refresh, or the refresh
    // was refused outright. Neither is a first launch worth narrating, so we do not decide yet.
    if (home.error || home.authError) return;
    decided.current = true;
    if (!shouldShowTour(seen)) {
      onDecision("closed");
      return;
    }
    // Marked seen HERE, before the first slide paints. Nothing in the close path writes the key.
    markTourSeen();
    setOpen(true);
    onDecision("open");
  }, [home.error, home.authError, seen, onDecision]);

  if (!open) return null;
  return (
    <TourSheet
      open
      index={index}
      onIndex={setIndex}
      onClose={() => {
        setOpen(false);
        onDecision("closed");
      }}
      readOnly={isReadOnly(home.device)}
    />
  );
}
