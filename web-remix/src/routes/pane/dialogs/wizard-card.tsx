// The wizard card: Claude's multi-question AskUserQuestion, as native controls
// (web/src/components/wizard-block.tsx). It mirrors what the TUI shows, the stepper chips and then the
// CURRENT step, because the terminal is the one source of truth: the card holds no form state. Every
// control resolves to ONE keystroke that routes/pane/dialogs/actions.ts guards and sends (ADR 0080).
// One control is in flight at a time: its spinner shows and the rest lock.
import { on, type Handle } from "remix/component";
import { Check, TriangleAlert } from "lucide";

import type { WizardOption } from "@web/lib/blocks";
import { WIZARD_BACK_KEYS, WIZARD_CANCEL_KEYS, WIZARD_NEXT_KEYS, WIZARD_SUBMIT_KEYS } from "@web/lib/harness/wizard-model";
import { t } from "@web/lib/i18n";

import { Collapse } from "../../../ui/collapse";
import { Icon } from "../../../ui/icon";
import { PromptPanel } from "../../../ui/prompt-panel";
import { toRows } from "../../../screen/rows";
import type { WizardCard } from "../cards";
import type { CardActions } from "../dialog-card";
import {
  AnswerList,
  ChoiceRow,
  createPending,
  ESCAPE_ROW,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  QuestionHeading,
  spinner,
  WizardStepper,
} from "./parts";

export interface WizardCardProps {
  card: WizardCard;
  disabled: boolean;
  actions: CardActions;
}

export function WizardDialogCard(handle: Handle<WizardCardProps>) {
  const pending = createPending(handle);

  return () => {
    const { card, disabled, actions } = handle.props;
    const { wizard } = card.block;
    const sending = pending.sending;
    const locked = disabled || sending !== null;
    const press = (id: string, keys: string[]): void => void pending.press(id, () => actions.wizard(keys));

    const answerRow = (option: WizardOption, i: number) => {
      const id = `opt-${String(i)}`;
      const busy = sending === id;
      return (
        <ChoiceRow
          key={id}
          testId="dialog-option"
          tone={busy ? "busy" : option.chosen ? "selected" : "default"}
          badge={option.keys[0]}
          label={option.label}
          description={option.description}
          disabled={locked}
          trailing={
            busy ? (
              spinner("mt-0.5 size-4")
            ) : option.chosen ? (
              <Icon icon={Check} class="mt-0.5 size-4 shrink-0 text-primary" label={t("dialog.preview.currentAnswerAria")} />
            ) : null
          }
          onPress={() => press(id, option.keys)}
        />
      );
    };

    const body =
      wizard.phase === "question" ? (
        <>
          <QuestionHeading>{wizard.question}</QuestionHeading>
          <div class="flex flex-col gap-1">{card.answers.map(answerRow)}</div>
          {/* "Chat about this" ends the WHOLE wizard (the tool call resolves as declined), so it
              stands apart and quiet, never like an answer. */}
          {card.escapes.map((option, i) => {
            const id = `esc-${String(i)}`;
            return (
              <button
                key={id}
                type="button"
                disabled={locked}
                class={ESCAPE_ROW}
                mix={on("click", () => press(id, option.keys))}
              >
                <span class="font-content min-w-0 flex-1">
                  {option.label}
                  <span class="text-muted-foreground"> {t("dialog.endsQuestionsSuffix")}</span>
                </span>
                {sending === id ? spinner() : null}
              </button>
            );
          })}
        </>
      ) : (
        <>
          <div class="text-sm font-medium text-foreground">{t("dialog.reviewAnswers")}</div>
          <AnswerList answers={wizard.answers} />
          <Collapse open={wizard.incomplete}>
            <div class="flex items-center gap-1.5 text-xs text-status-working">
              <Icon icon={TriangleAlert} class="size-3.5 shrink-0" />
              {t("dialog.incomplete")}
            </div>
          </Collapse>
          <div class="flex flex-col gap-1.5">
            <button
              type="button"
              disabled={locked}
              class={PRIMARY_BUTTON}
              mix={on("click", () => press("submit", wizard.submitKeys ?? WIZARD_SUBMIT_KEYS))}
            >
              {sending === "submit" ? spinner("size-4") : null}
              {t("dialog.submitAnswers")}
            </button>
            <button
              type="button"
              disabled={locked}
              class={QUIET_BUTTON}
              mix={on("click", () => press("cancel", wizard.cancelKeys ?? WIZARD_CANCEL_KEYS))}
            >
              {sending === "cancel" ? spinner() : null}
              {wizard.cancelLabel ?? t("dialog.cancel")}
            </button>
          </div>
        </>
      );

    return (
      <PromptPanel ariaLabel={card.caption} raw={toRows(card.block.lines)}>
        <WizardStepper
          view={card.stepper}
          locked={locked}
          busyBack={sending === "back"}
          busyNext={sending === "next"}
          onBack={() => press("back", WIZARD_BACK_KEYS)}
          onNext={() => press("next", WIZARD_NEXT_KEYS)}
        />
        {body}
      </PromptPanel>
    );
  };
}
