import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

/**
 * THE UNSEEN MARK: a filled SQUARE in full ink, meaning "a reply is waiting that you have not
 * opened" (`isUnseen()`, lib/triage.ts).
 *
 * A square because no status mark is one: blocked is a triangle, working a half-filled circle, done
 * a disc, idle a ring (`StatusDot`). Colour is already spent on status (red, amber, green, grey), and
 * green already means done, so an unseen dot in any colour read as one more status, or, in white, as
 * nothing much. A different SHAPE says a different kind of fact, needs no colour, and so reads the
 * same in both themes and to a colour-blind eye. Chosen 2026-09-16 over a violet or sky-blue dot that
 * would have replaced the status dot; since issue 420 (2026-10-12) it is one of five shapes and no
 * longer the only one.
 *
 * It is drawn in the status marks' own 12px box: a 9px square with 1.5px corners, so its weight sits
 * beside a disc and a triangle, and it stays `text-foreground`, full ink, not a status colour. A
 * caller that needs a smaller slot passes its own `size-*`.
 *
 * `reserve` keeps the slot when the pane is seen, drawn invisible, so a row's name truncates at the
 * same width in both states and nothing shifts when the mark comes or goes (DESIGN.md's no-shift
 * rule). The words are for a screen reader only when the mark is drawn.
 */
export function UnseenMark({
  on = true,
  reserve = false,
  decorative = false,
  className,
}: {
  on?: boolean;
  reserve?: boolean;
  decorative?: boolean;
  className?: string;
}) {
  useLocale();
  if (!on && !reserve) return null;
  const labelled = on && !decorative;
  return (
    <svg
      viewBox="0 0 12 12"
      role={labelled ? "img" : undefined}
      aria-label={labelled ? t("home.row.unseen") : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      className={cn("size-3 shrink-0 self-center text-foreground", !on && "invisible", className)}
    >
      <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill="currentColor" />
    </svg>
  );
}
