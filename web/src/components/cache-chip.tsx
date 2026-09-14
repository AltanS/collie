import { useSyncExternalStore } from "react";

import { Hourglass } from "lucide-react";

import { useLocale } from "@/hooks/use-locale";
import { cacheClockNow, subscribeCacheClock } from "@/lib/cache-clock";
import { cacheChipView } from "@/lib/cache-view";
import { t } from "@/lib/i18n";
import type { PaneCache } from "@/lib/types";
import { cn } from "@/lib/utils";

// How long this pane's prompt cache stays warm, as one small run of type.
//
// ── IT IS A COUNTDOWN, NOT A POLL ────────────────────────────────────────────
// `expiresAt` arrives with the ordinary snapshot, and the label is recomputed against ONE page clock
// (`lib/cache-clock.ts`) that ticks once a second and stops while the document is hidden. No chip owns
// a timer and no chip triggers a fetch. The rule that decides warm from cold is pure and lives in
// `lib/cache-view.ts`, so its ten-second grace at the zero crossing is a table test.
//
// ── NOTHING IS SHOWN BEFORE IT IS MEASURED ───────────────────────────────────
// `null` when the pane carries no reading: no journal adapter, no session, or an agent that has not
// taken a turn yet. There is no "waiting" and no "measuring" placeholder — a chip that appears to say
// something and says nothing is worse than an empty slot (ADR 0041). The column it sits in collapses
// the same way it already does with no host and no session.
//
// ── THE GLYPH CARRIES THE STATE, AND NOTHING ELSE CARRIES A COLOUR ───────────
// The chip used to paint the WHOLE chip — glyph, number and dot — in the identity ink of the machine
// the pane lives on, so a crew dashboard showed at a glance which numbers came from elsewhere. Altan,
// from his phone on 2026-09-14: that ink is a loud pink standing in a line of muted type, and the one
// thing the chip is about, how much window is left, wore no colour at all. So the identity ink is
// gone from here. DESIGN.md says a host tint may never be mistaken for a status, and this chip IS a
// status now; the `HostChip` on the same line already says whose machine it is, in the tint it owns.
// The glyph takes the state's ink in both layouts, the word stays at the meta colour everywhere, and
// the chip keeps no coloured dot of its own — `crew-formation.tsx` settled that a second coloured
// mark beside a `HostChip` says one fact twice.
//
// ── THE NUMBER STANDS ON THE GLYPH'S BOTTOM EDGE ─────────────────────────────
// `items-baseline`, not `items-center`. An SVG is a replaced box with no baseline of its own, so CSS
// synthesises one from its bottom border edge — which makes the hourglass's BOX bottom and the
// number's baseline the same line, at any font size. Centring put the number's baseline about 2.4px
// above that foot at 12px, which is the gap Altan saw the first time; `items-baseline` closed that.
//
// IT IS NOT QUITE FLUSH EVEN SO, because a BOX edge is not INK. Lucide draws every glyph on a 24
// viewBox with paths that run roughly y=2..22 and a 2px stroke, so at this glyph's rendered 12px the
// ink foot sits a little inside the box's own bottom edge — never ON it. Measured in real Chromium at
// device-pixel resolution (3x, `web/measure-ink.mjs` if it still exists, else re-measure the same
// way): the hourglass's ink foot sat 0.35px ABOVE the digits' own ink foot even with the boxes
// perfectly flush. Altan, from his phone, a third time: still a visible gap. `translate-y-[0.35px]`
// below nudges the glyph's ink down onto the digits' ink, not onto their box — the fix this time is
// measured against ink, never against the synthesised baseline alone. Both parents still state their
// own height (`h-3` inline, `h-4` in the column), so the nudge moves nothing else on the row.
//
// ── ONE FIXED GLYPH, LIKE HostChip'S Server MARK ─────────────────────────────
// A bare `12m` sitting beside a `HostChip` that carries a `Server` glyph reads as a loose word, not a
// reading — the eye has one shape to anchor "this is an address" and none for "this is a cache". The
// same `Hourglass` mark opens the chip in every state; the state is carried by the word and the ink,
// never by a second icon, so warm, expiring and cold all wear the one mark this component owns.
//
// IT IS AN HOURGLASS AND NOT A THERMOMETER, which was the first pick and the wrong one. A thermometer
// draws a TEMPERATURE, and the chip's tint already says warm, expiring or cold — so the glyph said
// the tint's own sentence a second time, in a shape that also had to stay the same in all three
// states, which is a thermometer reading that never moves. Altan, from his phone: "the cache icon is
// poorly picked". An hourglass asserts no temperature at all. It says a window is running out, which
// is the one thing true of every state of this chip, and it leaves warm/expiring/cold to the ink
// alone — the tint-on-glyph rule (DESIGN.md), kept rather than doubled.

// ONE INK PER STATE, ON THE GLYPH, AND NO GRADIENT BETWEEN THEM. Three states is what the bridge
// computes and three states is what the eye gets. Altan, from his phone on 2026-09-14: cold reads
// as blue, not red, and expiring is the alarm, so it wears the app's red at full strength. Warm
// stays the app's green, run down to a footnote opacity, because it is true for most of the
// window's life and asks for nothing. Cold takes the app's cool blue (`--status-info` in
// index.css) at reduced opacity, a footnote too, but a different colour from warm so the two quiet
// states stay tellable apart at a glance. Expiring alone runs at full strength, because it is the
// one state that asks for attention. The `herdr-cache-alert` plugin still paints green / amber /
// red in its own status line; this same change is filed upstream there too, so until that lands the
// chip and the plugin may briefly disagree on cold's colour. The word never takes any of this: it
// stays `text-muted-foreground` in both layouts (DESIGN.md, the tint lands on the glyph only).
const TONE_CLASS = {
  warm: "text-status-done/60",
  expiring: "text-status-blocked",
  cold: "text-status-info/70",
} as const;

interface CacheChipProps {
  cache: PaneCache | undefined;
  /**
   * Which machine this pane lives on. Stated by every crew call site and read by none: the chip
   * painted the identity ink until 2026-09-14 and now paints the cache state instead (this file's
   * header). The prop stays so a caller keeps saying which pane it is describing, and so the ink can
   * come back on some surface that has no `HostChip` beside it.
   */
  host?: string | undefined;
  /**
   * `row` — plain type in a list's trailing column, not a control, because the whole card is already
   * one button. `button` — the pane screen's header, where a tap opens the sheet.
   */
  variant?: "row" | "button";
  onOpen?: () => void;
  className?: string;
}

export function CacheChip({ cache, variant = "row", onOpen, className }: CacheChipProps) {
  useLocale();
  // One subscription per chip, one interval for the document. Subscribing unconditionally (rather than
  // only when there is something to count down) keeps the hook order fixed — the hide decision below
  // is a render decision, not a reason to skip a hook.
  const now = useSyncExternalStore(subscribeCacheClock, cacheClockNow, cacheClockNow);
  const view = cacheChipView(cache, now);
  if (view === null) return null;

  const ink = TONE_CLASS[view.tone];
  const label = t(`cache.${cache?.state === "cold" ? "cold" : cache?.state === "expiring" ? "expiring" : "warm"}`);

  const body = (
    <>
      {/* One fixed mark, in every state — the sibling of HostChip's `Server` glyph, at the same
          `tag`-variant size. It is the one thing here that carries a colour, and its bottom edge is
          the line the number stands on (this file's header, both sections). `translate-y-[0.35px]`
          is the ink nudge that header measured — the box edge already sits on the baseline, the INK
          inside it does not, and 0.35px is what closed that gap in Chromium at device resolution. */}
      <Hourglass className={cn("size-3 shrink-0 translate-y-[0.35px]", ink)} aria-hidden />
      <span aria-hidden>{view.label}</span>
      {view.overridden && (
        <>
          {/* The house pattern for a mark that is a dot (`agent-card.tsx` § cornerDot): a small dot
              beside the thing it qualifies, plus a word for a screen reader, because the dot alone is
              shape and colour. `data-overridden` is the handle the playground and the tests assert on,
              so neither has to read a class name. */}
          <span
            aria-hidden
            data-overridden="true"
            className="size-1 shrink-0 rounded-full bg-current opacity-70"
          />
          <span className="sr-only">{t("cache.overridden")}</span>
        </>
      )}
    </>
  );

  // `items-baseline` is the alignment, and `leading-none` stops the word's line box adding leading on
  // top of it. Measured in Chromium at 12px in the app's own face: centred, the number's baseline sat
  // 3.0px above the hourglass's foot; on the baseline the two are flush to 0.0px. The chip's own box
  // is then 15px — 12px of glyph above the baseline plus the face's 3px descent, which nothing is
  // drawn in — against 16px centred. Both callers state their own height, so neither box moves.
  const shared = cn(
    "flex shrink-0 items-baseline gap-1 text-xs leading-none tabular-nums text-muted-foreground",
    className,
  );

  if (variant === "button") {
    return (
      <button
        type="button"
        data-slot="cache-chip"
        onClick={onOpen}
        aria-label={`${label}, ${view.label}`}
        className={cn(shared, "transition-opacity active:opacity-60")}
      >
        {body}
      </button>
    );
  }

  return (
    <span data-slot="cache-chip" className={shared}>
      {body}
      {/* On the card the chip is not a control, so the meaning of the number goes to a screen reader
          as text rather than as a button label. */}
      <span className="sr-only">{label}</span>
    </span>
  );
}
