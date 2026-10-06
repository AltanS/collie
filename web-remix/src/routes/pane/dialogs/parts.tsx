// The pieces the wizard, multi-select and preview-select cards share. Ports of the parts of
// web/src/components/wizard-stepper.tsx, answer-list.tsx and option-button.tsx the three native
// forms draw alike, so the three cannot drift apart (a third hand-rolled copy is how they did).
// Presentational: nothing here sends a key; the card passes what each control should do.
import { on, type Handle, type RemixNode } from "remix/component";
import { Check, ChevronLeft, ChevronRight, LoaderCircle } from "lucide";

import type { WizardAnswer } from "@web/lib/blocks";
import { t } from "@web/lib/i18n";
import { cn } from "@web/lib/utils";

import { Icon } from "../../../ui/icon";
import type { StepperView } from "../cards";

export function spinner(size = "size-3.5"): RemixNode {
  return <Icon icon={LoaderCircle} class={cn(size, "shrink-0 animate-spin text-muted-foreground")} label={t("dialog.sendingAria")} />;
}

// ── one control in flight at a time ──────────────────────────────────────────────────────────────

interface PendingHost {
  props: { disabled: boolean };
  signal: AbortSignal;
  update(): Promise<AbortSignal>;
}

/**
 * The card's in-flight state: which control was pressed, until its handler settles. Every control
 * locks while one is pending (the terminal is the source of truth, so there is no optimistic state
 * and no queued tap). A direct `update()` is fine here: one tap is one update, on the card's own state.
 */
export function createPending(handle: PendingHost) {
  let sending: string | null = null;
  return {
    get sending(): string | null {
      return sending;
    },
    async press(id: string, run: () => Promise<boolean>): Promise<boolean> {
      if (handle.props.disabled || sending !== null) return false;
      sending = id;
      void handle.update();
      try {
        return await run();
      } finally {
        sending = null;
        if (!handle.signal.aborted) void handle.update();
      }
    },
  };
}

// ── surfaces ─────────────────────────────────────────────────────────────────────────────────────

export type ChoiceTone = "default" | "selected" | "busy";

/** The elevated option surface (option-button.tsx `optionSurface`), with the `selected` tone the
 *  shared Remix `optionSurface` does not carry. */
export function choiceSurface(tone: ChoiceTone): string {
  return cn(
    "flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left shadow-sm transition-all active:scale-[0.99]",
    tone === "busy"
      ? "border-primary bg-primary/10"
      : tone === "selected"
        ? "border-primary bg-primary/10 active:bg-primary/15 disabled:opacity-60"
        : "border-border bg-secondary active:border-primary/50 active:bg-primary/5 disabled:opacity-60",
  );
}

/** The small square key chip: the option's terminal digit. Decoration, the label names the button. */
export function KeyBadge(handle: Handle<{ tone: ChoiceTone; children?: RemixNode }>) {
  return () => (
    <span
      aria-hidden="true"
      class={cn(
        "mt-px flex size-5 shrink-0 items-center justify-center rounded-md border text-[11px] leading-none font-semibold tabular-nums",
        handle.props.tone === "default"
          ? "border-border bg-background text-muted-foreground"
          : "border-primary/40 bg-primary/15 text-primary",
      )}
    >
      {handle.props.children}
    </span>
  );
}

export interface ChoiceRowProps {
  tone: ChoiceTone;
  /** Before the badge: a checkbox square, or the preview pointer. */
  lead?: RemixNode;
  badge?: string;
  label: string;
  description?: string;
  /** The spinner while this control is in flight, or the "current answer" check. */
  trailing?: RemixNode;
  disabled: boolean;
  testId: string;
  role?: "checkbox";
  /** The checkbox state, read from the terminal; only meaningful with `role="checkbox"`. */
  "aria-checked"?: boolean;
  onPress: () => void;
}

/** One answer row: lead mark, key badge, label and description, a trailing slot. */
export function ChoiceRow(handle: Handle<ChoiceRowProps>) {
  return () => {
    const { tone, lead, badge, label, description, trailing, disabled, testId, role } = handle.props;
    const checked = handle.props["aria-checked"];
    return (
      <button
        type="button"
        role={role}
        aria-checked={role === "checkbox" ? (checked === true ? "true" : "false") : undefined}
        disabled={disabled}
        data-testid={testId}
        class={choiceSurface(tone)}
        mix={on("click", () => handle.props.onPress())}
      >
        {lead}
        {badge !== undefined && <KeyBadge tone={tone}>{badge}</KeyBadge>}
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

/** The accent tick that starts a heading and a caption. */
const ACCENT_TICK = <span aria-hidden="true" class="h-3 w-0.5 shrink-0 rounded-md bg-primary/60" />;

/** The readable question heading, for a step whose question the card replaced on screen. */
export function QuestionHeading(handle: Handle<{ children?: RemixNode }>) {
  return () => (
    <div class="flex items-start gap-1.5 pl-0.5">
      <span class="mt-[3px] flex">{ACCENT_TICK}</span>
      <div class="font-content text-sm font-medium text-foreground">{handle.props.children}</div>
    </div>
  );
}

/** The echoed `question → answer` pairs of a review screen, the terminal's own words. */
export function AnswerList(handle: Handle<{ answers: readonly WizardAnswer[] }>) {
  return () => {
    const { answers } = handle.props;
    if (answers.length === 0) return null;
    return (
      <dl class="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2">
        {answers.map((qa, i) => (
          <div key={i}>
            <dt class="font-content text-xs text-muted-foreground">{qa.question}</dt>
            <dd class="font-content text-sm font-medium text-foreground">{qa.answer}</dd>
          </div>
        ))}
      </dl>
    );
  };
}

// ── the stepper strip ────────────────────────────────────────────────────────────────────────────

// The weight is in the SHARED string: a weight change is a width change, so a chip that took
// `font-medium` on becoming current would shove the chips after it along. State is carried by colour.
const CHIP_CLASS = "flex min-w-0 items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium leading-tight";
const CHIP_CURRENT = "border-primary/60 bg-primary/15 text-foreground";
const CHIP_IDLE = "border-border/60 text-muted-foreground";
// 28px keeps the strip slim; the hit area is bled into the gap around it so the target is 44px.
const CHEVRON_CLASS =
  "relative flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 text-muted-foreground transition-colors active:bg-muted disabled:opacity-50 after:absolute after:-inset-2 after:content-['']";

export interface WizardStepperProps {
  view: StepperView;
  locked: boolean;
  busyBack: boolean;
  busyNext: boolean;
  onBack: () => void;
  onNext: () => void;
}

/** The question chips plus the Left and Right step navigation. The keys stay the card's business. */
export function WizardStepper(handle: Handle<WizardStepperProps>) {
  return () => {
    const { view, locked, busyBack, busyNext, onBack, onNext } = handle.props;
    return (
      <div class="flex items-center gap-1.5">
        <output class="sr-only">{view.position}</output>
        <button
          type="button"
          data-testid="wizard-nav"
          aria-label={t("dialog.previousStepAria")}
          disabled={locked || view.backDisabled}
          class={CHEVRON_CLASS}
          mix={on("click", () => onBack())}
        >
          {busyBack ? spinner("size-3.5") : <Icon icon={ChevronLeft} class="size-4" />}
        </button>
        <ol aria-label={t("dialog.questionsAria")} class="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {view.steps.map((step, i) => (
            <li
              key={i}
              aria-current={step.current ? "step" : undefined}
              class={cn(CHIP_CLASS, step.current ? CHIP_CURRENT : CHIP_IDLE)}
            >
              {step.answered ? (
                <Icon icon={Check} class="size-3 shrink-0 text-primary" label={t("dialog.answeredAria")} />
              ) : null}
              <span class="font-content truncate">{step.label}</span>
            </li>
          ))}
          <li
            aria-current={view.submitCurrent ? "step" : undefined}
            class={cn(CHIP_CLASS, view.submitCurrent ? CHIP_CURRENT : CHIP_IDLE)}
          >
            <span>{t("dialog.submitChip")}</span>
          </li>
        </ol>
        <button
          type="button"
          data-testid="wizard-nav"
          aria-label={t("dialog.nextStepAria")}
          disabled={locked || view.nextDisabled}
          class={CHEVRON_CLASS}
          mix={on("click", () => onNext())}
        >
          {busyNext ? spinner("size-3.5") : <Icon icon={ChevronRight} class="size-4" />}
        </button>
      </div>
    );
  };
}

// ── the action buttons every form ends with ──────────────────────────────────────────────────────

export const PRIMARY_BUTTON =
  "font-content flex w-full items-center justify-center gap-2 rounded-lg border border-primary/60 bg-primary/15 px-3 py-2 text-sm font-medium text-foreground transition-colors active:bg-primary/25 disabled:opacity-60";
export const QUIET_BUTTON =
  "flex w-full items-center justify-center gap-2 rounded-lg border border-border/70 px-3 py-1.5 text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60";
/** An escape row ends the whole dialog, so it stands apart: dashed and de-emphasised. */
export const ESCAPE_ROW =
  "flex w-full items-center gap-2 rounded-lg border border-dashed border-border/60 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60";
