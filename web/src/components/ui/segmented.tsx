import { cn } from "@/lib/utils";

/** One segment. */
export interface SegmentedOption<V extends string> {
  value: V;
  /** ALREADY TRANSLATED. */
  label: string;
}

export interface SegmentedProps<V extends string> {
  options: readonly SegmentedOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** ALREADY TRANSLATED. The group's accessible name. */
  label: string;
  /**
   * What choosing means. `tabs` is a switch between two screens (Changes | Files): a tablist whose
   * selected tab is `aria-selected`. `choice` is one setting with a few values (Source | Preview): a
   * radio group. The look is the same; a screen reader hears the right kind of control.
   */
  semantics?: "tabs" | "choice";
  className?: string;
}

/**
 * Two or three labelled segments in one row, exactly one selected: a tap picks one. Equal widths, a
 * 44px floor (DESIGN.md §6), 2px corners (§3).
 *
 * NOTHING MOVES ON A SWITCH (DESIGN.md §2). Every segment reserves a 1px border, and the selected
 * one only recolours it, so a switch repaints and re-lays-out nothing. The weight never changes
 * either, because a bold word is a wider word. Neighbours overlap by one pixel (`-ml-px`) so two
 * edges read as one line, and the selected edge sits above its neighbour's (`z-10`) so it is not
 * half hidden by it.
 *
 * It owns the look and the roles. It owns no words and no state.
 */
export function Segmented<V extends string>({
  options,
  value,
  onChange,
  label,
  semantics = "choice",
  className,
}: SegmentedProps<V>) {
  const tabs = semantics === "tabs";
  return (
    <div role={tabs ? "tablist" : "radiogroup"} aria-label={label} data-slot="segmented" className={cn("flex", className)}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role={tabs ? "tab" : "radio"}
            aria-selected={tabs ? on : undefined}
            aria-checked={tabs ? undefined : on}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative -ml-px min-h-11 min-w-0 flex-1 truncate border px-4 text-sm font-medium first:ml-0 first:rounded-l-sm last:rounded-r-sm focus-visible:z-20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              on ? "z-10 border-foreground text-foreground" : "border-border text-muted-foreground active:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
