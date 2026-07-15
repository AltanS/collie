import { useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { MultiSelectModel } from "@/lib/blocks";
import type { MultiSelectIntent } from "@/lib/multi-select-action";
import { KeyBadge, optionSurface, PromptPanel, QuestionHeading } from "@/components/option-button";

export interface MultiSelectBlockProps {
  /** The detected multi-select dialog (checkbox screen or review screen). */
  multi: MultiSelectModel;
  /**
   * Injected send handler (from AgentChat). Presentational contract: this component NEVER touches
   * the network — it maps taps to intents while the handler runs the race-guarded choreography
   * (toggle = one digit; submit = the closed-loop Down→Up→verify→Enter macro). Returning/throwing
   * simply clears the busy state.
   */
  onAction: (action: MultiSelectIntent) => void | Promise<void>;
  /** Read-only device or a gone pane: everything renders (for context) but can't be pressed. */
  disabled?: boolean;
}

// Native, tappable rendering of Claude's multiSelect AskUserQuestion. The terminal is the single
// source of truth for the checkbox state — a digit is an XOR (a double-fire would invert it), so
// there is NO optimistic local `checked`; each tap locks EVERY control (a `sending` state) until the
// round-trip re-derives the fresh state. That per-tap lock is an acknowledged v1 limitation (you
// can't queue toggles). Every visible string (labels, descriptions) is a React text node — the XSS
// boundary is unchanged.
export function MultiSelectBlock({ multi, onAction, disabled }: MultiSelectBlockProps) {
  const [sending, setSending] = useState<string | null>(null);
  const locked = disabled || sending !== null;

  async function press(id: string, action: MultiSelectIntent) {
    if (locked) return;
    setSending(id);
    try {
      await onAction(action);
    } finally {
      setSending(null);
    }
  }

  if (multi.phase === "review") {
    return <ReviewPhase incomplete={multi.incomplete} locked={locked} sending={sending} onPress={press} />;
  }
  return <CheckboxPhase multi={multi} locked={locked} sending={sending} onPress={press} />;
}

const spinnerSm = (
  <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Sending" />
);
const spinnerMd = (
  <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" aria-label="Sending" />
);

function CheckboxPhase({
  multi,
  locked,
  sending,
  onPress,
}: {
  multi: Extract<MultiSelectModel, { phase: "checkbox" }>;
  locked: boolean;
  sending: string | null;
  onPress: (id: string, action: MultiSelectIntent) => void;
}) {
  return (
    <PromptPanel ariaLabel={multi.question}>
      <QuestionHeading>{multi.question}</QuestionHeading>
      <div className="flex flex-col gap-1">
        {multi.options.map((option) => {
          const id = `opt-${option.n}`;
          const busy = sending === id;
          const tone = busy ? "busy" : "default";
          return (
            <button
              key={option.n}
              type="button"
              role="checkbox"
              aria-checked={option.checked}
              disabled={locked}
              onClick={() => onPress(id, { kind: "toggle", n: option.n })}
              className={optionSurface(tone)}
            >
              {/* The checkbox reflects the TERMINAL state (option.checked), never a local guess. */}
              <span
                aria-hidden
                className={cn(
                  "mt-px flex size-4 shrink-0 items-center justify-center rounded border",
                  option.checked
                    ? "border-primary bg-primary/20 text-primary"
                    : "border-border bg-background",
                )}
              >
                {option.checked ? <Check className="size-3" /> : null}
              </span>
              <KeyBadge tone={tone}>{option.n}</KeyBadge>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium leading-snug text-foreground">
                  {option.label}
                </span>
                {option.description ? (
                  <span className="block text-xs leading-snug text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </span>
              {busy ? spinnerMd : null}
            </button>
          );
        })}
      </div>

      {/* Submit advances to the review screen — the handler drives the closed-loop macro. */}
      <button
        type="button"
        disabled={locked}
        onClick={() => onPress("submit", { kind: "submit" })}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-primary/60 bg-primary/15 px-3 py-2 text-sm font-medium text-foreground transition-colors active:bg-primary/25 disabled:opacity-60"
      >
        {sending === "submit" ? spinnerSm : null}
        Submit
      </button>

      {/* "Chat about this" ABORTS the tool — de-emphasised, apart from the answers (like the wizard). */}
      {multi.escape ? (
        <button
          type="button"
          disabled={locked}
          onClick={() => onPress("escape", { kind: "escape" })}
          className="flex w-full items-center gap-2 rounded-lg border border-dashed border-border/60 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60"
        >
          <span className="min-w-0 flex-1">
            {multi.escape.label}
            <span className="text-muted-foreground/70"> — ends the questions</span>
          </span>
          {sending === "escape" ? spinnerSm : null}
        </button>
      ) : null}
    </PromptPanel>
  );
}

function ReviewPhase({
  incomplete,
  locked,
  sending,
  onPress,
}: {
  incomplete: boolean;
  locked: boolean;
  sending: string | null;
  onPress: (id: string, action: MultiSelectIntent) => void;
}) {
  return (
    <PromptPanel ariaLabel="Ready to submit your answers?">
      <QuestionHeading>Ready to submit your answers?</QuestionHeading>
      {incomplete ? (
        // role="alert" so a screen reader announces the incomplete-answers warning when the review
        // screen mounts — otherwise a user could confirm a partial set without ever hearing it.
        <div role="alert" className="flex items-center gap-1.5 text-xs text-yellow-500">
          <AlertTriangle className="size-3.5 shrink-0" />
          You have not answered all questions
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          disabled={locked}
          onClick={() => onPress("confirm", { kind: "confirm" })}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-primary/60 bg-primary/15 px-3 py-2 text-sm font-medium text-foreground transition-colors active:bg-primary/25 disabled:opacity-60"
        >
          {sending === "confirm" ? spinnerSm : null}
          Submit answers
        </button>
        <button
          type="button"
          disabled={locked}
          onClick={() => onPress("cancel", { kind: "cancel" })}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-border/70 px-3 py-1.5 text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60"
        >
          {sending === "cancel" ? spinnerSm : null}
          Cancel
        </button>
      </div>
    </PromptPanel>
  );
}
