import { useEffect, useRef } from "react";
import { Bot, ChevronUp, X } from "lucide-react";

import { MorphIcon } from "@/components/ui/morph-icon";

import { StatusDot } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/hooks/use-locale";
import { useLongPress } from "@/hooks/use-long-press";
import { usePinSide } from "@/hooks/use-pin-side";
import { useSwipeUp } from "@/hooks/use-swipe";
import { t as translate } from "@/lib/i18n";
import { paneDisplayName, statusLabel, type AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";

// The row that replaced the tab strip, the pane strip and the switcher handle: every agent
// working in this space as a horizontally scrollable run of session titles, with a small
// up-pill centred against its top border that opens the full switcher sheet. Tapping a title
// switches straight to that pane; the open one reads as current. Titles come from
// `paneDisplayName` (operator label, then the agent's own session name, then the agent kind),
// the same precedence the old pane pills used, so the row and the sheet never disagree about
// what a session is called.
interface SpaceAgentsRowProps {
  /** This workspace's agents, in stable order. */
  agents: readonly AgentView[];
  currentPaneId: string;
  onSelect: (paneId: string) => void;
  /** Opens the switcher sheet — the handle's old job, kept on the up-pill beside the swipe. */
  onOpenSwitcher: () => void;
  /** A hold on a chip opens that pane's options (rename, close) — the pane pill's old sheet. */
  onHoldPane: (pane: AgentView) => void;
  /** Connection not live: dots show the last snapshot dimmed, like every other StatusDot. */
  stale?: boolean;
  /** Toggles the in-flow agent palette through the composer's ref. */
  onOpenCommands: () => void;
  /** Whether the palette stands open — the pin morphs into its close control. */
  pinOpen: boolean;
  /** The palette's own gate: something pickable exists (shipped catalog or operator rows). */
  commandsAvailable: boolean;
  /** The write lock, recomputed up in AgentChat — a read-only device gets a dead button. */
  commandsDisabled: boolean;
}

export function SpaceAgentsRow({
  agents,
  currentPaneId,
  onSelect,
  onOpenSwitcher,
  onHoldPane,
  stale,
  onOpenCommands,
  pinOpen,
  commandsAvailable,
  commandsDisabled,
}: SpaceAgentsRowProps) {
  useLocale();
  const { side } = usePinSide();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the current session on screen: after a switch (the list is stable, so this only runs
  // when the pane actually changes) centre its chip. Manual scroll arithmetic rather than
  // scrollIntoView: the sums are zeros in jsdom, a harmless no-op, where scrollIntoView throws
  // "not implemented".
  useEffect(() => {
    const box = scrollRef.current;
    // SAFETY: the only [aria-current] descendants here are the chips, which are <button>s.
    const current = box?.querySelector("[aria-current]") as HTMLElement | null;
    if (box && current) {
      box.scrollLeft = current.offsetLeft - box.clientWidth / 2 + current.clientWidth / 2;
    }
  }, [currentPaneId]);
  // Dragging UP anywhere on the row opens the quick switcher — the same sheet as the pill,
  // for the thumb that starts on a chip rather than the handle. Touch-only and read-only: it
  // never preventDefaults, so the row's horizontal scroll and every chip tap pass through.
  const swipe = useSwipeUp(onOpenSwitcher);

  // The /Agents pin, built once and slotted left or right below: the rail's pad tab twin —
  // the SAME shadcn Button with the mirrored geometry, not a lookalike, so the two cannot
  // drift apart again. Filled flush to the glass. Rendered only when something is pickable
  // — the palette's own gate — and dead while the device may not write.
  const pin = commandsAvailable ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onOpenCommands}
      disabled={commandsDisabled}
      aria-label={translate("composer.controls.agent")}
      aria-expanded={pinOpen}
      aria-controls="dock-cmd"
      className={
        side === "left"
          ? "flex h-8 shrink-0 touch-manipulation items-center justify-center rounded-r-full rounded-l-none bg-muted pl-3 pr-2.5 text-muted-foreground select-none"
          : "flex h-8 shrink-0 touch-manipulation items-center justify-center rounded-l-full rounded-r-none bg-muted pl-2.5 pr-3 text-muted-foreground select-none"
      }
    >
      {/* Same morph as the rail pad — one shared MorphIcon, so the pin visibly offers to
      collapse what it opened, with the same untwist. */}
      <MorphIcon open={pinOpen} shut={Bot} show={X} />
    </Button>
  ) : null;

  return (
    // The pill's own lane: 10px of top padding whose upper half the pill vacates — it rides
    // centred ON the chrome border above this row (half over the statusline, half in this
    // lane), never on the chips: the scroller centres the current chip, so anything lower
    // would cover exactly the title the eye is looking for. In-flow costs 10px of chrome;
    // the statusline lends the top half its bottom-centre 48px, the emptiest patch of that
    // strip.
    // `touch-pan-x`: vertical drags belong to the swipe-up, not the browser. Without it a
    // swipe-up starts a viewport rubber-band (and a pull-to-refresh where one exists) while
    // the gesture also fires — the whole page bounces under the thumb. pan-x keeps the
    // chips' horizontal scroll and hands everything vertical to the handlers, no
    // preventDefault needed. `overscroll-y-none` stops the chain below from joining in.
    <div
      data-slot="space-agents"
      className="relative touch-pan-x overscroll-y-none px-3 pt-2.5"
      {...swipe}
    >
      {/* The up-pill: the swipe-up's visible twin. A bare gesture has no affordance — nothing
          says UP opens the picker — so the handle sits mid-screen (an easier target than the
          old edge cravat it replaces) wearing the gesture's own arrow. Same sheet, same
          accessible name the handle always answered to. */}
      <button
        type="button"
        onClick={onOpenSwitcher}
        aria-label={translate("chat.switcher.aria")}
        aria-haspopup="dialog"
        // Tapered, not capped: a hexagon clip pinches both ends to soft points, so the
        // handle reads as a direction (up) rather than a button among buttons. A real
        // border cannot survive the clip (it is cut where the polygon leaves the box), so
        // the edge is a doubled 1px silhouette shadow instead — filters apply after the
        // clip and follow the points. It wears the icon's own colour, not the rule
        // colour: a rule hairline vanishes on dark chrome, while the icon tone holds on
        // the terminal above and the chrome below in both themes. 12px tall, centred on
        // the border: 6px over the statusline, 6px in the lane below it.
        className="absolute -top-1.5 left-1/2 z-10 flex h-3 w-14 -translate-x-1/2 touch-manipulation items-center justify-center bg-muted text-muted-foreground transition-colors select-none hover:bg-muted/60 active:scale-95 [clip-path:polygon(0%_50%,18%_0%,82%_0%,100%_50%,82%_100%,18%_100%)]"
        style={{ filter: "drop-shadow(0 0 1px currentColor) drop-shadow(0 0 1px currentColor)" }}
      >
        <ChevronUp className="size-2.5" />
      </button>
      {/* Chips plus the pinned /Agents door: the scroller takes the free width and fades under
          the pin, the rail's own arrangement. The pin renders on the configured side (a plain
          variable, not a mirrored tree — one button, two slots), so tab order follows the eye.
          The bleed lives on this wrapper, never on the pin: WebKit drops negative margins on
          flex items, so a pin-side `-ml-3` computes flush in Chromium and parks 12px off in
          Safari. A block-level wrapper bleeds the same everywhere. */}
      <div
        className={
          side === "left" ? "-ml-3 flex h-8 items-center gap-1.5" : "-mr-3 flex h-8 items-center gap-1.5"
        }
      >
      {side === "left" && pin}
      <div
        ref={scrollRef}
        className={cn(
          "flex h-7 min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overscroll-x-contain [mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          // Air on the pin's side only: the far edge keeps no padding, the dual fade above
          // covers its clips. (A single-sided fade left overflow keys hard-clipped mid-glyph
          // on the far edge — the "<" fragment that reported this.)
          side === "left" ? "pl-3" : "pr-3",
        )}
      >
        {agents.map((a) => (
          <AgentChip
            key={a.paneId}
            agent={a}
            current={a.paneId === currentPaneId}
            stale={stale}
            onSelect={onSelect}
            onHoldPane={onHoldPane}
          />
        ))}
      </div>
      {side === "right" && pin}
      </div>
      </div>
  );
}

// One chip, split out so the hold gets its own hook instance — hooks in the map above would
// change count with the session list. The pane pill's old shape (pane-strip.tsx): tap selects,
// hold opens that pane's options, and the hook eats the click after a fired hold so a hold
// never switches panes on release.
function AgentChip({
  agent,
  current,
  stale,
  onSelect,
  onHoldPane,
}: {
  agent: AgentView;
  current: boolean;
  stale?: boolean;
  onSelect: (paneId: string) => void;
  onHoldPane: (pane: AgentView) => void;
}) {
  const hold = useLongPress(() => onHoldPane(agent));
  return (
    <button
      type="button"
      onClick={() => onSelect(agent.paneId)}
      {...hold}
      aria-current={current ? "true" : undefined}
      title={paneDisplayName(agent)}
      className={cn(
        // [-webkit-touch-callout:none] joins the select-none the chip already had: without it
        // iOS Safari's native hold gesture fires pointercancel and kills the timer (ui/chip.tsx).
        "flex h-6 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium whitespace-nowrap transition-colors select-none active:scale-95 [-webkit-touch-callout:none]",
        current
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted/60",
      )}
    >
      {/* The state dot leads the title: this chip carries no status word, so the dot is the
          only mark of the state in its group and takes the label (StatusDot's own rule —
          everywhere else the word stands beside it and the dot stays silent). Still, never
          live: only the watched pane's dots breathe. The hollow resting rings fill with the
          surface they sit on — primary on the current chip, chrome everywhere else. */}
      <StatusDot
        status={agent.status}
        label={statusLabel(agent.status)}
        stale={stale}
        surface={current ? "bg-primary" : "bg-chrome"}
      />
      {/* Explicit space: JSX drops the newline between the dot and the title, and without it
          the accessible name glues shut ("needs youclaude"). */}
      {" "}
      <span className="truncate">{paneDisplayName(agent)}</span>
    </button>
  );
}
