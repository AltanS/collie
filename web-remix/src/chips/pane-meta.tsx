import type { Handle } from "remix/component";

import type { PaneCache } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { CacheChip } from "./cache-chip";
import { HostChip, SessionChip } from "./host-chip";

// Port of web/src/components/pane-meta.tsx: the address and the cache reading at the end of a row's
// name line (and on the pane header's meta line), in one 12 px box. Each chip owns its hide rule; the
// "·" before the cache reading is CSS (`first:` drops it when nothing stands to its left, `empty:`
// drops the wrapper when the chip drew nothing), so no predicate here copies a chip's rule.
export interface PaneMetaProps {
  host: string | undefined;
  cache: PaneCache | undefined;
  session?: string | undefined;
  /** Given, the cache reading is a button that opens the sheet; omitted, plain type (a row). */
  onOpenCache?: () => void;
  class?: string;
}

export function PaneMeta(handle: Handle<PaneMetaProps>) {
  return () => {
    const { host, cache, session, onOpenCache } = handle.props;
    return (
      <div data-slot="pane-meta" class={cn("flex h-3 shrink-0 items-baseline gap-1.5", handle.props.class)}>
        <HostChip host={host} variant="bare" />
        <SessionChip session={session} />
        <span class="flex items-baseline gap-1.5 before:text-muted-foreground/60 before:content-['·'] first:before:content-none empty:hidden">
          <CacheChip
            cache={cache}
            variant={onOpenCache === undefined ? "row" : "button"}
            onOpen={onOpenCache}
            class={cn(
              "text-[11px]/3",
              onOpenCache !== undefined && "relative before:absolute before:inset-x-0 before:-top-0.5 before:-bottom-4 before:content-['']",
            )}
          />
        </span>
      </div>
    );
  };
}
