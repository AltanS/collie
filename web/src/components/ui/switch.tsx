import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
}

// Minimal accessible toggle (no Radix dependency): a button with role="switch". The thumb slides
// across a pill track; colors follow the theme tokens used elsewhere.
function Switch({ checked, onCheckedChange, disabled, id, ...rest }: SwitchProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      data-slot="switch"
      className={cn(
        // The track is 24×44 — wider than it is tall, so it is a stadium, and `rounded-full` on a
        // stadium is reserved shape this language does not spend. 2px, like every other box.
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
        // The OFF track needs real contrast against the card it sits on, or you can't read your own
        // settings: `bg-muted` is 1.09:1 on a white card, and the thumb is white on top of that —
        // a white blob on white, legible only by its shadow. WCAG 1.4.11 wants 3:1 for state.
        // A border carries the off state instead, since a fill dark enough to read would look
        // switched-on.
        // Solid border, not /60: the measurement was taken on the old `rounded-full` track, where no
        // straight edge existed at all, so the whole stroke was antialiased and an alpha border
        // rendered lighter than it computed (2.65:1 spec → 1.74:1 actual). At 2px radius most of the
        // stroke is now straight and the loss is smaller — but it has not been re-measured, and the
        // failure it guards against is a settings screen you cannot read. Stays full strength.
        //
        // The border is present in BOTH states, transparent when on. It has to be: `border-box`
        // means a 2px border pulls the content box in 2px, so with the border on one side only, the
        // thumb's `translate-x-0.5` rest position was 4px when off and 2px when on — the thumb hopped
        // sideways on every flip. Same box in both states, no hop.
        checked
          ? "border-2 border-transparent bg-primary"
          : "border-2 border-muted-foreground bg-muted",
      )}
      {...rest}
    >
      <span
        className={cn(
          // The thumb is the one full-round shape here, and it earns it: size-5 is square, so this
          // is a disc, not a stadium.
          "inline-block size-5 transform rounded-full bg-background shadow transition-transform",
          // Measured against the CONTENT box, which the always-present 2px border insets on both
          // sides: the box is 40px wide and the thumb is 20px, so 0 and 1.25rem park it flush left
          // and flush right with an even 2px of track showing either side. The old 1.375rem was
          // measured against a borderless checked track and now overshoots by 2px.
          checked ? "translate-x-[1.25rem]" : "translate-x-0",
        )}
      />
    </button>
  );
}

export { Switch };
