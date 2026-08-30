import { TerminalSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { ShellBadge, StatusBadge, StatusDot } from "@/components/status-badge";
import { AgentIcon } from "@/components/agent-icon";
import { HostChip } from "@/components/host-chip";
import { SessionChip } from "@/components/session-chip";
import { PaneHint } from "@/components/pane-hint";
import { timeAgoShort } from "@/lib/format";
import { paneParts, paneTitleInTab } from "@/lib/pane-name";
import { statusLabel } from "@/lib/types";
import type { AgentView } from "@/lib/types";
import { useLocale } from "@/hooks/use-locale";

interface AgentCardProps {
  agent: AgentView;
  onClick: () => void;
  /**
   * Show "how long ago" on the second line, and which timestamp it means: "seen" for the Recent
   * section (when you last opened it), "active" for Ready · unseen (when it finished). Omitted
   * elsewhere — a blocked agent's age is noise next to the fact that it's blocked.
   */
  age?: "seen" | "active";
  /**
   * Where the row is being shown. "herd" (default) is a flat list across every space, so the title
   * carries `project · tab`. "tab" is a list already grouped under its space and tab — repeating
   * them would say nothing, so the pane's own name leads instead.
   */
  scope?: "herd" | "tab";
  /**
   * How to show status. "badge" (default) spells it out. "dot" is for a list already GROUPED by
   * status — the section heading says "Working", so eighteen rows repeating it in a pill buys
   * nothing and costs a third of the row's width, which is exactly the width the title needs.
   */
  statusStyle?: "badge" | "dot";
  /**
   * "card" (default) is the bordered, shadowed treatment. "row" is flat — no border, no shadow,
   * separated by a hairline instead.
   *
   * Card chrome on 100% of rows is wallpaper, not emphasis: a Working row and a Recent row rendered
   * pixel-identically, throwing away the four-level priority `triage()` had just computed. Reserving
   * the card for the sections that mean "a human is required here" makes the shape itself carry the
   * signal — see a card, something wants you; all flat, nothing does.
   */
  density?: "card" | "row";
}

/** The row's age, in the trailing slot of whichever line it sits on. Not mono — it's a footnote,
 *  not data; mono made it read like the path it replaced. */
function Age({ at }: { at: number }) {
  return <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{timeAgoShort(at)}</span>;
}

// A pane row, used by the triage home and the space view. Usually an agent; for a bare shell pane
// (kind:"shell") it shows a terminal glyph and a muted "shell" tag instead of a status badge.
//
// The title is `project · tab` — NOT the agent name, which every row would otherwise share. The two
// parts render as separate spans on purpose: eight panes in one project all start `moonward_os · `,
// so truncating the joined string would eat the tab and leave every row identical. The project
// gives up width first; the tab, the only discriminator, survives.
export function AgentCard({
  agent,
  onClick,
  age,
  scope = "herd",
  statusStyle = "badge",
  density = "card",
}: AgentCardProps) {
  useLocale();
  const isShell = agent.kind === "shell";
  const blocked = agent.status === "blocked";
  const inTab = scope === "tab";
  const flat = density === "row";
  const parts = paneParts(agent);
  const tabTitle = paneTitleInTab(agent);
  const stamp = age === "seen" ? agent.lastSeenAt : age === "active" ? agent.lastActiveAt : undefined;
  const secondary = inTab ? tabTitle.secondary : parts.secondary;
  // The dot rides the avatar's corner rather than the far right: at the right edge the eye read a
  // title, then crossed 200px of empty card to a 10px mark describing it.
  const cornerDot = statusStyle === "dot" && !isShell;

  const Shell = flat ? "div" : Card;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full text-left transition-transform active:scale-[0.99]",
        // No radius on a flat row, in ANY state. These sit in a `divide-y` list, and a rounded fill
        // under a full-width straight hairline reads as a rendering fault — the corners pull away
        // from a line that doesn't follow them. Corners belong to where the row sits, never to what
        // it is doing, so a blocked flat row stays square too and takes a left rail instead.
        flat && "transition-colors hover:bg-muted/50",
      )}
    >
      <Shell
        className={cn(
          // 14px, the same as the card's own padding. A flat row now sits inside a 1px-bordered
          // ListGroup, so its content lands on the same x as a card row's content BY CONSTRUCTION
          // (14 + 1 on both sides) — the hand-computed 15px this replaced was faking exactly that
          // alignment against a group that had no border to supply the 1px. The rail below is a
          // box-shadow, which takes no room, so the number still holds.
          flat
            ? "flex flex-row items-center gap-3 px-3.5 py-2.5 shadow-[inset_2px_0_0_0_transparent]"
            : "flex-row items-center gap-3 rounded-xl px-3.5 py-3 shadow-sm",
          // The blocked tint survives both treatments — it's the one cue that reads at a glance.
          // The EDGE cannot: one class string, two containers. A card sits in a gap list and already
          // carries a border in every state, so it only recolours. A flat row sits in a divide-y
          // list, where a four-sided edge would double the hairline — and where a bare colour
          // utility paints nothing at all, because preflight leaves the width at 0. So the flat row
          // takes a 2px left rail, reserved transparent above so the box never changes.
          blocked &&
            (flat
              ? "bg-status-blocked/5 shadow-[inset_2px_0_0_0_var(--color-status-blocked)]"
              : "border-status-blocked/40 bg-status-blocked/5"),
        )}
      >
        <div className="relative shrink-0">
          {/* An avatar is a FRAME around someone else's artwork, not a shape that means something, so
              the whole family — this shell tile, the same tile in `agent-chat.tsx`, and the branded
              `AgentIcon` beside it — is framed at the house radius. A circle would crop the artwork,
              which is why `agent-icon.tsx` carried its own 22% radius before this; one slot may not
              hold two shapes for one role. Full-round stays RESERVED for things that are a circle in
              meaning: status dots (the corner dot just below), the switch thumb, round icon buttons.
              Don't "fix" one of the three back to `rounded-full`. */}
          {isShell ? (
            <div className="flex size-9 items-center justify-center rounded-md border bg-muted">
              <TerminalSquare className="size-4 text-muted-foreground" />
            </div>
          ) : (
            <AgentIcon agent={agent.agent} className="size-9" />
          )}
          {cornerDot && (
            <StatusDot
              status={agent.status}
              // Filled and ringed in the surface it actually sits on — a card is white, a flat row
              // is the page. Get this wrong and a hollow ring reads as a notch in the logo.
              surface={flat ? "bg-background" : "bg-card"}
              className={cn(
                "absolute -bottom-0.5 -right-0.5 rounded-full ring-2",
                flat ? "ring-background" : "ring-card",
              )}
            />
          )}
        </div>

        <div className="min-w-0 flex-1">
          {inTab ? (
            <div className="truncate font-medium">{tabTitle.primary}</div>
          ) : (
            <div className="flex min-w-0 items-baseline gap-1">
              {/* With a tab present the project yields width first (capped, truncatable) and the
                  tab — the discriminator — takes the rest. With NO tab the project IS the name, so
                  it takes the width itself; leaving the fill on the tab span meant an unlabelled
                  row had no filler at all and its age butted against the name, reading as part of
                  it ("comm_cli 37m"). */}
              <span
                className={cn(
                  "truncate text-muted-foreground",
                  parts.tab ? "max-w-[45%] shrink" : "min-w-0 flex-1",
                )}
              >
                {parts.project}
              </span>
              {parts.tab && (
                <>
                  <span className="shrink-0 text-muted-foreground/60" aria-hidden>
                    ·
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{parts.tab}</span>
                </>
              )}
            </div>
          )}

          {/* Only rendered when there's something to say — most rows are one line now. */}
          {secondary && (
            <div className="truncate font-mono text-xs text-muted-foreground">{secondary}</div>
          )}

          {/* The bridge's own sentence about this pane, when it sent one — text, never a branch
              (components/pane-hint.tsx). It changes nothing about the row: a hinted pane is still a
              shell, still sorts where an unknown status sorts, and still opens the same view. */}
          <PaneHint hint={agent.hint} />
        </div>

        {/* The trailing meta is a COLUMN, not a tail on the title. Inside the title line the chip
            was 4px from a truncated word and competed with the discriminator for the same width;
            here the title takes its natural width, the secondary line runs the full width beneath
            it, and the chip is centred against the whole row by the shell's own `items-center`.
            Costs no height — the row pitch is unchanged. HostChip self-hides: nothing renders
            unless the snapshot lists more than one machine (components/host-chip.tsx), so on a solo
            install this column collapses to the age alone, or to nothing. */}
        <div className="flex shrink-0 items-center gap-2">
          {/* The row's ADDRESS, both halves, in the order the address itself reads: which machine,
              then which session on it. Each self-hides — the host when there is no pack, the session
              when the row is in the primary one or the list was never widened — so on every install
              that exists today this column is still the age alone, or nothing. */}
          <HostChip host={agent.host} />
          <SessionChip session={agent.session} />
          {stamp !== undefined && <Age at={stamp} />}
        </div>

        {isShell ? (
          <ShellBadge />
        ) : cornerDot ? (
          /* The dot itself is colour-only and lives on the avatar; give SR users the word. */
          <span className="sr-only">{statusLabel(agent.status)}</span>
        ) : (
          <StatusBadge status={agent.status} />
        )}
      </Shell>
    </button>
  );
}
