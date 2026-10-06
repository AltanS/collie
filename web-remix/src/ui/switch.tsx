import { on, type Handle } from "remix/component";

import { cn } from "@web/lib/utils";

// Port of web/src/components/ui/switch.tsx: a button with role="switch". The border is present in
// both states (transparent when on), so the thumb never hops sideways on a flip.
export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

export function Switch(handle: Handle<SwitchProps>) {
  return () => {
    const { checked, onCheckedChange: _onChange, disabled, id, ...rest } = handle.props;
    return (
      <button
        {...rest}
        id={id}
        type="button"
        role="switch"
        aria-checked={checked ? "true" : "false"}
        disabled={disabled}
        data-slot="switch"
        mix={on("click", () => handle.props.onCheckedChange(!handle.props.checked))}
        class={cn(
          "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "border-2 border-transparent bg-primary" : "border-2 border-muted-foreground bg-muted",
        )}
      >
        <span
          class={cn(
            "inline-block size-5 transform rounded-full bg-background shadow transition-transform",
            checked ? "translate-x-[1.25rem]" : "translate-x-0",
          )}
        />
      </button>
    );
  };
}
