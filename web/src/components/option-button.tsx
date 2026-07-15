import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

// The one shared visual language for an up-levelled dialog option, used by all three block
// renderers (prompt-select / wizard / preview-select) so they can't drift into three different flat
// styles again. The rows must read as OBVIOUSLY tappable controls sitting apart from the raw
// terminal mirror above them: a solid, elevated surface (secondary fill + full-opacity border +
// shadow) with generous corners and tap padding, a leading key badge mirroring the terminal menu's
// digit, and calm accent/active states. Theme tokens only — light and dark both derive from these.
//
// XSS boundary unchanged: labels/descriptions passed in are React text nodes; nothing is ever set as
// innerHTML.

/**
 * Surface tone of an option row:
 *  - `default`  — a plain, selectable choice.
 *  - `selected` — the TUI's current/chosen row (primary accent tint).
 *  - `busy`     — this option's keystroke is in flight: primary accent, and NOT dimmed even while the
 *                 button is disabled (the caller renders a spinner in the trailing slot), so the
 *                 pressed row stays visibly distinct while its siblings dim under `disabled`.
 */
export type OptionTone = "default" | "selected" | "busy";

/** Shared surface classes for a tappable option row. Applied verbatim in all three blocks. */
export function optionSurface(tone: OptionTone): string {
  return cn(
    "flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left shadow-sm transition-all",
    "active:scale-[0.99]",
    tone === "busy"
      ? "border-primary bg-primary/10" // in flight — accent, never dimmed (the spinner reads over it)
      : tone === "selected"
        ? "border-primary bg-primary/10 active:bg-primary/15 disabled:opacity-60"
        : "border-border bg-secondary active:border-primary/50 active:bg-primary/5 disabled:opacity-60",
  );
}

/** The small square key chip — the option's terminal digit, so the menu mapping is visible.
 *  `aria-hidden`: the digit is a visual affordance; the button is already named by its label. */
export function KeyBadge({ children, tone = "default" }: { children: ReactNode; tone?: OptionTone }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-px flex size-5 shrink-0 items-center justify-center rounded-md border text-[11px] font-semibold leading-none tabular-nums",
        tone === "default"
          ? "border-border bg-background text-muted-foreground"
          : "border-primary/40 bg-primary/15 text-primary",
      )}
    >
      {children}
    </span>
  );
}

/**
 * The enclosing surface for an up-levelled dialog: a bordered, filled panel that lifts the WHOLE
 * prompt off the raw terminal mirror behind it — the primary "these are controls, not output"
 * signal, shared by all three block renderers so the separation can't drift. `bg-card` sits one
 * layer above the page background in dark (the terminal is on `--background`, the option rows on the
 * lighter `--secondary`, so the panel reads as a distinct middle layer); in light, where card ==
 * background, the border + shadow carry the separation. Owns `role="group"` + its aria label, so a
 * block's outermost element IS this panel.
 */
export function PromptPanel({ ariaLabel, children }: { ariaLabel: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="my-1.5 flex flex-col gap-1.5 rounded-xl border border-border bg-card p-1.5 shadow-sm"
    >
      {children}
    </div>
  );
}

// The small primary tick that flags an option group as "the terminal is asking you something",
// separating the block from the raw mirror above it. Shared by both group headers below.
const accentTick = <span aria-hidden className="h-3 w-0.5 shrink-0 rounded-full bg-primary/60" />;

/** The compact caption above an option group — a short uppercase label, for the single-question
 *  dialogs whose actual question stays visible in the raw scrollback just above. Non-semantic (the
 *  group is already aria-labelled by its question). */
export function OptionGroupCaption({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 pl-0.5">
      {accentTick}
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {children}
      </span>
    </div>
  );
}

/** The readable question heading, for the wizard steps whose question is NOT in the raw mirror (the
 *  dialog block replaced it) — kept prominent, with the same accent tick as {@link OptionGroupCaption}. */
export function QuestionHeading({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-1.5 pl-0.5">
      <span className="mt-[3px] flex">{accentTick}</span>
      <div className="text-sm font-medium text-foreground">{children}</div>
    </div>
  );
}

/** A full option row: leading key badge, label + optional description, and a trailing slot (spinner
 *  or a state mark). Shared by prompt-select and wizard answers, which are structurally identical;
 *  preview-select composes {@link optionSurface}/{@link KeyBadge} directly because its rows also
 *  carry the pointer chevron. */
export function OptionButton({
  tone = "default",
  keyLabel,
  label,
  description,
  trailing,
  disabled,
  onClick,
}: {
  tone?: OptionTone;
  keyLabel?: ReactNode;
  label: ReactNode;
  description?: ReactNode;
  trailing?: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={optionSurface(tone)}>
      {keyLabel != null ? <KeyBadge tone={tone}>{keyLabel}</KeyBadge> : null}
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm font-medium leading-snug text-foreground">{label}</span>
        {description ? (
          <span className="block break-words text-xs leading-snug text-muted-foreground">{description}</span>
        ) : null}
      </span>
      {trailing}
    </button>
  );
}
