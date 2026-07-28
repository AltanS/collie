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
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        // The OFF track needs real contrast against the card it sits on, or you can't read your own
        // settings: `bg-muted` is 1.09:1 on a white card, and the thumb is white on top of that —
        // a white blob on white, legible only by its shadow. WCAG 1.4.11 wants 3:1 for state.
        // A border carries the off state instead, since a fill dark enough to read would look
        // switched-on.
        // Solid border, not /60: `rounded-full` on a 24px pill leaves no straight edge, so the whole
        // stroke is antialiased and an alpha border renders lighter than it computes (2.65:1 spec →
        // 1.74:1 actual). Full strength survives the antialiasing.
        checked ? "bg-primary" : "border-2 border-muted-foreground bg-muted",
      )}
      {...rest}
    >
      <span
        className={cn(
          "inline-block size-5 transform rounded-full bg-background shadow transition-transform",
          checked ? "translate-x-[1.375rem]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export { Switch };
