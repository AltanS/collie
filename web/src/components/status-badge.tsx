import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { type AgentStatus, statusLabel, statusLabelPast } from "@/lib/types";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

const CHIP = {
  blocked: "border-status-blocked/30 bg-status-blocked/15 text-status-blocked",
  working: "border-status-working/30 bg-status-working/15 text-status-working",
  done: "border-status-done/30 bg-status-done/15 text-status-done",
  idle: "border-status-idle/30 bg-status-idle/10 text-status-idle",
  unknown: "border-status-unknown/30 bg-status-unknown/10 text-status-unknown",
} satisfies Record<AgentStatus, string>;

/** The mark's ink: the status token, drawn with `currentColor` so the SVG takes it whole. */
const TONE = {
  blocked: "text-status-blocked",
  working: "text-status-working",
  done: "text-status-done",
  idle: "text-status-idle",
  unknown: "text-status-unknown",
} satisfies Record<AgentStatus, string>;

/**
 * The resting states are drawn hollow and half-opaque: as solid discs they would carry exactly as
 * much weight as blocked (every --status-* value is tuned near the same lightness for text), and
 * eighteen idle marks would out-shout the one thing that needs you. They are the only marks with an
 * inside, and that inside is filled with the surface the mark sits on (the `surface` prop).
 */
const RESTING: ReadonlySet<AgentStatus> = new Set(["idle", "unknown"]);

/**
 * THE STATUS MARK: one SHAPE per state, in a 12-unit box, so the state reads without its colour
 * (issue 420). The shapes are the whole answer to "which is which"; the colour is a second channel.
 *
 * - blocked ("needs you"): a filled triangle, point up. A triangle drawn edge to edge looks smaller
 *   than the disc beside it, so it is drawn with a 1.8px round-joined stroke in its own fill colour:
 *   the fill is 10 wide (apex y 1.3, base y 10.5), the stroke grows it to about 11.8 by 11 and
 *   softens the corners, and by area it is 97% of the disc's.
 * - working: a circle with its LEFT half filled. It is the one mark that turns, and only when the
 *   caller says it is the one being watched (`live`, see {@link StatusDot}).
 * - done: a filled disc.
 * - idle: a hollow ring.
 * - unknown: a hollow DASHED ring, so it stays apart from idle.
 *
 * The geometry was chosen on playground card 9 (2026-10-12) and measured against its neighbours
 * there: filled silhouettes with no inner marks survive 10px and a colour-vision simulation, which a
 * ring with a gap or a symbol in a chip did not.
 */
function StatusGlyph({ status, turning }: { status: AgentStatus; turning: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden
      focusable="false"
      className={cn("relative size-full", turning && "status-turn")}
    >
      {status === "blocked" && (
        <path fill="currentColor" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" d="M6 1.3 L11 10.5 H1 Z" />
      )}
      {status === "working" && (
        <>
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path fill="currentColor" d="M6 1.5 A4.5 4.5 0 0 0 6 10.5 Z" />
        </>
      )}
      {status === "done" && <circle cx="6" cy="6" r="5" fill="currentColor" />}
      {status === "idle" && (
        <circle cx="6" cy="6" r="4.3" fill="none" stroke="currentColor" strokeOpacity="0.6" strokeWidth="1.6" />
      )}
      {status === "unknown" && (
        <circle
          cx="6"
          cy="6"
          r="4.3"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.6"
          strokeWidth="1.6"
          strokeDasharray="2.5 2"
        />
      )}
    </svg>
  );
}

export function StatusDot({
  status,
  surface = "bg-background",
  label,
  stale,
  live = false,
  glide,
  backed = false,
  className,
}: {
  status: AgentStatus;
  /**
   * The colour the dot sits ON (a `bg-*` class). A hollow ring (idle, unknown) must be FILLED with
   * its surface, not left transparent: over the avatar's corner a transparent interior showed orange
   * logo through one half and page grey through the other, reading as a notch cut out of the icon
   * rather than a badge. Pass the card's surface when the dot sits on a card. The filled shapes
   * ignore it.
   */
  surface?: string;
  /**
   * An ACCESSIBLE NAME for the dot, for the one caller where the dot is the only mark of the state
   * in its group. The dot had none and could not have one: it is an empty `<span>`, so it named
   * nothing, matched no text query, and reached no screen reader.
   *
   * Naming it is opt-in rather than default because most call sites put the dot IN FRONT OF the
   * word it belongs to (`ui/chip.tsx`, `pane-strip.tsx`, `tab-strip.tsx`) — there a name is the
   * state announced twice. Unnamed, it is explicitly `aria-hidden`, which is the same answer those
   * call sites already got by accident, now stated.
   */
  label?: string;
  /** The dot is showing the LAST snapshot's status while the connection is not live — dim it, and
   *  stop the working turn: a frozen reading must not animate as if it were arriving. Same
   *  `opacity-40` the StatusBadge has always used, and the same instant restore on recovery. */
  stale?: boolean;
  /**
   * Opt in to the working mark's turn (one full turn in 1.8s, rotation only, `.status-turn`). A pane
   * mounts several `StatusDot`s at once (tab chip, space chip, pane chip, pane header, agent card,
   * overview) and each one used to ping on its own unsynchronized clock — three or more on one phone
   * screen read as blinking, not as "alive". Only the ONE dot the operator is actually watching a
   * pane through moves: the pane chip. The pane header's agent badge turned too until 2026-10-14; over
   * the agent's tile a turning half-disc read as a loading spinner, so it holds still. Every other call site shows
   * a still mark for the same "working" state — the half-filled shape still says it, without the
   * motion. The turn REPLACED the old opacity breathe (issue 420): a shape that turns is read at any
   * size and by any eye, an opacity fade is not.
   */
  live?: boolean;
  /** The dot's `data-glide` part name, where it flies in a glide (lib/glide.ts). */
  glide?: string;
  /**
   * Paint the surface disc behind EVERY shape, not only the resting rings. For a dot that sits ON
   * something drawn, the pane header's badge on the agent's tile: unbacked, the tile showed through
   * the empty half of the working mark and around the triangle, and with the badge's halo it read as
   * a broken coin (2026-10-14). Paint only: the box is the same with or without it.
   */
  backed?: boolean;
  className?: string;
}) {
  const turning = live && status === "working" && stale !== true;
  return (
    <span
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      data-glide={glide}
      className={cn(
        // The 12px box every shape is drawn in. A caller that needs a smaller slot passes its own
        // `size-*`; the shapes all fill the box, so the box is the same in every state.
        "relative flex size-3 shrink-0 transition-opacity",
        TONE[status],
        stale === true && "opacity-40",
        className,
      )}
    >
      {/* The ring's inside, in the surface colour and a hair smaller than the ring's outer edge, so
          it is filled and never shows the ground through. Paint only: it is absolute, the box does
          not change with the state. */}
      {(backed || RESTING.has(status)) && <span aria-hidden className={cn("absolute inset-px rounded-full", surface)} />}
      <StatusGlyph status={status} turning={turning} />
    </span>
  );
}

export function StatusBadge({
  status,
  stale,
  past = false,
  className,
}: {
  status: AgentStatus;
  /** The reading is from the saved copy (M46 spec 10): say it in the past tense, "was working". */
  past?: boolean;
  /** The badge is showing the LAST snapshot's status while the connection is not live — dim it so
   *  frozen data doesn't read as current. No animation to remove here (the badge mark never turns),
   *  so opacity alone carries it; the transition restores it instantly on recovery. */
  stale?: boolean;
  className?: string;
}) {
  useLocale();
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 transition-opacity", CHIP[status], stale && "opacity-40", className)}
    >
      {/* The chip's own tint is the ground, so a resting ring fills with nothing. */}
      <StatusDot status={status} surface="bg-transparent" className="size-2.5" />
      {past ? statusLabelPast(status) : statusLabel(status)}
    </Badge>
  );
}

const WORD = {
  blocked: "text-status-blocked",
  working: "text-status-working",
  done: "text-status-done",
  idle: "text-status-idle",
  unknown: "text-status-unknown",
  shell: "text-muted-foreground",
} satisfies Record<AgentStatus | "shell", string>;

/**
 * The status as a WORD, in the caption register — the pane header's line 1, where the state rides
 * with the identity instead of competing with the actions for the name's width.
 *
 * Why a word at all, beside a mark: a status mark in hue alone does not survive the range. Simulated
 * on the app's own `--status-*` tokens, a deuteranope reads blocked, working and done as ONE colour
 * in light theme (OKLab ΔE 0.014–0.046 against a ~0.05 floor at this size), and "needs you" against
 * "done" — the app's most consequential opposite pair — collapses in BOTH themes. Idle and unknown
 * are 0.02 apart in lightness and are the same dot for everybody. That measurement is why the word
 * existed, and it is why the mark is now a SHAPE as well (issue 420, 2026-10-12): a triangle, a
 * half-filled circle, a disc and a ring differ in silhouette, not in hue, so the state is carried by
 * the shape and the colour is a second channel. The word is still the statement for a reader who
 * wants it spelled out; the shape is no longer the thing the colour has to rescue.
 *
 * Coloured with the same `--status-*` tokens as the chip's TEXT, not as its fill — those values are
 * tuned for text contrast on this ground, which is exactly the job here. No alpha modifier: index.css
 * says outright that no token value rescues a `/70`.
 *
 * THE COMPOSER NO LONGER DRAWS IT, and nothing else in the app does either — the 14px status band
 * above the actions row was its one call site, and Altan asked for that half of the band to go
 * ("the status is unnecessary at this place"). It is kept as the catalog entry for this idea, and
 * the measurement above is kept with it, because the measurement is what justifies the one NAMED
 * `StatusDot` in the app: the pane header's badge carries `label={statusLabel(...)}` so a screen
 * reader still gets the state, now that no word says it on the page. `StatusWordSlot`, the
 * reserved-width form this had for standing beside the host, left with the band.
 */
export function StatusWord({
  status,
  stale,
  className,
}: {
  /** `"shell"` for a bare shell pane, which has no agent and therefore no agent status. */
  status: AgentStatus | "shell";
  /** Frozen last-snapshot reading while the connection is not live — dimmed, as the badge is. */
  stale?: boolean;
  className?: string;
}) {
  useLocale();
  return (
    <span
      className={cn(
        // `text-[10px]/3` — 10px type in a stated 12px box, so the header's three-line budget is a
        // sum of boxes rather than of font metrics. One utility rather than `text-[10px] leading-3`
        // because tailwind-merge deletes an earlier `leading-*` when a later `text-<size>` lands in
        // the same cn(), and a caller passing `className="text-xs"` would silently take the line
        // height with it.
        "shrink-0 text-[10px]/3 font-medium uppercase tracking-wide transition-opacity",
        WORD[status],
        stale === true && "opacity-40",
        className,
      )}
    >
      {status === "shell" ? t("status.shellBadge") : statusLabel(status)}
    </span>
  );
}

/** Muted "shell" tag shown in place of a StatusBadge for a bare shell pane (no agent). */
export function ShellBadge({ stale, className }: { stale?: boolean; className?: string }) {
  useLocale();
  return (
    <span
      className={cn(
        "shrink-0 rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground transition-opacity",
        stale && "opacity-40",
        className,
      )}
    >
      {t("status.shellBadge")}
    </span>
  );
}
