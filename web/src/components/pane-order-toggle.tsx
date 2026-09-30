import { Clock, FolderTree } from "lucide-react";

import { cn } from "@/lib/utils";
import { PANE_ORDERS, type PaneOrder } from "@/lib/pane-order";
import { t, type MessageKey } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

// Place or Activity: the two-way segmented choice that decides which way a pane list runs
// (lib/pane-order.ts, ADR 0071). ONE control, drawn in two places — at the top of the pane switcher
// where the order is read, and on the Settings page where a person goes looking for it — because the
// two write the same stored value and a person who finds one should recognise the other.
//
// THE SELECTED SEGMENT IS `bg-muted`, NOT `bg-primary`, and that is deliberate on the sheet's
// account. The switcher keeps the primary ink for two things only: the row you are in, and the mark
// that says a pane needs you (ADR 0063 point 3, "urgency is a mark, and it has one place to go"). A
// filled segment here would be the loudest thing on a sheet whose whole job is to let an alarm be
// seen. Same treatment as `ChangesLayoutToggle`, which answers the same kind of question.
const SEGMENTS = {
  place: { label: "paneOrder.place", Icon: FolderTree },
  activity: { label: "paneOrder.activity", Icon: Clock },
} as const satisfies Record<PaneOrder, { label: MessageKey; Icon: typeof Clock }>;

export function PaneOrderToggle({
  order,
  onChange,
  className,
}: {
  order: PaneOrder;
  onChange: (order: PaneOrder) => void;
  className?: string;
}) {
  useLocale();
  return (
    <div role="radiogroup" aria-label={t("paneOrder.aria")} className={cn("flex gap-1", className)}>
      {PANE_ORDERS.map((value) => {
        const { label, Icon } = SEGMENTS[value];
        const selected = value === order;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(value)}
            className={cn(
              // 44px floor, and the weight is unconditional so a selection repaints and never
              // re-lays-out the row beneath it.
              "flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              selected ? "bg-muted text-foreground" : "text-muted-foreground active:bg-muted",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            {t(label)}
          </button>
        );
      })}
    </div>
  );
}
