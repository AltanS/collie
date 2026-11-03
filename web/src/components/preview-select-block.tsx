import { useState } from "react";
import { Check, ChevronRight, Loader2 } from "lucide-react";
import { QuestionNote } from "@/components/ui/question-note";
import { Button } from "@/components/ui/button";

import { WizardStepper } from "@/components/wizard-stepper";
import { cn } from "@/lib/utils";
import type { PreviewOption, PreviewSelectModel, StyledLine } from "@/lib/blocks";
import {
  KeyBadge,
  OptionGroupCaption,
  optionSurface,
  PromptPanel,
  QuestionHeading,
} from "@/components/option-button";
import { NOTE_MAX_LENGTH } from "@/lib/harness/preview-model";
import { WIZARD_BACK_KEYS, WIZARD_NEXT_KEYS } from "@/lib/harness/wizard-model";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";
import { AnswerFieldSurface, answerFieldCopy, stepOf, useAnswerEditor } from "@/components/answer-field-surface";
import type { SeenValue } from "@/lib/editor-action";
import type { DialogEditorObservation } from "@/lib/harness/editor-model";

/** One tap's intent, resolved to keystrokes by the injected handler (preview-action.ts). */
export type PreviewBlockAction =
  | { kind: "option"; option: PreviewOption }
  | { kind: "note"; text: string } // "" removes the note
  | { kind: "nav"; keys: string[] };

export interface PreviewSelectBlockProps {
  /** The detected preview-variant dialog (single question or one wizard step). */
  preview: PreviewSelectModel;
  /** The region this block replaced — passed through to PromptPanel as its way back (ADR 0056). */
  lines?: StyledLine[];
  /**
   * Injected send handler (from AgentChat). Presentational contract: this component NEVER touches
   * the network — it maps taps to intents while the handler runs the race-guarded choreography
   * (digit→verify→Enter for options; n→verify→type→Escape for notes). Returning/throwing simply
   * clears the busy state.
   */
  onAction: (action: PreviewBlockAction) => void | Promise<void>;
  /** Read-only device or a gone pane: everything renders (for context) but can't be pressed. */
  disabled?: boolean;
  onReadEditor?: (purpose: DialogEditorObservation["purpose"], remove?: boolean) => Promise<SeenValue | null>;
}

// Native, tappable rendering of Claude's preview-variant AskUserQuestion (options + a preview pane
// + the per-question note; grammar/NOTES_NOTES.md). Mirrors what the TUI shows — the preview pane
// belongs to the POINTED option, and the note belongs to the QUESTION — because the terminal is
// the single source of truth. Every visible string (labels, preview text, note text) is a React
// text node — the XSS boundary is unchanged. One control can be in flight at a time.
//
// While the TUI's own note input is focused (note.state === "editing" — someone is typing in the
// terminal) EVERY control locks: any keystroke we sent would be typed into their note instead of
// driving the dialog. A banner says so; polling clears it when the input blurs.
export function PreviewSelectBlock({ preview, lines, onAction, onReadEditor, disabled }: PreviewSelectBlockProps) {
  useLocale();
  const [sending, setSending] = useState<string | null>(null);
  const editor = useAnswerEditor();
  const terminalEditing = preview.note.state === "editing" || Boolean(preview.field?.focused);
  const locked = disabled || sending !== null || terminalEditing;

  async function press(id: string, action: PreviewBlockAction) {
    if (locked) return;
    setSending(id);
    try {
      await onAction(action);
    } finally {
      setSending(null);
    }
  }

  const wizard = preview.steps !== null;
  const pointedLabel = preview.options.find((o) => o.pointed)?.label;
  const busyIcon = (
    <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label={t("dialog.sendingAria")} />
  );

  return (
    <PromptPanel ariaLabel={preview.question} raw={lines}>
      {/* Wizard form only: the stepper chips + Left/Right navigation, exactly as in WizardBlock —
          a preview question is just one step of the same dialog. Single-question dialogs keep
          their question/chip line in the raw mirror above, so neither renders here. */}
      {wizard && (
        <WizardStepper
          steps={preview.steps!}
          locked={locked}
          busyBack={sending === "nav-back"}
          busyNext={sending === "nav-next"}
          busyIcon={busyIcon}
          onBack={() => press("nav-back", { kind: "nav", keys: preview.navigation?.back ?? WIZARD_BACK_KEYS })}
          onNext={() => press("nav-next", { kind: "nav", keys: preview.navigation?.next ?? WIZARD_NEXT_KEYS })}
        />
      )}
      {(wizard || preview.editors) && <QuestionHeading>{preview.question}</QuestionHeading>}
      {!wizard && <OptionGroupCaption>{preview.caption ?? t("dialog.chooseOption")}</OptionGroupCaption>}

      {/* Options. Tapping one selects it outright (the handler drives digit → verify → Enter). Each
          row leads with the pointer chevron (whose preview shows below) then its terminal-menu digit
          (KeyBadge), on the shared elevated option surface. */}
      <div className="flex flex-col gap-1">
        {preview.options.map((option, i) => {
          const id = `opt-${i}`;
          const busy = sending === id;
          const tone = busy ? "busy" : option.chosen ? "selected" : "default";
          return (
            <button
              key={i}
              type="button"
              disabled={locked}
              onClick={() => press(id, { kind: "option", option })}
              className={optionSurface(tone)}
            >
              <ChevronRight
                className={cn(
                  "mt-[3px] size-3.5 shrink-0",
                  option.pointed ? "text-primary" : "text-transparent",
                )}
                aria-label={option.pointed ? t("dialog.preview.previewedBelowAria") : undefined}
              />
              <KeyBadge tone={tone}>{option.n}</KeyBadge>
              <span className="font-content min-w-0 flex-1 text-sm font-medium text-foreground">
                {option.label}
                {option.description && <span className="block text-xs font-normal leading-snug text-muted-foreground">{option.description}</span>}
              </span>
              {busy ? (
                <Loader2
                  className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground"
                  aria-label={t("dialog.sendingAria")}
                />
              ) : option.chosen ? (
                <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-label={t("dialog.preview.currentAnswerAria")} />
              ) : null}
            </button>
          );
        })}
      </div>

      {/* The pointed option's preview pane, verbatim (mono text nodes — never markup). */}
      {preview.preview.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/20 px-2 py-1.5">
          {pointedLabel && (
            <div className="mb-1 text-[10px] font-medium label-caps text-muted-foreground">
              {t("dialog.preview.previewLabel", { label: pointedLabel })}
            </div>
          )}
          <pre className="m-0 min-w-0 w-full max-w-full overflow-x-auto font-mono text-[10px] leading-[1.3] text-foreground/80">
            {preview.preview.join("\n")}
          </pre>
        </div>
      )}

      {preview.field ? <AnswerFieldSurface field={preview.field} asked={{ question: preview.question, step: stepOf(preview.steps) }}
        copy={answerFieldCopy(t("prompt.feedback.answer.help"))} ours={false} anySending={sending !== null} editor={editor} onSend={() => undefined}
        locked={Boolean(disabled || sending !== null || preview.note.state === "editing" || !onReadEditor)}
        onOpenEditor={onReadEditor ? () => void onReadEditor("answer") : undefined} busyIcon={busyIcon} showTyped showFocused /> : null}
      <QuestionNote
        note={preview.note}
        disabled={locked || Boolean(preview.editors?.note && !onReadEditor)}
        saving={sending === "note-save" || sending === "note-remove"}
        maxLength={NOTE_MAX_LENGTH}
        onRead={preview.editors?.note && onReadEditor ? (remove) => onReadEditor("question-note", remove) : undefined}
        onSave={(text) => press(text === "" ? "note-remove" : "note-save", { kind: "note", text })}
      />
      {preview.cancelKeys && (
        <Button type="button" variant="outline" disabled={locked} onClick={() => press("cancel", { kind: "nav", keys: preview.cancelKeys! })} className="min-h-11 w-full text-xs text-muted-foreground">
          <span className="flex size-3.5 shrink-0 items-center justify-center">{sending === "cancel" ? busyIcon : null}</span>
          {t("dialog.cancel")}
        </Button>
      )}
    </PromptPanel>
  );
}
