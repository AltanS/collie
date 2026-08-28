import { cn } from "@/lib/utils";
import { CollieMark } from "@/components/collie-mark";
import { t } from "@/lib/i18n";
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
export function CollieHome({ onHome, trouble, lost = false, wordmark = false, className }: CollieHomeProps) {
  useLocale();
  const bloom = trouble && !lost;
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
          height. The row now states its own floor (`min-h-15` in AppHeader), so this box no longer
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
          loading={bloom}
          paper="var(--background)"
          className={cn("transition-opacity", lost && "opacity-40 grayscale")}
        />
      </span>
      {wordmark && <span className="text-lg font-semibold tracking-tight">Collie</span>}
    </button>
  );
}
