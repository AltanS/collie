// Pane-access ideas: five ways the pane screen could spend less height on "which pane am I in, and
// how do I get to another one". NONE OF THESE IS SHIPPED. This section is a staging ground for a
// decision, not a picture of the app — which is why every card says "idea, not shipped" where the
// rest of the playground says "reach it for real".
//
// WHAT IS REAL HERE AND WHAT IS NOT. The two strips, the bead bar, the pane pills, the status dots
// and the fold animation are the app's own components on the app's own fixtures (`StripsSummary`,
// `TabStrip`, `PaneStrip`, `StatusDot`, `Collapse`) — an idea that reuses them is measured at the
// height they really are. Everything an idea INVENTS is drawn here and nowhere else: the pane
// header (not extractable from `agent-chat.tsx`, so its structure and classes are copied), the
// breadcrumb list, the beacon pill, the nested row, the composer stand-in and the keyboard block.
// Each card's note says which side of that line it sits on.
//
// THE MIRROR IS THE CONSTANT. Every card shows the same eight lines of the same captured screen
// (`paneWorking`, run through the app's own ANSI parser to drop the colour), at the same width, so
// the only thing that differs between two cards is the chrome above it — which is the whole
// question. The slice is read-only: no scroller, no grammar, no dialog lift.
//
// DEV-ONLY, unreachable from the app entry.

import { useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronUp, EllipsisVertical, TriangleAlert } from "lucide-react";

import { AgentIcon } from "@/components/agent-icon";
import { MIRROR_INVERT, MIRROR_SPACE } from "@/components/mirror-space";
import { PaneStrip } from "@/components/pane-strip";
import { StatusDot } from "@/components/status-badge";
import { StripsSummary } from "@/components/strips-summary";
import { TabStrip } from "@/components/tab-strip";
import { Collapse } from "@/components/ui/collapse";
import { usePinSide } from "@/hooks/use-pin-side";
import { useRevealActive } from "@/hooks/use-reveal-active";
import { parseAnsi } from "@/lib/ansi";
import { lineText, splitLines } from "@/lib/blocks";
import { paneTag } from "@/lib/pane-tag";
import { TRIAGE_ORDER, bucketOf, worstTriage } from "@/lib/triage";
import { paneDisplayName, type AgentView, type TabView } from "@/lib/types";
import { cn } from "@/lib/utils";

import { allPanes, herd, paneWorking, tabs } from "../fixtures";
import { Card, Group, Section, type SectionDef } from "../harness";

export const DEF: SectionDef = {
  id: "ideas",
  title: "Pane access ideas",
  intent:
    "The pane screen spends 111px above the mirror on the tab strip and the pane strip, foldable to a 24px bead bar; zen takes all of it away and the dense layout moves it below the mirror instead. Five other answers, staged side by side over the same eight lines of the same captured screen, so the height each one costs can be read off the cards rather than argued about. Every card states its cost at rest in px, measured from the mock at 390px, and what it costs in taps to reach a sibling pane and the one pane that is blocked. The 111px is measured, and it is not the 94px strips-summary.tsx's own comment quotes: that number counts two 47px rows, and the pane row is 62px because it carries the \"Panes\" label, with 4px of page under the open folder tab on top. None of these is shipped and none is a proposal yet.",
};

// ── The space every card is standing in ──────────────────────────────────────
//
// `sprqvntrs-api` (w2), because it is the only fixture space that has the shape the hardest idea
// needs: three tabs, one of which holds three panes, and a pane in ANOTHER tab that is blocked. So
// "the sibling pane" and "the blocked pane" are two different distances on every card, which is the
// difference the notes are about.

const SPACE_ID = "w2";
const SPACE_LABEL = "sprqvntrs-api";

/** The three tabs of that space, in the snapshot's own order. */
const spaceTabs: TabView[] = tabs.filter((tab) => tab.workspaceId === SPACE_ID);

/** Every pane in the space — agents and shells together, as the strips see them. */
const spacePanes: AgentView[] = allPanes.filter((pane) => pane.workspaceId === SPACE_ID);

/**
 * One pane out of the fixture space, or a loud failure. A `!` here would be a claim about a file
 * this one does not own: the fixtures are edited for other cards, and a card built on a pane that
 * quietly became `undefined` would render a blank header rather than say so.
 */
function fixturePane(match: (pane: AgentView) => boolean, what: string): AgentView {
  const found = spacePanes.find(match);
  if (!found) throw new Error(`playground ideas: no ${what} in ${SPACE_ID}`);
  return found;
}

/** The pane the operator has open: `claude` on `billing-webhooks`, working, waiting on CI. */
const current: AgentView = fixturePane((pane) => pane.paneId === "w2:p2", "pane w2:p2");

/** The three panes that share the open pane's tab, in the order `PaneStrip` draws them. */
const tabPanes: AgentView[] = spacePanes.filter((pane) => pane.tabId === current.tabId);

/** The one pane in this space that is waiting on the operator — it sits in ANOTHER tab. */
const blocked: AgentView = fixturePane((pane) => pane.status === "blocked", "blocked pane");

// ── The mirror slice ─────────────────────────────────────────────────────────

/**
 * Eight lines out of a real capture, with the colour parsed away by the app's own parser rather
 * than by a regex written here. It is text in a `<pre>`, not `AnsiOutput`: the point of these cards
 * is the height of the chrome ABOVE the mirror, and mounting the real renderer would bring its
 * grammars, its dialog lift and its scroll behaviour into a card that has no business driving them.
 */
const MIRROR_SLICE: string = splitLines(parseAnsi(paneWorking.text))
  .slice(46, 54)
  .map((line) => lineText(line).trimEnd())
  .join("\n");

function MirrorSlice() {
  return (
    <pre
      className={cn(
        "m-0 whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-[1.3] [font-variant-ligatures:none]",
        MIRROR_SPACE,
        MIRROR_INVERT,
      )}
    >
      {MIRROR_SLICE}
    </pre>
  );
}

// ── The phone-width mock ─────────────────────────────────────────────────────

/**
 * One card's phone: 390px wide, or the column's width under the "Phone width" toggle, with the
 * header on top, whatever chrome the idea adds under it, and the mirror slice at the bottom. It is
 * a BOX, not a screen — no fixed height, because the height is what the cards are being compared on
 * and a frame that pinned it would hide the answer.
 */
function PhoneMock({ children }: { children: ReactNode }) {
  return (
    <div className="w-[390px] max-w-full overflow-hidden rounded-xl border border-border bg-background">
      {children}
    </div>
  );
}

/**
 * The pane screen's header, MOCKED — `agent-chat.tsx` builds it inline inside a 2,000-line
 * component and there is nothing to import. The structure and the class strings are copied from the
 * identity block there (`data-slot="pane-identity"` / `pane-lines`), so the 60px floor, the 20/4/12
 * line boxes and the badged status dot are the real ones; the back arrow and the ⋮ are inert
 * squares standing in for the shell's own controls.
 *
 * `title` replaces line 1's name run. That is idea 2's whole move, and it is the reason this is a
 * slot rather than a fixed block.
 */
function PaneHeaderMock({ pane, title }: { pane: AgentView; title?: ReactNode }) {
  return (
    <div className="flex min-h-15 items-center gap-2 border-b border-rule bg-background py-1 pl-4 pr-2">
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground"
      >
        <ChevronLeft className="size-5" />
      </span>
      <div className="-mx-1 flex min-h-11 min-w-0 flex-1 items-center rounded-lg px-1 text-left">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2 leading-5">
            <div className="relative shrink-0">
              <AgentIcon agent={pane.agent} className="size-4" />
              <StatusDot
                status={pane.status}
                surface="bg-background"
                className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-background"
              />
            </div>
            {title ?? (
              <>
                <span className="block truncate font-semibold leading-5">
                  {paneDisplayName(pane)}
                </span>
                <span className="shrink-0 font-mono text-[10px] leading-5 text-muted-foreground">
                  {paneTag(pane.paneId)}
                </span>
              </>
            )}
          </div>
          <span className="block truncate font-mono text-[11px] leading-3 text-muted-foreground">
            {pane.cwd}
          </span>
        </div>
      </div>
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground"
      >
        <EllipsisVertical className="size-5" />
      </span>
    </div>
  );
}

/** The composer's top edge, mocked — the beacon has to float above something to be judged. */
function ComposerMock() {
  return (
    <div className="flex items-center gap-2 border-t border-rule bg-background px-3 py-2">
      <div className="flex h-9 min-w-0 flex-1 items-center rounded-2xl border border-border px-3 text-[13px] text-muted-foreground">
        Reply to claude…
      </div>
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
      >
        <ChevronUp className="size-4" />
      </span>
    </div>
  );
}

/** The soft keyboard, as a labelled grey block. Idea 4 is only readable with one on the card. */
function KeyboardMock() {
  return (
    <div className="flex h-[150px] items-center justify-center bg-muted text-[11px] uppercase tracking-wide text-muted-foreground">
      keyboard
    </div>
  );
}

// ── The real strips, wired to nothing ────────────────────────────────────────
//
// Every switcher below is inert: the cards are photographs of a layout, and a tap that navigated
// would need a router, a snapshot and a pane view this section deliberately does not mount.

const inert = () => {};

function RealTabStrip({ trailing }: { trailing?: ReactNode }) {
  return (
    <TabStrip
      workspaceId={SPACE_ID}
      tabs={tabs}
      agents={herd}
      selected={current.tabId}
      onSelect={inert}
      onNewTab={inert}
      allowAll={false}
      trailing={trailing}
    />
  );
}

function RealPaneStrip() {
  return <PaneStrip panes={tabPanes} currentPaneId={current.paneId} onSelect={inert} />;
}

/** The two strips as the pane screen stacks them, including the 4px of page the folder tab sits on. */
function RealStrips({ trailing }: { trailing?: ReactNode }) {
  return (
    <div className="pb-1">
      <RealTabStrip trailing={trailing} />
      <RealPaneStrip />
    </div>
  );
}

function RealBeadBar({ onExpand = inert }: { onExpand?: () => void }) {
  return (
    <StripsSummary
      workspaceId={SPACE_ID}
      tabs={tabs}
      agents={herd}
      selectedTabId={current.tabId}
      panes={tabPanes}
      currentPaneId={current.paneId}
      onExpand={onExpand}
    />
  );
}

/** The fold chevron the tab row pins to its trailing end, drawn the size the real one is drawn. */
function FoldChevron({ onClick = inert }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Hide tabs and panes"
      className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent"
    >
      <ChevronUp className="size-4" />
    </button>
  );
}

// ── Idea 2: the breadcrumb list ──────────────────────────────────────────────

/** Line 1 of the header, as idea 2 rewrites it: the address, and a chevron that opens the list. */
function CrumbTitle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="-mx-1 flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left leading-5 transition-colors hover:bg-accent/40"
    >
      <span className="min-w-0 truncate font-semibold leading-5">
        {SPACE_LABEL}
        <span className="px-1 font-normal text-muted-foreground">›</span>
        {current.tabLabel}
      </span>
      <span className="shrink-0 font-mono text-[10px] leading-5 text-muted-foreground">
        {paneTag(current.paneId)}
      </span>
      <ChevronDown
        aria-hidden="true"
        className={cn(
          "size-4 shrink-0 text-muted-foreground transition-transform",
          open && "rotate-180",
        )}
      />
    </button>
  );
}

/**
 * Every pane in the space, grouped by tab, with the tab that is shouting loudest first and, inside
 * a tab, the pane that is shouting loudest first. The order is `lib/triage.ts`'s own
 * (`worstTriage` / `bucketOf` over `TRIAGE_ORDER`), not a second opinion written here — so the
 * blocked pane leads the list for the same reason it leads the dashboard.
 */
function paneRank(pane: AgentView): number {
  return TRIAGE_ORDER.indexOf(bucketOf(pane));
}

function tabRank(tab: TabView): number {
  const worst = worstTriage(spacePanes.filter((pane) => pane.tabId === tab.tabId));
  return worst === null ? TRIAGE_ORDER.length : TRIAGE_ORDER.indexOf(worst);
}

function crumbGroups(): { tab: TabView; panes: AgentView[] }[] {
  return spaceTabs
    .map((tab) => ({
      tab,
      panes: spacePanes
        .filter((pane) => pane.tabId === tab.tabId)
        .toSorted((a, b) => paneRank(a) - paneRank(b)),
    }))
    .toSorted((a, b) => tabRank(a.tab) - tabRank(b.tab));
}

/** The flat list idea 2 drops under the header. Drawn here; nothing like it exists in the app. */
function CrumbList() {
  return (
    <div className="border-b border-rule bg-background">
      {crumbGroups().map((group, index) => (
        <div key={group.tab.tabId} className={cn(index > 0 && "border-t border-rule")}>
          <p className="px-4 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {group.tab.label}
          </p>
          {group.panes.map((pane) => (
            <button
              key={pane.paneId}
              type="button"
              onClick={inert}
              aria-current={pane.paneId === current.paneId ? "true" : undefined}
              className={cn(
                "flex h-11 w-full items-center gap-2 px-4 text-left text-sm transition-colors hover:bg-accent/40",
                pane.paneId === current.paneId && "bg-accent/60 font-medium",
              )}
            >
              <StatusDot status={pane.status} className="size-2 shrink-0" />
              <AgentIcon agent={pane.agent} className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{paneDisplayName(pane)}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {paneTag(pane.paneId)}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Idea 3: the beacon ───────────────────────────────────────────────────────

/**
 * The pill, on the edge the holding thumb does NOT rest on: `usePinSide` is the real per-device
 * preference for where the fixed pins dock (left by default, the thumb's own side), and this takes
 * the other one, so the beacon never lands under the thumb that is holding the phone.
 */
function Beacon({ count }: { count: number }) {
  const { side } = usePinSide();
  return (
    <button
      type="button"
      onClick={inert}
      className={cn(
        "absolute -top-3 z-10 flex h-7 items-center gap-1.5 rounded-full border border-border bg-background px-2.5 text-[11px] font-medium shadow-md",
        side === "left" ? "right-3" : "left-3",
      )}
    >
      <TriangleAlert aria-hidden="true" className="size-3.5 text-status-blocked" />
      <span>{count} needs you</span>
    </button>
  );
}

// ── Idea 5: one nested row ───────────────────────────────────────────────────

/**
 * Tabs and panes in ONE row: a tab is a pill group, its panes are small pills inside it, and the
 * open pane is the emphasised one. Drawn here — the app has no such control, and this is the idea
 * that would need a real component built before it could be judged on anything but height.
 */
function NestedRow() {
  // The app's own reveal, because a row that starts scrolled away from the pane you are in is not
  // the idea — it is a bug in the mock. `TabStrip` and `PaneStrip` both run this hook; a single
  // nested row would have to run it too, and running it here is what makes the screenshot honest.
  const scrollerRef = useRef<HTMLElement>(null);
  useRevealActive(scrollerRef, current.paneId);
  return (
    <nav
      ref={scrollerRef}
      aria-label="Tabs and panes"
      className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto border-b border-rule px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {spaceTabs.map((tab) => {
        const panes = spacePanes.filter((pane) => pane.tabId === tab.tabId);
        return (
          <span
            key={tab.tabId}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-1",
              tab.tabId === current.tabId
                ? "border-rule bg-muted/60"
                : "border-transparent bg-muted/30",
            )}
          >
            <span className="whitespace-nowrap pl-0.5 text-[11px] font-medium text-muted-foreground">
              {tab.label}
            </span>
            {panes.map((pane) => (
              <button
                key={pane.paneId}
                type="button"
                onClick={inert}
                aria-current={pane.paneId === current.paneId ? "true" : undefined}
                aria-label={`${tab.label} — ${paneDisplayName(pane)}`}
                className={cn(
                  "flex h-6 shrink-0 items-center gap-1 rounded-full px-1.5 font-mono text-[10px] transition-colors",
                  pane.paneId === current.paneId
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-muted-foreground hover:bg-accent",
                )}
              >
                <StatusDot
                  status={pane.status}
                  surface={pane.paneId === current.paneId ? "bg-primary" : "bg-background"}
                  className="size-1.5"
                />
                {paneTag(pane.paneId)}
              </button>
            ))}
          </span>
        );
      })}
    </nav>
  );
}

// ── The cards ────────────────────────────────────────────────────────────────

/** Every card's `reach` line. These are ideas; none of them can be reached. */
const NOT_SHIPPED = "idea, not shipped:";

export function IdeasSection() {
  const [beadsOpen, setBeadsOpen] = useState(false);
  const [crumbOpen, setCrumbOpen] = useState(false);

  return (
    <Section def={DEF}>
      <Group title="1 · Beads at rest, strips on demand">
        <Card
          state="ideas-beads-rest"
          label="at rest: the 24px bead bar, and nothing else"
          reach={`${NOT_SHIPPED} the bead bar already exists (StripsSummary) — what is new is making it the RESTING state rather than the folded one, so the strips are what you opt into.`}
          note="Cost at rest: 24px, measured — the real StripsSummary at its real height, over the real header. Reaching a sibling pane in this tab: 2 taps (bar, then its pill). Reaching the blocked pane, which sits in another tab: 3 taps (bar, tab, pill). The beads say how many and where you are; they do not say the tabs' names, which is the honest cost of folding."
        >
          <PhoneMock>
            <PaneHeaderMock pane={current} />
            <RealBeadBar />
            <MirrorSlice />
          </PhoneMock>
        </Card>

        <Card
          state="ideas-beads-open"
          label="expanded in place: both strips, as they are today"
          reach={`${NOT_SHIPPED} this is today's unfolded state, shown here as the other half of idea 1.`}
          note="Cost while open: 111px, measured — a 45px tab row (44px plus its baseline rule), a 62px pane row (34px pills under the row's own 'Panes' label), and 4px of page under the open folder tab. That is the height the fold buys back, 87px of it, and the number every other idea on this page is compared against. Both strips are the real components on the real fixtures."
        >
          <PhoneMock>
            <PaneHeaderMock pane={current} />
            <RealStrips trailing={<FoldChevron />} />
            <MirrorSlice />
          </PhoneMock>
        </Card>

        <Card
          state="ideas-beads-tap"
          label="the gesture: tap the bar, the strips grow out of it"
          reach={`${NOT_SHIPPED} the two cards above are the two ends of this one — tap the bar, then the chevron, to see the edge between them.`}
          note="The same real Collapse the app folds with (240ms, and it snaps under prefers-reduced-motion), so what you are judging is the app's own movement. The two ends are also separate cards above, because a screenshot has to be able to address one state without tapping anything."
        >
          <PhoneMock>
            <PaneHeaderMock pane={current} />
            <Collapse open={!beadsOpen}>
              {!beadsOpen && <RealBeadBar onExpand={() => setBeadsOpen(true)} />}
            </Collapse>
            <Collapse open={beadsOpen}>
              {beadsOpen && (
                <RealStrips trailing={<FoldChevron onClick={() => setBeadsOpen(false)} />} />
              )}
            </Collapse>
            <MirrorSlice />
          </PhoneMock>
        </Card>
      </Group>

      <Group title="2 · Breadcrumb in the header">
        <Card
          state="ideas-crumb-rest"
          label="at rest: no strip at all, one chevron on the address"
          reach={`${NOT_SHIPPED} the header shows the pane's name today; this replaces that run with the whole address and hangs the switcher off it.`}
          note="Cost at rest: 0px beyond the header — the chevron rides inside line 1's existing 20px line box, and the header's 60px floor is unchanged. The cost is paid in the header's WIDTH instead: space › tab eats the room the pane's own name had, so on a 390px phone the tab name is what truncates."
        >
          <PhoneMock>
            <PaneHeaderMock
              pane={current}
              title={<CrumbTitle open={false} onToggle={inert} />}
            />
            <MirrorSlice />
          </PhoneMock>
        </Card>

        <Card
          state="ideas-crumb-open"
          label="open: every pane in the space, grouped by tab, blocked first"
          reach={`${NOT_SHIPPED} nothing in the app draws this list — it is mocked here, over the real fixtures and the real triage order.`}
          note="Cost while open: 292px, measured — five pane rows at 44px, three tab captions, two hairlines. It covers the mirror rather than pushing it, which is the trade: the list is transient, so it may be tall. Reaching ANY pane in the space, blocked or not: 2 taps. That is the only idea here where the blocked pane and a sibling cost the same, because the list is ordered by lib/triage.ts and the blocked one leads it."
        >
          <PhoneMock>
            <PaneHeaderMock pane={current} title={<CrumbTitle open onToggle={inert} />} />
            <CrumbList />
            <MirrorSlice />
          </PhoneMock>
        </Card>

        <Card
          state="ideas-crumb-tap"
          label="the gesture: tap the address, the list drops"
          reach={`${NOT_SHIPPED} tap the address line to open and close the list.`}
          note="Same real Collapse as idea 1, so the drop is the app's own 240ms. Both ends are separate cards above for the same reason."
        >
          <PhoneMock>
            <PaneHeaderMock
              pane={current}
              title={<CrumbTitle open={crumbOpen} onToggle={() => setCrumbOpen((was) => !was)} />}
            />
            <Collapse open={crumbOpen}>{crumbOpen && <CrumbList />}</Collapse>
            <MirrorSlice />
          </PhoneMock>
        </Card>
      </Group>

      <Group title="3 · Needs-you beacon">
        <Card
          state="ideas-beacon"
          label="one sibling is blocked: a pill above the composer's far edge"
          reach={`${NOT_SHIPPED} the pill is drawn here; only the thumb-side preference behind it (usePinSide) is the app's own.`}
          note="Cost at rest: 0px — the pill floats over the mirror's bottom edge and takes no row of its own. Reaching the blocked pane: 1 tap, the cheapest on this page. Reaching a sibling that is NOT blocked: impossible from here — this idea answers one question only, and every other switch falls back to the header or the dashboard. It docks opposite usePinSide's pin edge, so it never lands under the holding thumb."
        >
          <PhoneMock>
            <PaneHeaderMock pane={current} />
            <MirrorSlice />
            <div className="relative">
              <Beacon count={1} />
              <ComposerMock />
            </div>
          </PhoneMock>
        </Card>

        <Card
          state="ideas-beacon-quiet"
          label="nothing is blocked: the pill is absent"
          reach={`${NOT_SHIPPED} the quiet half of idea 3 — which is most of the day.`}
          note={`Cost at rest: 0px, and here that is literal — there is no control on the screen at all, and the chrome above the mirror is the header alone. Whether that is calm or disorienting is the question this card is asking. The blocked pane (${paneDisplayName(blocked)} on ${blocked.tabLabel}) is still blocked; nothing on this screen says so.`}
        >
          <PhoneMock>
            <PaneHeaderMock pane={current} />
            <MirrorSlice />
            <ComposerMock />
          </PhoneMock>
        </Card>
      </Group>

      <Group title="4 · Auto-fold on keyboard">
        <Card
          state="ideas-autofold-closed"
          label="keyboard closed: today's two strips, unchanged"
          reach={`${NOT_SHIPPED} today the fold is a tap and it stays where you left it; this makes the keyboard decide.`}
          note="Cost with the keyboard closed: 111px, the same as idea 1's open card — because it IS that card. The claim is that this height is affordable when the mirror has the whole screen, and only becomes expensive when the keyboard takes 45% of it."
        >
          <PhoneMock>
            <PaneHeaderMock pane={current} />
            <RealStrips trailing={<FoldChevron />} />
            <MirrorSlice />
            <ComposerMock />
          </PhoneMock>
        </Card>

        <Card
          state="ideas-autofold-open"
          label="keyboard open: the strips fold themselves to the bead bar"
          reach={`${NOT_SHIPPED} the fold is the app's own; what is new is the keyboard driving it. The grey block is a stand-in for the soft keyboard.`}
          note="Cost with the keyboard open: 24px, so the fold hands 87px back to the mirror exactly when the mirror has least. Reaching a sibling pane while typing: 2 taps, and the second one dismisses the keyboard — which is the objection: a rule that moves the chrome under your thumb while you type is a rule you cannot predict. The two states are two cards rather than a toggle because the driver is the keyboard, not a tap."
        >
          <PhoneMock>
            <PaneHeaderMock pane={current} />
            <RealBeadBar />
            <MirrorSlice />
            <ComposerMock />
            <KeyboardMock />
          </PhoneMock>
        </Card>
      </Group>

      <Group title="5 · One nested row">
        <Card
          state="ideas-nested"
          label="tabs and panes in one row: a pill group per tab, pane pills inside it"
          reach={`${NOT_SHIPPED} drawn here and nowhere else — this is the only idea on the page that would need a new component built before it could be judged on anything but height.`}
          note="Cost at rest: 44px, measured — one row instead of two, 67px less than today's 111px and 20px more than the bead bar. Reaching a sibling pane: 1 tap. Reaching the blocked pane in another tab: 1 tap, because its pill is already on the row. The breaking point is visible on this card: three tabs, one of them holding three panes, and the row already scrolls at 390px — the pane pills are reduced to their pN tag, so 'which agent' is a dot and a two-character id rather than a name."
        >
          <PhoneMock>
            <PaneHeaderMock pane={current} />
            <NestedRow />
            <MirrorSlice />
          </PhoneMock>
        </Card>
      </Group>
    </Section>
  );
}
