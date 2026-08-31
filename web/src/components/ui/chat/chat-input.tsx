import * as React from "react";

import { cn } from "@/lib/utils";

// Auto-growing message composer. It's just a styled textarea, so the phone's native keyboard —
// including voice dictation via the keyboard mic — works for free. Auto-capitalization is off: this
// drives a terminal (shell commands, slash-commands, agent replies) where a forced leading capital
// is usually wrong. (Callers can still override via props.)
function ChatInput({ className, ref, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      ref={ref}
      data-slot="chat-input"
      autoComplete="off"
      autoCapitalize="none"
      className={cn(
        // The border is unconditional and only its colour moves on focus, so the textarea never
        // resizes under the caret. Focus adds a second, separate mark OUTSIDE the box — `outline-2
        // outline-offset-2` — rather than the old `ring-[3px]`, which sat flush against the border
        // and read as one 4px smear. No `outline-none` reset: in Tailwind v4 that sets
        // `--tw-outline-style: none`, which `focus-visible:outline-2` would resolve through.
        // `placeholder:whitespace-nowrap` — A PLACEHOLDER MAY NOT SET THIS FIELD'S HEIGHT.
        //
        // `field-sizing-content` sizes the box to its content, and an EMPTY textarea's content is
        // its placeholder. So a placeholder long enough to wrap made the field two lines tall before
        // a single character was typed: measured at a 390px viewport, 46px with a one-line
        // placeholder and 70px with the read-only one — 24px of layout decided by a string. That is
        // DESIGN.md §2 (no state may move content) with the string as the state, and it is worse
        // than it looks, because the string is per-LOCALE: 9 of the 36 composer placeholders in the
        // six locale files overflow the 252px this field leaves for them (`w-full` minus `px-3`'s
        // 12px and the attach button's `pr-11` 44px), so the composer stands at a different height
        // in different languages. Copy alone cannot close that — `composer.placeholder.noMuxSend`
        // can also be the multiplexer's OWN note, which is machine-authored and unbounded.
        //
        // So the field states the contract instead: a placeholder is a LABEL, one line, and it is
        // clipped if it does not fit rather than allowed to resize the control.
        //
        // `overflow-hidden` is NOT decoration and must not be tidied away — it is what makes the
        // clip happen at the CONTENT box. With `whitespace-nowrap` alone the overrun keeps painting
        // out through the padding and straight under the attach button, which is the very collision
        // `pr-11` exists to prevent (composer.tsx:1160-1163); measured in German, where the string
        // overruns by 81px, the last word rendered on top of the icon. There is no ellipsis to go
        // with it: Chromium renders none on a clipped `::placeholder` in a textarea (`text-overflow`
        // and `-webkit-line-clamp` were both measured here and do nothing), so the budget is real
        // and a string that overruns it is a copy bug to fix in the locale file, not a layout to
        // absorb.
        // The typed VALUE is untouched — `::placeholder` styles the placeholder only, and a wrapping
        // draft still grows the field up to the cap below, which is the growth this field is for.
        //
        // ── THE CAP IS A FRACTION OF THE VIEWPORT, NOT A CONSTANT ───────────────────
        // It was `max-h-40` — 160px, chosen against a full-height screen. That number is wrong in
        // the only viewport where it matters. With the soft keyboard up the page is ~440px tall on
        // a phone, so a maxed field claims a THIRD of everything the operator can see, the mirror
        // is squeezed to zero rows, and the surplus lands under the keyboard: the send button and
        // the field's own bottom border are then unreachable. That is the "the bottom is cut off"
        // report, and it is arithmetic, not a padding bug.
        //
        // `min(10rem,30dvh)` fixes it WITHOUT naming a second number. `dvh` already tracks the
        // keyboard — the viewport meta is `interactive-widget=resizes-content`, so the layout
        // viewport shrinks with it (hooks/use-keyboard.ts states the same fact from the other
        // side) — so the cap follows the real screen on every device instead of encoding one.
        // `10rem` IS the old 160px, so at rest, on any screen taller than ~533px, this field
        // behaves byte-identically to before and the placeholder budget above is untouched. Only
        // the case that was broken changes. A longer draft scrolls inside the textarea, which is
        // what a textarea does; a draft you cannot see the bottom of is not a trade, it is a bug.
        //
        // ── `wrap-anywhere` ON THE VALUE, AND WHY `break-word` IS NOT THE SAME CLASS ────
        // `overflow-wrap: anywhere` and `overflow-wrap: break-word` PAINT the same: both break a
        // token that has no break opportunity rather than let it run out of the box. They differ in
        // one place only, and it is the place this field lives: `anywhere` participates in INTRINSIC
        // SIZING and `break-word` does not. So under `break-word` — which is the textarea's own UA
        // default, i.e. what this field had — the min-content width of the box is still the width of
        // the longest unbreakable token, and `field-sizing-content` is precisely the property that
        // turns an intrinsic width into a laid-out one. A difference that is normally invisible
        // becomes the layout.
        //
        // The token is not hypothetical. `composer.tsx`'s `uploadImage()` appends the HOST path the
        // bridge returns for an attached image — one unbroken run of `/`-joined characters, easily
        // 60+ chars and never a break opportunity. That min-content width propagates up the bottom
        // region (the enclosing `Collapse`'s grid item, `ui/collapse.tsx`, which carries `min-w-0`
        // for this reason), the composer row is laid out wider than the screen, and Send — the last
        // thing in that row — lands off the right edge. Reported as "the Send button disappeared
        // after I uploaded a picture". One class on the value fixes it at the source.
        //
        // It does NOT touch the placeholder: `::placeholder` above still says `whitespace-nowrap`,
        // and `white-space` beats any `overflow-wrap` there is — nothing may wrap what may not have
        // a line break. The one-line, clipped placeholder contract above stands unchanged.
        "field-sizing-content wrap-anywhere max-h-[min(10rem,30dvh)] min-h-11 w-full resize-none rounded-md border border-input bg-transparent px-3 py-2.5 text-base shadow-xs transition-[color,box-shadow] placeholder:overflow-hidden placeholder:whitespace-nowrap placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { ChatInput };
