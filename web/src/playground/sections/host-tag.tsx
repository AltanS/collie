// Host tag placement ideas: five ways the composer could name the machine it writes to, on five
// cards. THE FIRST ONE SHIPPED, on 2026-09-13; the other four are the roads not taken, kept with
// what each would have cost, which is why every one of them says "idea, not shipped" where the rest
// of the playground says "reach it for real".
//
// THE TARGET. `components/actions-row.tsx` used to open the belt with `<HostChip host={writeHost}
// variant="tag" sends />`, so on a crew the first thing in the scroller was the machine's name and
// the five control pills started after it. Altan's verdict on the phone: the tag "is taking up too
// much space". The belt is a scroller that already overflows on a Claude pane, so every pixel the
// tag took was a pixel of Keys, Type, Quick, Agent and Display that had to be flicked for. The round
// asked whether the same answer could be given from an absolute span that costs the scroller
// nothing, and the answer Altan picked keeps the pill where it was but stops it taking width: it is
// pinned over the belt's right end with the pills scrolling under it.
//
// WHAT IS REAL HERE AND WHAT IS NOT. The belt on every card is the app's own `ActionsRow` on Claude,
// in the roomy layout, inside a real `CrewProvider` over the `rosterFive` fixture, so the shipped tag
// is the shipped tag and the hide rule is the real hide rule. The input row is the app's own
// `ChatInput` and its send `Button`, with the class strings copied from `composer.tsx`'s bottom row,
// because `Composer` itself is a 1,900-line component that owns a draft store, an upload queue, a
// recorder and a send guard, and none of that is what these cards are about. What is INVENTED is
// drawn here and nowhere else: the legend on the input's border, the caption under the send button,
// the badge on it, and the fade at the belt's right end. Each card's note says which side of that
// line it sits on.
//
// THE MEASUREMENT. The tag draws 57px on `lodge` at a 390px viewport, and the scroller's own
// `gap-1.5` adds 6px behind it, so the belt pays 63px for the name today. Every note below is
// counted against that one number, taken with `getBoundingClientRect()` in a real browser on the
// first card, not estimated.
//
// DEV-ONLY, unreachable from the app entry.

import type { ReactNode } from "react";
import { Paperclip, Send } from "lucide-react";

import { ActionsRow } from "@/components/actions-row";
import { CrewProvider } from "@/components/crew-provider";
import { Button } from "@/components/ui/button";
import { ChatInput } from "@/components/ui/chat/chat-input";
import { MIRROR_INVERT, MIRROR_SPACE } from "@/components/mirror-space";
import { parseAnsi } from "@/lib/ansi";
import { lineText, splitLines } from "@/lib/blocks";
import { cn } from "@/lib/utils";

import { paneWorking, rosterFive, TS } from "../fixtures";
import { Card, Group, Section, type SectionDef } from "../harness";
import { took, useRoomyActions } from "./shared";

export const DEF: SectionDef = {
  id: "host-tag",
  title: "Host tag ideas",
  intent:
    "The machine the input sends to, named without spending the front of the actions belt on it. The tag used to open the scroller: 57px of pill plus the belt's own 6px gap, 63px of a row that already has to be flicked sideways on a Claude pane. Five cards, each a phone-width mock of the BOTTOM of the pane screen, with the REAL belt over the REAL input row, on a crew whose lead is called lodge. The first card is what SHIPPED on 2026-09-13, the tag pinned over the belt's right end with the pills panning under it; the other four latch the name onto the input or onto the send button and are kept as the roads not taken. Each note states what the belt saves, where the name reads before typing, while typing and with the keyboard up, and the main risk.",
};

// ── The crew every card stands on ────────────────────────────────────────────
//
// `rosterFive` with the LEAD's own clock, exactly as `PackedRootRouter` mounts it: the chip's hide
// rule is "more than one machine", so a solo provider would render nothing at all and the whole
// section would be six pictures of an empty belt. `lodge` is that roster's lead and is healthy, so
// every card shows the quiet reading rather than a dashed one.

const HOST = "lodge";

function Crew({ children }: { children: ReactNode }) {
  return (
    <CrewProvider servers={rosterFive} ts={TS} pollMs={3_000}>
      {children}
    </CrewProvider>
  );
}

// ── The mirror slice ─────────────────────────────────────────────────────────

/**
 * Six lines out of a real capture, with the colour parsed away by the app's own parser. It is text
 * in a `<pre>` and not `AnsiOutput`, for the reason `sections/ideas.tsx` gives: these cards are
 * about what sits BELOW the mirror, and the real renderer would bring its grammars, its dialog lift
 * and its scroll behaviour into a card that has no business driving them.
 */
const MIRROR_SLICE: string = splitLines(parseAnsi(paneWorking.text))
  .slice(48, 54)
  .map((line) => lineText(line).trimEnd())
  .join("\n");

function MirrorSlice() {
  return (
    <pre
      className={cn(
        "m-0 whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-[1.3] [font-variant-ligatures:none]",
        MIRROR_SPACE,
        MIRROR_INVERT,
      )}
    >
      {MIRROR_SLICE}
    </pre>
  );
}

// ── The phone-width mock ─────────────────────────────────────────────────────

/** One card's phone: 390px wide, or the column's width under the "Phone width" toggle. A BOX, not a
 *  screen, and with no fixed height: these cards differ in where a word sits, and a frame that
 *  pinned the height would only hide how little the chrome changes. */
function PhoneMock({ children }: { children: ReactNode }) {
  return (
    <div className="relative w-[390px] max-w-full overflow-hidden rounded-xl border border-border bg-background">
      {children}
    </div>
  );
}

/** The chrome block, as `agent-chat.tsx` draws it: ONE surface closed against the terminal above by
 *  ONE rule. The class string is copied from `data-slot="chrome-block"` there, because it is a
 *  `<div>` inside a 2,000-line component and cannot be imported. */
function ChromeBlock({ children }: { children: ReactNode }) {
  return (
    <div data-slot="chrome-block" className="border-t border-rule bg-chrome">
      {children}
    </div>
  );
}

/**
 * The REAL actions belt, on Claude, in the roomy layout, inside the composer's own `px-3` dock,
 * which the belt's `-mx-3` cancels, so the band runs edge to edge exactly as it does on a phone.
 *
 * `host` is the whole question: passed, the belt opens with the shipped tag; omitted, the scroller
 * starts on Keys and the 63px is back. `children` is how the one idea that draws ON the belt reaches
 * it, and nothing else on the card needs the positioned box.
 */
function Belt({ host, children }: { host?: string; children?: ReactNode }) {
  const general = useRoomyActions();
  return (
    <div className="relative bg-chrome px-3">
      <ActionsRow general={general} agent="claude" writeHost={host} onRun={took} />
      {children}
    </div>
  );
}

/**
 * The composer's input row, with the app's own `ChatInput` and its own send `Button` inside a layout
 * copied class for class from `composer.tsx` (`flex items-end gap-3`, the field in a
 * `relative min-w-0 flex-1` box, the attach button pinned `bottom-1 right-1`, a `size-11` round
 * send). The field is `readOnly` because a card is a photograph, not a draft.
 *
 * The three slots are the three places an idea may latch onto:
 *  - `legend` sits inside the FIELD's positioned box, so it can straddle the field's own border.
 *  - `sendMark` sits inside the SEND button's positioned box, over or under the button.
 *  - `pad` is the row's bottom padding, which one idea has to buy a little of.
 */
function InputRow({
  placeholder = "Type a reply…",
  legend,
  sendMark,
  pad = "pb-2",
}: {
  placeholder?: string;
  legend?: ReactNode;
  sendMark?: ReactNode;
  pad?: string;
}) {
  return (
    <div className={cn("flex items-end gap-3 bg-chrome px-3", pad)}>
      <div className="relative min-w-0 flex-1">
        <ChatInput placeholder={placeholder} rows={1} readOnly className="block pr-11 font-mono" />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Attach"
          className="absolute right-1 bottom-1 size-9 rounded-full text-muted-foreground"
        >
          <Paperclip className="size-4" />
        </Button>
        {legend}
      </div>
      <div className="relative shrink-0">
        <Button size="icon" aria-label="Send" className="size-11 shrink-0 rounded-full">
          <Send className="size-4" />
        </Button>
        {sendMark}
      </div>
    </div>
  );
}

// ── The five drawings ────────────────────────────────────────────────────────

/**
 * Idea 1: the name straddles the input's top-left corner like a fieldset legend. It is absolute, so
 * the field does not move and the row does not grow; the `bg-chrome` patch breaks the field's own
 * border around it, the way the belt's grip breaks the belt's rule. `-top-1.5` with a 12px line
 * centres the run on that border within half a CSS pixel.
 *
 * `pointer-events-none` and `select-none` together are what keep it out of the way: this is a label
 * lying ON a text field, and neither a tap aimed at the field nor a long-press aimed at the draft
 * may land on it. It is not in the accessibility tree either, for the reason the chip's own header
 * gives about decorative repetition: the field is `aria-label`led for real in the app.
 */
function InputLegend({ host }: { host: string }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute -top-1.5 left-2 bg-chrome px-1 font-mono text-[10px] leading-3 text-muted-foreground select-none"
    >
      {host}
    </span>
  );
}

/**
 * Idea 3: a caption centred under the send button. `max-w-[52px]` is the button's 44px plus the 8px
 * the brief allows, and `truncate` is what happens to a longer name, so a machine called
 * `build-runner-02` reads "build-run…" rather than pushing the row wider. It is the one idea that is
 * not free: 12px of caption under a button that already sits on the row's bottom edge needs the
 * dock's `pb-2` to grow to `pb-4`.
 */
function SendCaption({ host }: { host: string }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute -bottom-3 left-1/2 max-w-[52px] -translate-x-1/2 truncate text-center font-mono text-[10px] leading-3 text-muted-foreground select-none"
    >
      {host}
    </span>
  );
}

/**
 * Idea 4: a tiny pill on the send button's top-right corner, in the place a notification badge would
 * sit, carrying a word instead of a count. `bg-chrome` and a hairline are what keep it legible over
 * the button's own filled primary ground, and `-top-1 -right-1` keeps it inside the dock's `px-3`
 * rather than hanging off the screen's edge.
 */
function SendBadge({ host }: { host: string }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute -top-1 -right-1 max-w-[64px] truncate rounded-full border border-border bg-chrome px-1 font-mono text-[10px] leading-4 text-muted-foreground select-none"
    >
      {host}
    </span>
  );
}

// ── The cards ────────────────────────────────────────────────────────────────

/** Every idea card's `reach` line. These are ideas; none of them can be reached. */
const NOT_SHIPPED = "idea, not shipped:";

export function HostTagSection() {
  // NO STATE, deliberately: each card has to be addressable by a screenshot without tapping
  // anything first, so nothing here toggles and nothing here animates.
  return (
    <Section def={DEF}>
      <Group title="0 · The tag as it ships">
        <Card
          state="host-today"
          label="shipped: the tag is pinned at the belt's right end, Keys starts at 0"
          reach="open any pane on a collie that leads a crew."
          note="SHIPPED 2026-09-13, and this card is the real belt, so it is what your phone draws. The tag no longer opens the scroller: it is an absolute span over the band's right end, capped at the send button's 44px, with the pills panning under a two-layer fade. The belt got the whole 63px back — the 57px pill plus the scroller's own 6px gap — and the row's left edge is Keys on a crew exactly as on a solo install. The name now reads in all three states, before typing, while typing and with the keyboard up, and it never scrolls away, which the opening tag did. Two costs were taken knowingly: the glyph is gone, because 44px leaves 30px of text and a mark would take 16 of them, and the scroll cue had to learn to step around the tag (OverflowEdges' insetRight) so the fade that means there is more this way is not drawn under it. The four cards below are the roads not taken."
        >
          <Crew>
            <PhoneMock>
              <MirrorSlice />
              <ChromeBlock>
                <Belt host={HOST} />
                <InputRow />
              </ChromeBlock>
            </PhoneMock>
          </Crew>
        </Card>
      </Group>

      <Group title="1 · The name latches onto the input">
        <Card
          state="host-on-input"
          label="a legend on the input's top-left corner, straddling its border"
          reach={`${NOT_SHIPPED} the legend and its patch are drawn here; the belt above them is the app's own ActionsRow, with nothing passed for the host.`}
          note="Saves the whole 63px in the belt scroller, and costs 0px of layout anywhere else: the legend is absolute over the field's own border and the field does not move. The name reads before typing, while typing and with the keyboard up, because it is fixed to the box rather than to the text. Two risks. A 10px run on a hairline is a much quieter answer than a pill, and this is the surface where being sure which machine you are typing into matters most. And the corner is 8px from the caret, so a long name would want a truncation rule the pill already has."
        >
          <Crew>
            <PhoneMock>
              <MirrorSlice />
              <ChromeBlock>
                <Belt />
                <InputRow legend={<InputLegend host={HOST} />} />
              </ChromeBlock>
            </PhoneMock>
          </Crew>
        </Card>

        <Card
          state="host-in-placeholder"
          label="no mark at all: the host is folded into the placeholder"
          reach={`${NOT_SHIPPED} the belt is real and carries no host; only the placeholder string is invented.`}
          note="Saves the whole 63px in the belt and costs zero pixels anywhere, which is the only thing this idea has going for it. The name reads before typing, and that is the whole of it: the placeholder is gone on the first keystroke, so it does not read while typing, and with the keyboard up you are typing by definition. That is the risk, stated plainly, and it is a bad one on a crew: the answer to which machine this lands on disappears exactly when the draft that is about to land exists. The placeholder is also per-locale and already overruns its width budget in several languages (ui/chat/chat-input.tsx carries the measurement), so adding a machine name to it is adding to the string that is already too long."
        >
          <Crew>
            <PhoneMock>
              <MirrorSlice />
              <ChromeBlock>
                <Belt />
                <InputRow placeholder={`Type a reply on ${HOST}…`} />
              </ChromeBlock>
            </PhoneMock>
          </Crew>
        </Card>
      </Group>

      <Group title="2 · The name latches onto the send button">
        <Card
          state="host-under-send"
          label="a caption under the send button, centred and truncated"
          reach={`${NOT_SHIPPED} the caption is drawn here; the belt and the send button are the app's own.`}
          note="Saves the whole 63px in the belt, and gives 8px of it back: this is the one idea that is not free, because a 12px caption under a button already on the row's bottom edge needs the dock's pb-2 to become pb-4. Net 55px. The caption is capped at the button's width plus 8px and truncates, so a long machine name reads as an ellipsis rather than widening the row. The name reads in all three states, before typing, while typing and with the keyboard up. The risk is the neighbourhood: this puts a word directly above the home indicator and, with the keyboard up, a few pixels from the keyboard's own top row, which is the strip of glass the layout has least of."
        >
          <Crew>
            <PhoneMock>
              <MirrorSlice />
              <ChromeBlock>
                <Belt />
                <InputRow pad="pb-4" sendMark={<SendCaption host={HOST} />} />
              </ChromeBlock>
            </PhoneMock>
          </Crew>
        </Card>

        <Card
          state="host-on-send"
          label="a tiny pill on the send button's corner, where a badge would sit"
          reach={`${NOT_SHIPPED} the pill is drawn here; the button under it is the app's own send Button.`}
          note="Saves the whole 63px in the belt and costs 0px of layout: the pill is absolute on the button's own corner and nothing in the row moves. The name reads in all three states. The pill sits ON the one control that acts, which is the argument for it and the risk with it: a badge on a button is read as a count or a state of that button, not as an address, and it also overlaps the target a thumb aims at. A hairline pill on a filled primary ground is the loudest of the five ideas, which on this surface may be right."
        >
          <Crew>
            <PhoneMock>
              <MirrorSlice />
              <ChromeBlock>
                <Belt />
                <InputRow sendMark={<SendBadge host={HOST} />} />
              </ChromeBlock>
            </PhoneMock>
          </Crew>
        </Card>
      </Group>

    </Section>
  );
}
