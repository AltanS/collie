import type { ReactNode } from "react";

import type { RegisteredId } from "@/lib/settings";
import { cn } from "@/lib/utils";

/**
 * One place on a Settings page that draws registry rows (ADR 0170): today's control, wrapped, and marked with the
 * ids it draws. The marks are what the completeness test reads and what a search result scrolls to. A control that
 * renders nothing (Haptics on a phone that cannot vibrate) leaves an empty slot, and `empty:hidden` gives it no
 * height, so the page's `space-y-4` draws no gap for it.
 */
export function SettingSlot({ ids, className, children }: { ids: readonly RegisteredId[]; className?: string; children: ReactNode }) {
  return (
    <div
      data-setting={ids.join(" ")}
      // The mark of a search result (components/settings-page.tsx): the focus frame's own outline, never a new colour.
      className={cn(
        "scroll-my-4 rounded-xl empty:hidden data-[marked=true]:outline-2 data-[marked=true]:outline-offset-2 data-[marked=true]:outline-ring",
        className,
      )}
    >
      {children}
    </div>
  );
}
