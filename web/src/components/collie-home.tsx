import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { CollieMark } from "@/components/collie-mark";
import { t } from "@/lib/i18n";
import { useStatus } from "@/lib/status";
import { useLocale } from "@/hooks/use-locale";

interface CollieHomeProps {
  /** Return to the dashboard. */
  onHome?: () => void;
  /** The connection has been not-live for a sustained beat (useConnectionTrouble, ≥4s) — bloom the
   *  mark. Below that (healthy, or a single slow poll) it stays still: the 4s delay is the flicker
   *  fix, so a normal polling hiccup never sets the orbit turning. */
  trouble: boolean;
  /** The outage has passed the escalation threshold (useConnectionLost, ≥15s). The bloom stops and
   *  the mark goes still again, muted — a mark that blooms forever reads as "still trying" when
   *  we've in fact given up; muted says "not connected" at a glance, matching the boot splash. */
  lost?: boolean;
  /** Show the "Collie" wordmark beside the mark (dashboard header). Omit inside a pane to save space. */
  wordmark?: boolean;
  className?: string;
}

// The single, shared Collie mark: brand + home button + connection loader in one, so the top-left of
// every screen means the same thing. ONE element in all three states — <CollieMark/>, which is a
// still drawing while live, starts turning (the "bloom") once the connection has been not-live for a
// sustained beat (`trouble`), and goes still again, muted, once the outage escalates (`lost`). That
// is why this no longer swaps a sprite for a still image: the old sprite had no rest frame (frame 0
// is a full-stretch mid-stride pose that reads as frozen mid-run), so rest had to be a different
// picture. This mark rests by not animating at all, so nothing is ever swapped and nothing can
// resize as the connection settles.
// The mark is now the app's ONLY animal: the boot splash and the idle cover bloom this same mark, so
// "Collie is fetching" looks the same wherever it appears. <DogGallop/> is untouched but no longer
// mounted anywhere in the app (see components/dog-gallop.tsx).
//
// Tapping it returns to the dashboard. The dashboard shows the "Collie" wordmark too; inside a pane
// the mark stands alone (the breadcrumb carries the context). Both headers render THIS component —
// the consistency is structural, not a convention two files have to keep agreeing on.
// One full round of the orbit at the mark's LOADING rate, in milliseconds. <CollieMark/> owns that
// rate (`TURN.live`, collie-mark.tsx) and does not export it, so this number is a copy and has to
// stay in step with it: shorter cuts the round off part way, longer starts a second one. The rate
// is set in the collie-brand repo (`SPRINT` in src/geometry.ts) — a change there has to be walked
// over to here by hand, and this is the only thing on this side that knows the number.
const ORBIT_TURN_MS = 1800;

export function CollieHome({ onHome, trouble, lost = false, wordmark = false, className }: CollieHomeProps) {
  useLocale();
  const bloom = trouble && !lost;

  // ONE FULL ROUND OF THE ORBIT whenever a status is published (a send, a kill, an error —
  // lib/status.ts). The notice itself no longer moves the page to announce itself: it floats now,
  // and a thing that floats in at the top of a busy screen is easy to miss. The mark is the second
  // half of that announcement — it is already where the eye goes for connection state, so the round
  // lands where the reader is watching, and it costs no layout.
  //
  // It is the ORBIT that turns, not the mark. The whole SVG was rotated first and that was wrong:
  // the head span round with it, which is not a thing the drawing does. So this uses the mark's own
  // `loading` input instead — the same beads on the same path, at 20x the resting drift. The mark
  // carries the phase across the rate change by hand (collie-mark.tsx says how), so the round joins
  // the drift where it left it and rejoins it where it lands. Nothing jumps at either end.
  //
  // The accents come up to full chroma for the round as well. That is the mark's own coupling, not
  // an extra: under `prefers-reduced-motion` the turning stops and the colour is the only thing
  // left saying anything happened.
  //
  // It never fights the connection state. `bloom` is already the loading input and outranks this —
  // a round would tell the reader nothing there — and while `lost` the mark stays still and muted,
  // which is a state a passing event must not overwrite.
  // ONE round per burst, not one per status. A single action often publishes more than one — a send
  // acknowledges, then the pane's own lifecycle moves — and restarting the timer on each of them
  // ran the orbit on and on, which is a STATE again and the exact thing the round must not look
  // like. So a status that lands while a round is already turning is dropped: the round it would
  // have started is already on screen, saying the same thing.
  const status = useStatus();
  const statusId = status?.id ?? 0;
  const [round, setRound] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (statusId === 0 || timer.current !== null) return;
    setRound(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setRound(false);
    }, ORBIT_TURN_MS);
    // NO CLEANUP HERE, deliberately. React runs an effect's cleanup on every dependency change,
    // before the next run — so a cleanup that cleared the timer would clear the very thing the
    // guard above reads, and the second status of a burst would find the coast clear and restart
    // the round. That is the bug this guard exists to stop. The timer is torn down on UNMOUNT
    // instead, by the effect below.
  }, [statusId]);
  useEffect(() => () => (timer.current === null ? undefined : clearTimeout(timer.current)), []);
  return (
    <button
      type="button"
      onClick={onHome}
      // The bloom conveys connection state visually; fold it into the button's accessible name too,
      // so screen-reader users get it (inside a pane there's no other cue).
      aria-label={
        !trouble
          ? t("nav.home.aria.default")
          : lost
            ? t("nav.home.aria.lost")
            : t("nav.home.aria.reconnecting")
      }
      className={cn(
        "-mx-1 flex items-center gap-2 rounded px-1 transition-opacity active:opacity-70",
        className,
      )}
    >
      {/* No ring, no disc: the badge existed because the old sprite was a transparent cut-out that
          floated on the bar. This mark carries its own ring — the orbit IS the frame — and a
          40px circle with `overflow-hidden` would clip the beads that pass widest.

          The DRAWING is 40px; the BOX around it is `size-11` (44px), the same tap floor every other
          icon control in the header carries (SettingsGear, the Settings/Pack back button). This is a
          real button — it navigates home — so 40px was simply under the target, and it was also what
          made the header row 4px shorter inside a pane, where no 44px gear was there to set the
          height. The row now states its own floor (`min-h-15` in app-header.tsx), so this box no longer
          SIZES the header; it just stops being the short child. Keep the two numbers apart: 40 is the
          mark, 44 is the touchable box it is centred in.

          `paper` is the header's own ground, which is `bg-background` (app-header.tsx — chrome is
          the page colour, separated by a rule, not a fill). It is the colour of the knockout that
          makes a near-side bead read as being IN FRONT of the head; anything else shows up as a
          halo around those beads, so this value tracks the ground and is not a taste choice. The
          two are COUPLED and the coupling is easy to forget, so app-header.test.tsx fails if the
          header's background utility and this prop ever name different tokens.

          Muted while lost — grayscale + dimmed, to read asleep/inactive — and the orbit stops
          turning again. Mirrors the boot splash's not-connected state. */}
      <span className="grid size-11 shrink-0 place-items-center">
        <CollieMark
          size={40}
          weight="header"
          loading={bloom || (round && !lost)}
          paper="var(--background)"
          className={cn("transition-opacity", lost && "opacity-40 grayscale")}
        />
      </span>
      {wordmark && <span className="text-lg font-semibold tracking-tight">Collie</span>}
    </button>
  );
}
