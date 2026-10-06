// The shapes every Settings card shares, so a card is its content and not its furniture. Web draws
// each of these by hand in every control (icon, title, one sentence, then a switch or a band under a
// `border-border` divider); the markup here is the same markup, written once.
//
// All text arrives translated: the caller renders from `t()`, and subscribes to the locale itself.
import { on, type Handle, type RemixNode } from "remix/component";
import { LoaderCircle, type IconNode } from "lucide";

import { cn } from "@web/lib/utils";

import { Icon } from "../../ui/icon";
import { Switch } from "../../ui/switch";

export interface CardHeadProps {
  icon: IconNode;
  title: string;
  description?: string;
  /** What sits at the row's right end: a switch slot, a spinner, a button. */
  children?: RemixNode;
}

/** The card's first row: a 20 px glyph, the title, one muted sentence, and a slot on the right. */
export function CardHead(handle: Handle<CardHeadProps>) {
  return () => {
    const { icon, title, description, children } = handle.props;
    return (
      <div class="flex items-center justify-between gap-4 p-4">
        <div class="flex min-w-0 items-start gap-3">
          <Icon icon={icon} class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div class="min-w-0">
            <div class="font-medium">{title}</div>
            {description === undefined ? null : <p class="text-sm text-muted-foreground">{description}</p>}
          </div>
        </div>
        {children}
      </div>
    );
  };
}

/** A fixed slot the size of the Switch (h-6 w-11): a spinner swapped for it never resizes the row. */
export function SwitchSlot(handle: Handle<{ children?: RemixNode }>) {
  return () => <div class="flex h-6 w-11 shrink-0 items-center justify-center">{handle.props.children}</div>;
}

export function Spinner() {
  return () => <Icon icon={LoaderCircle} class="size-4 shrink-0 animate-spin text-muted-foreground" />;
}

export interface SwitchRowProps {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Hang under a titled row's text (`pl-12`) instead of at the card's edge. */
  nested?: boolean;
  /** The label reads muted while the row it depends on is off. */
  dim?: boolean;
}

/** A divider-topped row with a label, a hint and a switch: the notify and zen sub-row shape. */
export function SwitchRow(handle: Handle<SwitchRowProps>) {
  return () => {
    const { label, hint, checked, disabled, nested = false, dim = false } = handle.props;
    return (
      <div class={cn("flex items-center justify-between gap-4 border-t border-border py-3 pr-4", nested ? "pl-12" : "pl-4")}>
        <div class="min-w-0">
          <div class={cn("text-sm font-medium", dim && "text-muted-foreground")}>{label}</div>
          {hint === undefined ? null : <p class="text-xs text-muted-foreground">{hint}</p>}
        </div>
        <Switch checked={checked} disabled={disabled} aria-label={label} onCheckedChange={(next) => handle.props.onChange(next)} />
      </div>
    );
  };
}

export interface ChoiceOption<V extends string | number> {
  value: V;
  label: string;
  /** Set when the visible text is a digit and the name says what it counts. */
  aria?: string;
}

export interface ChoiceBandProps<V extends string | number> {
  options: readonly ChoiceOption<V>[];
  value: V;
  label: string;
  onChange: (value: V) => void;
  disabled?: boolean;
  /** `primary` fills the selected segment (ThemeControl); `muted` is the quiet one (pane order). */
  tone?: "primary" | "muted";
  class?: string;
}

/** ThemeControl's segmented choice: a 44 px floor, the weight unconditional so a pick never re-lays-out. */
export function ChoiceBand<V extends string | number>(handle: Handle<ChoiceBandProps<V>>) {
  return () => {
    const { options, value, label, disabled = false, tone = "primary" } = handle.props;
    return (
      <div role="radiogroup" aria-label={label} class={cn("flex gap-1", handle.props.class)}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected ? "true" : "false"}
              aria-label={option.aria}
              disabled={disabled}
              mix={on("click", () => handle.props.onChange(option.value))}
              class={cn(
                "flex min-h-11 flex-1 items-center justify-center rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50",
                selected
                  ? tone === "primary"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground"
                  : "text-muted-foreground active:bg-muted",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    );
  };
}
