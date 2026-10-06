import type { Handle } from "remix/component";

import { t } from "@web/lib/i18n";
import { cn } from "@web/lib/utils";

// Port of web/src/components/ui/unseen-mark.tsx: a small filled SQUARE in full ink, "a reply is
// waiting that you have not opened". A square because every status mark is round. `reserve` keeps
// the slot invisible when seen, so nothing shifts when the mark comes or goes.
export interface UnseenMarkProps {
  on?: boolean;
  reserve?: boolean;
  size?: "sm" | "md";
  class?: string;
}

export function UnseenMark(handle: Handle<UnseenMarkProps>) {
  return () => {
    const { on = true, reserve = false, size = "md" } = handle.props;
    if (!on && !reserve) return null;
    return (
      <span
        role={on ? "img" : undefined}
        aria-label={on ? t("home.row.unseen") : undefined}
        aria-hidden={on ? undefined : "true"}
        class={cn(
          "shrink-0 self-center rounded-[2px] bg-foreground",
          size === "sm" ? "size-1.5" : "size-2",
          !on && "invisible",
          handle.props.class,
        )}
      />
    );
  };
}
