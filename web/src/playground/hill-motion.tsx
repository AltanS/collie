// The moment of answering, live (2026-11-10): the real Hill (`HillHeader`, `HillView`, `DecisionCard`)
// over ten open Decisions, with a pretend bridge behind it that answers after a chosen delay. A tap on an
// option, a confirm or Dismiss runs the whole sequence the phone runs (lib/hill/motion.ts): the chosen
// option in place, the options giving way to "Sending…" and the receipt, the card leaving, the cards
// below gliding up, and the closed row growing in at the top of Answered. "Fails once" makes the first
// send of each card fail, so Try again is there to tap.
//
// `?motion=1#hill` draws it over the whole screen, for a phone and for frame-by-frame shots, with
// `&net=quick|slow|fail` and `&answered=1` (Answered unfolded).

import { useEffect, useRef, useState, type CSSProperties } from "react";

import { AppHeaderHost } from "@/components/app-header";
import { DashboardTabBar } from "@/components/dashboard-tab-bar";
import { DecisionCard } from "@/components/decision-card";
import { HillHeader, HillView } from "@/components/hill-view";
import { HILL_IDLE, type HillAnswerState } from "@/hooks/use-hill-answer";
import { HILL_LIST_READ_AFTER_MS } from "@/lib/hill/motion";
import { sortOpenDecisions, type HillDecision, type HillReceipt } from "@/lib/hill/wire";

import { homeSolo } from "./fixtures";
import { closedRows, later, playgroundMedia, textOnly, textRequired, threeWithConfirm, trickOpen, twoOptions, unattended, withBody } from "./fixtures/hill/decisions";
import { RootRouter } from "./harness";

export type Net = "quick" | "slow" | "fail";
export const NETS: readonly { value: Net; label: string }[] = [
  { value: "quick", label: "Quick (60 ms)" },
  { value: "slow", label: "Slow (1.2 s)" },
  { value: "fail", label: "Fails once" },
];

export function isNet(word: string | null): word is Net {
  return word === "quick" || word === "slow" || word === "fail";
}

const DELAY = { quick: 60, slow: 1200, fail: 600 } as const satisfies Record<Net, number>;
/** How long the pretend list read takes after it is asked for. */
const READ_MS = 40;

const noop = () => {};

/** Ten open Decisions with ids of their own, one alone under Now, so a group can leave with its card. */
function tenOpen(): HillDecision[] {
  const base: [HillDecision, Partial<HillDecision>][] = [
    [twoOptions, { priority: "now", title: "Ship 1.29.0 to Edge first?" }],
    [threeWithConfirm, { priority: "today" }],
    [twoOptions, { priority: "today", title: "Merge the Hill motion branch?", summary: "The leave and the arrive are one motion now. Tests are green." }],
    [withBody, { priority: "today" }],
    [unattended, { priority: "today" }],
    [textOnly, { priority: "today" }],
    [trickOpen, { priority: "today" }],
    [textRequired, { priority: "later" }],
    [later, { priority: "later" }],
    [twoOptions, { priority: "later", title: "Rename the dev lane's unit?", summary: "collie-next becomes collie-dev. The old name stays as an alias." }],
  ];
  return base.map(([decision, over], i) => Object.assign({}, decision, over, { id: `dc_motion${String(i + 1).padStart(5, "0")}` }));
}

function receiptFor(intent: string): HillReceipt {
  const dismissed = intent === "dismiss";
  return { rid: "motion", code: "ok", reason: null, state: dismissed ? "dismissed" : "answered", delivery: dismissed ? "none" : "typed", trick: "none", at: Date.now() };
}

function closedVersion(decision: HillDecision, intent: string, text: string | null): HillDecision {
  const at = Date.now();
  if (intent === "dismiss") return { ...decision, state: "dismissed", closedAt: at };
  const label = decision.options.find((o) => o.intent === intent)?.label ?? null;
  return { ...decision, state: "answered", closedAt: at, answer: { rid: "motion", intent, label, text, by: "phone", at, delivery: "typed", trick: "none" } };
}

/** The pretend bridge: open, closed, and where each card's answer is. */
function useMotionHill(net: Net) {
  const [open, setOpen] = useState<HillDecision[]>(() => sortOpenDecisions(tenOpen()));
  const [closed, setClosed] = useState<HillDecision[]>(() => [...closedRows]);
  const [answers, setAnswers] = useState<ReadonlyMap<string, HillAnswerState>>(new Map());
  const failed = useRef(new Set<string>());
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);

  const after = (ms: number, run: () => void) => timers.current.push(window.setTimeout(run, ms));
  const setAnswer = (id: string, state: HillAnswerState) => setAnswers((m) => new Map(m).set(id, state));

  const send = (decision: HillDecision) => (intent: string, text: string | null) => {
    const tappedAt = Date.now();
    setAnswer(decision.id, { phase: "sending", intent, text });
    after(DELAY[net], () => {
      if (net === "fail" && !failed.current.has(decision.id)) {
        failed.current.add(decision.id);
        setAnswer(decision.id, { phase: "failed", intent, text });
        return;
      }
      setAnswer(decision.id, { phase: "answered", intent, text, receipt: receiptFor(intent) });
      // As `useHillAnswer` does: the list is read HILL_LIST_READ_AFTER_MS after the tap, and lands a read later.
      after(Math.max(0, tappedAt + HILL_LIST_READ_AFTER_MS - Date.now()) + READ_MS, () => {
        setOpen((list) => list.filter((d) => d.id !== decision.id));
        setClosed((list) => [closedVersion(decision, intent, text), ...list]);
      });
    });
  };

  return { open, closed, answers, send };
}

const NO_KEPT: ReadonlyMap<string, string> = new Map();

/** The Hill's screen: header, the scrolling list, the bottom bar with the Hill's count. A new `key` starts it over. */
export function MotionHill({ net, answered = false, height }: { net: Net; answered?: boolean; height?: number }) {
  const style: CSSProperties & { "--app-h"?: string } = height === undefined ? { "--app-h": "100dvh" } : { height, "--app-h": `${height}px` };
  return (
    <div data-slot="hill-motion" className="flex min-h-0 flex-1 flex-col bg-background text-foreground" style={style}>
      {/* The router keeps the element it was made with, so the state lives in the body, inside it. */}
      <RootRouter data={homeSolo}>
        <AppHeaderHost bridge="connected" error={false}>
          <MotionBody net={net} answered={answered} />
        </AppHeaderHost>
      </RootRouter>
    </div>
  );
}

function MotionBody({ net, answered }: { net: Net; answered: boolean }) {
  const hill = useMotionHill(net);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (answered) scroller.current?.querySelector<HTMLButtonElement>('[data-slot="hill-answered"] button[aria-expanded="false"]')?.click();
  }, [answered]);
  const nowCount = hill.open.filter((d) => d.priority === "now").length;
  return (
    <>
      <HillHeader count={hill.open.length} nowCount={nowCount} onBack={noop} />
      <div ref={scroller} data-pg-scroll data-slot="hill-scroll" className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-4">
        <HillView
          open={hill.open}
          closed={hill.closed}
          kept={NO_KEPT}
          renderCard={(decision) => (
            <DecisionCard key={decision.id} decision={decision} answer={hill.answers.get(decision.id) ?? HILL_IDLE} onSend={hill.send(decision)} mediaSource={playgroundMedia} />
          )}
        />
      </div>
      <DashboardTabBar
        view="dashboard"
        onSelect={noop}
        crew
        files
        blockedCount={0}
        readyUnseen={false}
        hill={hill.open.length}
        hillNow={nowCount > 0}
        onOpenHill={noop}
        tabbarParts={[]}
        sessions={[]}
        onOpenSession={noop}
      />
    </>
  );
}
