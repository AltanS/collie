import { useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pencil,
  StickyNote,
  Trash2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { PreviewOption, PreviewSelectModel } from "@/lib/blocks";
import {
  KeyBadge,
  OptionGroupCaption,
  optionSurface,
  PromptPanel,
  QuestionHeading,
} from "@/components/option-button";
import { NOTE_MAX_LENGTH } from "@/lib/preview-action";
import { WIZARD_BACK_KEYS, WIZARD_NEXT_KEYS } from "@/lib/harness/claude/wizard";

/** One tap's intent, resolved to keystrokes by the injected handler (preview-action.ts). */
export type PreviewBlockAction =
  | { kind: "option"; option: PreviewOption }
  | { kind: "note"; text: string } // "" removes the note
  | { kind: "nav"; keys: string[] };

export interface PreviewSelectBlockProps {
  /** The detected preview-variant dialog (single question or one wizard step). */
  preview: PreviewSelectModel;
  /**
   * Injected send handler (from AgentChat). Presentational contract: this component NEVER touches
   * the network — it maps taps to intents while the handler runs the race-guarded choreography
   * (digit→verify→Enter for options; n→verify→type→Escape for notes). Returning/throwing simply
   * clears the busy state.
   */
  onAction: (action: PreviewBlockAction) => void | Promise<void>;
  /** Read-only device or a gone pane: everything renders (for context) but can't be pressed. */
  disabled?: boolean;
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
export function PreviewSelectBlock({ preview, onAction, disabled }: PreviewSelectBlockProps) {
  const [sending, setSending] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const terminalEditing = preview.note.state === "editing";
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

  async function saveNote() {
    const text = draft.trim();
    if (text.length === 0) return;
    await press("note-save", { kind: "note", text });
    setEditorOpen(false);
  }

  const wizard = preview.steps !== null;
  const atFirstQuestion = wizard && (preview.steps![0]?.current ?? false);
  const pointedLabel = preview.options.find((o) => o.pointed)?.label;
  const busyIcon = (
    <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Sending" />
  );

  return (
    <PromptPanel ariaLabel={preview.question}>
      {/* Wizard form only: the stepper chips + Left/Right navigation, exactly as in WizardBlock —
          a preview question is just one step of the same dialog. Single-question dialogs keep
          their question/chip line in the raw mirror above, so neither renders here. */}
      {wizard && (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Previous step"
            disabled={locked || atFirstQuestion}
            onClick={() => press("nav-back", { kind: "nav", keys: WIZARD_BACK_KEYS })}
            className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 text-muted-foreground transition-colors active:bg-muted disabled:opacity-50"
          >
            {sending === "nav-back" ? busyIcon : <ChevronLeft className="size-4" />}
          </button>
          <ol className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {preview.steps!.map((step, i) => (
              <li
                key={i}
                aria-current={step.current ? "step" : undefined}
                className={cn(
                  "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-tight",
                  step.current
                    ? "border-primary/60 bg-primary/15 font-medium text-foreground"
                    : "border-border/60 text-muted-foreground",
                )}
              >
                {step.answered ? (
                  <Check className="size-3 shrink-0 text-primary" aria-label="Answered" />
                ) : null}
                <span className="truncate">{step.label}</span>
              </li>
            ))}
            <li className="flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[11px] leading-tight text-muted-foreground">
              <span>Submit</span>
            </li>
          </ol>
          <button
            type="button"
            aria-label="Next step"
            disabled={locked}
            onClick={() => press("nav-next", { kind: "nav", keys: WIZARD_NEXT_KEYS })}
            className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 text-muted-foreground transition-colors active:bg-muted disabled:opacity-50"
          >
            {sending === "nav-next" ? busyIcon : <ChevronRight className="size-4" />}
          </button>
        </div>
      )}
      {wizard && <QuestionHeading>{preview.question}</QuestionHeading>}
      {!wizard && <OptionGroupCaption>Choose an option</OptionGroupCaption>}

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
                aria-label={option.pointed ? "Previewed below" : undefined}
              />
              <KeyBadge tone={tone}>{option.n}</KeyBadge>
              <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
                {option.label}
              </span>
              {busy ? (
                <Loader2
                  className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground"
                  aria-label="Sending"
                />
              ) : option.chosen ? (
                <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-label="Current answer" />
              ) : null}
            </button>
          );
        })}
      </div>

      {/* The pointed option's preview pane, verbatim (mono text nodes — never markup). */}
      {preview.preview.length > 0 && (
        <div className="rounded-lg border border-border/60 bg-muted/20 px-2 py-1.5">
          {pointedLabel && (
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Preview · {pointedLabel}
            </div>
          )}
          <pre className="m-0 min-w-0 w-full max-w-full overflow-x-auto font-mono text-[10px] leading-[1.3] text-foreground/80">
            {preview.preview.join("\n")}
          </pre>
        </div>
      )}

      {/* The question's note. Three surfaces: the terminal-editing banner (everything locked), the
          attached-note card with edit/remove, or the add-note affordance — plus our own editor. */}
      {terminalEditing ? (
        <div className="rounded-lg border border-dashed border-yellow-500/50 px-3 py-2 text-xs text-yellow-500">
          Note is being edited in the terminal — controls resume when it closes.
          {preview.note.text ? <span className="text-muted-foreground"> ({preview.note.text})</span> : null}
        </div>
      ) : editorOpen ? (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
          <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <StickyNote className="size-3.5 shrink-0" />
            Note for this question
          </label>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={NOTE_MAX_LENGTH}
            rows={2}
            autoFocus
            aria-label="Note text"
            placeholder="Add context for your answer…"
            className="w-full resize-none rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-primary/60"
          />
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              disabled={sending !== null}
              onClick={() => setEditorOpen(false)}
              className="rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={locked || draft.trim().length === 0}
              onClick={() => void saveNote()}
              className="flex items-center gap-1.5 rounded-md border border-primary/60 bg-primary/15 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors active:bg-primary/25 disabled:opacity-60"
            >
              {sending === "note-save" ? busyIcon : null}
              Save note
            </button>
          </div>
        </div>
      ) : preview.note.state === "attached" ? (
        <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
          <StickyNote className="mt-0.5 size-3.5 shrink-0 text-primary" aria-label="Note" />
          <span className="min-w-0 flex-1 text-xs text-foreground/90">{preview.note.text}</span>
          <button
            type="button"
            aria-label="Edit note"
            disabled={locked}
            onClick={() => {
              setDraft(preview.note.text);
              setEditorOpen(true);
            }}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors active:bg-muted disabled:opacity-50"
          >
            <Pencil className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Remove note"
            disabled={locked}
            onClick={() => void press("note-remove", { kind: "note", text: "" })}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors active:bg-muted disabled:opacity-50"
          >
            {sending === "note-remove" ? busyIcon : <Trash2 className="size-3.5" />}
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={locked}
          onClick={() => {
            setDraft("");
            setEditorOpen(true);
          }}
          className="flex w-full items-center gap-2 rounded-lg border border-dashed border-border/60 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60"
        >
          <StickyNote className="size-3.5 shrink-0" />
          Add a note to this answer
        </button>
      )}
    </PromptPanel>
  );
}
