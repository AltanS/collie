import { useState, type ReactNode } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";

import { AnswerFieldSurface, answerFieldCopy, stepOf, useAnswerEditor } from "@/components/answer-field-surface";
import { AnswerList } from "@/components/answer-list";
import { WizardStepper } from "@/components/wizard-stepper";
import type { StyledLine, WizardModel, WizardOption } from "@/lib/blocks";
import { OptionButton, PromptPanel, QuestionHeading } from "@/components/option-button";
import {
  WIZARD_BACK_KEYS,
  WIZARD_CANCEL_KEYS,
  WIZARD_NEXT_KEYS,
  WIZARD_SUBMIT_KEYS,
} from "@/lib/harness/wizard-model";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/liveness";
import type { Scope } from "@/lib/scope";
import { useLocale } from "@/hooks/use-locale";

export interface WizardBlockProps {
  /** The detected wizard step (question or Submit review) with its stepper state. */
  wizard: WizardModel;
  /** The region this block replaced — passed through to PromptPanel as its way back (ADR 0056). */
  lines?: StyledLine[];
  /**
   * Injected send handler (from AgentChat). Presentational contract: this component NEVER touches
   * the network — every control resolves to ONE keystroke (`keys`) that the handler race-guards
   * and sends (the incremental round-trip model; see grammar/WIZARD_NOTES.md). Returning/throwing
   * simply clears the busy state.
   */
  onAction: (keys: string[]) => void | Promise<void>;
  /**
   * Injected handler for an answer typed on the phone into the step's own field (ADR 0113,
   * lib/wizard-action.ts `submitWizardAnswer`). Resolves whether the answer was sent, so a refused
   * draft stays in the editor. Absent: the card offers no editor.
   */
  onAnswer?: (text: string) => boolean | Promise<boolean>;
  /** Read-only device or a gone pane: everything renders (for context) but can't be pressed. */
  disabled?: boolean;
  /** The pane this card answers for. With it, the answer editor's Send enables only while the bridge
   *  has answered a read for that pane lately (lib/liveness.ts, M46 spec 11). */
  paneId?: string;
  scope?: Scope;
  /** The parent drew this screen from the on-device cache (M46 spec 10): the answer Send stays locked. */
  stale?: boolean;
}

// Native, tappable rendering of Claude's multi-question AskUserQuestion wizard. Mirrors exactly
// what the TUI shows — the stepper chips, then the CURRENT step's body — because the terminal is
// the single source of truth for selections; Collie holds no form state of its own. Every visible
// string (chip labels, question, options, answers) is a React text node — the XSS boundary is
// unchanged. One control can be in flight at a time (spinner shows, the rest lock).
//
// A question step's `Type something.` field (ADR 0113) renders below the answers. While it has the
// keyboard in the terminal, a digit is typed into it and `Left` moves its caret, so every option, the
// escape row and both step arrows lock; the answer editor stays usable, because its recipe reaches
// the field itself.
export function WizardBlock({ wizard, lines, onAction, onAnswer, disabled, paneId, scope, stale }: WizardBlockProps) {
  useLocale();
  // M46 spec 11, as PromptSelectBlock: `useLive` is called unconditionally; no `paneId`, no offline.
  const live = useLive(paneId ?? "", scope);
  const offline = stale === true || (paneId !== undefined && !live);
  const [sending, setSending] = useState<string | null>(null);
  const editor = useAnswerEditor();
  const field = wizard.phase === "question" ? wizard.field : undefined;
  const asked = { question: wizard.phase === "question" ? wizard.question : "", step: stepOf(wizard.steps) };
  const locked = Boolean(disabled) || sending !== null || (field?.focused ?? false);
  const answerLocked = Boolean(disabled) || offline || sending !== null;

  // Resolves whether the answer landed: the editor closes only then, so a refused one keeps what was
  // thumb-typed.
  async function runAnswer(text: string): Promise<boolean> {
    if (!onAnswer) return false;
    setSending("answer");
    try {
      return await onAnswer(text);
    } finally {
      setSending(null);
    }
  }

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
    <PromptPanel ariaLabel={review ? t("dialog.reviewAnswers") : wizard.question} raw={lines}>
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
          answerField={
            field && onAnswer ? (
              <AnswerFieldSurface
                field={field}
                asked={asked}
                copy={answerFieldCopy(t("prompt.feedback.answer.helpWizard"))}
                ours={sending === "answer"}
                anySending={sending !== null}
                editor={editor}
                onSend={() => void editor.send(field, asked, runAnswer, answerLocked)}
                locked={answerLocked}
                busyIcon={busyIcon}
                showTyped
                showFocused
              />
            ) : null
          }
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
  answerField,
}: {
  question: string;
  options: WizardOption[];
  locked: boolean;
  sendingId: string | null;
  onPress: (id: string, keys: string[]) => void;
  /** The step's answer field surface, between the answers and the escape row; null when none. */
  answerField: ReactNode;
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
      {answerField}
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
      <AnswerList answers={wizard.answers} />
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
          onClick={() => onPress("submit", wizard.submitKeys ?? WIZARD_SUBMIT_KEYS)}
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
          onClick={() => onPress("cancel", wizard.cancelKeys ?? WIZARD_CANCEL_KEYS)}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60"
        >
          {sendingId === "cancel" ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-label={t("dialog.sendingAria")} />
          ) : null}
          {wizard.cancelLabel ?? t("dialog.cancel")}
        </button>
      </div>
    </>
  );
}
