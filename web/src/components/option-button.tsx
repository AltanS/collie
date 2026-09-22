import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { SquareTerminal } from "lucide-react";

import type { StyledLine } from "@/lib/blocks";
import { RawMirror } from "@/components/raw-mirror";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";
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

/** Shared classes for the panel's own ghost controls (Terminal / Back to the card) — quiet on
 *  purpose (DESIGN.md §7 of ADR 0056): no border, muted colour, small text, so neither one competes
 *  with the card's real actions. */
const ghostControl =
  "flex items-center gap-1 self-end rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors active:bg-muted";

/**
 * The enclosing surface for an up-levelled dialog: a bordered, filled panel that lifts the WHOLE
 * prompt off the raw terminal mirror behind it — the primary "these are controls, not output"
 * signal, shared by all six block renderers so the separation can't drift. `bg-card` sits one
 * layer above the page background in dark (the terminal is on `--background`, the option rows on the
 * lighter `--secondary`, so the panel reads as a distinct middle layer); in light, where card ==
 * background, the border + shadow carry the separation. Owns `role="group"` + its aria label, so a
 * block's outermost element IS this panel.
 *
 * ADR 0056: a card that carries `raw` (the block's own `lines` — the region it replaced) also
 * carries the way back to it. A ghost "Terminal" control swaps the panel's children for a
 * `RawMirror` of `raw` and a "Back to the card" control; the choice is local `useState`, so it
 * lasts exactly as long as this component instance — React keeps that instance across polls
 * because the caller renders each card kind as one conditional element at a fixed position
 * (ansi-output.tsx), and a fresh dialog is a fresh instance. Never persisted, never a device pref
 * — that's the always-on `rawTerminal` display setting, which stays exactly as it was. Omitting
 * `raw` (or leaving it `undefined`) renders no control at all, unchanged from before this ADR.
 *
 * `rawMode` names what the control actually does, because it does two different things depending
 * on the card. Four cards go from nothing to the region on tap — the default, `"reveal"` — so
 * "Show the terminal instead of this card" is true there. The generic-menu and unread-dialog
 * cards already show the mirror by default; their control only hides THEIR OWN buttons, the
 * mirror stays equivalent either way, so they pass `"declutter"`, which renames both controls to
 * say that ("Put away" / "Show the buttons") rather than claim a swap that isn't happening.
 */
export function PromptPanel({
  ariaLabel,
  raw,
  rawMode = "reveal",
  children,
}: {
  ariaLabel: string;
  /** The region this card replaced — every block variant already carries it as `lines`. */
  raw?: StyledLine[];
  /** What the Terminal control actually does on this card — see the ADR 0056 note above. */
  rawMode?: "reveal" | "declutter";
  children: ReactNode;
}) {
  useLocale();
  const [showRaw, setShowRaw] = useState(false);
  const terminalControlRef = useRef<HTMLButtonElement>(null);
  const backControlRef = useRef<HTMLButtonElement>(null);
  const isFirstRender = useRef(true);

  // Move focus to whichever control replaces the one just unmounted, so the swap never drops
  // focus onto the page body. Skipped on mount: the panel must not steal focus from wherever it
  // already was just because a dialog with a `raw` prop appeared.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (showRaw) {
      backControlRef.current?.focus({ preventScroll: true });
    } else {
      terminalControlRef.current?.focus({ preventScroll: true });
    }
  }, [showRaw]);

  const declutter = rawMode === "declutter";
  const terminalLabel = declutter ? t("dialog.putAwayControl") : t("dialog.terminalControl");
  const terminalAria = declutter ? t("dialog.putAwayControlAria") : t("dialog.terminalControlAria");
  const backLabel = declutter ? t("dialog.showButtons") : t("dialog.backToCard");

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="my-1.5 flex flex-col gap-1.5 rounded-xl border border-border bg-card p-1.5 shadow-sm"
    >
      {raw !== undefined && !showRaw && (
        <button
          ref={terminalControlRef}
          type="button"
          aria-label={terminalAria}
          onClick={() => setShowRaw(true)}
          className={ghostControl}
        >
          <SquareTerminal className="size-3.5 shrink-0" aria-hidden />
          {terminalLabel}
        </button>
      )}
      {raw !== undefined && showRaw ? (
        <>
          <RawMirror lines={raw} />
          <button
            ref={backControlRef}
            type="button"
            aria-label={backLabel}
            onClick={() => setShowRaw(false)}
            className={ghostControl}
          >
            {backLabel}
          </button>
        </>
      ) : (
        children
      )}
    </div>
  );
}

// The small primary tick that flags an option group as "the terminal is asking you something",
// separating the block from the raw mirror above it. Shared by both group headers below.
const accentTick = <span aria-hidden className="h-3 w-0.5 shrink-0 rounded-md bg-primary/60" />;

/** The compact caption above an option group — a short uppercase label, for the single-question
 *  dialogs whose actual question stays visible in the raw scrollback just above. Non-semantic (the
 *  group is already aria-labelled by its question). */
export function OptionGroupCaption({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 pl-0.5">
      {accentTick}
      <span className="font-content text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
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
      <div className="font-content text-sm font-medium text-foreground">{children}</div>
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
      {keyLabel === "" ? (
        // A row with no badge of its own (resume.ts's non-pointed session rows, ADR 0058) still
        // reserves the badge's own width, empty, so every row's label starts at the same column
        // whether or not it carries one — an omitted element here would shift the pointed row's
        // title left of every other one.
        <span aria-hidden className="mt-px size-5 shrink-0" />
      ) : keyLabel != null ? (
        <KeyBadge tone={tone}>{keyLabel}</KeyBadge>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="font-content block break-words text-sm font-medium leading-snug text-foreground">
          {label}
        </span>
        {description ? (
          <span className="font-content block break-words text-xs leading-snug text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
      {trailing}
    </button>
  );
}
