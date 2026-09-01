import { ChevronDown } from "lucide-react";

import { StatusDot } from "@/components/status-badge";
import { cn } from "@/lib/utils";
import { hostKey } from "@/lib/hosts";
import { TRIAGE_STATUS, worstTriage } from "@/lib/triage";
import type { AgentStatus, AgentView, TabView } from "@/lib/types";
import { t, tn, type TemplateVars } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

interface StripsSummaryProps {
  /** The space the open pane lives in — the tabs of any other space are not this row's business. */
  workspaceId: string;
  tabs: TabView[];
  agents: AgentView[];
  /** The machine this space is on — tab ids collide across a pack, so status is counted per host. */
  host?: string;
  /** The open pane's tab, so its bead can be the emphasised one. */
  selectedTabId: string;
  /** The panes that share that tab, in the SAME order the pane row draws them. */
  panes: AgentView[];
  currentPaneId: string;
  onExpand: () => void;
}

// The tab row and the pane row, folded down to one 24px bar of beads.
//
// WHAT THIS IS FOR. The pane screen is the one screen that stacks two strips, and the strips are
// chrome ABOUT the pane rather than the pane's own output — 94px of it, above a mirror that on a
// keyboard-open phone shows almost nothing. Zen already answers "take it all away", and it takes the
// header and the composer with it. This is the smaller ask: keep the navigation reachable, stop
// spending a third of the chrome on it.
//
// WHY BEADS AND NOT A COUNT. A folded row must still answer the question the row answered, or it is
// just a button. The two things the strips say at a glance are "how many, and where am I in them"
// and "is anything in there shouting" — a bead per tab in the tab strip's own triage palette says
// both, and the emphasised bead is the same aria-current the tabs draw as a folder. What it does NOT
// say is the tabs' NAMES, which is the honest cost of folding and the reason expanding is one tap on
// the whole bar rather than a target you have to find.
//
// The beads are decorative on purpose (`aria-hidden`): colour is the only channel they have, so the
// button's accessible name spells the whole thing in words instead — "Show tabs and panes. 3 tabs,
// 4 panes hidden." A screen reader gets the counts; the eye gets the shape.
export function StripsSummary({
  workspaceId,
  tabs,
  agents,
  host,
  selectedTabId,
  panes,
  currentPaneId,
  onExpand,
}: StripsSummaryProps) {
  useLocale();
  // The SAME two derivations `tab-strip.tsx` runs, and they may not drift: the tabs of this space,
  // and each tab's worst triage counted over THIS machine's panes only (tab ids collide across a
  // pack, so an unfiltered list paints a peer's blocked agent onto the lead's bead).
  const here = agents.filter((a) => hostKey(a) === (host ?? ""));
  const wsTabs = tabs.filter((tab) => tab.workspaceId === workspaceId);
  // The pane row itself renders nothing below two panes, so neither does its bead group — the bar
  // stands for what the rows would have drawn, never for more.
  const paneBeads = panes.length < 2 ? [] : panes;

  return (
    <button
      type="button"
      onClick={onExpand}
      aria-expanded={false}
      // ── 24px DRAWN, 44px HIT ─────────────────────────────────────────────────
      // The bar REPLACES two 47px strips, so every drawn pixel it spends is a pixel the fold did not
      // save — it was 32px and the operator read that as still heavy. 24px is the floor its contents
      // set rather than a number picked to be small: the beads are 16px boxes, so 24 leaves 4px of
      // air above and below them, and the next step down (20px) leaves 2px, which reads as a bead
      // row jammed against the header rule rather than a band with beads in it.
      //
      // Measured, and left alone: the band the EYE reads is bounded by the header's rule above and
      // the mirror's rule 4px below (DESIGN.md §4), so it is 28px and the beads sit 4px under the
      // top edge and 8px above the bottom one. Paying 2px of `pt` to balance that is exactly the
      // compensation §4 says to delete once the missing edge is back — and the edge below is the
      // mirror's own page gap, which is not this bar's to spend.
      //
      // A full-width control is the one shape that can buy its 44px floor purely as hit area with no
      // neighbour to collide with (DESIGN.md §6). 10px above and below (`-inset-y-2.5`) is
      // 24+10+10 = 44 exactly. Above is a banner or open ground; below is the mirror's 4px of page
      // and then 6px of the mirror's own top, whose only handler focuses the composer and already
      // declines a tap that lands on a control. Nothing with a target of its own is shadowed.
      // It lives inside a `Collapse`, which drops its clip once settled — that is what lets the
      // ::before reach outside the box at all (see ui/collapse.tsx).
      //
      // ── AND NO `border-b`, WHICH IS THE POINT ────────────────────────────────
      // It had one, copied from the tab row, and against the mirror's own unconditional
      // `border-t border-rule` 4px below it that made TWO hairlines 4px apart — the doubled line
      // DESIGN.md §4 forbids, just spaced far enough to look deliberate.
      //
      // The tab row's baseline is not a decoration this bar inherits. It exists because a FOLDER TAB
      // has to own the line it breaks: the active tab covers that baseline for its own width so the
      // tab and the content read as one piece, and the 4px below it is the page the open tab sits
      // on (tab-strip.tsx and agent-chat.tsx state both halves). Fold the rows away and there is no
      // folder tab, nothing is attached to anything, and the obligation goes with it.
      //
      // So the seam between chrome and mirror is drawn once, by the mirror — which is the half that
      // may not move: that `border-t` is unconditional on purpose, one geometry with no state in
      // which the seam is drawn differently. This bar simply stands on the page above it.
      className="relative flex h-6 w-full shrink-0 items-center gap-2 px-4 text-left transition-colors before:absolute before:inset-x-0 before:-inset-y-2.5 before:content-[''] hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {/* The words — the only thing here a screen reader is given. */}
      <span className="sr-only">
        {hiddenLabel(wsTabs.length, paneBeads.length, {
          tabs: tn("space.view.tabCount", wsTabs.length),
          panes: tn("space.view.paneCount", paneBeads.length),
        })}
      </span>

      <span aria-hidden="true" className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        {wsTabs.length > 0 && (
          <span className="flex items-center">
            {wsTabs.map((tab) => (
              <Bead
                key={tab.tabId}
                active={tab.tabId === selectedTabId}
                status={statusOfTab(here, tab.tabId)}
              />
            ))}
          </span>
        )}
        {wsTabs.length > 0 && paneBeads.length > 0 && (
          // The seam between the two groups, in `--border` and not `--rule`: it cuts one control's
          // contents in two, it does not cut two regions apart (DESIGN.md §4).
          <span className="h-3 w-px shrink-0 bg-border" />
        )}
        {paneBeads.length > 0 && (
          <span className="flex items-center">
            {paneBeads.map((pane) => (
              <Bead
                key={pane.paneId}
                active={pane.paneId === currentPaneId}
                status={pane.status}
              />
            ))}
          </span>
        )}
      </span>

      <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** The bead colour for one tab: its worst triage as a status, or null when it holds no agent. */
function statusOfTab(here: AgentView[], tabId: string): AgentStatus | null {
  const worst = worstTriage(here.filter((a) => a.tabId === tabId));
  return worst === null ? null : TRIAGE_STATUS[worst];
}

/**
 * The button's whole accessible name, as one sentence per case rather than a phrase assembled from
 * parts: "3 tabs" is a noun phrase, and dropping one into a sentence template is the translation bug
 * every language with cases hands back. Three keys, three sentences, one each.
 */
function hiddenLabel(tabCount: number, paneCount: number, counts: TemplateVars): string {
  if (tabCount > 0 && paneCount > 0) return t("chat.strips.show.both", counts);
  if (tabCount > 0) return t("chat.strips.show.tabs", counts);
  return t("chat.strips.show.panes", counts);
}

// One bead: a status dot in a fixed 16px box.
//
// THE BOX IS FIXED AND THE RING IS PAINT (DESIGN.md §2). "Which one am I on" has to be visible, and
// the obvious spelling — a bigger dot for the current one — moves every bead to its right each time
// the operator switches. So all beads occupy the same 16px square in every state, the dot inside is
// always 8px, and only two things change: the resting beads dim, and the current one gains a ring
// its box already reserved. `border-transparent` in the base string is the house recipe for that.
function Bead({ active, status }: { active: boolean; status: AgentStatus | null }) {
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
        active ? "border-foreground/30" : "border-transparent",
      )}
    >
      {status === null ? (
        // A tab holding no agent at all. Not idle — idle is a resting agent and this is no agent —
        // so it takes the neutral bead rather than a status colour, the same distinction
        // `worstTriage` draws by returning null.
        <span className="size-2 rounded-full bg-muted-foreground/40" />
      ) : (
        <StatusDot
          status={status}
          // A hollow resting dot is filled with the surface it sits on, and this bar is the page.
          surface="bg-background"
          className={cn("size-2", !active && "opacity-50")}
        />
      )}
    </span>
  );
}
