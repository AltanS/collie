import { on, type Handle, type RemixNode } from "remix/component";

import { cn } from "@web/lib/utils";

import { UnseenMark } from "./unseen-mark";

// Port of web/src/components/ui/tab-bar.tsx: the bottom tab bar. The active mark is a 2px top edge
// every tab reserves; badges float absolutely on the icon's corner, so nothing moves on a switch.
export interface TabBarItem<V extends string> {
  value: V;
  label: string;
  icon: RemixNode;
  badge?: number;
  dot?: boolean;
  badgeLabel?: string;
}

export interface TabBarProps<V extends string> {
  items: readonly TabBarItem<V>[];
  active: V | null;
  onSelect: (value: V) => void;
  label: string;
  class?: string;
}

export function TabBar<V extends string>(handle: Handle<TabBarProps<V>>) {
  return () => {
    const { items, active, label } = handle.props;
    return (
      <nav
        aria-label={label}
        data-slot="tab-bar"
        translate="no"
        class={cn("shrink-0 border-t border-rule bg-background pb-[env(safe-area-inset-bottom)]", handle.props.class)}
      >
        <div class="flex">
          {items.map((it) => {
            const selected = it.value === active;
            const badge = it.badge !== undefined && it.badge > 0 ? it.badge : undefined;
            const dot = badge === undefined && it.dot === true;
            const marked = badge !== undefined || dot;
            return (
              <button
                key={it.value}
                type="button"
                aria-current={selected ? "page" : undefined}
                mix={on("click", () => handle.props.onSelect(it.value))}
                class={cn(
                  "relative -mt-px flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 border-t-2 border-transparent px-1 text-[11px] font-medium select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  selected ? "border-foreground text-foreground" : "text-muted-foreground",
                )}
              >
                <span class="relative flex size-5 items-center justify-center" aria-hidden="true">
                  {it.icon}
                  {badge !== undefined && (
                    <span
                      data-slot="tab-badge"
                      class="absolute -top-1.5 left-[calc(100%-0.25rem)] flex h-4 min-w-4 items-center justify-center rounded-sm bg-status-blocked px-1 text-[10px] leading-none font-semibold text-background tabular-nums"
                    >
                      {badge}
                    </span>
                  )}
                  {dot && (
                    <span data-slot="tab-dot" class="absolute -top-0.5 left-[calc(100%-0.125rem)] flex">
                      <UnseenMark />
                    </span>
                  )}
                </span>
                <span class="max-w-full truncate leading-tight">{it.label}</span>
                {marked && it.badgeLabel !== undefined && <span class="sr-only">, {it.badgeLabel}</span>}
              </button>
            );
          })}
        </div>
      </nav>
    );
  };
}
