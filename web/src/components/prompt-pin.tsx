import { Icon } from "@/components/icons/icon";

import { USER_WELL_HUG, USER_WELL_META, USER_WELL_TIME } from "@/components/user-well";
import { useChatLook } from "@/lib/chat-look";
import { useLocale } from "@/hooks/use-locale";
import { clockTimeOf } from "@/lib/format";
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
//
// IT DRAWS THE RESTING TURN'S LAYOUT. Where the thread's own turn leans right and hugs its text
// (`ChatLook.userTurn` "hug"), so does the pin: the same side, the same 85 percent cap, the same well
// and padding (`user-well.ts`), the same text size, and the same inset as the stream's gutter and the same chat font size (the overlay gets the stream's text tokens). The
// message then stays where it is when it sticks and when it lets go. The prompt icon is not drawn in
// that look, because the resting turn has none and the icon would push the words right; while the
// pin seeks, the well pulses instead of swapping its icon for a spinner, so the width never changes
// under the reader's thumb. The pin's height stays fixed at two lines in every look (above), so the
// room the thread keeps for it (`PIN_ROOM`) does not depend on the prompt.
//
// THE TIME. The resting turn shows its clock time in the well, small, at the right edge (`USER_WELL_META`,
// `clockTimeOf`). The pin shows the same time, in the same element and classes, when it draws that look and
// the prompt carries one. The resting turn floats it after the text's last line; the pin clamps its text to two
// lines and a float after hidden text would hide with it, so the pin makes it a flex item at the well's right
// edge, on the first line. It takes no row of its own: the height stays two lines, and `gap-0` plus the
// element's own `ml-3` keep the words-to-time gap the resting turn has, so a one-line prompt hugs the same width.

const PIN =
  "pointer-events-auto flex h-14 w-full min-w-0 items-start gap-2 overflow-hidden rounded-md border border-status-working/25 bg-background text-left shadow-sm transition-colors active:bg-muted";
const PIN_WELL = "flex h-full w-full min-w-0 items-start gap-2 bg-status-working/8 px-3 py-2";
const PIN_TEXT = "font-content line-clamp-2 min-w-0 flex-1 text-sm leading-5 wrap-anywhere whitespace-pre-wrap";

export function PromptPin({ pin, busy, onTap }: { pin: Exclude<Pin, null>; busy: boolean; onTap: () => void }) {
  useLocale();
  const hug = useChatLook().userTurn === "hug";
  const earlier = pin.kind === "earlier";
  // The hugging look shows the time at rest; "earlier" points at no one message and shows none.
  const time = hug && !earlier && pin.ts !== undefined ? clockTimeOf(pin.ts) : "";
  // The hugging look draws no icon on a prompt; "earlier" has no resting twin and keeps its own.
  const icon = !hug || earlier;
  const iconKey = busy ? "busy" : earlier ? "prompt-earlier" : "prompt-user";
  return (
    <button
      type="button"
      data-slot="prompt-pin"
      className={cn(PIN, hug && USER_WELL_HUG)}
      onClick={onTap}
      disabled={busy}
      aria-busy={busy}
    >
      <span className={cn(PIN_WELL, hug && !earlier && "gap-0", hug && busy && !earlier && "animate-pulse")}>
        {icon && (
          <Icon
            name={iconKey}
            aria-hidden
            className={cn("mt-0.5 size-4 shrink-0", earlier ? "text-muted-foreground" : "text-status-working", busy && "animate-spin")}
          />
        )}
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
        {time !== "" && (
          <span data-slot="prompt-pin-time" className={cn(USER_WELL_META, "shrink-0")}>
            <span className={USER_WELL_TIME}>{time}</span>
          </span>
        )}
      </span>
    </button>
  );
}
