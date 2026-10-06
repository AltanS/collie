import { on, type Handle } from "remix/component";

import { cn } from "@web/lib/utils";

// Port of web/src/components/ui/segmented.tsx: two to four labelled segments, one selected. Every
// segment reserves a 1px border and the selected one only recolours it, so a switch moves nothing.
export interface SegmentedOption<V extends string | number> {
  value: V;
  label: string;
  mark?: string;
  badge?: number;
  badgeLabel?: string;
}

export interface SegmentedProps<V extends string | number> {
  options: readonly SegmentedOption<V>[];
  value: V;
  onChange: (value: V) => void;
  label: string;
  semantics?: "tabs" | "choice";
  disabled?: boolean;
  badgeClass?: string;
  class?: string;
}

export function Segmented<V extends string | number>(handle: Handle<SegmentedProps<V>>) {
  return () => {
    const { options, value, label, semantics = "choice", disabled = false } = handle.props;
    const badgeClass = handle.props.badgeClass ?? "bg-primary text-primary-foreground";
    const tabs = semantics === "tabs";
    const pad = options.length >= 5 ? "px-1" : options.length === 4 ? "px-2" : "px-4";
    return (
      <div role={tabs ? "tablist" : "radiogroup"} aria-label={label} data-slot="segmented" class={cn("flex", handle.props.class)}>
        {options.map((option) => {
          const selected = option.value === value;
          const badged = option.badge !== undefined && option.badge > 0;
          const said = [option.mark, badged ? option.badgeLabel : undefined].filter((w): w is string => w !== undefined);
          return (
            <button
              key={option.value}
              type="button"
              role={tabs ? "tab" : "radio"}
              aria-selected={tabs ? (selected ? "true" : "false") : undefined}
              aria-checked={tabs ? undefined : selected ? "true" : "false"}
              aria-label={said.length === 0 ? undefined : `${option.label}, ${said.join(", ")}`}
              disabled={disabled}
              mix={on("click", () => {
                if (option.value !== handle.props.value) handle.props.onChange(option.value);
              })}
              class={cn(
                pad,
                "relative -ml-px min-h-11 min-w-0 flex-1 truncate border text-sm font-medium first:ml-0 first:rounded-l-sm last:rounded-r-sm focus-visible:z-20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
                selected ? "z-10 border-foreground text-foreground" : "border-border text-muted-foreground active:text-foreground",
              )}
            >
              {option.label}
              {option.mark !== undefined && (
                <span aria-hidden="true" data-slot="segmented-mark" class="ml-1.5 inline-block size-2 rounded-full bg-status-blocked align-middle" />
              )}
              {badged && (
                <span
                  aria-hidden="true"
                  data-slot="segmented-badge"
                  class={cn(
                    "absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-sm px-1 text-[10px] leading-none font-semibold tabular-nums",
                    badgeClass,
                  )}
                >
                  {option.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    );
  };
}
