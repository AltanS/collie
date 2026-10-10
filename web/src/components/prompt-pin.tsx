import { ArrowUpToLine, Loader2, User } from "lucide-react";

import { t } from "@/lib/i18n";
import type { Pin } from "@/lib/prompt-pin";
import { cn } from "@/lib/utils";

// THE PROMPT PIN: the question the turns on screen answer, held above the Chat thread.
//
// An OVERLAY, never a row in the thread. It comes and goes as the reader scrolls, and a row that did
// that would push the text being read (DESIGN.md, "Every layout shift is a defect"). Floating over the
// scroller it moves nothing, and its height is FIXED at two lines whatever the prompt's length, so a
// tap aimed just below it lands where it was aimed whichever prompt is pinned.
//
// It wears the operator's own colour, the well `UserTurn` uses (`chat-cards.tsx`), over an opaque
// backing so the thread scrolling under it does not show through the tint.

const PIN =
  "pointer-events-auto flex h-14 w-full min-w-0 items-start gap-2 overflow-hidden rounded-md border border-status-working/25 bg-background text-left shadow-sm transition-colors active:bg-muted";
const PIN_WELL = "flex h-full w-full min-w-0 items-start gap-2 bg-status-working/8 px-3 py-2";
const PIN_TEXT = "font-content line-clamp-2 min-w-0 flex-1 text-sm leading-5 wrap-anywhere whitespace-pre-wrap";

export function PromptPin({ pin, busy, onTap }: { pin: Exclude<Pin, null>; busy: boolean; onTap: () => void }) {
  const earlier = pin.kind === "earlier";
  const Icon = busy ? Loader2 : earlier ? ArrowUpToLine : User;
  return (
    <button type="button" data-slot="prompt-pin" className={PIN} onClick={onTap} disabled={busy} aria-busy={busy}>
      <span className={PIN_WELL}>
        <Icon
          aria-hidden
          className={cn("mt-0.5 size-4 shrink-0", earlier ? "text-muted-foreground" : "text-status-working", busy && "animate-spin")}
        />
        {earlier ? (
          <span className="min-w-0 flex-1 text-sm leading-5 text-muted-foreground">{t("chat.pin.earlier")}</span>
        ) : (
          <span className={PIN_TEXT}>
            {/* The visible words are the prompt itself, so the name says whose they are first. */}
            <span className="sr-only">{t("chat.pin.label")}: </span>
            {pin.text}
            {pin.kind === "reported" && pin.truncated && "…"}
          </span>
        )}
      </span>
    </button>
  );
}
