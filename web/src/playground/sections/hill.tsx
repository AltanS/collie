// The hill section of the states playground (M96): the Decision card in each state, the Hill view, and
// the Dashboard's way in. Every card mounts the REAL component (`DecisionCard`, `HillView`,
// `HillHeader`, `HillEntryRow`) with fixtures shaped by the wire (`fixtures/hill/decisions.ts`). There
// is no bridge behind this page: a card's state is fixed, and a tap on a live card answers nothing.
// The cards wear the machine tints of a two-machine crew (bluefin and minibuch), as `LiveDecisionCard`
// would hand them on one.
//
// Cards are numbered 1 to 31.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { AgentList } from "@/components/agent-list";
import { AppHeaderHost, RouteHeader } from "@/components/app-header";
import { DecisionCard } from "@/components/decision-card";
import { HillEntryRow, HillHeader, HillView } from "@/components/hill-view";
import { HILL_IDLE, type HillAnswerState } from "@/hooks/use-hill-answer";
import type { HillDecision, HillReceipt } from "@/lib/hill/wire";
import { sortOpenDecisions } from "@/lib/hill/wire";
import type { PaneOrder } from "@/lib/pane-order";

import { herd, homeSolo, tabs } from "../fixtures";
import {
  brokenImage,
  busyOpen,
  closedRows,
  goneText,
  keptWords,
  oneImage,
  playgroundMedia,
  quietOpen,
  receipts,
  rich,
  sevenOpen,
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
import { Card, CardControls, Group, Section, type SectionDef } from "../layout";

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

/** The Dashboard with the hill's row above the list, as `routes/home.tsx` draws it. */
function DashboardPhone() {
  const [order, setOrder] = useState<PaneOrder>("place");
  const top = sortOpenDecisions([...sevenOpen])[0]!;
  return (
    <Phone height={720}>
      <RootRouter data={homeSolo}>
        <AppHeaderHost bridge="connected" error={false}>
          <RouteHeader wordmark width="column" />
          <div data-pg-scroll className="min-h-0 flex-1 overflow-y-auto">
            <div className="px-4 pt-3">
              <HillEntryRow count={sevenOpen.length} title={top.title} onOpen={noSend} />
            </div>
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
        </AppHeaderHost>
      </RootRouter>
    </Phone>
  );
}

const undeliverableId = closedRows.find((row) => row.state === "undeliverable")?.id ?? "";

/** Card 24: the three images with a body, so More has something to open beside the row. */
const withImagesAndBody: HillDecision = { ...threeImages, body: "The new header keeps the count line in every state." };

export function HillSection() {
  return (
    <Section def={DEF}>
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

      <Group title="The way in">
        <Card state="hill-entry-row" label="20: dashboard row">
          <CardHead n={20} title="Dashboard row" />
          <Phone>
            <div className="flex flex-col gap-3 p-4">
              <HillEntryRow count={1} title={twoOptions.title} onOpen={noSend} />
              <HillEntryRow count={7} title={twoOptions.title} onOpen={noSend} />
            </div>
          </Phone>
        </Card>
        <Card state="hill-entry-dashboard" label="21: dashboard with row">
          <CardHead n={21} title="Dashboard with row" />
          <DashboardPhone />
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
