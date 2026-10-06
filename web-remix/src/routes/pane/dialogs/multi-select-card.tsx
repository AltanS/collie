// The multi-select card: Claude's multiSelect AskUserQuestion, as native checkboxes plus its review
// screen (web/src/components/multi-select-block.tsx). The terminal is the single source of truth for
// the checkbox state: a digit is an XOR, so there is NO optimistic local `checked`. Each tap locks
// EVERY control until the round-trip re-derives the fresh state. Taps map to `MultiSelectIntent`s;
// routes/pane/dialogs/actions.ts runs the guarded choreography behind them (toggle, the closed-loop
// Submit macro, confirm, cancel; ADR 0080).
//
// One PromptPanel serves both phases, so the Terminal choice (ADR 0056) survives the step from the
// checkbox screen to the review.
import { on, type Handle } from "remix/component";
import { Check, TriangleAlert } from "lucide";

import type { MultiSelectModel } from "@web/lib/blocks";
import { WIZARD_BACK_KEYS, WIZARD_NEXT_KEYS } from "@web/lib/harness/wizard-model";
import { t } from "@web/lib/i18n";
import type { MultiSelectIntent } from "@web/lib/multi-select-action";
import { cn } from "@web/lib/utils";

import { toRows } from "../../../screen/rows";
import { Collapse } from "../../../ui/collapse";
import { Icon } from "../../../ui/icon";
import { PromptPanel } from "../../../ui/prompt-panel";
import type { MultiSelectCard } from "../cards";
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

export interface MultiSelectCardProps {
  card: MultiSelectCard;
  disabled: boolean;
  actions: CardActions;
}

type CheckboxModel = Extract<MultiSelectModel, { phase: "checkbox" }>;
type ReviewModel = Extract<MultiSelectModel, { phase: "review" }>;

export function MultiSelectDialogCard(handle: Handle<MultiSelectCardProps>) {
  const pending = createPending(handle);

  return () => {
    const { card, disabled, actions } = handle.props;
    const { multi } = card.block;
    const sending = pending.sending;
    const locked = disabled || sending !== null;
    const press = (id: string, intent: MultiSelectIntent): void => void pending.press(id, () => actions.multiSelect(intent));

    const checkbox = (m: CheckboxModel) => (
      <>
        {card.stepper !== null && (
          <WizardStepper
            view={card.stepper}
            locked={locked}
            busyBack={sending === "nav-back"}
            busyNext={sending === "nav-next"}
            onBack={() => press("nav-back", { kind: "nav", keys: WIZARD_BACK_KEYS })}
            onNext={() => press("nav-next", { kind: "nav", keys: WIZARD_NEXT_KEYS })}
          />
        )}
        <QuestionHeading>{m.question}</QuestionHeading>
        <div class="flex flex-col gap-1">
          {m.options.map((option) => {
            const id = `opt-${String(option.n)}`;
            const busy = sending === id;
            return (
              <ChoiceRow
                key={id}
                testId="multi-option"
                role="checkbox"
                aria-checked={option.checked}
                tone={busy ? "busy" : "default"}
                // The box reflects the TERMINAL state (option.checked), never a local guess.
                lead={
                  <span
                    aria-hidden="true"
                    class={cn(
                      "mt-px flex size-4 shrink-0 items-center justify-center rounded border",
                      option.checked ? "border-primary bg-primary/20 text-primary" : "border-border bg-background",
                    )}
                  >
                    {option.checked ? <Icon icon={Check} class="size-3" /> : null}
                  </span>
                }
                badge={String(option.n)}
                label={option.label}
                description={option.description}
                disabled={locked}
                trailing={busy ? spinner("mt-0.5 size-4") : null}
                onPress={() => press(id, { kind: "toggle", n: option.n })}
              />
            );
          })}
        </div>
        {/* The advance row: "Submit" on the last question, "Next" before it. The name is on the
            ATTRIBUTE too: this one button is renamed under a user who may have it focused, and a
            child-text swap on a focused control is not reliably re-announced. */}
        <button
          type="button"
          data-testid="multi-submit"
          disabled={locked}
          aria-label={m.advanceLabel}
          class={PRIMARY_BUTTON}
          mix={on("click", () => press("advance", { kind: "advance" }))}
        >
          {sending === "advance" ? spinner() : null}
          {m.advanceLabel}
        </button>
        {/* "Chat about this" ABORTS the tool: de-emphasised, apart from the answers. */}
        <Collapse open={m.escape !== null}>
          <button
            type="button"
            disabled={locked}
            class={ESCAPE_ROW}
            mix={on("click", () => press("escape", { kind: "escape" }))}
          >
            <span class="font-content min-w-0 flex-1">
              {m.escape?.label}
              <span class="text-muted-foreground"> {t("dialog.endsQuestionsSuffix")}</span>
            </span>
            {sending === "escape" ? spinner() : null}
          </button>
        </Collapse>
      </>
    );

    const review = (m: ReviewModel) => (
      <>
        <QuestionHeading>{t("dialog.readySubmit")}</QuestionHeading>
        {m.answers ? <AnswerList answers={m.answers} /> : null}
        {/* role="alert": a screen reader hears the warning when the review mounts, so nobody
            confirms a partial set without ever being told. */}
        <Collapse open={m.incomplete}>
          <div role="alert" class="flex items-center gap-1.5 text-xs text-status-working">
            <Icon icon={TriangleAlert} class="size-3.5 shrink-0" />
            {t("dialog.incomplete")}
          </div>
        </Collapse>
        <div class="flex flex-col gap-1.5">
          <button
            type="button"
            data-testid="multi-submit"
            disabled={locked}
            class={PRIMARY_BUTTON}
            mix={on("click", () => press("confirm", { kind: "confirm" }))}
          >
            {sending === "confirm" ? spinner() : null}
            {t("dialog.submitAnswers")}
          </button>
          {/* Back to the checkbox screen: one declared key, offered only when the harness declares
              it. Above cancel, because it loses nothing. */}
          <Collapse open={m.backKeys !== undefined}>
            <button type="button" disabled={locked} class={QUIET_BUTTON} mix={on("click", () => press("back", { kind: "back" }))}>
              {sending === "back" ? spinner() : null}
              {t("dialog.backToOptions")}
            </button>
          </Collapse>
          <button type="button" disabled={locked} class={QUIET_BUTTON} mix={on("click", () => press("cancel", { kind: "cancel" }))}>
            {sending === "cancel" ? spinner() : null}
            {/* The terminal's own cancel-row label (Muse: `Interrupt turn`); absent, "Cancel". */}
            {m.cancelLabel ?? t("dialog.cancel")}
          </button>
        </div>
      </>
    );

    return (
      <PromptPanel ariaLabel={card.caption} raw={toRows(card.block.lines)}>
        {multi.phase === "checkbox" ? checkbox(multi) : review(multi)}
      </PromptPanel>
    );
  };
}
