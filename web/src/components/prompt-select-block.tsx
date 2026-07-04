import { useState } from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { PromptModel, PromptOption } from "@/lib/blocks";

export interface PromptSelectBlockProps {
  /** The detected dialog: question (screen-reader label) + selectable options as buttons. */
  prompt: PromptModel;
  /**
   * Injected send handler (from AgentChat). Presentational contract: this component NEVER touches
   * the network — it just reflects the sending state while the handler runs the race guard and
   * sends the option's keys. Returning/throwing simply clears the busy state.
   */
  onAction: (option: PromptOption) => void | Promise<void>;
  /** Read-only device or a gone pane: buttons still render (for context) but can't be pressed. */
  disabled?: boolean;
}

// Native, tappable rendering of a Claude single-choice dialog. Every visible string — the option
// label and its description — is a React text node (the XSS boundary is unchanged; nothing is ever
// set as innerHTML). Real <button>s, so they're keyboard-focusable and screen-reader-announced; the
// group is labelled by the question (which stays visible in the raw scrollback just above, so it's
// not repeated here). One option can be in flight at a time — its spinner shows and the rest lock,
// preventing a double-send.
export function PromptSelectBlock({ prompt, onAction, disabled }: PromptSelectBlockProps) {
  const [sending, setSending] = useState<number | null>(null);

  async function press(index: number, option: PromptOption) {
    if (disabled || sending !== null) return;
    setSending(index);
    try {
      await onAction(option);
    } finally {
      setSending(null);
    }
  }

  return (
    <div role="group" aria-label={prompt.question} className="my-1.5 flex flex-col gap-1.5">
      {prompt.options.map((option, index) => {
        const busy = sending === index;
        return (
          <button
            key={index}
            type="button"
            disabled={disabled || sending !== null}
            onClick={() => press(index, option)}
            className={cn(
              "flex w-full items-start gap-2 rounded-lg border border-border/70 bg-muted/40 px-3 py-2",
              "text-left transition-colors active:bg-muted disabled:opacity-60",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">{option.label}</span>
              {option.description ? (
                <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span>
              ) : null}
            </span>
            {busy ? (
              <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" aria-label="Sending" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
