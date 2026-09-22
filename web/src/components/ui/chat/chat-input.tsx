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
      // Plain Enter inserts a newline here (composer.tsx sends only on Ctrl/Cmd+Enter), so the
      // on-screen keyboard's return key must read as a plain Enter, never "Send" or "Go".
      enterKeyHint="enter"
      className={cn(
        // ── THIS CONTROL DRAWS NO FRAME, AND THAT IS THE POINT ──────────────────────────────
        // The border, the radius and the focus mark moved OUT, onto the composer's own box, which
        // holds the attach button, this field and the primary action on one row (ADR 0057, amended
        // 2026-09-22). The box keeps its border unconditional and moves only its colour on focus,
        // plus a 1px ring as a box-shadow, so nothing resizes under the caret and there is ONE
        // frame. Do not give this textarea a border or an outline back: two frames, one inside the
        // other, is what the box replaced. `focus-visible:outline-none` here keeps the browser's
        // own focus ring off the inner control; the box's ring is what marks focus.
        //
        // NO PADDING OR MIN-HEIGHT HERE. The composer sets them (`composer.tsx`, the field's own
        // className), because they are measured against the buttons that share its row.
        //
        // `placeholder:whitespace-nowrap` — A PLACEHOLDER MAY NOT SET THIS FIELD'S HEIGHT.
        //
        // `field-sizing-content` sizes the box to its content, and an EMPTY textarea's content is
        // its placeholder. So a placeholder long enough to wrap made the field two lines tall before
        // a single character was typed: measured at a 390px viewport, 46px with a one-line
        // placeholder and 70px with the read-only one — 24px of layout decided by a string. That is
        // DESIGN.md §2 (no state may move content) with the string as the state, and it is worse
        // than it looks, because the string is per-LOCALE: 9 of the 36 composer placeholders in the
        // six locale files overflow the 252px this field left for them when it was measured
        // (`w-full` minus `px-3`'s 12px and the 44px the attach button reserved with `pr-11`), so
        // the composer stood at a different height in different languages. The budget has moved
        // since (the buttons sit beside the field on the box's one row, ADR 0057), but the contract
        // below is the same one and the reason for it has not changed. Copy alone cannot close it, because
        // `composer.placeholder.noMuxSend` can also be the multiplexer's OWN note, which is
        // machine-authored and unbounded.
        //
        // So the field states the contract instead: a placeholder is a LABEL, one line, and it is
        // clipped if it does not fit rather than allowed to resize the control.
        //
        // `overflow-hidden` is NOT decoration and must not be tidied away — it is what makes the
        // clip happen at the CONTENT box. With `whitespace-nowrap` alone the overrun keeps painting
        // out through the padding and past the field's own edge; measured in German, where the
        // string overruns by 81px, it rendered on top of the attach button the `pr-11` strip
        // existed to keep clear of it. The button is a sibling of the field now, so the
        // overrun would run into it past the field's own edge, and the clip is what stops it. There is no ellipsis to go with it: Chromium renders none on a clipped `::placeholder` in a textarea (`text-overflow`
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
        // The token is not hypothetical. `composer.tsx`'s `uploadFile()` appends the HOST path the
        // bridge returns for an attached image — one unbroken run of `/`-joined characters, easily
        // 60+ chars and never a break opportunity. That min-content width propagates up the bottom
        // region (the enclosing `Collapse`'s grid item, `ui/collapse.tsx`, which carries `min-w-0`
        // for this reason), the composer is laid out wider than the screen, and Send goes with it,
        // off the right edge. Reported as "the Send button disappeared after I uploaded a picture".
        // One class on the value fixes it at the source. Send sits beside the field again, on the
        // box's one row, and the field's own `min-w-0` (composer.tsx) is the second, independent
        // reason a long path cannot push it out of reach; neither replaces the other.
        //
        // It does NOT touch the placeholder: `::placeholder` above still says `whitespace-nowrap`,
        // and `white-space` beats any `overflow-wrap` there is — nothing may wrap what may not have
        // a line break. The one-line, clipped placeholder contract above stands unchanged.
        "field-sizing-content wrap-anywhere max-h-[min(10rem,30dvh)] w-full resize-none border-0 bg-transparent text-base transition-[color,box-shadow] placeholder:overflow-hidden placeholder:whitespace-nowrap placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { ChatInput };
