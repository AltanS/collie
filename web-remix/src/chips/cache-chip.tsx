import { on, type Handle } from "remix/component";
import { Hourglass } from "lucide";

import { cacheChipView } from "@web/lib/cache-view";
import { t } from "@web/lib/i18n";
import type { PaneCache } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { clock } from "../lib/clock";
import { useLocale } from "../lib/i18n-store";
import { useStore } from "../lib/store";
import { Icon } from "../ui/icon";

// Port of web/src/components/cache-chip.tsx: how long a pane's prompt cache stays warm, as an
// hourglass in the state's ink and a minutes label (`12m`, `<1m`, the word for cold), with a dot when
// an override set the rule. The words are web/'s pure `cacheChipView` (reused read-only: the 10 s
// grace, the bridge trusted for cold). One shared 1 s page clock (lib/clock.ts) ticks every chip; a
// screen with no chip runs no timer.
//
// `row` is plain type (the dashboard row is already one button); `button` is the pane header's form,
// a control that opens the cache sheet.
const TONE_CLASS = {
  warm: "text-status-done/60",
  expiring: "text-status-blocked",
  cold: "text-status-info/70",
} as const;

export interface CacheChipProps {
  cache: PaneCache | undefined;
  variant?: "row" | "button";
  onOpen?: () => void;
  class?: string;
}

export function CacheChip(handle: Handle<CacheChipProps>) {
  const now = useStore(handle, clock);
  useLocale(handle);
  return () => {
    const { cache, variant = "row" } = handle.props;
    const view = cacheChipView(cache, now());
    if (view === null) return null;
    const label = t(`cache.${cache?.state === "cold" ? "cold" : cache?.state === "expiring" ? "expiring" : "warm"}`);
    const shared = cn(
      "flex shrink-0 items-baseline gap-1 text-xs leading-none tabular-nums text-muted-foreground",
      handle.props.class,
    );
    const body = (
      <>
        <Icon icon={Hourglass} class={cn("size-3 shrink-0 translate-y-[0.35px]", TONE_CLASS[view.tone])} />
        <span aria-hidden="true">{view.label}</span>
        {view.overridden ? (
          <>
            <span aria-hidden="true" data-overridden="true" class="size-1 shrink-0 rounded-full bg-current opacity-70" />
            <span class="sr-only">{t("cache.overridden")}</span>
          </>
        ) : null}
      </>
    );
    if (variant === "button") {
      return (
        <button
          type="button"
          data-slot="cache-chip"
          data-tone={view.tone}
          aria-label={`${label}, ${view.label}`}
          class={cn(shared, "transition-opacity active:opacity-60")}
          mix={on("click", () => handle.props.onOpen?.())}
        >
          {body}
        </button>
      );
    }
    return (
      <span data-slot="cache-chip" data-tone={view.tone} class={shared}>
        {body}
        <span class="sr-only">{label}</span>
      </span>
    );
  };
}
