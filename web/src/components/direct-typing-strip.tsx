import { Keyboard } from "lucide-react";

// The armed indicator for direct typing, in the same in-flow slot as the "You sent:" strip.
//
// WHY THIS EXISTS ON TOP OF THE RESTYLED BUTTON AND TEXTAREA. Those two are exactly the elements a
// user stops looking at once they start typing, so they fail the glance-back test: come back to the
// phone twenty seconds later and nothing in your field of view says the next keystroke goes straight
// into a running agent. This strip sits where the eye already goes for composer state, cannot scroll
// away, and says what is happening in words.
//
// WHEN THIS REACHES THE PACK BRANCH IT MUST NAME THE HOST. On v1 every write surface carries a
// HostChip, because a write names its target; a mode that streams keystrokes into a terminal without
// saying WHICH machine would be the one write path that doesn't. That component does not exist on
// main, so the chip goes in at the merge, next to the label below.
export function DirectTypingStrip({ onStop }: { onStop: () => void }) {
  return (
    <div className="flex items-center gap-2 px-1 pb-1 text-xs text-primary">
      <Keyboard className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">Typing into terminal</span>
        <span className="text-muted-foreground"> — keys go straight through</span>
      </span>
      <button
        type="button"
        onClick={onStop}
        className="shrink-0 rounded-md px-2 py-0.5 font-medium underline-offset-2 transition-colors hover:underline active:bg-muted"
      >
        Stop
      </button>
    </div>
  );
}
