import { cn } from "@/lib/utils";

/** One segment. */
export interface SegmentedOption<V extends string | number> {
  value: V;
  /** ALREADY TRANSLATED. */
  label: string;
  /**
   * ALREADY TRANSLATED. A state the segment's view is in that the operator should see before opening
   * it (an alert firing behind the Alerts tab). Drawn as a small dot after the label in the blocked
   * colour, and said as these words to a screen reader, so it is never colour alone.
   */
  mark?: string;
}

export interface SegmentedProps<V extends string | number> {
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
  /** Every segment is inert together, for a choice that is being saved. */
  disabled?: boolean;
  className?: string;
}

/**
 * Two to four labelled segments in one row, exactly one selected: a tap picks one. Equal widths, a
 * 44px floor (DESIGN.md §6), 2px corners (§3).
 *
 * NOTHING MOVES ON A SWITCH (DESIGN.md §2). Every segment reserves a 1px border, and the selected
 * one only recolours it, so a switch repaints and re-lays-out nothing. The weight never changes
 * either, because a bold word is a wider word. Neighbours overlap by one pixel (`-ml-px`) so two
 * edges read as one line, and the selected edge sits above its neighbour's (`z-10`) so it is not
 * half hidden by it.
 *
 * Values are strings or numbers (the alert threshold and duration choices are numbers). Tapping the
 * selected segment does nothing, and `disabled` makes every segment inert together.
 *
 * It owns the look and the roles. It owns no words and no state.
 */
export function Segmented<V extends string | number>({
  options,
  value,
  onChange,
  label,
  semantics = "choice",
  disabled = false,
  className,
}: SegmentedProps<V>) {
  const tabs = semantics === "tabs";
  // Equal widths mean four segments get a quarter of the row each. At 375 px that is about 78 px,
  // and `px-4` spent 32 of them on air, which left "30 min" (about 50 px at 14 px) clipped to "30 m…".
  // The padding follows the count, so two and three segments keep the look they have always had.
  const pad = options.length >= 5 ? "px-1" : options.length === 4 ? "px-2" : "px-4";
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
            // A mark is said in words: the name becomes "Alerts, alert firing" rather than a dot.
            aria-label={option.mark === undefined ? undefined : `${option.label}, ${option.mark}`}
            disabled={disabled}
            onClick={() => {
              // A choice is never un-picked, and a caller that posts on change is not asked to post
              // twice for a tap on the segment that is already on.
              if (!on) onChange(option.value);
            }}
            className={cn(
              pad,
              "relative -ml-px min-h-11 min-w-0 flex-1 truncate border text-sm font-medium first:ml-0 first:rounded-l-sm last:rounded-r-sm focus-visible:z-20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
              on ? "z-10 border-foreground text-foreground" : "border-border text-muted-foreground active:text-foreground",
            )}
          >
            {option.label}
            {option.mark !== undefined && (
              <span aria-hidden data-slot="segmented-mark" className="ml-1.5 inline-block size-2 rounded-full bg-status-blocked align-middle" />
            )}
          </button>
        );
      })}
    </div>
  );
}
