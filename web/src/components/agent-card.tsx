import { TerminalSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { UnseenMark } from "@/components/ui/unseen-mark";
import { Card } from "@/components/ui/card";
import { ShellBadge, StatusBadge, StatusDot } from "@/components/status-badge";
import { AgentIcon } from "@/components/agent-icon";
import { PaneMeta } from "@/components/pane-meta";
import { PaneHint } from "@/components/pane-hint";
import { paneCwdLine, paneName, panePlaceParts, soleTabName } from "@/lib/pane-name";
import { statusLabel } from "@/lib/types";
import type { AgentView } from "@/lib/types";
import { useLocale } from "@/hooks/use-locale";

interface AgentCardProps {
  agent: AgentView;
  onClick: () => void;
  /**
   * Where the row is being shown. "herd" (default) is a flat list across every space, so line 2
   * carries the place. "tab" is a list already grouped under its space and tab, so line 2 is the
   * path alone. "place" is the dashboard's grouped list, where the heading above already says the
   * WORKSPACE, so line 2 carries the tab alone — and carries nothing at all when that tab has no
   * name of its own, in a slot that keeps its height either way. Line 1 is the pane's name in all
   * three.
   */
  scope?: "herd" | "tab" | "place";
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
  /**
   * A finished pane the operator hasn't opened yet — see `isUnseen()` (lib/triage.ts). Only the
   * "Ready · unseen" section passes it; every other row leaves it at the default. Draws a small
   * filled dot right after the name, on line 1, so a glance at a compact row still tells it apart
   * from an ordinary finished pane sitting in its workspace group.
   */
  unseen?: boolean;
  /**
   * The dashboard trial's louder in-place mark (variant 5): a flat row that needs you, or is
   * finished and unseen, takes a full-row wash in its status colour, 10 percent, in place of the
   * 5 percent blocked tint alone. The row is the mark; nothing on its edge and nothing moves.
   */
  tint?: boolean;
}

/** The row's text: line 1's name, and line 2's two runs. */
interface RowLines {
  primary: string;
  /** Line 2's first run — the space, in a herd row. Null when there is none. */
  detailLead: string | null;
  /** Line 2's second run, which takes the remaining width — the tab, in a herd row. */
  detailTail: string | null;
  /** The tail is a path (mono, data) rather than a tab or a space (app face). */
  tailMono: boolean;
  /** The tail is the tab's POSITION, not its name (`tabTitle`'s `positional`) — drawn a shade
   *  lighter so it never reads as a name the operator chose. */
  tailPositional: boolean;
}

// A pane row, used by the triage home and the space view. Usually an agent; for a bare shell pane
// (kind:"shell") it shows a terminal glyph and a muted "shell" tag instead of a status badge.
//
// ── THE ROW LEADS WITH THE PANE'S NAME, AND THE PLACE SITS BENEATH ───────────
// Line 1 is the pane's NAME (lib/pane-name.ts), in the row's one bold run, taking the whole width.
// Line 2 is its PLACE, `space › tab`, muted and small. The name is the only fact on the row that is
// unique to it: the space repeats across every one of an eight-pane project's rows, and the tab name
// repeats across projects. So the name gets the weight and the width, and the place goes beneath it
// as context — you read what the work is, then where it lives. Every other surface answers the same
// two questions the same way round.
//
// The tile shrank with the same argument. At `size-9` it was a 36px column on every row of a list
// where every row is the same agent, so it carried no information and pushed both lines 44px right.
// At `size-4` it rides inline on line 1 as a mark beside the title, and the row's text starts
// where the row starts. That is the SAME size and the same shell tile the pane header wears
// (`agent-chat.tsx`), which is the other place the agent's mark stands beside a name — one size for
// one role, so the two surfaces cannot drift apart.
//
// The two parts of line 2 render as separate spans on purpose: at 390px a joined string truncates
// from the right, which would eat the tab and leave every row of a project reading the same nine
// characters of its space. The space gives up width first and the tab takes what is left.
export function AgentCard({
  agent,
  onClick,
  scope = "herd",
  statusStyle = "badge",
  density = "card",
  unseen = false,
  tint = false,
}: AgentCardProps) {
  useLocale();
  const isShell = agent.kind === "shell";
  const blocked = agent.status === "blocked";
  const inTab = scope === "tab";
  // ── THE WORKSPACE-GROUPED ROW CARRIES ITS TAB, AT ONE HEIGHT ─────────────────
  // Under a WORKSPACE heading (lib/pane-groups.ts) line 2 has one fact left worth saying: the tab.
  // The workspace is the heading and the cwd is the same cwd down most of a project, but the tab is
  // what tells two rows of one workspace apart — so line 2 is the tab's name, and when the
  // multiplexer only numbered that tab (`isUnnamedTab`), it reads that number instead: `tab 2`, in
  // the lighter ink. When the raw label carries no number at all, the slot is skipped outright and
  // the row's own `items-center` puts the name in the middle of the 44px row instead.
  //
  // The slot is always 16px when it renders, and the row STATES its own height rather than letting
  // its contents set it: `h-11`, 44px, the app's touch floor, holding a 20px line over a 16px slot
  // with no vertical padding of its own. Every row of every group is that height whether its tab
  // carries a name, a position, or neither, so nothing in the list can move (DESIGN.md §2). The
  // bridge's hint stays off the row for the same reason — it is a sentence, and a sentence has no
  // height anyone can state.
  //
  // The trailing meta rides the name line, same as every other scope — `PaneMeta`, at the end of
  // line 1, in the 12px box the pane header's workspace line already gives it — so it never adds a
  // slot of its own and can't set this row's stated height. The hint is still on the pane screen,
  // which is where a sentence belongs.
  const inPlace = scope === "place";
  const flat = density === "row";
  // ONE NAME, ONE PLACE (lib/pane-name.ts). Line 1 is what the pane is CALLED, on every row of
  // every list; line 2 is WHERE it sits. In a tab-scoped list the place is already established by
  // the space heading and the per-tab section above, so line 2 is the path instead — the one fact
  // that still tells two panes in one tab apart.
  const place = panePlaceParts(agent);
  // When the tab's own name IS the pane's name (a named one-pane tab, pane-name.ts § soleTabName),
  // line 2 would repeat it; it carries the title Claude writes instead, so that stays in sight.
  const nameIsTab = soleTabName(agent) !== null && paneName(agent) === soleTabName(agent);
  const liveTitle = agent.terminalTitle && agent.terminalTitleStale !== true ? agent.terminalTitle : null;
  const lines: RowLines = inPlace
    ? {
        primary: paneName(agent),
        detailLead: null,
        detailTail: nameIsTab ? liveTitle : (place.tab?.text ?? null),
        tailMono: false,
        tailPositional: nameIsTab ? false : (place.tab?.positional ?? false),
      }
    : inTab
      ? {
          primary: paneName(agent),
          detailLead: null,
          detailTail: paneCwdLine(agent),
          tailMono: true,
          tailPositional: false,
        }
      : {
          primary: paneName(agent),
          detailLead: place.space,
          detailTail: place.tab?.text ?? null,
          tailMono: false,
          tailPositional: place.tab?.positional ?? false,
        };
  const { primary, detailLead, detailTail } = lines;
  // A workspace-grouped row whose tab has no name of its own reads its position instead — `tab 2` —
  // via `tabTitle` (`lib/pane-name.ts`) — or, when the raw label carries no digit at all, nothing:
  // the slot is then skipped outright.
  const skipBlankSlot = inPlace && detailTail === null;
  // The dot leads line 1, INLINE, ahead of the tile — not on the tile's corner. The corner was
  // right at `size-9`: a 10px badge on a 36px tile is a badge. On a 16px tile it is most of the
  // artwork, and shrinking it to fit kills the one glance cue the row has — the resting states are
  // hollow rings drawn with a 1.5px border, which at 8px is nearly a solid disc and stops telling
  // idle from working. Inline it keeps full size, still sits against its subject, and a list of rows
  // lines its dots up in one column at the left edge, which is how the list is actually scanned.
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
          // alignment against a group that had no border to supply the 1px.
          flat
            ? "flex flex-row items-center gap-3 px-3.5 py-2.5"
            : "flex-row items-center gap-3 rounded-xl px-3.5 py-3 shadow-sm",
          // Every flat row states its own pitch — `py-0` because the height IS the statement, and
          // the flat row's own `py-2.5` around two lines would make it 56px and the number would
          // stop being a number. Was `inPlace`-only; keyed on `flat` now (2026-09-14) so an urgent
          // row (`scope="herd"`, `density="row"`) gets the same 44px as a workspace-grouped one —
          // the two are meant to read as the SAME kind of row (agent-list.tsx's urgent section).
          flat && "h-11 py-0",
          // The blocked TINT survives both treatments — it's the one cue that reads at a glance.
          // A card sits in a gap list and already carries a border in every state, so it only
          // recolours. A flat row sits in a divide-y list, where a four-sided edge would double the
          // hairline — it used to take a 2px left rail instead, which read as the thick-left-border
          // accent the design rules ban (removed 2026-09-14): status on a flat row is carried by the
          // dot (`cornerDot`) and this tint alone, nothing on the edge.
          blocked && (flat ? "bg-status-blocked/5" : "border-status-blocked/40 bg-status-blocked/5"),
          tint && flat && blocked && "bg-status-blocked/10",
        )}
      >
        <div className="min-w-0 flex-1">
          {/* LINE 1 IS THE NAME, AND THE ADDRESS ENDS IT. The dot and the tile stay centred on the
              row's own line box — neither has a baseline worth chasing — but the name and the
              trailing meta share one, via `self-baseline` on each rather than `items-baseline` on
              the row: CSS computes that baseline group only over the children that ask for it and
              leaves the icons centred (`pane-meta.tsx`'s header explains the technique it borrows).
              The meta is `flex-none` by way of `PaneMeta`'s own `shrink-0`, so it never yields
              width before the name does, and it draws its own 12px box whether or not either chip
              inside it has anything to say — an empty reading leaves its space rather than pulling
              the row narrower (DESIGN.md §2). This closes the corner column's old fault: two fixed
              slots stacked beside a one- or two-line row read as three rows on a phone (Altan's
              phone feedback), and folding the address onto the name line answers it without losing
              the "a slot with nothing to say still holds its place" guarantee the column had. */}
          <div data-slot="agent-row-title" className="flex min-w-0 items-center gap-2">
            {cornerDot && (
              <StatusDot
                status={agent.status}
                // A hollow resting ring must be filled with the colour it actually sits on — a card
                // is `--card`, a flat row is the page.
                surface={flat ? "bg-background" : "bg-card"}
              />
            )}
            {/* An avatar is a FRAME around someone else's artwork, not a shape that means
                something, so this tile, the shell tile beside it and the same tile in
                `agent-chat.tsx` are all framed at the house radius — a circle would crop the
                artwork. Full-round stays RESERVED for things that are a circle in meaning: the
                status dot above, the switch thumb, round icon buttons. */}
            {isShell ? (
              <div className="flex size-4 shrink-0 items-center justify-center rounded-sm border bg-muted">
                <TerminalSquare className="size-2.5 text-muted-foreground" />
              </div>
            ) : (
              <AgentIcon agent={agent.agent} className="size-4" />
            )}
            {/* No longer `flex-1`: that let the name claim the whole line, which pushed the unseen
                dot all the way to the far end, beside the meta, instead of beside the NAME. It now
                sizes to its own text and only `min-w-0` lets it truncate below that — the dot still
                sits right after whatever survives the truncation. `PaneMeta`'s own `ml-auto` is what
                claims the row's spare width now, so it still lands at the end. */}
            <span className="min-w-0 truncate self-baseline font-medium">{primary}</span>
            {/* A finished pane you haven't opened yet: the square (ui/unseen-mark.tsx). Right after
                the name, never before it, and its slot is reserved on a flat row so the name
                truncates at one width whether the mark is drawn or not. */}
            <UnseenMark on={unseen} reserve={flat} className="ml-2" />
            <PaneMeta
              host={agent.host}
              cache={agent.cache}
              session={agent.session}
              className="ml-auto self-baseline"
            />
          </div>

          {/* Only rendered when there's something to say — a pane with neither a tab nor a name of
              its own is a one-line row. A workspace-grouped row is the exception: its slot is
              always there, holding the tab's name or its position — UNLESS neither is available,
              which skips the slot outright and centres the name in the 44px row instead. */}
          {!skipBlankSlot && (inPlace || detailLead !== null || detailTail !== null) && (
            <div
              data-slot="agent-row-detail"
              className={cn(
                "flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground",
                // 16px whatever is in it, which is the slot half of the stated height above —
                // keyed on `flat` for the same reason the height above is.
                flat && "h-4 items-center",
              )}
            >
              {inPlace && lines.tailPositional && detailTail !== null ? (
                // The unnamed tab's position, a shade lighter than an ordinary tab name so it never
                // reads as one.
                <span className="min-w-0 flex-1 truncate text-muted-foreground/70">
                  {detailTail}
                </span>
              ) : (
                <>
                  {/* Both runs of the address are plainly muted — line 2 is one fact in two parts,
                      and weighting either half turns it back into a competition with line 1. The
                      space gives up width first; the tab takes the rest. A positional tail (`tab
                      2`) takes the same shade-lighter ink here as it does alone above. */}
                  {detailLead !== null && (
                    <span className="min-w-0 shrink truncate">{detailLead}</span>
                  )}
                  {detailLead !== null && detailTail !== null && (
                    // The place's own separator, the same glyph the joined form uses (PLACE_SEP): a
                    // crumb, because a space CONTAINS a tab. A middot would read as two peers.
                    <span className="shrink-0 text-muted-foreground/60" aria-hidden>
                      ›
                    </span>
                  )}
                  {detailTail !== null && (
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate",
                        lines.tailMono && "font-mono",
                        lines.tailPositional && "text-muted-foreground/70",
                      )}
                    >
                      {detailTail}
                    </span>
                  )}
                </>
              )}
            </div>
          )}

          {/* The bridge's own sentence about this pane, when it sent one — text, never a branch
              (components/pane-hint.tsx). It changes nothing about the row: a hinted pane is still a
              shell, still sorts where an unknown status sorts, and still opens the same view.
              Withheld on any flat row, whose height is stated; see `flat` above. */}
          {!flat && <PaneHint hint={agent.hint} />}
        </div>

        {isShell ? (
          <ShellBadge />
        ) : cornerDot ? (
          /* The dot itself is colour-only and lives on line 1; give SR users the word. */
          <span className="sr-only">{statusLabel(agent.status)}</span>
        ) : (
          <StatusBadge status={agent.status} />
        )}
      </Shell>
    </button>
  );
}
