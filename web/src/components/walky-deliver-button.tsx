import type { ComponentProps } from "react";

import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * "Deliver now" (deliver-now prototype): hand one held message to the agent as data, the draft left as it is.
 * One button for the Messages sheet's row and for the held mark. While the call runs it is disabled and a
 * spinner stands over the word; the word stays in the box, only hidden, so the button keeps its width and
 * nothing beside it moves (DESIGN.md §2). The caller's `className` sizes it: 44px tall in the sheet, the
 * notice's 24px with a 44px reach on the mark (`NOTICE_ACTION`).
 */
export function DeliverNowButton({
  busy,
  className,
  variant = "outline",
  disabled = false,
  ...rest
}: { busy: boolean } & Omit<ComponentProps<typeof Button>, "children" | "size">) {
  useLocale();
  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      data-slot="walky-deliver"
      className={cn("relative", className)}
      disabled={busy || disabled}
      aria-busy={busy || undefined}
      {...rest}
    >
      <span className={cn(busy && "opacity-0")}>{t("walky.sheet.deliverNow")}</span>
      {busy && <Icon name="busy" aria-hidden="true" className="absolute size-4 animate-spin" />}
    </Button>
  );
}
