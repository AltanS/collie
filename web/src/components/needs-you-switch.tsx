import { CircleDot } from "lucide-react";

import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// The Dashboard's "needs you" switch (ADR 0085, the old Focus tab of ADRs 0066 and 0068). One
// toggle button in the summary line's row, beside the order toggle. On, each workspace shows only the
// panes that need you; it is a filter and never a sort, and the rules are ADR 0066 point 2's.
//
// It wears `CircleDot`, the icon the Focus tab wore, so a person who knew the tab finds the switch.
// On, it takes the primary tint (`bg-primary/10 text-primary`, as the Changes filter button does)
// and a hairline primary ring. The ring is what keeps it apart from the order toggle's selected
// segment, which is `bg-muted`: with the brand's near-black primary the two fills read alike, and one
// control on and the other selected must never look like the same state.
// The glyph is the control and the accessible name says what it does; `aria-pressed` says its state.
// A 44px square, like the order toggle's segments.
export function NeedsYouSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  useLocale();
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={t("home.needsYouOnly")}
      onClick={() => onChange(!on)}
      className={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-md transition-colors",
        on ? "bg-primary/10 text-primary ring-1 ring-inset ring-primary/40" : "text-muted-foreground active:bg-muted",
      )}
    >
      <CircleDot className="size-4 shrink-0" aria-hidden />
    </button>
  );
}
