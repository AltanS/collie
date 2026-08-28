import { useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";

import { WizardStepper } from "@/components/wizard-stepper";
import type { WizardModel, WizardOption } from "@/lib/blocks";
import { OptionButton, PromptPanel, QuestionHeading } from "@/components/option-button";
import {
  WIZARD_BACK_KEYS,
  WIZARD_CANCEL_KEYS,
  WIZARD_NEXT_KEYS,
  WIZARD_SUBMIT_KEYS,
} from "@/lib/harness/wizard-model";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

export interface WizardBlockProps {
  /** The detected wizard step (question or Submit review) with its stepper state. */
  wizard: WizardModel;
  /**
   * Injected send handler (from AgentChat). Presentational contract: this component NEVER touches
   * the network — every control resolves to ONE keystroke (`keys`) that the handler race-guards
   * and sends (the incremental round-trip model; see grammar/WIZARD_NOTES.md). Returning/throwing
   * simply clears the busy state.
   */
  onAction: (keys: string[]) => void | Promise<void>;
  /** Read-only device or a gone pane: everything renders (for context) but can't be pressed. */
  disabled?: boolean;
}

// Native, tappable rendering of Claude's multi-question AskUserQuestion wizard. Mirrors exactly
// what the TUI shows — the stepper chips, then the CURRENT step's body — because the terminal is
// the single source of truth for selections; Collie holds no form state of its own. Every visible
// string (chip labels, question, options, answers) is a React text node — the XSS boundary is
// unchanged. One control can be in flight at a time (spinner shows, the rest lock).
export function WizardBlock({ wizard, onAction, disabled }: WizardBlockProps) {
  useLocale();
  const [sending, setSending] = useState<string | null>(null);
  const locked = disabled || sending !== null;

  async function press(id: string, keys: string[]) {
    if (locked) return;
    setSending(id);
    try {
      await onAction(keys);
    } finally {
      setSending(null);
    }
  }

  const review = wizard.phase === "review";
  // The TUI clamps navigation (no wraparound): Left at the first question and Right on the Submit
  // review step are no-ops, so disable those arrows rather than send a keystroke that does nothing.
  // When no chip reads as current (an unknown theme's highlight), both stay enabled — the TUI still
  // clamps, and keeping nav available is the safer degradation.
  const busyIcon = (
    <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label={t("dialog.sendingAria")} />
  );

  return (
    <PromptPanel ariaLabel={review ? t("dialog.reviewAnswers") : wizard.question}>
      {/* Stepper: one chip per question plus the fixed Submit step, flanked by the same back/next
          navigation the TUI drives with ←/→ (each tap sends exactly that one key). */}
      <WizardStepper
        steps={wizard.steps}
        locked={locked}
        submitCurrent={review}
        nextDisabled={review}
        busyBack={sending === "back"}
        busyNext={sending === "next"}
        busyIcon={busyIcon}
        onBack={() => press("back", WIZARD_BACK_KEYS)}
        onNext={() => press("next", WIZARD_NEXT_KEYS)}
      />

      {wizard.phase === "question" ? (
        <QuestionStep
          question={wizard.question}
          options={wizard.options}
          locked={locked}
          sendingId={sending}
          onPress={press}
        />
      ) : (
        <ReviewStep wizard={wizard} locked={locked} sendingId={sending} onPress={press} />
      )}
    </PromptPanel>
  );
}

function QuestionStep({
  question,
  options,
  locked,
  sendingId,
  onPress,
}: {
  question: string;
  options: WizardOption[];
  locked: boolean;
  sendingId: string | null;
  onPress: (id: string, keys: string[]) => void;
}) {
  useLocale();
  const answers = options.filter((o) => !o.escape);
  const escapes = options.filter((o) => o.escape);
  return (
    <>
      <QuestionHeading>{question}</QuestionHeading>
      <div className="flex flex-col gap-1">
        {answers.map((option, i) => {
          const id = `opt-${i}`;
          const busy = sendingId === id;
          return (
            <OptionButton
              key={i}
              tone={busy ? "busy" : option.chosen ? "selected" : "default"}
              keyLabel={option.keys[0]}
              label={option.label}
              description={option.description}
              disabled={locked}
              onClick={() => onPress(id, option.keys)}
              trailing={
                busy ? (
                  <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" aria-label={t("dialog.sendingAria")} />
                ) : option.chosen ? (
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-label={t("dialog.preview.currentAnswerAria")} />
                ) : null
              }
            />
          );
        })}
      </div>
      {/* The escape row ("Chat about this") ends the WHOLE wizard — the tool call resolves as
          declined — so it renders apart and de-emphasised, never like an answer. */}
      {escapes.map((option, i) => {
        const id = `esc-${i}`;
        return (
          <button
            key={i}
            type="button"
            disabled={locked}
            onClick={() => onPress(id, option.keys)}
            className="flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60"
          >
            <span className="font-content min-w-0 flex-1">
              {option.label}
              <span className="text-muted-foreground"> {t("dialog.endsQuestionsSuffix")}</span>
            </span>
            {sendingId === id ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin" aria-label={t("dialog.sendingAria")} />
            ) : null}
          </button>
        );
      })}
    </>
  );
}

function ReviewStep({
  wizard,
  locked,
  sendingId,
  onPress,
}: {
  wizard: Extract<WizardModel, { phase: "review" }>;
  locked: boolean;
  sendingId: string | null;
  onPress: (id: string, keys: string[]) => void;
}) {
  useLocale();
  return (
    <>
      <div className="text-sm font-medium text-foreground">{t("dialog.reviewAnswers")}</div>
      {wizard.answers.length > 0 && (
        <dl className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2">
          {wizard.answers.map((qa, i) => (
            <div key={i}>
              <dt className="font-content text-xs text-muted-foreground">{qa.question}</dt>
              <dd className="font-content text-sm font-medium text-foreground">{qa.answer}</dd>
            </div>
          ))}
        </dl>
      )}
      {wizard.incomplete && (
        <div className="flex items-center gap-1.5 text-xs text-status-working">
          <AlertTriangle className="size-3.5 shrink-0" />
          {t("dialog.incomplete")}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          disabled={locked}
          onClick={() => onPress("submit", WIZARD_SUBMIT_KEYS)}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-primary/60 bg-primary/15 px-3 py-2 text-sm font-medium text-foreground transition-colors active:bg-primary/25 disabled:opacity-60"
        >
          {sendingId === "submit" ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-label={t("dialog.sendingAria")} />
          ) : null}
          {t("dialog.submitAnswers")}
        </button>
        <button
          type="button"
          disabled={locked}
          onClick={() => onPress("cancel", WIZARD_CANCEL_KEYS)}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60"
        >
          {sendingId === "cancel" ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-label={t("dialog.sendingAria")} />
          ) : null}
          {t("dialog.cancel")}
        </button>
      </div>
    </>
  );
}
