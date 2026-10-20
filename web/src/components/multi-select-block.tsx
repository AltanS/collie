import { useState, type ReactNode } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { MultiSelectModel, StyledLine } from "@/lib/blocks";
import type { MultiSelectIntent } from "@/lib/multi-select-action";
import { AnswerFieldSurface, answerFieldCopy, stepOf, useAnswerEditor } from "@/components/answer-field-surface";
import { AnswerList } from "@/components/answer-list";
import { KeyBadge, optionSurface, PromptPanel, QuestionHeading } from "@/components/option-button";
import { WizardStepper } from "@/components/wizard-stepper";
import { WIZARD_BACK_KEYS, WIZARD_NEXT_KEYS } from "@/lib/harness/wizard-model";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/liveness";
import type { Scope } from "@/lib/scope";
import { useLocale } from "@/hooks/use-locale";

type CheckboxModel = Extract<MultiSelectModel, { phase: "checkbox" }>;

export interface MultiSelectBlockProps {
  /** The detected multi-select dialog (checkbox screen or review screen). */
  multi: MultiSelectModel;
  /** The region this block replaced — passed through to whichever PromptPanel this component
   *  renders (checkbox or review) as its way back (ADR 0056). The review used to go without one,
   *  as a short confirm screen over answers already shown; a review can now carry its own answers
   *  and its own declared keys, so it is a card worth checking against the terminal too. */
  lines?: StyledLine[];
  /**
   * Injected send handler (from AgentChat). Presentational contract: this component NEVER touches
   * the network — it maps taps to intents while the handler runs the race-guarded choreography
   * (toggle = one digit, or digit-jump + verified Enter in pointer mode; submit = the closed-loop
   * Down→Up→verify→Enter macro). Returning/throwing simply clears the busy state.
   */
  onAction: (action: MultiSelectIntent) => void | Promise<void>;
  /**
   * Injected handler for an answer typed on the phone into the question's own field (ADR 0113,
   * lib/multi-select-action.ts `type`). Resolves whether the answer was sent, so a refused draft
   * stays in the editor. Absent: the card offers no editor.
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

// Native, tappable rendering of Claude's multiSelect AskUserQuestion. The terminal is the single
// source of truth for the checkbox state — a digit is an XOR (a double-fire would invert it), so
// there is NO optimistic local `checked`; each tap locks EVERY control (a `sending` state) until the
// round-trip re-derives the fresh state. That per-tap lock is an acknowledged v1 limitation (you
// can't queue toggles). Every visible string (labels, descriptions) is a React text node — the XSS
// boundary is unchanged.
//
// The question's `Type something` field (ADR 0113): a typed answer is one more ticked choice, drawn as
// a checkbox row after the options, and the answer editor sits below them. While the field has the
// keyboard in the terminal a digit is typed into it and `Left` moves its caret, so an option toggle,
// the escape and a step arrow first move the pointer off it (lib/multi-select-action.ts `offField`),
// and the advance macro and the answer recipe walk on their own. Only the field's own row locks then:
// its action refuses that digit on a focused field.
export function MultiSelectBlock({ multi, lines, onAction, onAnswer, disabled, paneId, scope, stale }: MultiSelectBlockProps) {
  useLocale();
  // M46 spec 11, as WizardBlock: `useLive` is called unconditionally; no `paneId`, no offline.
  const live = useLive(paneId ?? "", scope);
  const offline = stale === true || (paneId !== undefined && !live);
  const [sending, setSending] = useState<string | null>(null);
  const editor = useAnswerEditor();
  const locked = Boolean(disabled) || sending !== null;
  const answerLocked = locked || offline;

  async function press(id: string, action: MultiSelectIntent) {
    if (locked) return;
    setSending(id);
    try {
      await onAction(action);
    } finally {
      setSending(null);
    }
  }

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

  if (multi.phase === "review") {
    return (
      <ReviewPhase
        multi={multi}
        lines={lines}
        locked={locked}
        sending={sending}
        onPress={press}
      />
    );
  }
  const field = multi.field;
  const asked = { question: multi.question, step: stepOf(multi.steps) };
  const answerField =
    field && onAnswer ? (
      <AnswerFieldSurface
        field={field}
        asked={asked}
        copy={answerFieldCopy(t("prompt.feedback.answer.helpMulti"))}
        ours={sending === "answer"}
        anySending={sending !== null}
        editor={editor}
        onSend={() => void editor.send(field, asked, runAnswer, answerLocked)}
        locked={answerLocked}
        busyIcon={<SpinnerSm />}
        showTyped={false}
        showFocused={false}
      />
    ) : null;
  return (
    <CheckboxPhase
      multi={multi}
      lines={lines}
      locked={locked}
      sending={sending}
      onPress={press}
      answerField={answerField}
    />
  );
}

function SpinnerSm() {
  return <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label={t("dialog.sendingAria")} />;
}
function SpinnerMd() {
  return <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" aria-label={t("dialog.sendingAria")} />;
}

/** One checkbox row: an option, or a typed answer field (its label in the content face). */
function CheckboxRow({
  n,
  label,
  description,
  checked,
  busy,
  disabled,
  typed,
  onToggle,
}: {
  n: number;
  label: string;
  description?: string;
  checked: boolean;
  busy: boolean;
  disabled: boolean;
  /** The row is the answer field holding someone's words: drawn in the content face. */
  typed: boolean;
  onToggle: () => void;
}) {
  const tone = busy ? "busy" : "default";
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
      className={optionSurface(tone)}
    >
      {/* The checkbox reflects the TERMINAL state (`checked`), never a local guess. */}
      <span
        aria-hidden
        className={cn(
          "mt-px flex size-4 shrink-0 items-center justify-center rounded border",
          checked ? "border-primary bg-primary/20 text-primary" : "border-border bg-background",
        )}
      >
        {checked ? <Check className="size-3" /> : null}
      </span>
      <KeyBadge tone={tone}>{n}</KeyBadge>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-sm font-medium leading-snug text-foreground", typed && "font-content")}>
          {label}
        </span>
        {description ? <span className="block text-xs leading-snug text-muted-foreground">{description}</span> : null}
      </span>
      {busy ? <SpinnerMd /> : null}
    </button>
  );
}

function CheckboxPhase({
  multi,
  lines,
  locked,
  sending,
  onPress,
  answerField,
}: {
  multi: CheckboxModel;
  lines?: StyledLine[];
  locked: boolean;
  sending: string | null;
  onPress: (id: string, action: MultiSelectIntent) => void;
  answerField: ReactNode;
}) {
  const field = multi.field;
  return (
    <PromptPanel ariaLabel={multi.question} raw={lines}>
      {multi.steps && (
        <WizardStepper
          steps={multi.steps}
          locked={locked}
          busyBack={sending === "nav-back"}
          busyNext={sending === "nav-next"}
          busyIcon={<SpinnerSm />}
          onBack={() => onPress("nav-back", { kind: "nav", keys: WIZARD_BACK_KEYS })}
          onNext={() => onPress("nav-next", { kind: "nav", keys: WIZARD_NEXT_KEYS })}
        />
      )}
      <QuestionHeading>{multi.question}</QuestionHeading>
      <div className="flex flex-col gap-1">
        {multi.options.map((option) => (
          <CheckboxRow
            key={option.n}
            n={option.n}
            label={option.label}
            description={option.description}
            checked={option.checked}
            busy={sending === `opt-${option.n}`}
            disabled={locked}
            typed={false}
            onToggle={() => onPress(`opt-${option.n}`, { kind: "toggle", n: option.n })}
          />
        ))}
        {field && field.text !== "" ? (
          <CheckboxRow
            n={field.n}
            label={field.text}
            checked={field.checked}
            busy={sending === `opt-${field.n}`}
            disabled={locked || field.focused}
            typed
            onToggle={() => onPress(`opt-${field.n}`, { kind: "toggle", n: field.n })}
          />
        ) : null}
      </div>
      {answerField}

      {/* The advance row — "Submit" on the last question, "Next" before it. The handler drives the
          closed-loop macro that walks the pointer onto it and verifies before pressing Enter. */}
      <button
        type="button"
        disabled={locked}
        // The name is on the ATTRIBUTE, not just the text: this same button element is renamed
        // "Next" → "Submit" underneath a user who may already have it focused, and a plain
        // child-text swap on a focused control is not reliably re-announced.
        aria-label={multi.advanceLabel}
        onClick={() => onPress("advance", { kind: "advance" })}
        className="font-content flex w-full items-center justify-center gap-2 rounded-lg border border-primary/60 bg-primary/15 px-3 py-2 text-sm font-medium text-foreground transition-colors active:bg-primary/25 disabled:opacity-60"
      >
        {sending === "advance" ? <SpinnerSm /> : null}
        {multi.advanceLabel}
      </button>

      {/* "Chat about this" ABORTS the tool — de-emphasised, apart from the answers (like the wizard). */}
      {multi.escape ? (
        <button
          type="button"
          disabled={locked}
          onClick={() => onPress("escape", { kind: "escape" })}
          className="flex w-full items-center gap-2 rounded-lg border border-dashed border-border/60 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60"
        >
          <span className="font-content min-w-0 flex-1">
            {multi.escape.label}
            <span className="text-muted-foreground"> {t("dialog.endsQuestionsSuffix")}</span>
          </span>
          {sending === "escape" ? <SpinnerSm /> : null}
        </button>
      ) : null}
    </PromptPanel>
  );
}

function ReviewPhase({
  multi,
  lines,
  locked,
  sending,
  onPress,
}: {
  multi: Extract<MultiSelectModel, { phase: "review" }>;
  lines?: StyledLine[];
  locked: boolean;
  sending: string | null;
  onPress: (id: string, action: MultiSelectIntent) => void;
}) {
  useLocale();
  return (
    <PromptPanel ariaLabel={t("dialog.readySubmit")} raw={lines}>
      <QuestionHeading>{t("dialog.readySubmit")}</QuestionHeading>
      {multi.answers ? <AnswerList answers={multi.answers} /> : null}
      {multi.incomplete ? (
        // role="alert" so a screen reader announces the incomplete-answers warning when the review
        // screen mounts — otherwise a user could confirm a partial set without ever hearing it.
        <div role="alert" className="flex items-center gap-1.5 text-xs text-status-working">
          <AlertTriangle className="size-3.5 shrink-0" />
          {t("dialog.incomplete")}
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          disabled={locked}
          onClick={() => onPress("confirm", { kind: "confirm" })}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-primary/60 bg-primary/15 px-3 py-2 text-sm font-medium text-foreground transition-colors active:bg-primary/25 disabled:opacity-60"
        >
          {sending === "confirm" ? <SpinnerSm /> : null}
          {t("dialog.submitAnswers")}
        </button>
        {/* Back to the checkbox screen: one declared keystroke, offered only when the harness
            declares it. De-emphasised like cancel, and above it, because it loses nothing. */}
        {multi.backKeys ? (
          <button
            type="button"
            disabled={locked}
            onClick={() => onPress("back", { kind: "back" })}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border/70 px-3 py-1.5 text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60"
          >
            {sending === "back" ? <SpinnerSm /> : null}
            {t("dialog.backToOptions")}
          </button>
        ) : null}
        <button
          type="button"
          disabled={locked}
          onClick={() => onPress("cancel", { kind: "cancel" })}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-border/70 px-3 py-1.5 text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60"
        >
          {sending === "cancel" ? <SpinnerSm /> : null}
          {/* The terminal's own cancel-row label (Muse: `Interrupt turn`); absent ⇒ "Cancel". */}
          {multi.cancelLabel ?? t("dialog.cancel")}
        </button>
      </div>
    </PromptPanel>
  );
}
