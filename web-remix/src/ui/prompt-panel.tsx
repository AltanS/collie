import { on, type Handle, type RemixNode } from "remix/component";
import { SquareTerminal } from "lucide";

import { t } from "@web/lib/i18n";
import { cn } from "@web/lib/utils";

import type { Row } from "../screen/rows";
import { Screen } from "../screen/screen";
import { Icon } from "./icon";

// Port of web/src/components/option-button.tsx: the surface every lifted dialog card stands on
// (`PromptPanel`), its option row (`OptionButton`) and its caption. New primitives; nothing existing
// changed.
//
// ADR 0056: a card that carries `raw` (the region it replaced) carries the way back to it. A ghost
// "Terminal" control swaps the card's children for that region and a "Back to the card" control. The
// choice is this component's own state, so it lasts while the same dialog is on screen (the pane keys
// the card by kind) and is never stored. `rawMode: "declutter"` is for the cards that already show
// the region by default: the control then puts their buttons away instead.

export type OptionTone = "default" | "busy";

export function optionSurface(tone: OptionTone): string {
  return cn(
    "flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left shadow-sm transition-all active:scale-[0.99]",
    tone === "busy"
      ? "border-primary bg-primary/10"
      : "border-border bg-secondary active:border-primary/50 active:bg-primary/5 disabled:opacity-60",
  );
}

const GHOST =
  "flex items-center gap-1 self-end rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors active:bg-muted";

export interface PromptPanelProps {
  ariaLabel: string;
  raw?: readonly Row[];
  rawMode?: "reveal" | "declutter";
  children?: RemixNode;
}

export function PromptPanel(handle: Handle<PromptPanelProps>) {
  let showRaw = false;
  const toggle = (next: boolean) => {
    showRaw = next;
    void handle.update();
  };
  return () => {
    const { ariaLabel, raw, rawMode = "reveal", children } = handle.props;
    const declutter = rawMode === "declutter";
    return (
      <div
        role="group"
        aria-label={ariaLabel}
        data-slot="dialog-card"
        class="my-1.5 flex flex-col gap-1.5 rounded-xl border border-border bg-card p-1.5 shadow-sm"
      >
        {raw !== undefined && !showRaw && (
          <button
            type="button"
            aria-label={declutter ? t("dialog.putAwayControlAria") : t("dialog.terminalControlAria")}
            class={GHOST}
            mix={on("click", () => toggle(true))}
          >
            <Icon icon={SquareTerminal} class="size-3.5 shrink-0" />
            {declutter ? t("dialog.putAwayControl") : t("dialog.terminalControl")}
          </button>
        )}
        {raw !== undefined && showRaw ? (
          <>
            <Screen rows={raw} inset />
            <button type="button" class={GHOST} mix={on("click", () => toggle(false))}>
              {declutter ? t("dialog.showButtons") : t("dialog.backToCard")}
            </button>
          </>
        ) : (
          children
        )}
      </div>
    );
  };
}

/** The short caption above an option group, with the accent tick. */
export function OptionCaption(handle: Handle<{ children?: RemixNode }>) {
  return () => (
    <div class="flex items-center gap-1.5 pl-0.5">
      <span aria-hidden="true" class="h-3 w-0.5 shrink-0 rounded-md bg-primary/60" />
      <span class="font-content text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {handle.props.children}
      </span>
    </div>
  );
}

export interface OptionButtonProps {
  tone?: OptionTone;
  badge?: string;
  label: string;
  description?: string;
  trailing?: RemixNode;
  disabled?: boolean;
  testId?: string;
  onPress: () => void;
}

/** One option row: the key badge, the label and its description, a trailing slot (the spinner). */
export function OptionButton(handle: Handle<OptionButtonProps>) {
  return () => {
    const { tone = "default", badge, label, description, trailing, disabled, testId } = handle.props;
    return (
      <button
        type="button"
        disabled={disabled}
        data-testid={testId}
        class={optionSurface(tone)}
        mix={on("click", () => handle.props.onPress())}
      >
        {badge !== undefined && (
          <span
            aria-hidden="true"
            class={cn(
              "mt-px flex size-5 shrink-0 items-center justify-center rounded-md border text-[11px] leading-none font-semibold tabular-nums",
              tone === "default"
                ? "border-border bg-background text-muted-foreground"
                : "border-primary/40 bg-primary/15 text-primary",
            )}
          >
            {badge}
          </span>
        )}
        <span class="min-w-0 flex-1">
          <span class="font-content block text-sm leading-snug font-medium break-words text-foreground">{label}</span>
          {description ? (
            <span class="font-content block text-xs leading-snug break-words text-muted-foreground">{description}</span>
          ) : null}
        </span>
        {trailing}
      </button>
    );
  };
}
