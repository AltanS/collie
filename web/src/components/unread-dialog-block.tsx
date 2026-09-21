import { useState } from "react";

import { cn } from "@/lib/utils";
import type { StyledLine, UnreadDialogModel } from "@/lib/blocks";
import { keyLabel } from "@/lib/key-queue";
import { MIRROR_INVERT, MIRROR_SPACE, styleFor } from "@/components/mirror-space";
import { OptionGroupCaption, PromptPanel } from "@/components/option-button";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

export interface UnreadDialogBlockProps {
  /** The screen no grammar read, and the key its harness DECLARED as the way out (.adr/0053). */
  cancel: UnreadDialogModel;
  /** The whole pane's styled lines — rendered verbatim under the control (see below). */
  lines: StyledLine[];
  /**
   * Injected send handler (from AgentChat). Presentational contract: this component NEVER touches
   * the network — the race guard and the send live in lib/unread-dialog-action.ts's caller.
   */
  onAction: (key: string) => void | Promise<void>;
  /** Read-only device or a gone pane: everything renders (for context) but can't be pressed. */
  disabled?: boolean;
}

// The UNREAD-DIALOG CARD — one declared key over a screen Collie could not read (.adr/0053).
//
// This is the least confident block in the family and it must look it. It claims nothing about the
// screen: no title lifted, no options, no footer parsed. The caption says what is true ("Collie
// cannot read this dialog") and the single button says only the KEY, never what the key does — on
// Muse that key steps back rather than dismisses, so a label promising "cancel" would be a lie on a
// real harness.
//
// The region is the WHOLE pane, mirrored verbatim, because the screen is the only thing the operator
// has to read. Same treatment as menu-block.tsx: React text nodes only, and the agent's own terminal
// colours (MIRROR_SPACE / MIRROR_INVERT, ADR 0002).
//
// DESIGN.md §2: the in-flight state recolours the button and changes NOTHING else — no spinner child
// appears, no border is added, no padding moves. The border is reserved in the base string and the
// pending state only repaints it, so the card the operator is reading does not shift under the tap.
// DESIGN.md §6: `min-h-11` is the 44px tap floor, stated as a floor and never a fixed height.
export function UnreadDialogBlock({ cancel, lines, onAction, disabled }: UnreadDialogBlockProps) {
  useLocale();
  const [sending, setSending] = useState(false);
  const locked = disabled || sending;
  const caption = t("unreadDialog.caption");

  async function press() {
    if (locked) return;
    setSending(true);
    try {
      await onAction(cancel.key);
    } finally {
      setSending(false);
    }
  }

  return (
    <PromptPanel ariaLabel={caption}>
      <OptionGroupCaption>{caption}</OptionGroupCaption>

      <button
        type="button"
        disabled={locked}
        aria-busy={sending}
        onClick={press}
        className={cn(
          "font-content flex min-h-11 w-full items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium text-foreground transition-colors disabled:opacity-60",
          sending ? "border-primary bg-primary/25" : "border-primary/60 bg-primary/15 active:bg-primary/25",
        )}
      >
        {keyLabel(cancel.key)}
      </button>

      {/* The region, mirrored verbatim. Scrolls horizontally on its own so a wide TUI never makes the
          page pan. */}
      <pre
        className={cn(
          "m-0 overflow-x-auto rounded-lg px-2 py-1.5 font-mono text-[11px] leading-[1.25] whitespace-pre",
          MIRROR_SPACE,
          MIRROR_INVERT,
        )}
      >
        {lines.map((line, li) => (
          <span key={li}>
            {li > 0 ? "\n" : null}
            {line.segments.map((s, si) => (
              <span key={si} style={styleFor(s)}>
                {s.text}
              </span>
            ))}
          </span>
        ))}
      </pre>
    </PromptPanel>
  );
}
