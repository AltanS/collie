// Compact strip ideas: FIVE numbered options for the tab row and the pane row under the pane
// header, plus the unnumbered "as today" card they are measured against. Altan's ask, from the
// phone: the tab row and the pane row under the pane header "feel too tall and the fonts too
// large". This section exists so he can say "option N" and be understood, the same pattern
// `header-corner.tsx` and `header-meta.tsx` already use.
//
// WHAT IS REAL AND WHAT IS DRAWN. Every card here is DRAWN, not mounted: the two rows this section
// compares are `components/tab-strip.tsx` and `components/pane-strip.tsx`, and no prop on either
// lets a caller shrink its height or its type size — the geometry is baked into each file's own
// class string. So every pill below is a copy of that class string, held constant except for the
// one thing an option changes (row height, padding, font size), which is the only way six cards
// can be read as one comparison rather than six unrelated screenshots. `reach` on each card says so
// plainly: shrinking a row for real means editing `tab-strip.tsx` / `pane-strip.tsx` themselves.
//
// THE FIXTURE. Two tabs — `work` (active) and `tab 2` (its neighbour, muted, unremarkable) — and two
// panes on the open tab — `daily fact checks and fixes` (selected) and `investigation`. The same
// pair on every card, so height and type size are the only variables in view.
//
// DEV-ONLY, unreachable from the app entry.

import type { ReactNode } from "react";
import { ChevronUp, Plus } from "lucide-react";

import { STRIP_TAP_TARGET_SQUARE } from "@/components/ui/labelled-strip";
import { cn } from "@/lib/utils";

import { Card, Group, Section, type SectionDef } from "../harness";
import { PhoneMock } from "./shared";

export const DEF: SectionDef = {
  id: "strips-compact",
  title: "Compact strips",
  intent:
    "Five numbered options for the pane screen's tab row and pane row, which read as too tall and " +
    "too large today. The tab row and the pane pills under it are drawn here, held to the same two " +
    "tabs and two panes on every card, with only height, padding and type size changing between " +
    "them. Say the number.",
};

// ── The fixture every card stands on ─────────────────────────────────────────

const TAB_ACTIVE = "work";
const TAB_OTHER = "tab 2";
const PANE_SELECTED = "daily fact checks and fixes";
const PANE_OTHER = "investigation";

/** A stand-in for the bottom of the pane header, drawn only for context — this section is not about
 *  the header itself, so it carries no corner and no meta, just the line the strips sit under. */
function HeaderEdge() {
  return (
    <div className="flex min-h-15 flex-col justify-center gap-1 border-b border-rule bg-background px-3 py-2">
      <span className="truncate text-sm font-semibold leading-5 text-foreground">
        collie-workspace › UI work
      </span>
      <span className="truncate font-mono text-[11px] leading-3 text-muted-foreground">
        ~/projects/collie-workspace
      </span>
    </div>
  );
}

/** The "+" new-tab button, copied from `tab-strip.tsx`'s own — every option keeps it, since it is
 *  not the fault under review. */
function NewTabButton() {
  return (
    <span
      aria-hidden
      className={cn(
        STRIP_TAP_TARGET_SQUARE,
        "flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground",
      )}
    >
      <Plus className="size-4" />
    </span>
  );
}

/** The fold chevron pinned at the tab row's trailing end, copied from the pane screen's own control
 *  (`tab-strip.tsx`'s `trailing` slot, drawn open here as `agent-chat.tsx` wires it today). */
function FoldChevron() {
  return (
    <span
      aria-hidden
      className={cn(
        STRIP_TAP_TARGET_SQUARE,
        "flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground",
      )}
    >
      <ChevronUp className="size-4" />
    </span>
  );
}

// ── The tab row, one shape parametrised by size ──────────────────────────────

interface TabRowSizing {
  /** The row's own height class, e.g. `h-11`. */
  rowH: string;
  /** The label's type size, e.g. `text-sm`. */
  text: string;
}

/** One folder tab, `tab-strip.tsx`'s `Tab` with its geometry pulled out to props. The border and the
 *  cover-strip trick are unchanged — only the box they draw at, and the type they carry, move. */
function TabPill({
  label,
  active,
  sizing,
}: {
  label: string;
  active: boolean;
  sizing: TabRowSizing;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-t-md border border-b-0 border-transparent px-3 font-medium after:absolute after:inset-x-0 after:-bottom-px after:h-px after:content-['']",
        sizing.rowH,
        sizing.text,
        active
          ? "border-rule bg-background text-foreground after:bg-background"
          : "bg-muted/40 text-muted-foreground after:bg-transparent",
      )}
    >
      {label}
    </span>
  );
}

/** The tab row, `tab-strip.tsx`'s `<nav>` with the same baseline rule and the same two trailing
 *  controls, at whatever size `sizing` names. */
function TabsRow({ sizing }: { sizing: TabRowSizing }) {
  return (
    <nav aria-label="Tabs" className="flex shrink-0 items-stretch gap-2 border-b border-rule px-4">
      <div className="-mb-px flex min-w-0 flex-1 items-start gap-1 overflow-x-auto pb-px [scrollbar-width:none]">
        <TabPill label={TAB_ACTIVE} active sizing={sizing} />
        <TabPill label={TAB_OTHER} active={false} sizing={sizing} />
        <span className="flex shrink-0 self-center">
          <NewTabButton />
        </span>
      </div>
      <span className="flex shrink-0 items-center self-center pl-1">
        <FoldChevron />
      </span>
    </nav>
  );
}

// ── Option 2's tab row, redrawn to match what actually shipped ───────────────
//
// The compact height shipped as option 2 said, but the shape did not stay a folder tab — Altan,
// from the phone, once he saw it small: "the top tabs area has a lot of weird lines now. Completely
// remove horizontal borders and just have vertical ones for tab items." `tab-strip.tsx` now draws no
// border-b/border-t of its own and sits on `bg-chrome`. The vertical hairline that first reply
// shipped (`divide-x divide-border`) came out again a step later — Altan, once the open cell got its
// own box: "the border left is weird, I'd prefer a full border on the item" — so cells now separate
// with a plain gap, and the open cell is an outlined pill: `rounded-md border-border bg-background`.
// This card is the only one in the section redrawn to match — the others are frozen ideas at their
// own height, never shipped, and stay as they were when the operator compared them.

function ShippedTabPill({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-8 shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md border my-px px-3 text-[11px] font-medium",
        active ? "border-border bg-background text-foreground" : "border-transparent text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

function ShippedTabsRow() {
  return (
    <nav aria-label="Tabs" className="flex shrink-0 items-stretch gap-1 bg-chrome px-4">
      <div className="flex min-w-0 flex-1 items-start gap-1 overflow-x-auto pt-1.5 pb-1.5 [scrollbar-width:none]">
        <div className="flex shrink-0 items-stretch gap-1">
          <ShippedTabPill label={TAB_ACTIVE} active />
          <ShippedTabPill label={TAB_OTHER} active={false} />
        </div>
        <span className="flex shrink-0 self-center">
          <NewTabButton />
        </span>
      </div>
      <span className="flex shrink-0 items-center self-center pl-1">
        <FoldChevron />
      </span>
    </nav>
  );
}

// ── The pane row, the ordinary shape (options 0, 1, 2, 5) ────────────────────

interface PaneRowSizing {
  /** The pill's own vertical padding, e.g. `py-1.5`. */
  pad: string;
  /** The label's type size, e.g. `text-sm`. */
  text: string;
}

function PanePill({
  label,
  active,
  sizing,
}: {
  label: string;
  active: boolean;
  sizing: PaneRowSizing;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 select-none items-center whitespace-nowrap rounded-md border border-transparent px-2.5 font-medium",
        sizing.pad,
        sizing.text,
        active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

/** The pane row, `pane-strip.tsx`'s scroller with `LabelledStrip`'s own edge-to-edge gutter, at
 *  whatever size `sizing` names. */
function PaneRow({ sizing }: { sizing: PaneRowSizing }) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto px-4 py-1.5 [scrollbar-width:none]">
      <PanePill label={PANE_SELECTED} active sizing={sizing} />
      <PanePill label={PANE_OTHER} active={false} sizing={sizing} />
    </div>
  );
}

// ── Option 3's pane row: a line of names, no ground but on the open one ──────

function QuietPaneRow() {
  return (
    <div className="flex items-center gap-3 overflow-x-auto px-4 py-1 text-xs [scrollbar-width:none]">
      <span
        aria-hidden
        className="shrink-0 select-none whitespace-nowrap rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground"
      >
        {PANE_SELECTED}
      </span>
      <span aria-hidden className="shrink-0 select-none whitespace-nowrap font-medium text-muted-foreground">
        {PANE_OTHER}
      </span>
    </div>
  );
}

// ── Option 4's merged row: tabs, a hairline, then the open tab's panes ───────

function MergedRow() {
  return (
    <nav
      aria-label="Tabs and panes"
      className="flex h-9 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-rule px-4 text-xs [scrollbar-width:none]"
    >
      <span
        aria-hidden
        className="shrink-0 select-none whitespace-nowrap rounded-md bg-background px-2 py-1 font-medium text-foreground"
      >
        {TAB_ACTIVE}
      </span>
      <span aria-hidden className="shrink-0 select-none whitespace-nowrap px-2 py-1 font-medium text-muted-foreground">
        {TAB_OTHER}
      </span>
      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
      <span
        aria-hidden
        className="shrink-0 select-none whitespace-nowrap rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground"
      >
        {PANE_SELECTED}
      </span>
      <span aria-hidden className="shrink-0 select-none whitespace-nowrap rounded-md bg-muted px-2 py-1 font-medium text-muted-foreground">
        {PANE_OTHER}
      </span>
    </nav>
  );
}

// ── One card's mock: the header edge, then whatever rows the option draws ────

function StripsMock({ children }: { children: ReactNode }) {
  return <PhoneMock>{children}</PhoneMock>;
}

// ── The cards ────────────────────────────────────────────────────────────────

const AS_TODAY: TabRowSizing = { rowH: "h-11", text: "text-sm" };
const AS_TODAY_PANE: PaneRowSizing = { pad: "py-1.5", text: "text-sm" };

export function StripsCompactSection() {
  return (
    <Section def={DEF}>
      <Group title="The tab row and the pane row — as today, then five options">
        <Card
          state="strips-compact-as-today"
          label="As today"
          reach="every pane screen: the tab row under the header, the pane row under that."
          note="Tab row 44px, `text-sm`. Pane pills 34px drawn (`py-1.5`), `text-sm`. This is the pair the five options below are measured against."
        >
          <StripsMock>
            <HeaderEdge />
            <TabsRow sizing={AS_TODAY} />
            <PaneRow sizing={AS_TODAY_PANE} />
          </StripsMock>
        </Card>

        <Card
          state="strips-compact-option-1"
          label="Option 1 · Both rows one step smaller"
          reach="idea, not shipped: tab-strip.tsx's `h-11` and pane-strip.tsx's `py-1.5` would both move."
          note="Tab row 36px, pane pills 28px. Fonts 12px. The tap target stays 44px through the invisible reach the belt pills already use."
        >
          <StripsMock>
            <HeaderEdge />
            <TabsRow sizing={{ rowH: "h-9", text: "text-xs" }} />
            <PaneRow sizing={{ pad: "py-1", text: "text-xs" }} />
          </StripsMock>
        </Card>

        <Card
          state="strips-compact-option-2"
          label="Option 2 · Two steps smaller"
          reach="idea, not shipped: the same two files, taken one step further."
          note="Shipped. Tab row 32px, pane pills 24px. Fonts 11px, the size of the header's path line. Tightest that still reads. The tab row is redrawn here to match what actually shipped: no horizontal rule, cells separated by a vertical hairline, the open one marked by ground alone."
        >
          <StripsMock>
            <HeaderEdge />
            <ShippedTabsRow />
            <PaneRow sizing={{ pad: "py-0.5", text: "text-[11px]" }} />
          </StripsMock>
        </Card>

        <Card
          state="strips-compact-option-3"
          label="Option 3 · Tabs as today, panes compact"
          reach="idea, not shipped: only pane-strip.tsx would change; tab-strip.tsx stays untouched."
          note="The tab row keeps its size. The pane row becomes a line of names, 28px tall, and only the open pane has a ground."
        >
          <StripsMock>
            <HeaderEdge />
            <TabsRow sizing={AS_TODAY} />
            <QuietPaneRow />
          </StripsMock>
        </Card>

        <Card
          state="strips-compact-option-4"
          label="Option 4 · One row"
          reach="idea, not shipped: this one merges the two components into a single scroller, the bigger change of the five."
          note="Tabs and panes share one 36px row. A hairline separates them. Saves a whole row, and the tab strip scrolls with the panes."
        >
          <StripsMock>
            <HeaderEdge />
            <MergedRow />
          </StripsMock>
        </Card>

        <Card
          state="strips-compact-option-5"
          label="Option 5 · Smaller fonts, same heights"
          reach="idea, not shipped: only the two files' type-size classes would move."
          note="Only the fonts shrink to 12px. Row heights stay, so nothing else moves."
        >
          <StripsMock>
            <HeaderEdge />
            <TabsRow sizing={{ rowH: "h-11", text: "text-xs" }} />
            <PaneRow sizing={{ pad: "py-1.5", text: "text-xs" }} />
          </StripsMock>
        </Card>
      </Group>
    </Section>
  );
}
