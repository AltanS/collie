import { Keyboard } from "lucide-react";

import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

// The armed indicator for direct typing, in the same in-flow slot as the "You sent:" strip.
//
// WHY THIS EXISTS ON TOP OF THE RESTYLED BUTTON AND TEXTAREA. Those two are exactly the elements a
// user stops looking at once they start typing, so they fail the glance-back test: come back to the
// phone twenty seconds later and nothing in your field of view says the next keystroke goes straight
// into a running agent. This strip sits where the eye already goes for composer state, cannot scroll
// away, and says what is happening in words.
//
// WHEN THIS REACHES THE CREW BRANCH IT MUST NAME THE HOST. On v1 every write surface carries a
// HostChip, because a write names its target; a mode that streams keystrokes into a terminal without
// saying WHICH machine would be the one write path that doesn't. That component does not exist on
// main, so the chip goes in at the merge, next to the label below.
export function DirectTypingStrip({ onStop }: { onStop: () => void }) {
  useLocale();
  // Full-width banner, not a quiet row: this mode streams keystrokes into a
  // live terminal, and the 2026-10-07 phone trap was an armed session nobody
  // noticed. Destructive tint + STOP button, always in flow above the input.
  return (
    <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive">
      <Keyboard className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        <span>{t("sendMode.armed.title")}</span>
        <span className="opacity-80"> — {t("sendMode.armed.hint")}</span>
      </span>
      <button
        type="button"
        onClick={onStop}
        className="shrink-0 rounded-md px-2 py-0.5 font-medium underline-offset-2 transition-colors hover:underline active:bg-muted"
      >
        {t("sendMode.armed.stop")}
      </button>
    </div>
  );
}
