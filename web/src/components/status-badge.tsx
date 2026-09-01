import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { OneOf } from "@/components/ui/one-of";
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
  live = false,
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
   *  stop the working breathe: a frozen reading must not animate as if it were arriving. Same
   *  `opacity-40` the StatusBadge has always used, and the same instant restore on recovery. */
  stale?: boolean;
  /**
   * Opt in to the working state's breathing animation. A pane mounts several `StatusDot`s at once
   * (tab chip, space chip, pane chip, pane header, agent card, overview) and each one used to ping
   * on its own unsynchronized 1s clock — three or more on one phone screen read as blinking, not as
   * "alive". Only the ONE dot the operator is actually watching a pane through animates now: the
   * pane chip and the pane header's agent badge. Every other call site shows a solid, still dot for
   * the same "working" state — the colour still says it, just without the motion.
   */
  live?: boolean;
  className?: string;
}) {
  const hollow = RESTING.has(status);
  const breathing = live && status === "working" && stale !== true;
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
      {/* Hollow and solid are the same box: measured at 10x10 in both, because `size-full` fixes the
          outer geometry and the 1.5px border is drawn inside it (border-box). The dot has no content
          to push in, and nothing outside it moves, so the ring/fill swap is paint only. Left as is
          on purpose — this is not a no-shift case. */}
      <span
        className={cn(
          "relative inline-flex size-full rounded-full",
          breathing && "status-breathe",
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

/**
 * Every word an AGENT pane's slot can ever hold. Ordered as the state machine reads, not
 * alphabetically; the order is only the paint order of stacked layers, so nothing depends on it.
 *
 * IT MUST LIST EVERY MEMBER OF {@link AgentStatus}, and that is a guard rather than a habit: the
 * slot reserves exactly what stands in it, so a sixth status left out of this array would be a word
 * WIDER than the space reserved for it, and the host beside it would slide on the day that state
 * first occurs — the very bug the slot exists to fix, re-armed silently. `satisfies` only proves
 * the members ARE statuses; it cannot prove none is missing. An exhaustive list is pinned in
 * `status-badge.test.tsx` against a `Record<AgentStatus, …>` (complete-checked by tsc), and that
 * pin has been SEEN to fail with a status removed.
 */
const AGENT_WORDS = [
  "blocked",
  "working",
  "done",
  "idle",
  "unknown",
] as const satisfies ReadonlyArray<AgentStatus>;

/**
 * {@link StatusWord} in a slot WIDE ENOUGH FOR EVERY WORD IT CAN EVER HOLD — the form to use
 * anywhere something else stands beside it.
 *
 * The bare word is a run of text whose width is the state's: at 390px in English "needs you" is
 * 54.6px and "done" is 27.9px, so a strip holding the word plus anything else re-lays-out every
 * time the pane changes state, and the thing beside it slides. That is DESIGN.md §2 — a state may
 * repaint, it may not re-lay-out — and §2's own technique (reserve the border, transparent) has
 * nothing to say about a changing WORD.
 *
 * So the slot reserves the widest word instead, by rendering all of them stacked in one grid cell
 * (`ui/one-of.tsx`) and showing one. A hard-coded width could not do this job: the same slot is
 * "braucht dich" (72.2px) in German and "desconocido" (70.0px) in Spanish, so any constant clips a
 * locale or wastes a locale's space. The layout engine measures the real glyphs of the real
 * dictionary, so a new translation is correct on arrival and a retranslation cannot silently
 * un-reserve the slot.
 *
 * WHICH words are reserved is decided by what the PANE can become, not by the union of everything:
 *
 *  • a bare shell has no agent and therefore no agent status — its word is "shell" forever, so
 *    reserving the agent set would buy a solo shell ~30px of permanent emptiness for a state it can
 *    never enter;
 *  • an agent pane reserves the five agent words, `undefined` included. `undefined` is a GONE pane,
 *    which has nothing left to describe and shows no word at all — and a state that shows nothing
 *    is still a state, so it keeps the slot rather than collapsing it. Without that, a pane dying
 *    under you would slide the machine's name sideways at the exact moment you are reading it.
 */
export function StatusWordSlot({
  status,
  stale,
  className,
}: {
  /** The word to show. `undefined` shows none — the slot keeps its width. */
  status: AgentStatus | "shell" | undefined;
  stale?: boolean;
  className?: string;
}) {
  // No `useLocale()` here: this component renders no text of its own. Each StatusWord below
  // subscribes for itself, so a locale change repaints every layer AND re-measures the cell.
  const words: ReadonlyArray<AgentStatus | "shell"> = status === "shell" ? ["shell"] : AGENT_WORDS;
  return (
    <OneOf
      active={status ?? null}
      options={words.map((word) => ({
        key: word,
        node: <StatusWord status={word} stale={stale} />,
      }))}
      // `shrink-0`, and it is the pair to the host chip's `min-w-0`: the slot is the fixed budget
      // and the machine's name is what truncates into what is left. The word is the half of the
      // pair a colour-blind reader depends on, so it is never the half that gives up width.
      // `justify-items-end` because the strip is right-aligned — the visible word hugs the slot's
      // right edge, and the reserve it does not use opens to its LEFT, where nothing stands.
      className={cn("shrink-0 justify-items-end", className)}
    />
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
