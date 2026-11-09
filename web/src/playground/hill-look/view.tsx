// Part C of the "Hill look" round: the Hill view. C0 is today's view (the real `HillHeader` and
// `HillView` with the real card). C1 is calm, grouped by priority, with the B1 card; C2 is
// sender-first, grouped by who asks, with the B2 card. DEV-ONLY.

import { Flag, Mountain, MountainSnow } from "lucide-react";
import { useId, useState } from "react";

import { AppHeaderHost, RouteHeader } from "@/components/app-header";
import { BrandMark } from "@/components/brand-mark";
import { DecisionCard } from "@/components/decision-card";
import { HillHeader, HillView } from "@/components/hill-view";
import { Icon } from "@/components/icons/icon";
import type { IconKey } from "@/components/icons/keys";
import { SectionHeader } from "@/components/section-header";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { ListGroup } from "@/components/ui/list-group";
import { HILL_IDLE } from "@/hooks/use-hill-answer";
import type { HillDecision, HillPriority } from "@/lib/hill/wire";
import { answerLine, stateWord } from "@/lib/hill/words";
import { cn } from "@/lib/utils";

import { homeSolo } from "../fixtures";
import { playgroundMedia } from "../fixtures/hill/decisions";
import { RootRouter } from "../harness";
import { CardCalm, CardSender } from "./cards";
import type { HillCase } from "./fixtures";
import { HostLine, PeakGlyph, PRIORITY_WORD, SenderMark, useAge } from "./parts";

export type ViewId = "C0" | "C1" | "C2";

const noop = () => {};
const NO_KEPT: ReadonlyMap<string, string> = new Map();

function BackButton() {
  return (
    <Button variant="ghost" size="icon" className="size-11 shrink-0" onClick={noop} aria-label="Back to the Dashboard">
      <Icon name="back" className="size-5" />
    </Button>
  );
}

/** The state of a closed Decision as a glyph, so the Answered list reads before its words do. */
const STATE_GLYPH = {
  answered: "answered",
  dismissed: "dismiss",
  expired: "time",
  withdrawn: "back",
  superseded: "mod-icon-refresh",
  undeliverable: "error",
} as const satisfies Record<Exclude<HillDecision["state"], "open">, IconKey>;

function ClosedLine({ decision }: { decision: HillDecision }) {
  if (decision.state === "open") return null;
  const word = stateWord(decision.state);
  return <>{decision.state === "answered" && decision.answer !== null ? `${word} · ${answerLine(decision)}` : word}</>;
}

/** The Answered fold: the real SectionHeader opening a list, open from the start when nothing else is on the hill. */
function AnsweredFold({ closed, startOpen, look }: { closed: readonly HillDecision[]; startOpen: boolean; look: "calm" | "sender" }) {
  const [open, setOpen] = useState(startOpen);
  const id = useId();
  if (closed.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <SectionHeader label="Answered" count={closed.length} open={open} onToggle={setOpen} controls={id} />
      <Collapse open={open}>
        <ListGroup as="ul" id={id}>
          {closed.map((d) => (
            <li key={d.id}>{look === "calm" ? <C1Closed decision={d} /> : <C2Closed decision={d} />}</li>
          ))}
        </ListGroup>
      </Collapse>
    </section>
  );
}

// ── C1: calm, by priority ─────────────────────────────────────────────────────────────────────────

function C1Header({ c }: { c: HillCase }) {
  const now = c.open.filter((d) => d.priority === "now").length;
  return (
    <RouteHeader
      width="column"
      override={
        <>
          <BackButton />
          <span aria-hidden className={cn("flex size-9 shrink-0 items-center justify-center rounded-full border bg-card", now > 0 ? "border-status-working/60" : "border-border")}>
            <Mountain className={cn("size-5", now > 0 ? "text-status-working" : "text-foreground")} strokeWidth={1.75} />
          </span>
          <div className="ml-1 flex min-w-0 flex-col">
            <h1 className="truncate text-lg font-semibold leading-tight tracking-tight">Hill</h1>
            <p className="truncate text-xs tabular-nums text-muted-foreground">
              {c.open.length === 0 ? "All clear" : `${c.open.length} open${now > 0 ? ` · ${now} now` : ""}`}
            </p>
          </div>
        </>
      }
    />
  );
}

/** The empty hill: a ridge drawn as one traced line, the mark resting on the top. */
function C1Empty({ answered }: { answered: number }) {
  return (
    <div className="flex flex-col items-center gap-4 pb-2 pt-8 text-center">
      <div className="relative h-[104px] w-[248px]">
        <svg aria-hidden viewBox="0 0 248 104" className="absolute inset-0 h-full w-full">
          <path d="M4 100 L58 56 L84 74 L138 26 L170 54 L196 40 L244 100 Z" className="fill-muted stroke-rule" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        <span className="absolute left-[112px] top-[-22px]">
          <BrandMark size={52} state="rest" />
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-base font-semibold">The hill is clear.</p>
        <p className="text-sm text-muted-foreground">{answered > 0 ? `${answered} answered. Nothing waits on you.` : "Nothing waits on you."}</p>
      </div>
    </div>
  );
}

function C1Closed({ decision }: { decision: HillDecision }) {
  if (decision.state === "open") return null;
  return (
    <div className="flex min-w-0 items-start gap-3 px-3.5 py-2.5">
      <Icon name={STATE_GLYPH[decision.state]} aria-hidden className={cn("mt-0.5 size-4 shrink-0", decision.state === "answered" ? "text-status-done" : "text-muted-foreground")} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-content truncate text-sm font-medium">{decision.title}</span>
        <span className="truncate text-xs text-muted-foreground">
          <ClosedLine decision={decision} />
        </span>
      </div>
    </div>
  );
}

const ORDER: readonly HillPriority[] = ["now", "today", "later"];

function C1Body({ c }: { c: HillCase }) {
  return (
    <div className="flex flex-col gap-7">
      {c.open.length === 0 ? (
        <C1Empty answered={c.closed.filter((d) => d.state === "answered").length} />
      ) : (
        ORDER.map((p) => {
          const group = c.open.filter((d) => d.priority === p);
          if (group.length === 0) return null;
          return (
            <section key={p} className="flex flex-col gap-3">
              <h2 className="flex items-center gap-2 text-[13px] font-semibold">
                <PeakGlyph priority={p} />
                <span className={p === "now" ? "text-status-working" : "text-foreground"}>{PRIORITY_WORD[p]}</span>
                <span className="tabular-nums text-muted-foreground">{group.length}</span>
              </h2>
              {group.map((d) => (
                <CardCalm key={d.id} decision={d} />
              ))}
            </section>
          );
        })
      )}
      <AnsweredFold closed={c.closed} startOpen={c.open.length === 0} look="calm" />
    </div>
  );
}

// ── C2: who asks, grouped by sender ───────────────────────────────────────────────────────────────

function sendersOf(open: readonly HillDecision[]): HillDecision[][] {
  const groups = new Map<string, HillDecision[]>();
  for (const d of open) {
    const k = d.from.kind === "trick" ? `trick:${d.from.trickId}` : `agent:${d.from.label}:${d.from.host}`;
    const list = groups.get(k) ?? [];
    list.push(d);
    groups.set(k, list);
  }
  return [...groups.values()];
}

function C2Header({ c }: { c: HillCase }) {
  const senders = sendersOf(c.open).map((g) => g[0]!);
  const now = c.open.some((d) => d.priority === "now");
  const Peak = now ? MountainSnow : Mountain;
  return (
    <RouteHeader
      width="column"
      override={
        <>
          <BackButton />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Peak aria-hidden className="size-6 shrink-0 text-foreground" strokeWidth={1.75} />
            <h1 className="truncate text-lg font-semibold leading-tight tracking-tight">Hill</h1>
            {c.open.length > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-sm bg-foreground px-1.5 text-[11px] font-semibold tabular-nums text-background">{c.open.length}</span>
            )}
          </div>
          {senders.length > 0 && (
            <div aria-label={`${senders.length} asking`} className="mr-2 flex shrink-0 items-center">
              {senders.map((d, i) => (
                <SenderMark key={d.id} decision={d} className={cn("size-6", i > 0 && "ml-1")} />
              ))}
            </div>
          )}
        </>
      }
    />
  );
}

function C2Empty({ c }: { c: HillCase }) {
  const answered = c.closed.filter((d) => d.state === "answered").length;
  return (
    <div className="flex flex-col items-center gap-3 pb-2 pt-8 text-center">
      <div className="relative h-24 w-40">
        <svg aria-hidden viewBox="0 0 160 96" className="absolute inset-0 h-full w-full">
          <path d="M8 92 L80 20 L152 92 Z" className="fill-card stroke-rule" strokeWidth="2" strokeLinejoin="round" />
          <path d="M58 42 L80 20 L102 42 L91 36 L80 44 L69 36 Z" className="fill-muted stroke-rule" strokeWidth="2" strokeLinejoin="round" />
        </svg>
        <Flag aria-hidden className="absolute left-[78px] top-[-6px] size-7 text-status-done" strokeWidth={2} />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-base font-semibold">Top of the hill.</p>
        <p className="text-sm text-muted-foreground">Every Decision is answered.</p>
      </div>
      {answered > 0 && (
        <p className="flex items-center gap-1.5 rounded-sm border border-border px-2 py-1 text-xs tabular-nums text-muted-foreground">
          <Icon name="answered" aria-hidden className="size-3.5 text-status-done" />
          {answered} answered today
        </p>
      )}
    </div>
  );
}

function C2Closed({ decision }: { decision: HillDecision }) {
  const age = useAge(decision.closedAt ?? decision.at);
  if (decision.state === "open") return null;
  return (
    <div className="flex min-w-0 items-center gap-3 px-3.5 py-2.5">
      <span className="relative shrink-0">
        <SenderMark decision={decision} className="size-6" />
        <span className="absolute -bottom-1 -right-1 flex size-3.5 items-center justify-center rounded-full border border-border bg-card">
          <Icon name={STATE_GLYPH[decision.state]} aria-hidden className={cn("size-2.5", decision.state === "answered" ? "text-status-done" : "text-muted-foreground")} />
        </span>
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-content truncate text-sm font-medium">{decision.title}</span>
        <span className="truncate text-xs text-muted-foreground">
          <ClosedLine decision={decision} />
        </span>
      </div>
      <span className="shrink-0 self-start text-xs tabular-nums text-muted-foreground">{age}</span>
    </div>
  );
}

function C2Body({ c }: { c: HillCase }) {
  const groups = sendersOf(c.open);
  return (
    <div className="flex flex-col gap-7">
      {c.open.length === 0 ? (
        <C2Empty c={c} />
      ) : (
        groups.map((g) => {
          const first = g[0]!;
          return (
            <section key={first.id} className="flex flex-col gap-3">
              <h2 className="flex min-w-0 items-center gap-2">
                <SenderMark decision={first} className="size-6" />
                <span className="truncate text-[15px] font-semibold">{first.from.label}</span>
                <HostLine decision={first} className="text-xs text-muted-foreground" />
                <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{g.length}</span>
              </h2>
              {g.map((d) => (
                <CardSender key={d.id} decision={d} grouped />
              ))}
            </section>
          );
        })
      )}
      <AnsweredFold closed={c.closed} startOpen={c.open.length === 0} look="sender" />
    </div>
  );
}

/** The whole view in its frame, header included. */
export function HillLookView({ option, c }: { option: ViewId; c: HillCase }) {
  return (
    <RootRouter data={homeSolo}>
      <AppHeaderHost bridge="connected" error={false}>
        {option === "C0" && <HillHeader count={c.open.length} nowCount={c.open.filter((d) => d.priority === "now").length} onBack={noop} />}
        {option === "C1" && <C1Header c={c} />}
        {option === "C2" && <C2Header c={c} />}
        <div data-pg-scroll className="min-h-0 flex-1 overflow-y-auto p-4">
          {option === "C0" && (
            <HillView open={c.open} closed={c.closed} kept={NO_KEPT} renderCard={(d) => <DecisionCard key={d.id} decision={d} answer={HILL_IDLE} onSend={noop} mediaSource={playgroundMedia} />} />
          )}
          {option === "C1" && <C1Body c={c} />}
          {option === "C2" && <C2Body c={c} />}
        </div>
      </AppHeaderHost>
    </RootRouter>
  );
}
