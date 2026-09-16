import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

/**
 * THE UNSEEN MARK: a small filled SQUARE in full ink, meaning "a reply is waiting that you have not
 * opened" (`isUnseen()`, lib/triage.ts).
 *
 * A square because every status mark in Collie is round. Colour is already spent on status (red,
 * amber, green, grey), and green already means done, so an unseen dot in any colour read as one more
 * status, or, in white, as nothing much. A different SHAPE says a different kind of fact, needs no
 * colour, and so reads the same in both themes and to a colour-blind eye. Chosen 2026-09-16 over a
 * violet or sky-blue dot that would have replaced the status dot.
 *
 * `reserve` keeps the slot when the pane is seen, drawn invisible, so a row's name truncates at the
 * same width in both states and nothing shifts when the mark comes or goes (DESIGN.md's no-shift
 * rule). The words are for a screen reader only when the mark is drawn.
 */
export function UnseenMark({
  on = true,
  reserve = false,
  size = "md",
  className,
}: {
  on?: boolean;
  reserve?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  useLocale();
  if (!on && !reserve) return null;
  return (
    <span
      role={on ? "img" : undefined}
      aria-label={on ? t("home.row.unseen") : undefined}
      aria-hidden={on ? undefined : true}
      className={cn(
        "shrink-0 self-center rounded-[2px] bg-foreground",
        size === "sm" ? "size-1.5" : "size-2",
        !on && "invisible",
        className,
      )}
    />
  );
}
