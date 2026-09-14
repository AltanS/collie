// Header corner ideas: nine numbered options for the TOP of the pane screen, and for the one pill at
// the bottom that got too wide. The section exists so Altan can say "option N" and be understood,
// and he did: OPTION 2 AND OPTION 8 ARE SHIPPED. Those two cards now draw the production pieces
// themselves, so this page stays true as the app moves; the other seven stay as the ideas they were,
// because a page of options with the losing options deleted cannot be read as a comparison any more.
//
// THE TARGET, GROUP A. `agent-chat.tsx`'s header puts a column of two fixed slots at its trailing
// edge (`components/pane-meta.tsx`): the bordered host tag on top, the bare tinted cache reading
// under it, then the ⋮ in its own 44px column beside them. Altan, from his phone: "the top section
// with host and cache stuff is not where it needs to be yet... try again, let's move this to the
// playground with a bunch of options." The fault the screenshot shows is weight, not position: a
// BORDERED pill stacked over a BARE tinted word, with a third loose glyph beside them, reads as
// three unrelated objects rather than as one corner. Options 1 to 6 each answer that differently.
//
// THE TARGET, GROUP B. The belt's trailing pill DREW a `Layers` mark and the word "Switch" (78px of
// pill, `actions-row.tsx`'s SWITCH_PILL_INSET). Altan: "the switch button is taking up too much room
// for my taste, I'd argue we can just have the icon." Options 7 to 9 drop the word three ways, and
// option 8 is what the belt draws today.
//
// WHAT IS REAL HERE AND WHAT IS NOT. `CacheChip`, `HostChip`, `PaneMeta`, `TabStrip`, `AgentIcon` and
// the belt's `ActionsRow` are the app's own components on every card, inside a real `CrewProvider`
// over the `rosterFive` fixture, so the hide rules, the identity tint and the countdown are the real
// ones. What is DRAWN HERE is the header ROW itself — `RouteHeader` is a portal into the one hoisted
// header shell and cannot be mounted in a card — plus, per option, whatever chrome production has no
// prop for yet. Each card's note says which side of that line it sits on. The two shipped cards sit
// as far on the real side as a card can: option 2 mounts `PaneMeta` in its inline layout and option 8
// hands `ActionsRow` a handle and lets it draw its own trailing control.
//
// THE MACHINE IS `lodge`, the `rosterFive` lead, not the `bluefin` of the screenshot: a host that is
// not in the roster gets no identity tint and no health, so it would draw a quieter tag than the
// phone draws. The name is four letters either way.
//
// DEV-ONLY, unreachable from the app entry.

import type { ReactNode } from "react";
import { ChevronUp, EllipsisVertical, Layers, Server } from "lucide-react";

import { ActionsRow, type ActionsRowProps } from "@/components/actions-row";
import { AgentIcon } from "@/components/agent-icon";
import { CacheChip } from "@/components/cache-chip";
import { CrewProvider } from "@/components/crew-provider";
import { HostChip } from "@/components/host-chip";
import { PaneMeta } from "@/components/pane-meta";
import { TabStrip } from "@/components/tab-strip";
import { Button } from "@/components/ui/button";
import { STRIP_ROW_PILL, STRIP_TAP_TARGET_SQUARE } from "@/components/ui/labelled-strip";
import { HOST_TEXT_CLASSES, hostSlot } from "@/lib/hosts";
import type { PaneCache } from "@/lib/types";
import { cn } from "@/lib/utils";

import { allPanes, cacheNow, paneCache, rosterFive, tabs, TS } from "../fixtures";
import { Card, Group, Section, type SectionDef } from "../harness";
import { ChromeBlock, PhoneMock, took, useRoomyActions } from "./shared";

export const DEF: SectionDef = {
  id: "header-corner",
  title: "Header corner ideas",
  intent:
    "Nine numbered options. Two of them shipped — option 2 in the header, option 8 on the belt — and the other seven stay here as the comparison they were made for. Options 1 to 6 redraw the pane header's trailing corner, where a bordered host tag stacked over a bare cache reading and a loose ⋮ reads as three objects instead of one. Each of the six is drawn three times — cache cold, cache 58m, cache 62m — so the width variance is on the card rather than in the imagination. Options 7 to 9 take the word off the belt's Switch pill and leave the Layers mark. Say the number.",
};

// ── The fixture every card stands on ─────────────────────────────────────────

const HOST = "lodge";
const TITLE = "collie-workspace › UI work";
const PATH = "~/projects/collie-workspace";
const MIN = 60_000;

/** The three readings, in the order every card draws them. A `label` for the card's own caption,
 *  because the chip's word is the chip's to render and this page may not restate it. */
const READINGS: readonly { key: string; caption: string; cache: PaneCache }[] = [
  { key: "cold", caption: "cold", cache: paneCache({ state: "cold" }) },
  {
    key: "warm",
    caption: "58 minutes left",
    cache: paneCache({ state: "warm", expiresAt: cacheNow + 58 * MIN + 30_000 }),
  },
  {
    key: "long",
    caption: "62 minutes left (the widest reading there is)",
    cache: paneCache({ state: "warm", expiresAt: cacheNow + 62 * MIN + 30_000 }),
  },
];

/** A card is a photograph: every callback on it does nothing. */
const inert = () => {};

function Crew({ children }: { children: ReactNode }) {
  return (
    <CrewProvider servers={rosterFive} ts={TS} pollMs={3_000}>
      {children}
    </CrewProvider>
  );
}

// ── The header row, drawn here ───────────────────────────────────────────────

/**
 * The pane header's own row, as `agent-chat.tsx` composes it into `RouteHeader`: a 60px floor
 * (`min-h-15`), the identity block on the left — the agent's 16px mark, the pane name on line 1, the
 * working directory on line 2 — and a trailing corner. `RouteHeader` itself portals into the one
 * hoisted header shell (`app-header.tsx`) and cannot be mounted in a card, so the ROW is drawn here
 * with its class strings copied from that file; everything INSIDE the corner is the real component.
 *
 * `crumb` prefixes line 1 with a dimmed segment (option 5 only). `pathTrailing` puts something at the
 * right end of line 2 (option 2 only). `corner` is the trailing cluster itself.
 */
function HeaderRow({
  crumb,
  pathTrailing,
  corner,
}: {
  crumb?: string;
  pathTrailing?: ReactNode;
  corner: ReactNode;
}) {
  return (
    <div className="flex min-h-15 items-stretch gap-2 border-b border-rule bg-background px-3 py-2">
      <div className="flex min-h-11 min-w-0 flex-1 items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2 leading-5">
            <AgentIcon agent="claude" className="size-4 shrink-0" />
            <span className="block truncate font-semibold leading-5">
              {crumb !== undefined && (
                <span className="font-normal text-muted-foreground">{crumb} › </span>
              )}
              {TITLE}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <span className="block truncate font-mono text-[11px] leading-3 text-muted-foreground">
              {PATH}
            </span>
            {pathTrailing !== undefined && <span className="ml-auto shrink-0">{pathTrailing}</span>}
          </div>
        </div>
      </div>
      {corner}
    </div>
  );
}

/** The ⋮, exactly as `agent-chat.tsx` draws it: its own 44px column, `self-stretch`, a real target. */
function Kebab() {
  return (
    <button
      type="button"
      onClick={inert}
      aria-label="Pane menu"
      className="grid w-11 min-h-11 shrink-0 place-items-center self-stretch rounded-md text-muted-foreground transition-colors active:bg-muted/60 active:text-foreground"
    >
      <EllipsisVertical className="size-5" />
    </button>
  );
}

/** The corner's own box: whatever the option puts in it, then the ⋮, on the header's right gutter. */
function Corner({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-stretch gap-2">
      {children}
      <Kebab />
    </div>
  );
}

/** Three headers, one per reading, with the reading named under each. Every Group-A card is this. */
function ThreeReadings({ render }: { render: (cache: PaneCache) => ReactNode }) {
  return (
    <div className="space-y-3">
      {READINGS.map((reading) => (
        <div key={reading.key}>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {reading.caption}
          </p>
          <PhoneMock>{render(reading.cache)}</PhoneMock>
        </div>
      ))}
    </div>
  );
}

// ── Group A, the six corners ─────────────────────────────────────────────────

/**
 * Option 1 — ONE bordered chip holding both facts. The box is `ui/address-tag.tsx`'s quiet recipe,
 * copied class for class (there is no primitive that takes two facts), and the cache half inside it
 * is the REAL `CacheChip` at the tag's own 10px, so the countdown and the tint stay the app's.
 */
function FusedChip({ cache }: { cache: PaneCache }) {
  const slot = hostSlot(rosterFive, HOST);
  return (
    <span
      aria-label={`Host: ${HOST}`}
      className="inline-flex max-w-[11rem] shrink-0 items-center gap-1 rounded-md border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
    >
      <Server
        className={cn("size-3 shrink-0", slot !== null && HOST_TEXT_CLASSES[slot])}
        aria-hidden
      />
      <span className="truncate" aria-hidden>
        {HOST}
      </span>
      <span aria-hidden className="text-muted-foreground/60">
        ·
      </span>
      <CacheChip cache={cache} host={HOST} className="text-[10px]" />
    </span>
  );
}

/** Option 6's menu, drawn open beside the header so the heading row can be judged. Mocked: the real
 *  pane menu is a `BottomSheet` full of live actions, and none of them may be reachable here. */
function KebabMenuMock() {
  return (
    <div className="mt-2 w-56 overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <HostChip host={HOST} variant="bare" />
        <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground/70">
          this pane
        </span>
      </div>
      {["Rename pane", "Show in terminal", "Prompt cache", "Close pane"].map((row) => (
        <div key={row} className="px-3 py-2 text-sm text-foreground">
          {row}
        </div>
      ))}
    </div>
  );
}

// ── Group B, the belt ────────────────────────────────────────────────────────

/**
 * The REAL belt, on Claude, in the roomy layout, inside the composer's own `px-3` dock — with NO
 * `handle`, so `ActionsRow` draws no pinned pill of its own and each option below can draw the one it
 * is proposing at the same right end, over the same two-layer fade (the markup is copied from
 * `actions-row.tsx`'s pinned span, which has no prop for a different pill).
 */
function BeltWithSwitch({ children, handle }: BeltProps) {
  const general = useRoomyActions();
  return (
    <div className="relative bg-chrome px-3">
      <ActionsRow general={general} agent="claude" onRun={took} handle={handle} />
      {children !== undefined && (
        <span className="absolute inset-y-0 right-0 z-10 flex items-center pr-3 pl-8">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-chrome [mask-image:linear-gradient(to_right,transparent,black_2rem)]"
          >
            <span className="absolute inset-0 bg-foreground/6" />
          </span>
          {children}
        </span>
      )}
    </div>
  );
}

/** A belt card: either an idea's own pinned object over a copied fade (`children`), or the real
 *  ActionsRow drawing its own (`handle`). Never both. */
interface BeltProps {
  children?: ReactNode;
  handle?: ActionsRowProps["handle"];
}

/** A belt card: the belt over a quiet stand-in for the input row, in a phone-width box. */
function BeltCard({ children, handle }: BeltProps) {
  return (
    <PhoneMock>
      <div className="h-16 bg-background" />
      <ChromeBlock>
        <BeltWithSwitch handle={handle}>{children}</BeltWithSwitch>
        <div className="flex items-end gap-3 bg-chrome px-3 pb-2">
          <div className="flex h-9 min-w-0 flex-1 items-center rounded-2xl border border-border bg-background px-3 text-[13px] text-muted-foreground">
            Type a reply…
          </div>
          <div className="size-11 shrink-0 rounded-full bg-primary" />
        </div>
      </ChromeBlock>
    </PhoneMock>
  );
}

// ── The cards ────────────────────────────────────────────────────────────────

/** The `reach` line of the seven cards that stayed ideas. Options 2 and 8 shipped and say so. */
const NOT_SHIPPED = "idea, not shipped:";

export function HeaderCornerSection() {
  // NO STATE, deliberately: every card has to be addressable by a screenshot without tapping
  // anything first, so nothing here toggles and nothing here animates.
  return (
    <Section def={DEF}>
      <Group title="A · The header corner — before, then options 1 to 6 (2 shipped)">
        <Card
          state="header-corner-today"
          label="before: the bordered tag over the bare reading, ⋮ beside them"
          reach="the dashboard still draws this column on every row; the pane header drew it until option 2 shipped."
          note="The REAL PaneMeta, in its two-slot column, with the ⋮ in its own 44px column beside it — this is what the DASHBOARD row draws, and what the pane header drew until option 2 shipped. Read the three readings together: the bordered box on top holds one width while the bare word under it changes, which is the mismatch of weight the options attack. Options 2 and 8 are the picks, and both are live: the header's pair moved onto the path line, and the belt's Switch pill is a bare mark."
        >
          <Crew>
            <ThreeReadings
              render={(cache) => (
                <HeaderRow
                  corner={
                    <div className="flex items-stretch gap-2">
                      <PaneMeta host={HOST} cache={cache} onOpenCache={inert} />
                      <Kebab />
                    </div>
                  }
                />
              )}
            />
          </Crew>
        </Card>
        <Card
          state="header-corner-fused"
          label="Option 1 · one fused chip"
          reach={`${NOT_SHIPPED} the fused box is drawn here from ui/address-tag.tsx's own class recipe; the cache half inside it is the real CacheChip.`}
          note="Host and cache share ONE bordered chip on ONE line, so there is one weight and one edge in the corner instead of two. The corner drops from two rows to one, which takes the whole stack under the 44px the ⋮ already spends. The cost is width: the chip grows with the reading, and on the 62m card it is the widest thing this corner has ever been. Shipping it means a real two-fact variant, either on HostChip or on a new primitive — a bordered CacheChip inside a bordered HostChip would be two boxes again."
        >
          <Crew>
            <ThreeReadings
              render={(cache) => (
                <HeaderRow corner={<Corner><FusedChip cache={cache} /></Corner>} />
              )}
            />
          </Crew>
        </Card>
        <Card
          state="header-corner-path-meta"
          label="Option 2 · the meta joins the path row"
          reach="SHIPPED, and this card draws it: open any pane on a collie that leads a crew."
          note="Altan's pick. The corner holds the ⋮ and nothing else. The machine and the reading ride at the right end of line 2, opposite the working directory, in the same small mono the path already wears — where a pane LIVES and where its work SITS are one sentence, so they share one line. The corner loses its whole stack, which is the largest saving on offer. The two risks it was picked with, and what answers each: line 2 is a truncating line, so the path is what gives way and the meta is never cut; and the reading tints its WORD as well as its glyph, so it now takes tint='glyph' on this line and leaves the word at the meta colour. The pair is the real PaneMeta in its inline layout — the same component the dashboard row's corners use."
        >
          <Crew>
            <ThreeReadings
              render={(cache) => (
                <HeaderRow
                  pathTrailing={
                    <PaneMeta layout="inline" host={HOST} cache={cache} onOpenCache={inert} />
                  }
                  corner={<div className="flex items-stretch"><Kebab /></div>}
                />
              )}
            />
          </Crew>
        </Card>
        <Card
          state="header-corner-two-bare"
          label="Option 3 · two bare rows, same weight"
          reach={`${NOT_SHIPPED} both rows are real components now — HostChip's borderless variant, which option 2 put in the app, and the real CacheChip.`}
          note="The mismatch is removed by dropping the BORDER rather than by merging the two facts: two right-aligned rows, same size, same mono register, no box on either. The column keeps its two fixed slot heights, so nothing moves when a reading disappears (DESIGN.md §2). The risk is the opposite of option 1's: with no box at all, the machine's name stops reading as an address and becomes a second loose word beside the ⋮, which is the fault the AddressTag pill was introduced to fix on the dashboard."
        >
          <Crew>
            <ThreeReadings
              render={(cache) => (
                <HeaderRow
                  corner={
                    <Corner>
                      <div className="flex flex-col items-end justify-between gap-1 self-stretch">
                        <div className="flex h-[21px] items-center">
                          <HostChip host={HOST} variant="bare" />
                        </div>
                        <div className="flex h-4 items-center">
                          <CacheChip cache={cache} host={HOST} variant="button" onOpen={inert} />
                        </div>
                      </div>
                    </Corner>
                  }
                />
              )}
            />
          </Crew>
        </Card>
        <Card
          state="header-corner-tab-cache"
          label="Option 4 · the cache moves to the tab strip's trailing edge"
          reach={`${NOT_SHIPPED} the header row is drawn here; the host tag, the cache chip and the whole tab strip under them are the app's own components.`}
          note="The corner keeps the host tag and the ⋮ on ONE line, and the reading moves down to the tab row, pinned before the fold chevron in TabStrip's real `trailing` slot. The argument is that the two are different KINDS of fact — one is where the pane is, one is what its agent's window is doing — so they get different rows instead of two mismatched slots in one. The tab row is already 44px, so the reading costs no height at all. The risk: that row scrolls sideways and its trailing end is already the chevron's, so the reading lands in the busiest corner of the screen, and on a space with no tabs the row is absent and the reading has nowhere to go."
        >
          <Crew>
            <ThreeReadings
              render={(cache) => (
                <>
                  <HeaderRow
                    corner={
                      <Corner>
                        <div className="flex items-center">
                          <HostChip host={HOST} variant="tag" />
                        </div>
                      </Corner>
                    }
                  />
                  <TabStrip
                    workspaceId="w1"
                    tabs={tabs}
                    agents={allPanes}
                    host={HOST}
                    selected="w1:t1"
                    onSelect={inert}
                    onNewTab={inert}
                    allowAll={false}
                    trailing={
                      <span className="flex items-center gap-2">
                        <CacheChip cache={cache} host={HOST} variant="button" onOpen={inert} />
                        <button
                          type="button"
                          onClick={inert}
                          aria-label="Hide the strips"
                          className={cn(
                            STRIP_TAP_TARGET_SQUARE,
                            "flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent active:scale-95",
                          )}
                        >
                          <ChevronUp className="size-4" />
                        </button>
                      </span>
                    }
                  />
                </>
              )}
            />
          </Crew>
        </Card>
        <Card
          state="header-corner-host-crumb"
          label="Option 5 · the host leads the title, the cache holds the corner alone"
          reach={`${NOT_SHIPPED} the breadcrumb is drawn here; the cache chip in the corner is the real CacheChip.`}
          note="The machine becomes the FIRST crumb of the title — 'lodge › collie-workspace › UI work', dimmed — because that is what a machine is: the outermost part of the address. The corner then has one item and the ⋮, both on one line, which is the fewest objects of any option that keeps the reading visible. The cost is line 1, which is the one line that may never truncate the pane's own name: on a 390px phone a long machine name eats the title from the left. It also gives up the identity tint unless the crumb carries the Server glyph, which would put a third mark on the title line."
        >
          <Crew>
            <ThreeReadings
              render={(cache) => (
                <HeaderRow
                  crumb={HOST}
                  corner={
                    <Corner>
                      <div className="flex items-center">
                        <CacheChip cache={cache} host={HOST} variant="button" onOpen={inert} />
                      </div>
                    </Corner>
                  }
                />
              )}
            />
          </Crew>
        </Card>
        <Card
          state="header-corner-kebab-menu"
          label="Option 6 · the kebab absorbs the machine"
          reach={`${NOT_SHIPPED} the open menu is a mock — the real pane menu is a BottomSheet of live actions. The cache chip in the corner is the real CacheChip.`}
          note="The corner is one reading and the ⋮, on one line, and the machine's name moves INTO the menu as its first row: a heading, not an action, which is where a fact that is read once per session belongs. Fewest items in the corner of any option here. The cost is stated plainly: on a crew the machine stops being visible at all on the pane screen, and 'which terminal am I typing into' is the one question this app must never make anyone tap for. The menu below each header is drawn open so the heading row can be judged; in the app it is closed."
        >
          <Crew>
            <ThreeReadings
              render={(cache) => (
                <>
                  <HeaderRow
                    corner={
                      <Corner>
                        <div className="flex items-center">
                          <CacheChip cache={cache} host={HOST} variant="button" onOpen={inert} />
                        </div>
                      </Corner>
                    }
                  />
                  <div className="flex justify-end px-3 pb-3">
                    <KebabMenuMock />
                  </div>
                </>
              )}
            />
          </Crew>
        </Card>
      </Group>

      <Group title="B · The Switch pill — options 7 to 9 (8 shipped)">
        <Card
          state="switch-pill-icon"
          label="Option 7 · icon only, same pill chrome"
          reach={`${NOT_SHIPPED} the belt is the app's own ActionsRow with no handle; the pinned pill and its fade are drawn here, copied from actions-row.tsx.`}
          note="The pill keeps its accent border, its accent ground and its place, and drops the word: a square at the belt's own pill register. The belt gets back about 42px of the 78px the pill spends today. It is DRAWN 32px and ANSWERS 46px, like every other belt pill (STRIP_ROW_PILL's ::before) — a literally drawn 44px box would set the belt's height on its own and push the composer down. The risk: a bordered square with one glyph and no word is the least legible of the three, and Layers alone does not say 'pane'."
        >
          <BeltCard>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Switch"
              aria-haspopup="dialog"
              onClick={inert}
              className={cn(
                `${STRIP_ROW_PILL} relative size-8 px-0 has-[>svg]:px-0`,
                "border-primary/30 bg-primary/10 text-foreground hover:bg-primary/10 hover:text-foreground",
              )}
            >
              <Layers className="size-4 shrink-0 text-primary" />
            </Button>
          </BeltCard>
        </Card>
        <Card
          state="switch-pill-bare"
          label="Option 8 · bare glyph behind a hairline"
          reach="SHIPPED, and this card draws it: the real ActionsRow, with a handle, so the mark and its hairline are the app's own."
          note="Altan's pick. No border and no ground: the Layers mark alone at the trailing end, with a hairline on its left saying the end of the scroller is here. It is the narrowest of the three and it matches the general pills, which also stand directly on the belt's ground with no outline. The risk it was picked with is rank: the accent border was what said this one control LEAVES the composer while the others operate it, and a bare mark gives that up — the accent stays on the glyph and carries it alone. The box is unchanged at 44 × 32px drawn and 46px answered, so the belt's height is what it always was."
        >
          <BeltCard handle={{ ref: inert, onClick: inert, label: "Switch pane" }} />
        </Card>
        <Card
          state="switch-pill-chevron"
          label="Option 9 · glyph with a chevron up"
          reach={`${NOT_SHIPPED} the belt is the app's own ActionsRow with no handle; the pinned glyph pair and the fade are drawn here.`}
          note="Option 8 plus a 10px chevron under the mark, which is the one thing the word used to carry that a glyph does not: the sheet opens UPWARD, from this belt. It is the same box as options 7 and 8 with the two marks stacked inside it, so it costs no extra width. The risk: a chevron on the belt is what Altan already rejected once, in its centred form ('now blocking the Quick action, it's a bad spot') — pinned at the end it blocks nothing, but it is the same mark, and two marks in one 32px box is a busy target."
        >
          <BeltCard>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Switch"
              aria-haspopup="dialog"
              onClick={inert}
              className={cn(
                `${STRIP_ROW_PILL} relative size-8 flex-col gap-0 border-0 px-0 has-[>svg]:px-0`,
              )}
            >
              <Layers className="size-4 shrink-0 text-primary" />
              <ChevronUp className="size-2.5 shrink-0 text-muted-foreground" />
            </Button>
          </BeltCard>
        </Card>
      </Group>
    </Section>
  );
}
