// Pull-up handle ideas: five ways the bottom of the pane screen could offer the switcher sheet, on
// seven cards — two of the ideas need a second card to show a second state.
// NONE OF THESE IS SHIPPED except the first, which is the reference. This section is a staging
// ground for a decision, not a picture of the app — which is why every card but the first says
// "idea, not shipped" where the rest of the playground says "reach it for real".
//
// THE TARGET. `components/agent-chat.tsx` draws a chrome block above the composer
// (`data-slot="chrome-block"`, `border-t border-rule bg-chrome`) and puts a full-width button in it:
// `py-3` around a 6px grip, so 30px of height whose only job is to open the switcher sheet — by tap,
// or by a finger-tracked drag (`hooks/use-sheet-pull.ts`). Under it sits the actions belt
// (`components/actions-row.tsx`, a 48px full-bleed band), then the input. The round asks what else
// could hold that job for less than 30px.
//
// WHAT IS REAL HERE AND WHAT IS NOT. The belt under every handle is the app's own `ActionsRow` on
// Claude, in the roomy layout, mounted the way `sections/actions-row.tsx` mounts it — so the thing
// each handle is measured AGAINST is never a drawing. The shipped handle is the shipped markup,
// copied character for character. The fold is the app's own `Collapse`, the peeking sheet is the app's
// own `BottomSheet` driven through its real `pull`/`pullFrom` props with the real `ThreadSidebar`
// inside it. What is INVENTED is drawn here and nowhere else: the grip on the rule, the switcher pill, the belt copy it
// needs, the drag hint, the mirror slice and the composer's input row. Each card's note says which
// side of that line it sits on.
//
// THE MIRROR IS THE CONSTANT. Every card shows the same eight lines of the same captured screen
// (`paneWorking`, run through the app's own ANSI parser to drop the colour), at the same width, so
// the only thing that differs between two cards is the chrome below it — which is the whole
// question. The slice is read-only: no scroller, no grammar, no dialog lift.
//
// DEV-ONLY, unreachable from the app entry.

import type { ReactNode } from "react";
import { ArrowUp, ChevronUp, Layers } from "lucide-react";

import { ActionsRow } from "@/components/actions-row";
import { ThreadSidebar } from "@/components/agent-sidebar";
import { HarnessBar } from "@/components/harness-bar";
import { MIRROR_INVERT, MIRROR_SPACE } from "@/components/mirror-space";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { STRIP_ROW_PILL, STRIP_SCROLLER } from "@/components/ui/labelled-strip";
import { OverflowEdges } from "@/components/ui/overflow-edges";
import { BottomSheet } from "@/components/ui/sheet";
import { parseAnsi } from "@/lib/ansi";
import { lineText, splitLines } from "@/lib/blocks";
import type { AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";

import { allPanes, herd, paneWorking, shells } from "../fixtures";
import { Card, Group, Section, type SectionDef } from "../harness";
import { took, useRoomyActions } from "./shared";

export const DEF: SectionDef = {
  id: "ideas",
  title: "Pull-up handle ideas",
  intent:
    "The bar at the bottom that can be dragged up. Today it is a 30px band — `py-3` around a 6px grip — sitting inside the chrome block, directly above a 48px actions belt and the input: 78px of chrome under the mirror before a single word is typed, and 30px of it does nothing but open one sheet. This round asks how to keep that sheet reachable by thumb for less. Eight cards, each a phone-width mock of the BOTTOM of the pane screen over the same eight lines of the same captured screen, with the REAL actions belt under every handle so the comparison is against the real neighbour. Each note states the handle's measured height at rest in px, what it costs in taps or gestures to open the sheet, and the main risk. The first card is the shipped handle, as the reference; the other seven carry five ideas, two of which need a second card for a second state, and none of them is a proposal yet.",
};

// ── The space every card is standing in ──────────────────────────────────────
//
// `sprqvntrs-api` (w2), because it is the only fixture space with the shape the "only when there is
// somewhere to go" idea needs: one tab holding three panes, so the handle has a reason to exist, and
// a sibling that can be taken away to make the solo card.

const SPACE_ID = "w2";

/** Every pane in the space — agents and shells together, as the switcher sheet sees them. */
const spacePanes: AgentView[] = allPanes.filter((pane) => pane.workspaceId === SPACE_ID);

/**
 * One pane out of the fixture space, or a loud failure. A `!` here would be a claim about a file
 * this one does not own: the fixtures are edited for other cards, and a card built on a pane that
 * quietly became `undefined` would render a blank screen rather than say so.
 */
function fixturePane(match: (pane: AgentView) => boolean, what: string): AgentView {
  const found = spacePanes.find(match);
  if (!found) throw new Error(`playground ideas: no ${what} in ${SPACE_ID}`);
  return found;
}

/** The pane the operator has open: `claude` on `billing-webhooks`, working. */
const current: AgentView = fixturePane((pane) => pane.paneId === "w2:p2", "pane w2:p2");

/** The agents of that space, for the switcher sheet the peek card actually mounts. */
const spaceAgents: AgentView[] = herd.filter((pane) => pane.workspaceId === SPACE_ID);

/** The bare shells of that space, listed under the agents in the same sheet. */
const spaceShells: AgentView[] = shells.filter((pane) => pane.workspaceId === SPACE_ID);

// ── The mirror slice ─────────────────────────────────────────────────────────

/**
 * Eight lines out of a real capture, with the colour parsed away by the app's own parser rather
 * than by a regex written here. It is text in a `<pre>`, not `AnsiOutput`: the point of these cards
 * is what sits BELOW the mirror, and mounting the real renderer would bring its grammars, its
 * dialog lift and its scroll behaviour into a card that has no business driving them.
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
 * mirror on top and whatever chrome the idea puts under it. It is a BOX, not a screen — no fixed
 * height, because the height is what the cards are being compared on and a frame that pinned it
 * would hide the answer.
 *
 * `stage` turns the box into a containing block (`transform`) with its own clip, which is what a
 * `position: fixed` descendant needs to resolve against the card instead of escaping to the page.
 * One card wants it: the peek, which mounts a real `BottomSheet`.
 */
function PhoneMock({ stage = false, children }: { stage?: boolean; children: ReactNode }) {
  return (
    <div
      className="relative w-[390px] max-w-full overflow-hidden rounded-xl border border-border bg-background"
      style={stage ? { transform: "translate(0)" } : undefined}
    >
      {children}
    </div>
  );
}

/**
 * The chrome block, as `agent-chat.tsx` draws it: ONE surface closed against the terminal above by
 * ONE rule. The class string is copied from `data-slot="chrome-block"` there, because it is not
 * extractable — it is a `<div>` inside a 2,000-line component. Every idea's handle goes inside it,
 * above the belt, which is exactly where the shipped one lives.
 */
function ChromeBlock({ children }: { children: ReactNode }) {
  return (
    <div data-slot="chrome-block" className="border-t border-rule bg-chrome">
      {children}
    </div>
  );
}

/**
 * The REAL actions belt, on Claude, in the roomy layout, inside the composer's own `px-3` dock —
 * which the belt's `-mx-3` cancels, so the band runs edge to edge exactly as it does on a phone.
 * `children` is how the two ideas that draw ON the belt reach it: they need it wrapped in a
 * positioned box, and nothing else on the card does.
 */
function Belt({ children }: { children?: ReactNode }) {
  const general = useRoomyActions();
  return (
    <div className="relative bg-chrome px-3">
      <ActionsRow general={general} agent="claude" onRun={took} />
      {children}
    </div>
  );
}

/** The composer's input row, MOCKED — `Composer` is a 1,400-line component that owns a draft store,
 *  an upload queue and a send guard, and none of that is what these cards are about. The dock's own
 *  ground and padding are the real ones (`bg-chrome px-3`, `composer.tsx`). */
function ComposerMock() {
  return (
    <div className="flex items-center gap-2 bg-chrome px-3 pb-2">
      <div className="flex h-9 min-w-0 flex-1 items-center rounded-2xl border border-border bg-background px-3 text-[13px] text-muted-foreground">
        Reply to claude…
      </div>
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
      >
        <ArrowUp className="size-4" />
      </span>
    </div>
  );
}

// ── Idea 0: the handle as it ships ───────────────────────────────────────────

/**
 * The shipped handle, copied character for character out of `agent-chat.tsx` (the `<button>` inside
 * `data-slot="chrome-block"`): `py-3` around an `h-1.5 w-12` grip, full width, `touch-none`. The two
 * things it cannot carry into a card are the two things a card has no use for — `useSheetPull`'s ref,
 * which needs a sheet to reveal, and the translated aria label, which the playground does not run
 * through `t()`.
 *
 * `onOpen` is how the "when needed" pair and the reference card stay one component: the real handle
 * both taps and drags into the sheet, and a card that only taps is still the same 30px.
 */
function ShippedHandle({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-label="Switch pane"
      onClick={onOpen}
      className="flex w-full touch-none items-center justify-center py-3 transition-colors active:bg-muted/50"
    >
      <span className="h-1.5 w-12 rounded-md bg-muted-foreground/50" />
    </button>
  );
}

// ── Idea 1: the grip straddles the belt's top rule ───────────────────────────

/**
 * A mark centred ON the belt's top rule, half above and half below, on a small `bg-chrome` patch so
 * the rule appears to break around it. It costs NO layout at all: the patch is absolutely positioned
 * over the belt's own border, and the 44px hit box is a `::before` pseudo-element reaching out from
 * it — the same negative-inset trick `ui/labelled-strip.tsx`'s `STRIP_TAP_TARGET` uses to give a 32px
 * pill a 46px answer, and the same "absolute, so it costs no layout" move the lane idea
 * makes with its own handle.
 *
 * `top-1.5` is the belt's `mt-1.5`: the rule sits 6px below this box's top edge, and
 * `-translate-y-1/2` centres the patch on it.
 */
function RuleGrip({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-label="Switch pane"
      onClick={onOpen}
      className="absolute top-1.5 left-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center rounded-md bg-chrome px-2 py-0.5 text-muted-foreground transition-colors select-none before:absolute before:-inset-4 before:content-[''] active:bg-muted/50"
    >
      <ChevronUp className="size-3" />
    </button>
  );
}

// ── Idea 2: a switcher pill on the belt ──────────────────────────────────────

/**
 * A COPY of the belt, because the idea puts a pill inside it and `ActionsRow` has no prop for that.
 * Every class string here is copied from `components/actions-row.tsx` — the band's own
 * `-mx-3 … border-y border-border bg-foreground/6 mt-1.5 mb-1.5`, the `STRIP_SCROLLER` inside it, the
 * `STRIP_ROW_PILL` face on each pill — and the harness section is the REAL `HarnessBar`, so only the
 * general half is a drawing. A card built this way drifts the day the real belt changes; the note on
 * the card says so, and the fix is a prop on `ActionsRow`, not a better copy.
 */
function BeltWithPill({ onOpen }: { onOpen: () => void }) {
  const general = useRoomyActions();
  return (
    <div className="bg-chrome px-3">
      <div className="-mx-3 mt-1.5 mb-1.5 flex items-center border-y border-border bg-foreground/6">
        <OverflowEdges>
          {(scrollerRef) => (
            <div ref={scrollerRef} className={cn(STRIP_SCROLLER, "px-3")}>
              <div role="group" aria-label="Controls" className="flex shrink-0 items-center gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Panes"
                  aria-haspopup="dialog"
                  onClick={onOpen}
                  className={cn(`${STRIP_ROW_PILL} gap-1.5 text-xs`, "text-muted-foreground")}
                >
                  <Layers className="size-4 shrink-0" />
                  Panes
                </Button>
                {general.map((action) => (
                  <Button
                    key={action.id}
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={action.label}
                    aria-expanded={action.expanded}
                    aria-pressed={action.pressed}
                    onClick={action.onSelect}
                    className={cn(`${STRIP_ROW_PILL} gap-1.5 text-xs`, "text-muted-foreground")}
                  >
                    <action.icon className="size-4 shrink-0" />
                    {action.word ?? action.label}
                  </Button>
                ))}
              </div>
              <HarnessBar agent="claude" onRun={took} />
            </div>
          )}
        </OverflowEdges>
      </div>
    </div>
  );
}

// ── The cards ────────────────────────────────────────────────────────────────

/** Every idea card's `reach` line. These are ideas; none of them can be reached. */
const NOT_SHIPPED = "idea, not shipped:";

/** Nothing on these cards navigates: they are photographs of a layout, and a tap that switched panes
 *  would need a router, a snapshot and a pane view this section deliberately does not mount. */
const inert = () => {};

export function IdeasSection() {
  // NO STATE AT ALL, and that is deliberate: every pair on this page is two cards rather than one
  // card with a toggle, because a screenshot has to be able to address one state without tapping
  // anything. The peek is mounted already peeking; the "when needed" pair is two Collapses, one open
  // and one shut.
  return (
    <Section def={DEF}>
      <Group title="0 · The handle as it ships">
        <Card
          state="handle-today"
          label="today: a 30px band above the belt, tap or drag"
          reach="open any pane."
          note="Height at rest: 30px, measured — `py-3` (12px + 12px) around a 6px grip, full width. To open the sheet: one tap, or one upward drag that passes useSheetPull's 6px slop and then travels 120px (OPEN_PX) or flings at 0.6px/ms. The risk is the one this round exists for: 30px of permanent chrome, directly above a 48px belt, for one errand. It already stands down while the keyboard is up, which is the admission that it is expensive."
        >
          <PhoneMock>
            <MirrorSlice />
            <ChromeBlock>
              <ShippedHandle onOpen={inert} />
              <Belt />
              <ComposerMock />
            </ChromeBlock>
          </PhoneMock>
        </Card>
      </Group>

      <Group title="1 · The grip moves onto the belt's rule">
        <Card
          state="handle-on-rule"
          label="no band at all: a chevron straddling the belt's top rule"
          reach={`${NOT_SHIPPED} the mark and its patch are drawn here; the belt under them is the app's own ActionsRow.`}
          note="Height at rest: 0px, measured — the patch is absolutely positioned over the belt's own border, so the belt does not move and the chrome block loses the whole 30px. The 44px hit box is a ::before reaching 16px out on every side (the negative-inset trick from ui/labelled-strip.tsx), so the target is bigger than the shipped grip's while the layout cost is nothing. To open the sheet: one tap, or the same drag, bound to the same 44px box. The risk is affordance: a 12px chevron sitting on a hairline is a much quieter promise than a full-width band, and it is the FIRST thing a thumb finds by feel today."
        >
          <PhoneMock>
            <MirrorSlice />
            <ChromeBlock>
              <Belt>
                <RuleGrip onOpen={inert} />
              </Belt>
              <ComposerMock />
            </ChromeBlock>
          </PhoneMock>
        </Card>

        <Card
          state="handle-on-rule-peek"
          label="mid-drag: the sheet peeking 60px up under the finger"
          reach={`${NOT_SHIPPED} the peek is REAL — the app's own BottomSheet in its peeking state, with the real ThreadSidebar inside it, driven through the real pull/pullFrom props.`}
          note="Height at rest: still 0px; what this card shows is the 60px of sheet a half-finished drag reveals. `pull` is 60 and `pullFrom` is 0, so the panel's top edge stands 60px off the card's bottom edge and the backdrop dims to pull/120 × 0.5, exactly what useSheetPull feeds it on a phone — the one difference is that a real drag measures pullFrom from the handle's own distance to the viewport bottom, which on this idea is the belt's rule rather than the screen's edge. The card is a stage (transform + clip), so the sheet's `fixed` resolves against the mock instead of escaping to the page. The risk this card is asking about: at 60px the sheet shows one row and a title, so the drag has to go most of the way to OPEN_PX before it tells you anything."
        >
          <PhoneMock stage>
            <MirrorSlice />
            <ChromeBlock>
              <Belt>
                <RuleGrip onOpen={inert} />
              </Belt>
              <ComposerMock />
            </ChromeBlock>
            <BottomSheet
              open={false}
              onClose={inert}
              title="Switch pane"
              pull={60}
              pullFrom={0}
            >
              <ThreadSidebar
                agents={spaceAgents}
                shellPanes={spaceShells}
                currentPaneId={current.paneId}
                onSelect={inert}
              />
            </BottomSheet>
          </PhoneMock>
        </Card>
      </Group>

      <Group title="2 · The belt carries it">
        <Card
          state="handle-belt-pill"
          label="no handle: a Panes pill, first on the belt, left of Keys"
          reach={`${NOT_SHIPPED} and this belt is a MOCK — a copy of ActionsRow's own class strings, because the component has no prop for an extra pill. Only the harness section inside it is the real HarnessBar.`}
          note="Height at rest: 0px — the belt already exists and the pill rides in it, so the chrome block loses the full 30px and nothing takes its place. To open the sheet: one tap, and there is no gesture at all, which is the trade. Two risks. The pill takes the belt's LEFT EDGE, which actions-row.tsx says is Keys on every pane there is — leading with something else means the left edge means a different thing per pane. And the belt scrolls sideways: on a narrow phone with a long harness section the pill is still first, but a thumb that has flicked the belt right has to flick back to find it."
        >
          <PhoneMock>
            <MirrorSlice />
            <ChromeBlock>
              <BeltWithPill onOpen={inert} />
              <ComposerMock />
            </ChromeBlock>
          </PhoneMock>
        </Card>
      </Group>

      <Group title="3 · Only when there is somewhere to go">
        <Card
          state="handle-when-needed"
          label="more than one pane in the space: today's handle, unchanged"
          reach={`${NOT_SHIPPED} the fold is the app's own Collapse; the handle inside it is the shipped markup.`}
          note="Height at rest: 30px, measured — this IS the shipped card, and that is the point: the idea changes nothing about the handle and everything about when it is there. The space behind this card holds three panes in the open tab, so the sheet has something to show and the band is earned. To open the sheet: one tap or the drag, exactly as today."
        >
          <PhoneMock>
            <MirrorSlice />
            <ChromeBlock>
              <Collapse open>
                <ShippedHandle onOpen={inert} />
              </Collapse>
              <Belt />
              <ComposerMock />
            </ChromeBlock>
          </PhoneMock>
        </Card>

        <Card
          state="handle-when-needed-solo"
          label="one pane and no launchers: the handle collapses to nothing"
          reach={`${NOT_SHIPPED} the same real Collapse, closed — which is how the app already takes this handle away while the keyboard is up.`}
          note="Height at rest: 0px, measured — Collapse unmounts the button at the end of the exit, so it leaves the tab order with the pixels. To open the sheet: you cannot, and that is the idea, because there is nothing in it. The risk is that the app's own condition is already close to this (`agents.length + shellPanes.length > 0 || launchers.length > 0`) and still shows the handle on a solo pane, deliberately: the sheet is the way back to something alive when the open pane is GONE. A rule that counts siblings has to answer that case, or a dead pane becomes a dead end."
        >
          <PhoneMock>
            <MirrorSlice />
            <ChromeBlock>
              <Collapse open={false}>
                <ShippedHandle onOpen={inert} />
              </Collapse>
              <Belt />
              <ComposerMock />
            </ChromeBlock>
          </PhoneMock>
        </Card>
      </Group>

      <Group title="4 · The belt itself is the handle">
        <Card
          state="handle-drag-belt"
          label="no mark at all: drag the whole belt upward"
          reach={`${NOT_SHIPPED} the belt is the real ActionsRow; the arrow hint over its ground is drawn here, and it is a stand-in for whatever a real answer to 'nothing says this drags' would be.`}
          note="Height at rest: 0px — the belt is already there and the gesture is free. To open the sheet: an upward drag anywhere on the 48px band, no tap path at all. The risk is a real conflict, not a stylistic one: the belt is a horizontal scroller (STRIP_SCROLLER, overflow-x-auto), so a drag that starts on it is already claimed by the browser until a direction is decided. `touch-pan-x` plus `overscroll-y-none` solves that collision, handing vertical to the handler and keeping horizontal for the chips — so this is buildable, but every diagonal flick has to be adjudicated, and a thumb aiming for Keys that drifts 7px up would open a sheet instead."
        >
          <PhoneMock>
            <MirrorSlice />
            <ChromeBlock>
              <Belt>
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 top-1.5 flex h-12 items-center justify-center text-muted-foreground/40"
                >
                  <ArrowUp className="size-6" />
                </span>
              </Belt>
              <ComposerMock />
            </ChromeBlock>
          </PhoneMock>
        </Card>
      </Group>
    </Section>
  );
}
