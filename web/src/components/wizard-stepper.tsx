import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import type { WizardStepChip } from "@/lib/harness/claude/wizard";
import { cn } from "@/lib/utils";

// The chip pill, identical for a question and for the trailing Submit — the only difference is which
// one is current, which the callers know and this component does not infer.
const CHIP_CLASS = "flex min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-tight";
const CHIP_CURRENT = "border-primary/60 bg-primary/15 font-medium text-foreground";
const CHIP_IDLE = "border-border/60 text-muted-foreground";
// 28px keeps the strip slim; the hit area is bled into the gap around it so the target is 44px
// without the visual weight — the same trick the mirror's tap-to-open links use.
const CHEVRON_CLASS =
  "relative flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 text-muted-foreground transition-colors active:bg-muted disabled:opacity-50 after:absolute after:-inset-2 after:content-['']";

/**
 * The multi-question stepper strip — chips for each question plus the Left/Right step navigation.
 *
 * All three dialog grammars that show a stepper render it through here (wizard, preview-select,
 * multi-select); a third hand-rolled copy is how they drift apart. The keys themselves stay the
 * caller's business: it passes what a chevron should send, so this component never decides what a
 * tap types.
 */
export function WizardStepper({
  steps,
  locked,
  submitCurrent = false,
  nextDisabled = false,
  busyBack,
  busyNext,
  busyIcon,
  onBack,
  onNext,
}: {
  steps: WizardStepChip[];
  locked: boolean;
  /** The wizard's review step: the trailing Submit pill is the current one. */
  submitCurrent?: boolean;
  /** Disable Next beyond `locked` — the review step has nothing after it. */
  nextDisabled?: boolean;
  /** Show the spinner on the back / next chevron respectively. */
  busyBack: boolean;
  busyNext: boolean;
  busyIcon: ReactNode;
  onBack: () => void;
  onNext: () => void;
}) {
  // The first question has nothing to its left; the TUI clamps there anyway, but a disabled control
  // says so rather than sending a key that does nothing.
  const atFirstQuestion = !submitCurrent && (steps[0]?.current ?? false);
  const currentIndex = steps.findIndex((s) => s.current);
  // Which step you are on is carried only by `aria-current` moving between list items, and by the
  // advance button's name changing — neither of which is reliably announced. Say it out loud, once,
  // on change. Politely: it is context, not an interruption.
  const position = submitCurrent
    ? `Step ${steps.length + 1} of ${steps.length + 1}, Submit`
    : currentIndex >= 0
      ? `Step ${currentIndex + 1} of ${steps.length + 1}, ${steps[currentIndex]!.label}`
      : "";
  return (
    <div className="flex items-center gap-1.5">
      <span className="sr-only" role="status">
        {position}
      </span>
      <button
        type="button"
        aria-label="Previous step"
        disabled={locked || atFirstQuestion}
        onClick={onBack}
        className={CHEVRON_CLASS}
      >
        {busyBack ? busyIcon : <ChevronLeft className="size-4" />}
      </button>
      <ol aria-label="Questions" className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {steps.map((step, i) => (
          <li
            key={i}
            aria-current={step.current ? "step" : undefined}
            className={cn(CHIP_CLASS, step.current ? CHIP_CURRENT : CHIP_IDLE)}
          >
            {step.answered ? (
              <Check className="size-3 shrink-0 text-primary" aria-label="Answered" />
            ) : null}
            <span className="truncate">{step.label}</span>
          </li>
        ))}
        {/* The trailing Submit pill is the dialog's last stop, and on the wizard's review step it is
            where you actually are — hence `submitCurrent` rather than a hardcoded never. */}
        <li
          aria-current={submitCurrent ? "step" : undefined}
          className={cn(CHIP_CLASS, submitCurrent ? CHIP_CURRENT : CHIP_IDLE)}
        >
          <span>Submit</span>
        </li>
      </ol>
      <button
        type="button"
        aria-label="Next step"
        disabled={locked || nextDisabled}
        onClick={onNext}
        className={CHEVRON_CLASS}
      >
        {busyNext ? busyIcon : <ChevronRight className="size-4" />}
      </button>
    </div>
  );
}
