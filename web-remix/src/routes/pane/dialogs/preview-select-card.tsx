// The preview-select card: Claude's preview-variant AskUserQuestion, as native controls
// (web/src/components/preview-select-block.tsx): the options, the pointed option's preview pane and
// the per-question note. The preview belongs to the POINTED option and the note to the QUESTION; the
// terminal is the one source of truth, so the card holds no answer state, only the note editor's
// draft. Taps map to `PreviewCardAction`s; routes/pane/dialogs/actions.ts runs the guarded
// choreography (digit, verify, Enter for an option; n, verify, type, Escape for a note; ADR 0080).
//
// While the TUI's own note input is focused (someone is typing in the terminal) EVERY control
// locks: a key we sent would be typed into their note. A banner says so, and the poll clears it.
import { on, ref, type Handle } from "remix/component";
import { Check, ChevronRight, Pencil, StickyNote, Trash2 } from "lucide";

import { WIZARD_BACK_KEYS, WIZARD_NEXT_KEYS } from "@web/lib/harness/wizard-model";
import { t } from "@web/lib/i18n";
import { cn } from "@web/lib/utils";

import { toRows } from "../../../screen/rows";
import { Collapse } from "../../../ui/collapse";
import { Icon } from "../../../ui/icon";
import { OptionCaption, PromptPanel } from "../../../ui/prompt-panel";
import type { PreviewSelectCard } from "../cards";
import type { CardActions } from "../dialog-card";
import { ChoiceRow, createPending, QuestionHeading, spinner, WizardStepper } from "./parts";
import type { PreviewCardAction } from "./actions";

/**
 * web/src/lib/preview-action.ts `NOTE_MAX_LENGTH`, held here so the card does not import the preview
 * action (the dialog guard and every harness grammar) for one number (S3). ../feedback-limit.test.ts
 * keeps the two equal.
 */
export const NOTE_MAX_LENGTH = 300;

export interface PreviewSelectCardProps {
  card: PreviewSelectCard;
  disabled: boolean;
  actions: CardActions;
}

const ICON_BUTTON =
  "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors active:bg-muted disabled:opacity-50";

export function PreviewSelectDialogCard(handle: Handle<PreviewSelectCardProps>) {
  const pending = createPending(handle);
  let editorOpen = false;
  let draft = "";

  const press = (id: string, action: PreviewCardAction): Promise<boolean> =>
    pending.press(id, () => handle.props.actions.preview(action));

  const openEditor = (text: string): void => {
    draft = text;
    editorOpen = true;
    void handle.update();
  };

  const saveNote = async (): Promise<void> => {
    const text = draft.trim();
    if (text.length === 0) return;
    // Closed only when the note went out: a refused save keeps what someone just thumb-typed.
    if (await press("note-save", { kind: "note", text })) {
      editorOpen = false;
      if (!handle.signal.aborted) void handle.update();
    }
  };

  return () => {
    const { card, disabled } = handle.props;
    const { preview } = card.block;
    const sending = pending.sending;
    const terminalEditing = card.terminalEditing;
    const locked = disabled || sending !== null || terminalEditing;
    const noteAttached = preview.note.state === "attached";
    const quiet = !terminalEditing && !editorOpen;

    return (
      <PromptPanel ariaLabel={preview.question} raw={toRows(card.block.lines)}>
        {/* Wizard form only: the stepper and its Left and Right, as in the wizard card, since a
            preview question is one step of the same dialog. A single-question dialog keeps its
            question in the raw mirror above, so neither renders here. */}
        {card.stepper !== null && (
          <WizardStepper
            view={card.stepper}
            locked={locked}
            busyBack={sending === "nav-back"}
            busyNext={sending === "nav-next"}
            onBack={() => void press("nav-back", { kind: "nav", keys: WIZARD_BACK_KEYS })}
            onNext={() => void press("nav-next", { kind: "nav", keys: WIZARD_NEXT_KEYS })}
          />
        )}
        {card.stepper !== null ? <QuestionHeading>{card.caption}</QuestionHeading> : <OptionCaption>{card.caption}</OptionCaption>}

        {/* Tapping an option selects it outright. Each row leads with the pointer chevron (whose
            preview shows below), then its terminal-menu digit. */}
        <div class="flex flex-col gap-1">
          {preview.options.map((option, i) => {
            const id = `opt-${String(i)}`;
            const busy = sending === id;
            return (
              <ChoiceRow
                key={id}
                testId="dialog-option"
                tone={busy ? "busy" : option.chosen ? "selected" : "default"}
                lead={
                  <Icon
                    icon={ChevronRight}
                    class={cn("mt-[3px] size-3.5 shrink-0", option.pointed ? "text-primary" : "text-transparent")}
                    label={option.pointed ? t("dialog.preview.previewedBelowAria") : undefined}
                  />
                }
                badge={String(option.n)}
                label={option.label}
                disabled={locked}
                trailing={
                  busy ? (
                    spinner("mt-0.5 size-4")
                  ) : option.chosen ? (
                    <Icon icon={Check} class="mt-0.5 size-4 shrink-0 text-primary" label={t("dialog.preview.currentAnswerAria")} />
                  ) : null
                }
                onPress={() => void press(id, { kind: "option", option })}
              />
            );
          })}
        </div>

        {/* The pointed option's preview pane, verbatim: mono text, never markup. */}
        <Collapse open={preview.preview.length > 0}>
          <div class="rounded-lg border border-border bg-muted/20 px-2 py-1.5">
            {card.pointedLabel ? (
              <div class="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                {t("dialog.preview.previewLabel", { label: card.pointedLabel })}
              </div>
            ) : null}
            <pre class="m-0 w-full max-w-full min-w-0 overflow-x-auto font-mono text-[10px] leading-[1.3] text-foreground/80">
              {preview.preview.join("\n")}
            </pre>
          </div>
        </Collapse>

        {/* The question's note: the terminal-editing banner (everything locked), our editor, the
            attached note with edit and remove, or the add-note offer. Exactly one is open. */}
        <Collapse open={terminalEditing}>
          <div class="rounded-lg border border-dashed border-status-working/50 px-3 py-2 text-xs text-status-working">
            {t("dialog.preview.editingBanner")}
            {preview.note.text ? <span class="font-content text-muted-foreground"> ({preview.note.text})</span> : null}
          </div>
        </Collapse>
        <Collapse open={!terminalEditing && editorOpen}>
          <div class="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2">
            <label
              for={`preview-note-${handle.id}`}
              class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
            >
              <Icon icon={StickyNote} class="size-3.5 shrink-0" />
              {t("dialog.preview.noteForQuestion")}
            </label>
            <textarea
              id={`preview-note-${handle.id}`}
              rows={2}
              maxLength={NOTE_MAX_LENGTH}
              aria-label={t("dialog.preview.noteTextAria")}
              placeholder={t("dialog.preview.notePlaceholder")}
              value={draft}
              class="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-primary/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              mix={[
                // Focused on every open (the field mounts with the editor), after the panel is named.
                ref((node: HTMLTextAreaElement) => node.focus()),
                on("input", (event) => {
                  draft = event.currentTarget.value;
                  void handle.update();
                }),
              ]}
            />
            <div class="flex items-center justify-end gap-1.5">
              <button
                type="button"
                disabled={sending !== null}
                class="rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60"
                mix={on("click", () => {
                  editorOpen = false;
                  void handle.update();
                })}
              >
                {t("dialog.cancel")}
              </button>
              <button
                type="button"
                disabled={locked || draft.trim().length === 0}
                class="flex items-center gap-1.5 rounded-md border border-primary/60 bg-primary/15 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors active:bg-primary/25 disabled:opacity-60"
                mix={on("click", () => void saveNote())}
              >
                {sending === "note-save" ? spinner() : null}
                {t("dialog.preview.saveNote")}
              </button>
            </div>
          </div>
        </Collapse>
        <Collapse open={quiet && noteAttached}>
          <div class="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
            <Icon icon={StickyNote} class="mt-0.5 size-3.5 shrink-0 text-primary" label={t("dialog.preview.noteAria")} />
            <span class="font-content min-w-0 flex-1 text-xs text-foreground/90">{preview.note.text}</span>
            <button
              type="button"
              aria-label={t("dialog.preview.editNoteAria")}
              disabled={locked}
              class={ICON_BUTTON}
              mix={on("click", () => openEditor(handle.props.card.block.preview.note.text))}
            >
              <Icon icon={Pencil} class="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={t("dialog.preview.removeNoteAria")}
              disabled={locked}
              class={ICON_BUTTON}
              mix={on("click", () => void press("note-remove", { kind: "note", text: "" }))}
            >
              {sending === "note-remove" ? spinner() : <Icon icon={Trash2} class="size-3.5" />}
            </button>
          </div>
        </Collapse>
        <Collapse open={quiet && !noteAttached}>
          <button
            type="button"
            disabled={locked}
            class="flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60"
            mix={on("click", () => openEditor(""))}
          >
            <Icon icon={StickyNote} class="size-3.5 shrink-0" />
            {t("dialog.preview.addNote")}
          </button>
        </Collapse>
      </PromptPanel>
    );
  };
}
