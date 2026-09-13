import { useSyncExternalStore } from "react";

import { Thermometer } from "lucide-react";

import { useCrew } from "@/components/crew-provider";
import { useLocale } from "@/hooks/use-locale";
import { cacheClockNow, subscribeCacheClock } from "@/lib/cache-clock";
import { cacheChipView } from "@/lib/cache-view";
import { HOST_TEXT_CLASSES, hostSlot } from "@/lib/hosts";
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
// ── A PEER'S NUMBER TAKES THE PEER'S INK, AND ADDS NO SECOND DOT ─────────────
// The number is computed on the machine the pane lives on, with that machine's own rules, so the chip
// is true where it is rendered. It takes that machine's identity ink from `hostSlot` — the same tint
// `HostChip` wears — so a crew dashboard shows at a glance which numbers came from elsewhere. It does
// NOT get a coloured dot of its own: `crew-formation.tsx` already settled that a second coloured mark
// beside a `HostChip` says one fact twice.
//
// ── ONE FIXED GLYPH, LIKE HostChip'S Server MARK ─────────────────────────────
// A bare `12m` sitting beside a `HostChip` that carries a `Server` glyph reads as a loose word, not a
// reading — the eye has one shape to anchor "this is an address" and none for "this is a cache". The
// same `Thermometer` mark opens the chip in every state; the state is carried by the word and the ink,
// never by a second icon, so warm, expiring and cold all wear the one mark this component owns.

// `--status-working` IS the app's amber, measured against both grounds in index.css's contrast table;
// there is no second amber token and adding one would be a second answer to one question. `warm` and
// `cold` are deliberately quiet: the chip is a footnote until the window is nearly out.
const TONE_CLASS = {
  warm: "text-muted-foreground",
  expiring: "text-status-working",
  cold: "text-muted-foreground/70",
} as const;

interface CacheChipProps {
  cache: PaneCache | undefined;
  /** Which machine this pane lives on, for the identity ink. Undefined = this one. */
  host?: string | undefined;
  /**
   * `row` — plain type in a list's trailing column, not a control, because the whole card is already
   * one button. `button` — the pane screen's header, where a tap opens the sheet.
   */
  variant?: "row" | "button";
  onOpen?: () => void;
  className?: string;
}

export function CacheChip({ cache, host, variant = "row", onOpen, className }: CacheChipProps) {
  useLocale();
  const { servers } = useCrew();
  // One subscription per chip, one interval for the document. Subscribing unconditionally (rather than
  // only when there is something to count down) keeps the hook order fixed — the hide decision below
  // is a render decision, not a reason to skip a hook.
  const now = useSyncExternalStore(subscribeCacheClock, cacheClockNow, cacheClockNow);
  const view = cacheChipView(cache, now);
  if (view === null) return null;

  // A PEER's pane wears that machine's ink; this machine's panes wear the tone. `hostSlot` answers
  // null on a solo install, which is every install until somebody joins a crew.
  const slot = hostSlot(servers, host);
  const ink = slot === null ? TONE_CLASS[view.tone] : (HOST_TEXT_CLASSES[slot] ?? TONE_CLASS[view.tone]);
  const label = t(`cache.${cache?.state === "cold" ? "cold" : cache?.state === "expiring" ? "expiring" : "warm"}`);

  const body = (
    <>
      {/* One fixed mark, in every state — the sibling of HostChip's `Server` glyph, at the same
          `tag`-variant size. It inherits `currentColor`, so a peer's chip paints it in that
          machine's identity ink with no extra code. */}
      <Thermometer className="size-3 shrink-0" aria-hidden />
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

  const shared = cn("flex shrink-0 items-center gap-1 text-xs tabular-nums", ink, className);

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
