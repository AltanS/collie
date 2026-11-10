// The hill section of the states playground (M96): the Decision card in each state, the Hill view, and
// the Dashboard's way in. Every card mounts the REAL component (`DecisionCard`, `HillView`,
// `HillHeader`, `DashboardTabBar`) with fixtures shaped by the wire (`fixtures/hill/decisions.ts`). There
// is no bridge behind this page: a card's state is fixed, and a tap on a live card answers nothing.
// The cards wear the machine tints of a two-machine crew (bluefin and minibuch), as `LiveDecisionCard`
// would hand them on one.
//
// Cards are numbered 1 to 48.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { AgentList } from "@/components/agent-list";
import { AppHeaderHost, RouteHeader } from "@/components/app-header";
import { DecisionCard } from "@/components/decision-card";
import { DashboardTabBar } from "@/components/dashboard-tab-bar";
import { HillHeader, HillOff, HillView } from "@/components/hill-view";
import { HillSwitchCard } from "@/components/hill-switch-card";
import { TrickDashboardStrip } from "@/components/trick-place-items";
import { HILL_IDLE, type HillAnswerState } from "@/hooks/use-hill-answer";
import type { HillDecision, HillReceipt } from "@/lib/hill/wire";
import { sortOpenDecisions } from "@/lib/hill/wire";
import type { PaneOrder } from "@/lib/pane-order";
import { partKey, type PlaceItem, type WireTrickInfo, type WireTrickPart } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore } from "@/lib/tricks/store";
import { mintRequestId } from "@/lib/worktree-name";

import { herd, homeSolo, tabs } from "../fixtures";
import { CASE_DATA, CASES, HOST_SLOT as LOOK_HOST_SLOT, TRICK_ICON_OF, isCaseId, type CaseId, type HillCase } from "../hill-look/fixtures";
import {
  brokenImage,
  busyOpen,
  closedRows,
  compareShots,
  diffCard,
  diffSummary,
  gateStrip,
  goneText,
  keptWords,
  mixedImages,
  placedImage,
  oneImage,
  playgroundMedia,
  quietOpen,
  receipts,
  rich,
  reviewCard,
  roughCard,
  sevenOpen,
  sparkCard,
  stressCard,
  tableCard,
  textOnly,
  textRequired,
  threeImages,
  threeWithConfirm,
  trickOpen,
  twoOptions,
  unattended,
  withBody,
} from "../fixtures/hill/decisions";
import { RootRouter } from "../harness";
import { isNet, MotionHill, NETS, type Net } from "../hill-motion";
import { Card, CardControls, Group, Section, Segmented, type SectionDef } from "../layout";

export const DEF: SectionDef = {
  id: "hill",
  title: "Hill",
  intent: "The Decisions agents post, the Hill that lists them, and the Dashboard row that opens it.",
};

const NO_KEPT: ReadonlyMap<string, string> = new Map();
const noSend = () => {};

/** The tint slot per machine, as `lib/hosts.ts` would assign it on this two-machine crew. */
const HOST_SLOT: ReadonlyMap<string, number> = new Map([
  ["bluefin", 2],
  ["minibuch", 6],
]);

/** The trick icon per trick id, as the tricks list would say it. */
const TRICK_ICON: ReadonlyMap<string, string> = new Map([["look", "eye"]]);

/** The real card with the playground's images, tints and trick icons. */
function PlaygroundCard({ decision, answer = HILL_IDLE }: { decision: HillDecision; answer?: HillAnswerState }) {
  const { from } = decision;
  return (
    <DecisionCard
      decision={decision}
      answer={answer}
      onSend={noSend}
      mediaSource={playgroundMedia}
      hostSlot={from.host === null ? null : (HOST_SLOT.get(from.host) ?? null)}
      trickIcon={from.trickId === null ? undefined : TRICK_ICON.get(from.trickId)}
    />
  );
}

/** A phone-wide box on the page colour, the card's own gutter around it. */
function Phone({ height, children }: { height?: number; children: ReactNode }) {
  const box: CSSProperties & { "--app-h"?: string } = { width: 390, height, transform: "translate(0)" };
  if (height !== undefined) box["--app-h"] = `${height}px`;
  return (
    <div data-pg-frame="" className="relative isolate flex max-w-full flex-col overflow-hidden rounded-sm bg-background ring-1 ring-rule" style={box}>
      {children}
    </div>
  );
}

function CardHead({ n, title }: { n: number; title: string }) {
  return (
    <CardControls className="flex items-center gap-3">
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-lg font-bold leading-none text-background">
        {n}
      </span>
      <p className="text-sm font-semibold text-foreground">
        {n}: {title}
      </p>
    </CardControls>
  );
}

/** One Decision card at phone width, in a fixed state. Its images are the page's own panels. */
function OneCard({ decision, answer = HILL_IDLE }: { decision: HillDecision; answer?: HillAnswerState }) {
  return (
    <Phone>
      <div className="p-4">
        <PlaygroundCard decision={decision} answer={answer} />
      </div>
    </Phone>
  );
}

/** The card with one of its folds open by the real tap on its toggle (More or Add a note), once mounted. */
function OpenedCard({ decision, toggle }: { decision: HillDecision; toggle: "decision-more" | "decision-note" }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>(`[data-slot="${toggle}"]`)?.click();
  }, [toggle]);
  return (
    <div ref={root}>
      <OneCard decision={decision} />
    </div>
  );
}

/** The card with its confirm option armed: the real first tap, once mounted, and again on demand. */
function ArmedCard() {
  const root = useRef<HTMLDivElement>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('[data-intent="reset"]')?.click();
  }, [round]);
  return (
    <div ref={root}>
      <CardControls>
        <button type="button" className="rounded-md border border-border px-2 py-1 text-[11px] font-medium" onClick={() => setRound((n) => n + 1)}>
          Arm again
        </button>
      </CardControls>
      <OneCard decision={threeWithConfirm} />
    </div>
  );
}

const answered = (receipt: HillReceipt, intent = "yes", text: string | null = null): HillAnswerState => ({ phase: "answered", intent, text, receipt });

/** The view in a phone, with the header the route draws. */
function HillPhone({ open, closed, kept = NO_KEPT, unfold = false }: { open: readonly HillDecision[]; closed: readonly HillDecision[]; kept?: ReadonlyMap<string, string>; unfold?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (unfold) root.current?.querySelector<HTMLButtonElement>('[data-slot="hill-answered"] button[aria-expanded="false"]')?.click();
  }, [unfold]);
  const sorted = sortOpenDecisions([...open]);
  const nowCount = sorted.filter((d) => d.priority === "now").length;
  return (
    <div ref={root}>
      <Phone height={760}>
        <RootRouter data={homeSolo}>
          <AppHeaderHost bridge="connected" error={false}>
            <HillHeader count={sorted.length} nowCount={nowCount} onBack={noSend} />
            <div data-pg-scroll className="min-h-0 flex-1 overflow-y-auto p-4">
              <HillView
                open={sorted}
                closed={closed}
                kept={kept}
                renderCard={(decision) => <PlaygroundCard key={decision.id} decision={decision} />}
              />
            </div>
          </AppHeaderHost>
        </RootRouter>
      </Phone>
    </div>
  );
}

/**
 * The Hill with Clear on its closed group: three closed rows, the button idle. The control is live in the
 * page: the first tap arms it, the second clears the rows and the empty Hill shows (a reload brings them
 * back). With `armed` the real first tap is made once mounted, and again on demand ("Arm again"), as
 * `ArmedCard` does. The rows are held INSIDE the route (`ClearBody`): the router keeps the element it was
 * first given, so state held above it would never reach the view.
 */
function ClearBody() {
  const [closed, setClosed] = useState<readonly HillDecision[]>(closedRows.slice(0, 3));
  return (
    <AppHeaderHost bridge="connected" error={false}>
      <HillHeader count={0} nowCount={0} onBack={noSend} />
      <div data-pg-scroll className="min-h-0 flex-1 overflow-y-auto p-4">
        <HillView
          open={[]}
          closed={closed}
          kept={NO_KEPT}
          renderCard={(decision) => <PlaygroundCard key={decision.id} decision={decision} />}
          clear={{ canWrite: true, busy: false, onClear: () => setClosed([]) }}
        />
      </div>
    </AppHeaderHost>
  );
}

function ClearPhone({ armed = false }: { armed?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (armed) root.current?.querySelector<HTMLButtonElement>('[data-slot="hill-clear"]')?.click();
  }, [armed, round]);
  return (
    <div ref={root}>
      {armed && (
        <CardControls>
          <button type="button" className="rounded-md border border-border px-2 py-1 text-[11px] font-medium" onClick={() => setRound((n) => n + 1)}>
            Arm again
          </button>
        </CardControls>
      )}
      <Phone height={560}>
        <RootRouter data={homeSolo}>
          <ClearBody />
        </RootRouter>
      </Phone>
    </div>
  );
}

/** The Hill switched off: the route's header and its off state, the bar without the Hill item under it. */
function HillOffPhone() {
  const [on, setOn] = useState(false);
  return (
    <Phone height={620}>
      <RootRouter data={homeSolo}>
        <AppHeaderHost bridge="connected" error={false}>
          <HillHeader count={0} nowCount={0} onBack={noSend} off={!on} />
          <div data-pg-scroll className="min-h-0 flex-1 overflow-y-auto p-4">
            {on ? <HillView open={[]} closed={[]} kept={NO_KEPT} renderCard={() => null} /> : <HillOff canWrite busy={false} onTurnOn={() => setOn(true)} />}
          </div>
          <HillBar open={on ? 0 : null} />
        </AppHeaderHost>
      </RootRouter>
    </Phone>
  );
}

/** The row in Settings → Alerts, in a 390px column, with a switch that flips in place. */
function SwitchRow({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  return (
    <div className="w-[390px] max-w-full bg-background p-4">
      <HillSwitchCard on={on} disabled={false} onToggle={setOn} />
    </div>
  );
}

/** The Dashboard's bar with the Hill item, as `routes/home.tsx` builds it, with `open` Decisions (null: the Hill is off). */
function HillBar({ open }: { open: number | null }) {
  return (
    <DashboardTabBar
      view="dashboard"
      onSelect={noSend}
      crew
      files
      blockedCount={herd.filter((pane) => pane.status === "blocked").length}
      readyUnseen={false}
      hill={open}
      onOpenHill={noSend}
      tabbarParts={[]}
      sessions={[]}
      onOpenSession={noSend}
    />
  );
}

/** The Dashboard with the Hill item in its bar, as `routes/home.tsx` draws it. */
function DashboardPhone() {
  const [order, setOrder] = useState<PaneOrder>("place");
  return (
    <Phone height={720}>
      <RootRouter data={homeSolo}>
        <AppHeaderHost bridge="connected" error={false}>
          <RouteHeader wordmark width="column" />
          <div data-pg-scroll className="min-h-0 flex-1 overflow-y-auto">
            <AgentList
              agents={herd}
              shellPanes={[]}
              bridge="connected"
              onOpen={noSend}
              tabs={tabs}
              order={order}
              onOrderChange={setOrder}
              isolated={[]}
              hidden={[]}
              onIsolate={noSend}
              onToggleHidden={noSend}
              needsYouOnly={false}
              onNeedsYouOnlyChange={noSend}
            />
          </div>
          <HillBar open={sevenOpen.length} />
        </AppHeaderHost>
      </RootRouter>
    </Phone>
  );
}

const undeliverableId = closedRows.find((row) => row.state === "undeliverable")?.id ?? "";

/** Card 24: the three images with a body, so More has something to open beside the row. */
const withImagesAndBody: HillDecision = { ...threeImages, body: "The new header keeps the count line in every state." };

// ── The chosen look, on the option's own data (2026-11-10) ───────────────────────────────────────────
// The owner picked B1, C1 and A5 from the "Hill look" section. These screens mount the REAL components
// on that section's fixtures (`../hill-look/fixtures.ts`, cases a to d), so a shot of an option and a
// shot of the build compare one to one: `?case=<case>&match=<B1|C1|A5>#hill` draws one over the whole
// screen, as the look section's `solo` does.

type MatchId = "B1" | "C1" | "A5";
const MATCHES: readonly MatchId[] = ["B1", "C1", "A5"];

function isMatchId(word: string | null): word is MatchId {
  return MATCHES.some((m) => m === word);
}

/** The real card with the look section's tints and trick icons. */
function MatchCard({ decision }: { decision: HillDecision }) {
  const { from } = decision;
  return (
    <DecisionCard
      decision={decision}
      answer={HILL_IDLE}
      onSend={noSend}
      mediaSource={playgroundMedia}
      hostSlot={from.kind === "agent" && from.host !== null ? (LOOK_HOST_SLOT.get(from.host) ?? null) : null}
      trickIcon={from.trickId === null ? undefined : TRICK_ICON_OF.get(from.trickId)}
    />
  );
}

/** B1's list: the case's open Decisions as real cards, in the option's own list frame. */
function MatchCards({ c }: { c: HillCase }) {
  return (
    <div data-pg-scroll className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 [&>*]:shrink-0">
      {c.open.map((d) => (
        <MatchCard key={d.id} decision={d} />
      ))}
    </div>
  );
}

/** C1: the real header and view. */
function MatchView({ c }: { c: HillCase }) {
  return (
    <RootRouter data={homeSolo}>
      <AppHeaderHost bridge="connected" error={false}>
        <HillHeader count={c.open.length} nowCount={c.open.filter((d) => d.priority === "now").length} onBack={noSend} />
        <div data-pg-scroll className="min-h-0 flex-1 overflow-y-auto p-4">
          <HillView open={c.open} closed={c.closed} kept={NO_KEPT} renderCard={(d) => <MatchCard key={d.id} decision={d} />} />
        </div>
      </AppHeaderHost>
    </RootRouter>
  );
}

/** The case's tricks as `dashboard` parts in a store of their own, so the real strip draws them. */
function useCaseTricksStore(c: HillCase): TricksStore {
  const store = useMemo(() => {
    const infos: WireTrickInfo[] = c.tricks.map((trick) => ({ host: "bluefin", id: trick.id, name: trick.name, icon: trick.icon, on: true, state: "ok", places: ["dashboard"] }));
    const asOf = new Date().toISOString();
    const parts: WireTrickPart[] = c.tricks.map((trick) => {
      const item: PlaceItem = { icon: trick.icon, label: trick.name };
      if (trick.count !== undefined) item.badge = trick.count;
      if (trick.tone !== undefined) item.tone = trick.tone;
      return { host: "bluefin", trick: trick.id, part: "dashboard", rev: 1, value: { at: "dashboard", id: "dashboard", item }, asOf, fresh: "1h" };
    });
    return createTricksStore({
      fetchTricks: () => Promise.resolve({ rev: 1, tricks: infos, parts, present: parts.map(partKey) }),
      tapTrick: (_host, _trick, body) => Promise.resolve({ rid: body.rid, code: "ok" }),
      mintRequestId,
    });
  }, [c]);
  useEffect(() => {
    void store.syncTricks(1);
  }, [store]);
  return store;
}

/** A5: the real Dashboard, the tricks' tiles at the top, the Hill as the bar's fourth item. */
function MatchDashboard({ c }: { c: HillCase }) {
  const [order, setOrder] = useState<PaneOrder>("place");
  const store = useCaseTricksStore(c);
  return (
    <RootRouter data={homeSolo}>
      <AppHeaderHost bridge="connected" error={false}>
        <RouteHeader wordmark width="column" />
        <div data-pg-scroll className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <TrickDashboardStrip sessions={[]} onOpenSession={noSend} store={store} />
          <AgentList
            agents={herd}
            shellPanes={[]}
            bridge="connected"
            onOpen={noSend}
            tabs={tabs}
            order={order}
            onOrderChange={setOrder}
            isolated={[]}
            hidden={[]}
            onIsolate={noSend}
            onToggleHidden={noSend}
            needsYouOnly={false}
            onNeedsYouOnlyChange={noSend}
          />
        </div>
        <DashboardTabBar
          view="dashboard"
          onSelect={noSend}
          crew
          files
          blockedCount={herd.filter((pane) => pane.status === "blocked").length}
          readyUnseen={false}
          hill={c.open.length}
          hillNow={c.open.some((d) => d.priority === "now")}
          onOpenHill={noSend}
          tabbarParts={[]}
          sessions={[]}
          onOpenSession={noSend}
        />
      </AppHeaderHost>
    </RootRouter>
  );
}

function MatchScreen({ id, c }: { id: MatchId; c: HillCase }) {
  if (id === "B1") return <MatchCards c={c} />;
  if (id === "C1") return <MatchView c={c} />;
  return <MatchDashboard c={c} />;
}

function matchParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

/** One match screen over the whole page, for a phone and for the shots. */
function MatchSolo({ id, caseId }: { id: MatchId; caseId: CaseId }) {
  const style: CSSProperties & { "--app-h"?: string } = { "--app-h": "100dvh" };
  return (
    <div className="fixed inset-0 z-[60] flex flex-col overflow-hidden bg-background text-foreground" style={style}>
      <MatchScreen id={id} c={CASE_DATA[caseId]} />
    </div>
  );
}

function MatchGroup() {
  const asked = matchParam("case");
  const [caseId, setCaseId] = useState<CaseId>(isCaseId(asked) ? asked : "busy");
  return (
    <>
      <div className="sticky top-0 z-40 -mx-4 bg-background/95 px-4 py-2 backdrop-blur-sm">
        <Segmented name="Case" value={caseId} options={CASES} onChange={setCaseId} />
      </div>
      <Group title="The chosen look, on the option's data">
      {MATCHES.map((id) => (
        <Card key={id} state={`hill-match-${id.toLowerCase()}`} label={`${id} built`}>
          <CardControls className="flex items-center gap-3">
            <a href={`?case=${caseId}&match=${id}#hill`} className="text-sm font-semibold text-foreground underline">
              {id} built, full screen
            </a>
          </CardControls>
          <Phone height={760}>
            <MatchScreen key={caseId} id={id} c={CASE_DATA[caseId]} />
          </Phone>
        </Card>
      ))}
      </Group>
    </>
  );
}


// ── The rough card (2026-11-10) ─────────────────────────────────────────────────────────────────────
// The owner's card on a 360 px phone, word for word, the stress card with every view kind in long
// words, a portrait shot beside a wide one, and the review card of 2026-11-10 (42).
// `?card=<rough|stress|mixed|review>#hill` draws one card over
// the whole screen at the window's own width, so a shot at 360 or 390 px is the phone's; `&open=1`
// opens the view's fold first.

const ROUGH_CARDS = { rough: roughCard, stress: stressCard, mixed: mixedImages, review: reviewCard } as const;
type RoughId = keyof typeof ROUGH_CARDS;

function isRoughId(word: string | null): word is RoughId {
  return word === "rough" || word === "stress" || word === "mixed" || word === "review";
}

/** The card with its view's "Show all" tapped once, as the person would, when `open` is set. */
function RoughCard({ decision, open }: { decision: HillDecision; open: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // The fold is measured after the first paint: tap it on the next frame.
    const frame = requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('[data-slot="decision-view-more"]')?.click());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  return (
    <div ref={root}>
      <PlaygroundCard decision={decision} />
    </div>
  );
}

/** One rough card over the whole page, at the window's width, on the page's own gutter. The page scrolls, so a full-page shot holds the whole card. */
function RoughSolo({ id, open }: { id: RoughId; open: boolean }) {
  return (
    <div className="absolute inset-x-0 top-0 z-[60] min-h-[100dvh] bg-background p-4 text-foreground">
      <RoughCard decision={ROUGH_CARDS[id]} open={open} />
    </div>
  );
}

/** The moment of answering, live, in a phone: the pretend bridge's delay, and a way to start over. */
function MotionCard() {
  const [net, setNet] = useState<Net>("quick");
  const [round, setRound] = useState(0);
  return (
    <>
      <CardControls className="flex flex-wrap items-center gap-3">
        <Segmented name="Network" value={net} options={NETS} onChange={setNet} />
        <button type="button" className="rounded-md border border-border px-2 py-1 text-[11px] font-medium" onClick={() => setRound((n) => n + 1)}>
          Start over
        </button>
        <a href={`?motion=1&net=${net}#hill`} className="text-sm font-semibold text-foreground underline">
          Full screen
        </a>
      </CardControls>
      <Phone height={760}>
        <MotionHill key={`${net}:${round}`} net={net} height={760} />
      </Phone>
    </>
  );
}

/** The live Hill over the whole page, at the window's own size, for a phone and for frame-by-frame shots. */
function MotionSolo() {
  const net = matchParam("net");
  return (
    <div className="fixed inset-0 z-[60] flex flex-col overflow-hidden bg-background">
      <MotionHill net={isNet(net) ? net : "quick"} answered={matchParam("answered") === "1"} />
    </div>
  );
}

export function HillSection() {
  if (matchParam("motion") === "1") return <MotionSolo />;
  const match = matchParam("match");
  const asked = matchParam("case");
  const rough = matchParam("card");
  if (isRoughId(rough)) return <RoughSolo id={rough} open={matchParam("open") === "1"} />;
  if (isMatchId(match)) return <MatchSolo id={match} caseId={isCaseId(asked) ? asked : "busy"} />;
  return (
    <Section def={DEF}>
      <MatchGroup />
      <Group title="The card">
        <Card state="hill-card-recommended" label="1: two options, recommended">
          <CardHead n={1} title="Two options, recommended" />
          <OneCard decision={twoOptions} />
        </Card>
        <Card state="hill-card-confirm" label="2: three options, one confirm">
          <CardHead n={2} title="Three options, one confirm" />
          <OneCard decision={threeWithConfirm} />
        </Card>
        <Card state="hill-card-armed" label="3: confirm armed">
          <CardHead n={3} title="Confirm armed" />
          <ArmedCard />
        </Card>
        <Card state="hill-card-text-only" label="4: text only">
          <CardHead n={4} title="Text only" />
          <OneCard decision={textOnly} />
        </Card>
        <Card state="hill-card-text-required" label="5: text required">
          <CardHead n={5} title="Text required" />
          <OneCard decision={textRequired} />
        </Card>
        <Card state="hill-card-body" label="6: body and links">
          <CardHead n={6} title="Body and links" />
          <OneCard decision={withBody} />
        </Card>
        <Card state="hill-card-unattended" label="7: target runs unattended">
          <CardHead n={7} title="Target runs unattended" />
          <OneCard decision={unattended} />
        </Card>
        <Card state="hill-card-rich" label="28: the rich Decision">
          <CardHead n={28} title="The rich Decision" />
          <OneCard decision={rich} />
        </Card>
        <Card state="hill-card-more-open" label="29: More open">
          <CardHead n={29} title="More open" />
          <OpenedCard decision={rich} toggle="decision-more" />
        </Card>
        <Card state="hill-card-note-open" label="30: Add a note open">
          <CardHead n={30} title="Add a note open" />
          <OpenedCard decision={twoOptions} toggle="decision-note" />
        </Card>
      </Group>

      <Group title="Images">
        <Card state="hill-card-image-one" label="22: one image">
          <CardHead n={22} title="One image" />
          <OneCard decision={oneImage} />
        </Card>
        <Card state="hill-card-image-three" label="23: three images">
          <CardHead n={23} title="Three images" />
          <OneCard decision={threeImages} />
        </Card>
        <Card state="hill-card-image-body" label="24: three images, body open">
          <CardHead n={24} title="Three images, body open" />
          <OpenedCard decision={withImagesAndBody} toggle="decision-more" />
        </Card>
        <Card state="hill-card-image-failed" label="25: image not available">
          <CardHead n={25} title="Image not available" />
          <OneCard decision={brokenImage} />
        </Card>
      </Group>

      <Group title="A view under the summary">
        <Card state="hill-card-view-gates" label="32: a gate strip">
          <CardHead n={32} title="A gate strip" />
          <OneCard decision={gateStrip} />
        </Card>
        <Card state="hill-card-view-diff" label="33: a diff summary">
          <CardHead n={33} title="A diff summary" />
          <OneCard decision={diffSummary} />
        </Card>
        <Card state="hill-card-view-image" label="37: one picture, zoomed in">
          <CardHead n={37} title="One picture, zoomed in" />
          <OneCard decision={placedImage} />
        </Card>
        <Card state="hill-card-view-compare" label="38: before and after">
          <CardHead n={38} title="Before and after" />
          <OneCard decision={compareShots} />
        </Card>
        <Card state="hill-card-view-table" label="39: a small table">
          <CardHead n={39} title="A small table" />
          <OneCard decision={tableCard} />
        </Card>
        <Card state="hill-card-view-diff-lines" label="40: a hunk as a diff">
          <CardHead n={40} title="A hunk as a diff" />
          <OneCard decision={diffCard} />
        </Card>
        <Card state="hill-card-view-spark" label="41: figures with a trend">
          <CardHead n={41} title="Figures with a trend" />
          <OneCard decision={sparkCard} />
        </Card>
        <Card state="hill-card-view-review" label="42: a review card">
          <CardHead n={42} title="A review card, composed" />
          <OneCard decision={reviewCard} />
        </Card>
      </Group>

      <Group title="Rough edges, at the narrowest phone">
        <Card state="hill-card-rough" label="34: the rough card">
          <CardHead n={34} title="The rough card: two phone shots, five word steps, four rows" />
          <OneCard decision={roughCard} />
        </Card>
        <Card state="hill-card-stress" label="35: every view kind, long words">
          <CardHead n={35} title="Every view kind, long words" />
          <OneCard decision={stressCard} />
        </Card>
        <Card state="hill-card-mixed-images" label="36: a phone shot and a wide one">
          <CardHead n={36} title="A phone shot and a wide one" />
          <OneCard decision={mixedImages} />
        </Card>
      </Group>

      <Group title="The moment of answering, live">
        <Card state="hill-motion" label="46: answer and dismiss, live">
          <CardHead n={46} title="Answer, confirm, dismiss and retry on ten cards: the whole motion" />
          <MotionCard />
        </Card>
      </Group>

      <Group title="After the tap">
        <Card state="hill-card-sending" label="8: sending">
          <CardHead n={8} title="Sending" />
          <OneCard decision={twoOptions} answer={{ phase: "sending", intent: "yes", text: null }} />
        </Card>
        <Card state="hill-card-typed" label="9: sent, typed">
          <CardHead n={9} title="Sent, typed" />
          <OneCard decision={twoOptions} answer={answered(receipts.typed)} />
        </Card>
        <Card state="hill-card-held" label="10: sent, held">
          <CardHead n={10} title="Sent, held" />
          <OneCard decision={twoOptions} answer={answered(receipts.held)} />
        </Card>
        <Card state="hill-card-unknown" label="11: sent, not confirmed">
          <CardHead n={11} title="Sent, not confirmed" />
          <OneCard decision={twoOptions} answer={answered(receipts.unknown)} />
        </Card>
        <Card state="hill-card-rejected" label="12: rejected">
          <CardHead n={12} title="Rejected" />
          <OneCard decision={textRequired} answer={answered(receipts.rejected, "main")} />
        </Card>
        <Card state="hill-card-gone" label="13: gone, words kept">
          <CardHead n={13} title="Gone, words kept" />
          <OneCard decision={twoOptions} answer={answered(receipts.gone, "yes", goneText)} />
        </Card>
        <Card state="hill-card-denied" label="14: device denied">
          <CardHead n={14} title="Device denied" />
          <OneCard decision={twoOptions} answer={answered(receipts.denied)} />
        </Card>
        <Card state="hill-card-failed" label="15: not sent, retry">
          <CardHead n={15} title="Not sent, retry" />
          <OneCard decision={twoOptions} answer={{ phase: "failed", intent: "yes", text: goneText }} />
        </Card>
        <Card state="hill-card-dismissed" label="16: dismissed">
          <CardHead n={16} title="Dismissed" />
          <OneCard decision={twoOptions} answer={answered({ ...receipts.typed, delivery: "none", state: "dismissed" }, "dismiss")} />
        </Card>
      </Group>

      <Group title="The view">
        <Card state="hill-view-quiet" label="31: quiet, two cards">
          <CardHead n={31} title="Quiet, two cards" />
          <HillPhone open={quietOpen} closed={closedRows} />
        </Card>
        <Card state="hill-view-seven" label="17: busy, eight cards">
          <CardHead n={17} title="Busy, eight cards" />
          <HillPhone open={busyOpen} closed={closedRows} />
        </Card>
        <Card state="hill-view-empty" label="18: empty">
          <CardHead n={18} title="Empty" />
          <HillPhone open={[]} closed={[]} />
        </Card>
        <Card state="hill-view-closed" label="19: closed rows">
          <CardHead n={19} title="Closed rows" />
          <HillPhone open={[]} closed={closedRows} kept={new Map([[undeliverableId, keptWords]])} unfold />
        </Card>
      </Group>

      <Group title="Clear">
        <Card state="hill-clear-idle" label="47: Clear, idle">
          <CardHead n={47} title="Clear on the closed group, idle: two taps clear it" />
          <ClearPhone />
        </Card>
        <Card state="hill-clear-armed" label="48: Clear, armed">
          <CardHead n={48} title="Clear, armed: tap again to confirm" />
          <ClearPhone armed />
        </Card>
      </Group>

      <Group title="The way in">
        <Card state="hill-entry-bar" label="20: the Hill in the bar">
          <CardHead n={20} title="The Hill in the bar: none, 1 and 7 open" />
          <Phone>
            <div className="flex flex-col gap-3 py-4">
              <HillBar open={0} />
              <HillBar open={1} />
              <HillBar open={7} />
            </div>
          </Phone>
        </Card>
        <Card state="hill-entry-dashboard" label="21: dashboard with the Hill">
          <CardHead n={21} title="Dashboard with the Hill" />
          <DashboardPhone />
        </Card>
      </Group>

      <Group title="The switch">
        <Card state="hill-switch-on" label="43: Settings row, on">
          <CardHead n={43} title="Settings → Alerts: the Hill on" />
          <SwitchRow initial />
        </Card>
        <Card state="hill-switch-off" label="44: Settings row, off">
          <CardHead n={44} title="Settings → Alerts: the Hill off" />
          <SwitchRow initial={false} />
        </Card>
        <Card state="hill-off" label="45: the Hill, switched off">
          <CardHead n={45} title="The Hill switched off: no Hill item in the bar" />
          <HillOffPhone />
        </Card>
      </Group>

      <Group title="A trick's decision">
        <Card state="hill-card-trick" label="26: a trick, no target">
          <CardHead n={26} title="A trick, no target" />
          <OneCard decision={trickOpen} />
        </Card>
        <Card state="hill-card-trick-ran" label="27: a trick recorded it">
          <CardHead n={27} title="A trick recorded it" />
          <OneCard decision={trickOpen} answer={answered({ ...receipts.typed, delivery: "none", trick: "ran" })} />
        </Card>
      </Group>
    </Section>
  );
}
