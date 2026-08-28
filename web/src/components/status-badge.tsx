import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { type AgentStatus, statusLabel } from "@/lib/types";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

const DOT = {
  blocked: "bg-status-blocked",
  working: "bg-status-working",
  done: "bg-status-done",
  idle: "bg-status-idle",
  unknown: "bg-status-unknown",
} satisfies Record<AgentStatus, string>;

const CHIP = {
  blocked: "border-status-blocked/30 bg-status-blocked/15 text-status-blocked",
  working: "border-status-working/30 bg-status-working/15 text-status-working",
  done: "border-status-done/30 bg-status-done/15 text-status-done",
  idle: "border-status-idle/30 bg-status-idle/10 text-status-idle",
  unknown: "border-status-unknown/30 bg-status-unknown/10 text-status-unknown",
} satisfies Record<AgentStatus, string>;

/**
 * As a FILL, the status palette needs a different ramp than it does as text. Every --status-* value
 * is tuned near the same lightness for text contrast, so drawn as solid discs the resting states
 * (idle / unknown) carry exactly as much weight as blocked — eighteen idle dots would out-shout the
 * one thing that needs you. The resting states are therefore hollow rings; the states that mean
 * something is happening stay solid.
 */
const RESTING: ReadonlySet<AgentStatus> = new Set(["idle", "unknown"]);

const RING = {
  blocked: "border-status-blocked",
  working: "border-status-working",
  done: "border-status-done",
  idle: "border-status-idle/60",
  unknown: "border-status-unknown/60",
} satisfies Record<AgentStatus, string>;

export function StatusDot({
  status,
  surface = "bg-background",
  label,
  stale,
  className,
}: {
  status: AgentStatus;
  /**
   * The colour the dot sits ON. A hollow ring must be FILLED with its surface, not left
   * transparent: over the avatar's corner a transparent interior showed orange logo through one
   * half and page grey through the other, reading as a notch cut out of the icon rather than a
   * badge. Pass the card's surface when the dot sits on a card.
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
   *  stop the working pulse: a frozen reading must not animate as if it were arriving. Same
   *  `opacity-40` the StatusBadge has always used, and the same instant restore on recovery. */
  stale?: boolean;
  className?: string;
}) {
  const hollow = RESTING.has(status);
  return (
    <span
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      className={cn(
        "relative flex size-2.5 shrink-0 transition-opacity",
        stale === true && "opacity-40",
        className,
      )}
    >
      {status === "working" && stale !== true && (
        <span
          className={cn(
            "absolute inline-flex size-full animate-ping rounded-full opacity-75",
            DOT[status],
          )}
        />
      )}
      {/* size-full, not a second size-2.5: the wrapper owns the size so `className` can change it
          (the chips ask for size-2), and a hard-coded inner would overflow or get squashed by the
          flex parent instead. The ping span above already works this way. */}
      {/* Hollow and solid are the same box: measured at 10x10 in both, because `size-full` fixes the
          outer geometry and the 1.5px border is drawn inside it (border-box). The dot has no content
          to push in, and nothing outside it moves, so the ring/fill swap is paint only. Left as is
          on purpose — this is not a no-shift case. */}
      <span
        className={cn(
          "relative inline-flex size-full rounded-full",
          hollow ? cn("border-[1.5px]", surface, RING[status]) : DOT[status],
        )}
      />
    </span>
  );
}

export function StatusBadge({
  status,
  stale,
  className,
}: {
  status: AgentStatus;
  /** The badge is showing the LAST snapshot's status while the connection is not live — dim it so
   *  frozen data doesn't read as current. No animation to remove here (the badge dot never pulses),
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
      <span className={cn("size-1.5 rounded-full", DOT[status])} />
      {statusLabel(status)}
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
 * Why a word at all, when the header already carries a dot: a 10px disc encodes this range in HUE
 * ALONE, and the range does not survive it. Simulated on the app's own `--status-*` tokens, a
 * deuteranope reads blocked, working and done as ONE colour in light theme (OKLab ΔE 0.014–0.046
 * against a ~0.05 floor at this size), and "needs you" against "done" — the app's most consequential
 * opposite pair — collapses in BOTH themes. Idle and unknown are 0.02 apart in lightness and are the
 * same dot for everybody. The dot is the anchor and welds the state to its subject; the word is the
 * statement for every reader the colour fails. Both, not either.
 *
 * Coloured with the same `--status-*` tokens as the chip's TEXT, not as its fill — those values are
 * tuned for text contrast on this ground, which is exactly the job here. No alpha modifier: index.css
 * says outright that no token value rescues a `/70`.
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
