// Pane marker ideas: six numbered options for saying WHAT KIND OF THING you are looking at.
//
// THE COMPLAINT, in Altan's words from his phone: "what's confusing to me still is that the panes
// are not all clearly indicated as such? maybe we need a clearer indication of what I'm looking at
// or sth. panes title?"
//
// Read it as a KIND problem, not a name problem. Since the one-name rule landed (lib/pane-name.ts)
// every screen names a pane the same way — line 1 is what it is CALLED, line 2 is WHERE it sits —
// and that rule is working. What no screen says is what the thing IS. A dashboard row, a tab chip, a
// space card and a pane pill are all a name over a place, so the reader has to know the hierarchy
// (space › tab › pane) before the screen means anything. The six options below each name the level
// somewhere different: on the row, on the name, on the place, on the grouping, on the strip, or on
// the app bar.
//
// EVERY CARD SHOWS BOTH SURFACES, stacked in one phone box: the DASHBOARD ROW on top, the PANE
// SCREEN HEADER under it. A marker that reads well in one place and badly in the other is the whole
// risk here, and a card that showed one of them would hide it.
//
// WHAT IS REAL AND WHAT IS DRAWN. `AgentIcon`, `StatusDot`, `PaneMeta`, `SectionLabel`,
// `ListGroup`, `PaneStrip`, `CollieHome`, the whole `AgentCard` on option 6 and the whole
// `AgentList` on option 4 — which SHIPPED — are the app's own components, inside a real
// `CrewProvider` over `rosterFive`, so the host tint, the cache countdown and the hide rules are
// the real ones. DRAWN HERE are the two ROWS
// themselves wherever an option adds something INSIDE them: `RouteHeader` portals into the one
// hoisted header shell (`app-header.tsx`) and cannot be mounted in a card, and `AgentCard` has no
// prop for an eyebrow, a leading glyph, a third crumb or a trailing chip. Each card's `reach` line
// says which side of that line it sits on.
//
// THE MACHINE IS `lodge`, the `rosterFive` lead, so the host tag carries a real identity tint.
//
// DEV-ONLY, unreachable from the app entry.

import type { ReactNode } from "react";
import { EllipsisVertical, PanelTop } from "lucide-react";

import { AgentCard } from "@/components/agent-card";
import { AgentIcon } from "@/components/agent-icon";
import { AgentList } from "@/components/agent-list";
import { CollieHome } from "@/components/collie-home";
import { CrewProvider } from "@/components/crew-provider";
import { PaneMeta } from "@/components/pane-meta";
import { PaneStrip } from "@/components/pane-strip";
import { StatusDot } from "@/components/status-badge";
import { ListGroup } from "@/components/ui/list-group";
import { SectionLabel } from "@/components/ui/section-label";
import { STRIP_TAP_TARGET } from "@/components/ui/labelled-strip";
import { paneName, panePlaceParts } from "@/lib/pane-name";
import { statusLabel, type AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";

import { cacheNow, paneCache, rosterFive, TS } from "../fixtures";
import { Card, Group, Section, type SectionDef } from "../harness";
import { PhoneMock } from "./shared";

export const DEF: SectionDef = {
  id: "pane-marker",
  title: "Pane marker ideas",
  intent:
    "Six numbered options for saying that the thing on screen IS a pane — a terminal pane inside a tab, not a tab, a space or a session. The one-name rule already gives every surface the same name on line 1 and the same place on line 2; what it does not give is the KIND, so a row and a header read as a name over an address and the reader has to already know the hierarchy. Each card shows the same pane twice in one phone box, the dashboard row over the pane header, because a marker that works on one surface and not the other is the failure to look for. Say the number.",
};

// ── The fixture every card stands on ─────────────────────────────────────────

const MIN = 60_000;
const HOST = "lodge";

/** A card is a photograph: every callback on it does nothing. */
const inert = () => {};

/**
 * The pane every card draws: named by its Claude `/rename` session name, sitting in the second tab
 * of one space, on the crew's lead. One warm cache reading, so the header's trailing meta has
 * something to say and the row's corner is not an empty box.
 */
const PANE: AgentView = {
  paneId: "w1:p2",
  workspaceId: "w1",
  workspaceLabel: "collie-workspace",
  workspaceNumber: 1,
  tabId: "w1:t1",
  tabLabel: "UI work",
  agent: "claude",
  status: "working",
  cwd: "/home/you/src/collie-workspace",
  focused: false,
  hasSession: true,
  sessionName: "Collie playground sync check",
  host: HOST,
  lastActiveAt: TS - 3 * MIN,
  lastSeenAt: TS - 12 * MIN,
  readableLines: 400,
  cache: paneCache({ state: "warm", expiresAt: cacheNow + 58 * MIN + 30_000 }),
};

/** Its two neighbours in the same tab — what makes "pane 2 of 3", a group of three, and a switcher
 *  with something to switch between. Option 3's ordinal and option 5's count both count THESE. */
const SIBLINGS: readonly AgentView[] = [
  {
    ...PANE,
    paneId: "w1:p1",
    sessionName: undefined,
    paneLabel: "docs pass",
    status: "idle",
    cache: undefined,
    lastActiveAt: TS - 40 * MIN,
  },
  PANE,
  {
    ...PANE,
    paneId: "w1:p3",
    sessionName: undefined,
    paneLabel: "logs",
    agent: "shell",
    kind: "shell",
    status: "unknown",
    cache: undefined,
    lastActiveAt: TS - 2 * MIN,
  },
];

/** The same three, split the way the dashboard route hands them over: agents, then bare shells. */
const AGENT_SIBLINGS: readonly AgentView[] = SIBLINGS.filter((p) => p.kind !== "shell");
const SHELL_SIBLINGS: readonly AgentView[] = SIBLINGS.filter((p) => p.kind === "shell");

const NAME = paneName(PANE);
const PLACE = panePlaceParts(PANE);
/** `collie-workspace › UI work`, joined — the header renders the place as one run of text. */
const PLACE_LINE = `${PLACE.space} › ${PLACE.tab ?? ""}`;

function Crew({ children }: { children: ReactNode }) {
  return (
    <CrewProvider servers={rosterFive} ts={TS} pollMs={3_000}>
      {children}
    </CrewProvider>
  );
}

// ── The two surfaces, drawn ──────────────────────────────────────────────────

/** The small grey word that says which surface the box below it is. Card chrome, not app chrome. */
function Surface({ children }: { children: ReactNode }) {
  return (
    <p className="bg-muted/40 px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

/** One phone box holding both surfaces, in the order the operator meets them. */
function BothSurfaces({ row, header }: { row: ReactNode; header: ReactNode }) {
  return (
    <PhoneMock>
      <Surface>dashboard</Surface>
      <div className="px-4 py-3">{row}</div>
      <Surface>pane screen</Surface>
      {header}
    </PhoneMock>
  );
}

/**
 * The dashboard row, as `agent-card.tsx` draws it in its FLAT density with a status dot — the
 * treatment every non-attention section of the home list uses. Drawn here rather than mounted
 * because `AgentCard` has no prop for an eyebrow, a leading glyph, a third crumb or a trailing chip,
 * and may not grow one for this page. The class strings are copied from that file; the tile, the dot
 * and the trailing meta inside it are the real components.
 *
 * `eyebrow` puts a line above line 1 (option 1). `nameLead` puts a mark before the tile (option 2).
 * `place` replaces line 2's text (option 3). `trailing` adds a chip before the meta column (option 5).
 */
function RowShell({
  eyebrow,
  nameLead,
  place,
  trailing,
}: {
  eyebrow?: ReactNode;
  nameLead?: ReactNode;
  place?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <ListGroup>
      <div className="flex w-full flex-row items-center gap-3 px-3.5 py-2.5 text-left">
        <div className="min-w-0 flex-1">
          {eyebrow}
          <div className="flex min-w-0 items-center gap-2">
            <StatusDot status={PANE.status} surface="bg-background" />
            {nameLead}
            <AgentIcon agent={PANE.agent} className="size-4" />
            <span className="min-w-0 flex-1 truncate font-medium">{NAME}</span>
          </div>
          <div className="flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground">
            {place ?? (
              <>
                <span className="min-w-0 shrink truncate">{PLACE.space}</span>
                <span className="shrink-0 text-muted-foreground/60" aria-hidden>
                  ›
                </span>
                <span className="min-w-0 flex-1 truncate">{PLACE.tab}</span>
              </>
            )}
          </div>
        </div>
        {trailing}
        <PaneMeta host={PANE.host} cache={PANE.cache} />
        <span className="sr-only">{statusLabel(PANE.status)}</span>
      </div>
    </ListGroup>
  );
}

/** The ⋮, exactly as `agent-chat.tsx` draws it: its own 44px column, `self-stretch`, a real target. */
function Kebab() {
  return (
    <button
      type="button"
      onClick={inert}
      aria-label="Pane menu"
      className="grid min-h-11 w-11 shrink-0 place-items-center self-stretch rounded-md text-muted-foreground transition-colors active:bg-muted/60 active:text-foreground"
    >
      <EllipsisVertical className="size-5" />
    </button>
  );
}

/**
 * The pane screen's header row, as `agent-chat.tsx` composes it into `RouteHeader`: the 60px floor
 * (`min-h-15`), the identity block — the agent's 16px mark with the status dot badged on it, the
 * pane's name on line 1, its place on line 2 with the host and the cache reading at that line's end
 * — and the ⋮ in its own 44px column. `RouteHeader` portals into the one hoisted header shell and
 * cannot be mounted in a card, so the ROW is drawn with its class strings copied from that file;
 * everything inside it is the app's own component.
 *
 * `lead` puts something at the very start of the row, in the slot the dashboard's wordmark occupies
 * (option 6). `eyebrow`, `nameLead` and `place` are the header's twins of {@link RowShell}'s.
 */
function HeaderRow({
  lead,
  eyebrow,
  nameLead,
  place,
}: {
  lead?: ReactNode;
  eyebrow?: ReactNode;
  nameLead?: ReactNode;
  place?: ReactNode;
}) {
  return (
    <div className="flex min-h-15 items-center gap-2 border-b border-rule bg-background py-1 pl-4 pr-2">
      {lead}
      <div className="relative -mx-1 flex min-h-11 min-w-0 flex-1 items-center rounded-lg px-1 text-left">
        <div className="relative flex min-w-0 flex-1 flex-col gap-1">
          {eyebrow}
          <div className="flex min-w-0 items-center gap-2 leading-5">
            {nameLead}
            <div className="relative shrink-0">
              <AgentIcon agent={PANE.agent} className="size-4" />
              <StatusDot
                status={PANE.status}
                label={statusLabel(PANE.status)}
                live
                surface="bg-background"
                className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-background"
              />
            </div>
            <span className="block truncate font-semibold leading-5">{NAME}</span>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-[11px] leading-3 text-muted-foreground">
              {place ?? PLACE_LINE}
            </span>
            <PaneMeta
              layout="inline"
              host={PANE.host}
              cache={PANE.cache}
              onOpenCache={inert}
              className="ml-auto"
            />
          </div>
        </div>
      </div>
      <Kebab />
    </div>
  );
}

// ── The pieces the options add ───────────────────────────────────────────────

/**
 * Option 1's kicker. The REAL `SectionLabel` at its `above` placement — the app's own 10px uppercase
 * tracked tier (DESIGN.md §1: the primitive exists, so this is not a new type style) — with its
 * `mb-1` dropped, because both rows already state their own gap between lines.
 */
function KindEyebrow() {
  return (
    <SectionLabel placement="above" className="mb-0">
      Pane
    </SectionLabel>
  );
}

/**
 * Option 2's and option 5's mark. `PanelTop` and deliberately NOT `SquareTerminal` or
 * `TerminalSquare`: the terminal-in-a-box glyph is already spoken for — `agent-card.tsx`,
 * `pane-strip.tsx` and the pane header all wear it as the tile of a SHELL pane, so reusing it as
 * "this is a pane" would make every agent pane look like a shell one. `PanelTop` is a rectangle with
 * a bar across its top, which is what a mux pane looks like on a real screen.
 */
function KindGlyph({ className }: { className?: string }) {
  return <PanelTop className={cn("size-4 shrink-0 text-muted-foreground", className)} aria-hidden />;
}

// ── The cards ────────────────────────────────────────────────────────────────

export function PaneMarkerSection() {
  // NO STATE, deliberately: every card has to be addressable by a screenshot without tapping
  // anything first, so nothing here toggles and nothing here animates.
  return (
    <Section def={DEF}>
      <Group title="Before — the two surfaces as they ship today">
        <Card
          state="pane-marker-today"
          label="before: a name over a place, on both surfaces"
          reach="open the dashboard, then tap any row."
          note="The one-name rule as it stands. Line 1 is what the pane is CALLED and line 2 is WHERE it sits, on the row and in the header alike, which is the consistency the rule was built for. Read it as a stranger would: nothing on either surface says the word pane. The row could be a tab, a saved session or a project; the header could be a document. The place is the only hint, and it is a hint only if you already know that a space contains tabs and a tab contains panes. Every option below adds one marker and changes nothing else. OPTION 4 SHIPPED: the dashboard now groups by place, so this card is the BEFORE picture for the row, not the list it sits in. The pane header is unchanged and is still today's."
        >
          <Crew>
            <BothSurfaces row={<RowShell />} header={<HeaderRow />} />
          </Crew>
        </Card>
      </Group>

      <Group title="The six markers — options 1 to 6">
        <Card
          state="pane-marker-eyebrow"
          label="Option 1 · a PANE kicker over line 1"
          reach="idea, not shipped: both rows are drawn here; the kicker is the real SectionLabel and the tile, the dot and the trailing meta are the app's own."
          note="The plainest possible answer: a 10px uppercase word above the name, on the row and in the header. It uses the type tier the app already has (SectionLabel at its `above` placement, the same tier the header's own Collie eyebrow wears), so it introduces no new style and reads as a label rather than as content. The cost is height, and it is charged twice: about 12px on every dashboard row, which on a list of eighteen is a screen and a half, and 12px in the header — where the block is currently 20 + 4 + 12 = 36px inside a 44px floor, so the eyebrow pushes it to 48px and the header grows past its min-h-15. That is a layout change, not a state change, so DESIGN.md §2 is intact; the question is whether one word is worth a row of the mirror. The other cost is repetition: on a list where every row says PANE, the word is wallpaper by the third row."
        >
          <Crew>
            <BothSurfaces
              row={<RowShell eyebrow={<KindEyebrow />} />}
              header={<HeaderRow eyebrow={<KindEyebrow />} />}
            />
          </Crew>
        </Card>

        <Card
          state="pane-marker-glyph"
          label="Option 2 · a pane glyph leading the name"
          reach="idea, not shipped: both rows are drawn here; the glyph is lucide's PanelTop and everything beside it is the app's own."
          note="A 16px mark at the head of line 1, the same size as the harness tile, which stays. Costs no height at all on either surface, which is the whole argument for it. Two risks. First, line 1 now carries three marks before the first letter — the status dot, the kind glyph and the Claude tile — and the pane's own name starts about 24px further right on a 390px row; the name is the one run that may not be squeezed. Second, the glyph has to be learned, and a mark that means kind sitting beside a mark that means agent and a mark that means status is three vocabularies on one line. NOT SquareTerminal or TerminalSquare, and that is not a preference: those already mean SHELL PANE in agent-card.tsx, pane-strip.tsx and the header, so reusing one would make every agent pane read as a shell."
        >
          <Crew>
            <BothSurfaces
              row={<RowShell nameLead={<KindGlyph />} />}
              header={<HeaderRow nameLead={<KindGlyph />} />}
            />
          </Crew>
        </Card>

        <Card
          state="pane-marker-breadcrumb"
          label="Option 3 · line 2 becomes a trail that ends in the pane"
          reach="idea, not shipped: both rows are drawn here; the third crumb has no source in lib/pane-name.ts yet."
          note="`collie-workspace › UI work › pane 2 of 3`. The marker is not a label bolted on — it is the place line finishing its own sentence, so the reader learns the hierarchy (space › tab › pane) from the screen instead of bringing it. It costs no height, and it names the level in words rather than in a glyph. Two costs. Line 2 is already the truncating line, and a third crumb makes the tab name give way sooner on a 390px phone — the ordinal would have to be flex-none and the tab the one that clips. And the number is ALWAYS shown here, which is a deliberate break with lib/pane-ordinal.ts: the pane strip prints a position only when a neighbour would read identically, on the argument that a number nobody needs is noise. Shipping this means deciding that the ordinal is part of the address rather than a tie-breaker, and teaching panePlaceParts a third part."
        >
          <Crew>
            <BothSurfaces
              row={
                <RowShell
                  place={
                    <>
                      <span className="min-w-0 shrink truncate">{PLACE.space}</span>
                      <span className="shrink-0 text-muted-foreground/60" aria-hidden>
                        ›
                      </span>
                      <span className="min-w-0 shrink truncate">{PLACE.tab}</span>
                      <span className="shrink-0 text-muted-foreground/60" aria-hidden>
                        ›
                      </span>
                      <span className="shrink-0 tabular-nums">pane 2 of 3</span>
                    </>
                  }
                />
              }
              header={<HeaderRow place={`${PLACE_LINE} › pane 2 of 3`} />}
            />
          </Crew>
        </Card>

        <Card
          state="pane-marker-grouped"
          label="Option 4 · the dashboard groups rows under their workspace"
          reach="SHIPPED — open the dashboard. The list in this card is the REAL AgentList over three real panes, so the heading, the count, the group frame and the rows are the dashboard's own. The header below is today's, drawn."
          note="ALTAN PICKED THIS ONE, and it is on the dashboard now. No marker on either surface. The rows sit under a heading that names the workspace and counts what is inside it — `collie-workspace`, 3 panes — so the level is carried by the STRUCTURE: everything under one workspace heading lives in that workspace, and the tab that used to earn its own heading now sits on the row itself, on line 2, blank when the tab has no name. It is the only option here that also answers a second question, which is how many siblings this pane has. WHAT SHIPPING IT SETTLED. The two axes do coexist, in one order: what needs you stays on top, by urgency, listed once and never repeated in its workspace group; everything else is grouped by workspace, and the Working and Recent headings are gone with the sort toggle and the fold, because a status word the row's own dot already carries is a poor thing to spend a group on. The rows took a third scope after all — `scope: place` carries the tab name on line 2 instead of the working directory, and the group then states one 44px pitch, so nothing inside it can shift. Bare shells join their own tab's group after its agents. The pane header is untouched."
        >
          <Crew>
            <PhoneMock>
              <Surface>dashboard</Surface>
              {/* THE REAL LIST, not a drawing of one: `AgentList` over this card's own three panes,
                  so the heading, the count, the group frame, the row scope and the 44px pitch are
                  the dashboard's and cannot drift from it. The shell is handed over separately,
                  which is how the route hands it over too. */}
              <AgentList agents={[...AGENT_SIBLINGS]} shellPanes={[...SHELL_SIBLINGS]} onOpen={inert} />
              <Surface>pane screen — unchanged</Surface>
              <HeaderRow />
            </PhoneMock>
          </Crew>
        </Card>

        <Card
          state="pane-marker-strip-label"
          label="Option 5 · the pane strip says its own name, and the row counts siblings"
          reach="idea, not shipped: the switcher is the REAL PaneStrip over three real panes. The `Panes` pill and the row's count chip are drawn — neither component has a slot for them."
          note="The marker lives on the two places that already know about siblings. On the pane screen the switcher under the tab strip gets a muted, non-interactive `Panes` pill leading its pills; on the dashboard the row gets a trailing chip, a pane glyph and the number of panes in that tab. The header itself is untouched. THE FINDING THAT MAKES THIS CHEAP: the strip is ALREADY named Panes — LabelledStrip takes the word as a required prop and it is this row's accessible name — and the pane route unpaints every strip label at once (CompactStripLabels in ui/labelled-strip.tsx) to buy 16px a row back above the mirror. So option 5 is mostly a decision to pay 16px again, and the pill form is the cheaper way to pay it: inline, it costs the row nothing, where the label above costs a line. The risk is that the strip only exists when a tab holds more than one pane, so on a one-pane tab the marker is absent on the surface that needed it. THE CARD DEVIATES ONCE: the pill is drawn BESIDE the real strip rather than inside its scroller, because PaneStrip takes its pills as children and has no leading slot. That is also where it belongs — LabelledStrip keeps its own label outside the scroller so the row cannot lose its name half way through a swipe — but it means the strip's edge-to-edge `-mx-4 px-4` is measured against this card's box here, not against the route's gutter."
        >
          <Crew>
            <PhoneMock>
              <Surface>dashboard</Surface>
              <div className="px-4 py-3">
                <RowShell
                  trailing={
                    <span className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      <PanelTop className="size-3 shrink-0" aria-hidden />
                      <span className="tabular-nums">3</span>
                      <span className="sr-only">panes in this tab</span>
                    </span>
                  }
                />
              </div>
              <Surface>pane screen — header unchanged, switcher labelled</Surface>
              <HeaderRow />
              <div className="flex items-center gap-2 px-4">
                <span
                  className={cn(
                    STRIP_TAP_TARGET,
                    "flex h-[34px] shrink-0 items-center gap-1 rounded-md border border-transparent bg-muted/50 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground",
                  )}
                >
                  <PanelTop className="size-3.5 shrink-0" aria-hidden />
                  Panes
                </span>
                <div className="min-w-0 flex-1">
                  <PaneStrip
                    panes={[...SIBLINGS]}
                    currentPaneId={PANE.paneId}
                    onSelect={inert}
                  />
                </div>
              </div>
            </PhoneMock>
          </Crew>
        </Card>

        <Card
          state="pane-marker-app-bar"
          label="Option 6 · the app bar says which kind of screen this is"
          reach="idea, not shipped: the row is drawn and the Collie mark in it is the real CollieHome. The dashboard rows are the real AgentCard, unchanged."
          note="The word rides in the app bar, where the dashboard shows the brand — so the top of the screen says what kind of screen it is, exactly as a settings page would. Costs no height and no width on the row, and the dashboard is untouched, which makes it the smallest change here. THE THING TO KNOW BEFORE PICKING IT: the pane screen has no separate app bar. There is ONE hoisted row (app-header.tsx), and on this route the pane's identity block CLAIMS it — that is why the Collie / on-herdr wordmark is hidden here and the breadcrumb has the width. So the title cannot be centred; it takes the wordmark's own slot beside the mark, as drawn, and it is then competing for the same 390px as the pane's name. The other cost is that it marks one screen and not the list: on the dashboard nothing has changed, and the dashboard is where the operator said he was confused."
        >
          <Crew>
            <PhoneMock>
              <Surface>dashboard — unchanged</Surface>
              <div className="px-4 py-3">
                <ListGroup>
                  <AgentCard agent={PANE} onClick={inert} statusStyle="dot" density="row" />
                </ListGroup>
              </div>
              <Surface>pane screen</Surface>
              <HeaderRow
                lead={
                  <span className="flex shrink-0 items-center gap-2">
                    <CollieHome onHome={inert} trouble={false} />
                    <SectionLabel className="shrink-0">Pane</SectionLabel>
                  </span>
                }
              />
            </PhoneMock>
          </Crew>
        </Card>
      </Group>
    </Section>
  );
}
