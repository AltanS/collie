import { useId, useState, type ReactNode } from "react";

import { RouteHeader } from "@/components/app-header";
import { BrandMark } from "@/components/brand-mark";
import { useCrew } from "@/components/crew-provider";
import { DecisionCard, KeptWords } from "@/components/decision-card";
import { HillPriorityGlyph, PRIORITY_INK } from "@/components/hill-priority";
import { Icon } from "@/components/icons/icon";
import type { IconKey } from "@/components/icons/keys";
import { SectionHeader } from "@/components/section-header";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { ListGroup } from "@/components/ui/list-group";
import { useHillAnswer } from "@/hooks/use-hill-answer";
import { useLocale } from "@/hooks/use-locale";
import { HILL_PRIORITIES, type HillDecision, type HillState } from "@/lib/hill/wire";
import { answerLine, priorityWord, stateWord } from "@/lib/hill/words";
import { hostSlot } from "@/lib/hosts";
import { t, tn } from "@/lib/i18n";
import { useTricksState } from "@/lib/tricks/store";
import { cn } from "@/lib/utils";

// THE HILL (M96): the open Decisions agents and tricks posted, as cards, grouped by priority (Now,
// Today, Later), and under them a fold "Answered" with the closed ones the bridge serves. One view, its
// own route (`/hill`), reached from the Dashboard's row while something is open. "Hill" is the view's
// name, the same in every language. The look is calm, by priority (the owner's pick, C1, 2026-11-09).
//
// This file draws; it reads nothing but the crew roster and the tricks list, for a card's machine tint
// and a trick's icon. The route hands it the store's lists (lib/hill/store.ts) and a card for each
// decision, so the playground can hand it fixtures and fixed card states instead.

/**
 * The header: back to the Dashboard, the Hill's mountain mark, the title, and one line under it that
 * is always there ("3 open · 1 now", or "All clear"), so a count arriving or leaving moves nothing.
 */
export function HillHeader({ count, nowCount, onBack }: { count: number; nowCount: number; onBack: () => void }) {
  useLocale();
  const line = count === 0 ? t("hill.clear") : nowCount > 0 ? `${tn("hill.open", count)} · ${t("hill.now", { count: nowCount })}` : tn("hill.open", count);
  return (
    <RouteHeader
      width="column"
      override={
        <>
          <Button
            variant="ghost"
            size="icon"
            // 44px, the tap floor every control in this row shares. size="icon" alone is 36px.
            className="size-11 shrink-0"
            onClick={onBack}
            aria-label={t("hill.back")}
          >
            <Icon name="back" className="size-5" />
          </Button>
          {/* The mark is a disc because it is as wide as it is tall (DESIGN.md §3). Neutral ink: the count line says `now`. */}
          <span aria-hidden data-slot="hill-mark" className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-card text-foreground">
            <Icon name="hill" className="size-5" />
          </span>
          <div className="ml-1 flex min-w-0 flex-col">
            <h1 className="min-w-0 truncate text-lg font-semibold leading-tight tracking-tight">{t("hill.title")}</h1>
            <p data-slot="hill-count" className="truncate text-xs text-muted-foreground tabular-nums">
              {line}
            </p>
          </div>
        </>
      }
    />
  );
}

/** A closed Decision's state as a glyph, so the Answered list reads before its words do. */
const STATE_GLYPH = {
  answered: "answered",
  dismissed: "decision-dismissed",
  expired: "time",
  withdrawn: "decision-withdrawn",
  superseded: "decision-superseded",
  undeliverable: "error",
} as const satisfies Record<Exclude<HillState, "open">, IconKey>;

/** One closed decision under Answered: its state glyph, its title, its state in words, and for an answer where it went. */
function ClosedRow({ decision, kept }: { decision: HillDecision; kept: string | undefined }) {
  // The closed list holds closed decisions only (lib/hill/reader.ts); an open one would have no words here.
  if (decision.state === "open") return null;
  const word = stateWord(decision.state);
  const line = decision.state === "answered" && decision.answer !== null ? `${word} · ${answerLine(decision)}` : word;
  return (
    <li data-slot="hill-closed-row" data-state={decision.state} className="flex min-w-0 items-start gap-3 px-3.5 py-2.5">
      <Icon
        name={STATE_GLYPH[decision.state]}
        aria-hidden
        className={cn("mt-0.5 size-4 shrink-0", decision.state === "answered" ? "text-status-done" : "text-muted-foreground")}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-content truncate text-sm font-medium">{decision.title}</span>
        <span data-slot="hill-closed-line" className="truncate text-xs text-muted-foreground">
          {line}
        </span>
        {kept !== undefined && (
          <div className="pt-1.5">
            <KeptWords text={kept} />
          </div>
        )}
      </div>
    </li>
  );
}

/** The empty hill: a ridge drawn as one traced line, the mark resting on its top, and the words. */
function HillClear({ answered }: { answered: number }) {
  return (
    <div data-slot="hill-empty" className="flex flex-col items-center gap-4 pb-2 pt-8 text-center">
      <div aria-hidden className="relative h-[104px] w-[248px]">
        <svg viewBox="0 0 248 104" className="absolute inset-0 size-full">
          <path d="M4 100 L58 56 L84 74 L138 26 L170 54 L196 40 L244 100 Z" className="fill-muted stroke-rule" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        {/* On the top peak (138, 26): the mark's 52px box, its feet on the ridge line. */}
        <span className="absolute left-[112px] top-[-22px]">
          <BrandMark size={52} state="rest" />
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-base font-semibold">{t("hill.empty.title")}</p>
        <p className="text-sm text-muted-foreground">{answered > 0 ? tn("hill.empty.answered", answered) : t("hill.empty.body")}</p>
      </div>
    </div>
  );
}

/** One priority's cards under its heading: the three peaks, the word, how many. */
function PriorityGroup({ priority, decisions, renderCard }: { priority: HillDecision["priority"]; decisions: readonly HillDecision[]; renderCard: (decision: HillDecision) => ReactNode }) {
  const headingId = useId();
  return (
    <section data-slot="hill-group" data-priority={priority} aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="flex items-center gap-2 text-sm font-semibold">
        <HillPriorityGlyph priority={priority} surface="background" decorative />
        <span className={PRIORITY_INK[priority]}>{priorityWord(priority)}</span>
        <span className="tabular-nums text-muted-foreground">{decisions.length}</span>
      </h2>
      {decisions.map((decision) => renderCard(decision))}
    </section>
  );
}

/**
 * The view's body: the cards by priority, or the empty hill, then the Answered fold. `renderCard`
 * draws one open decision; `kept` holds the words of answers that did not reach their target, per
 * decision. `open` comes sorted (most urgent first, then oldest), and each group keeps that order.
 * With nothing open the fold starts open, because then it is all the hill has to show.
 */
export function HillView({
  open,
  closed,
  kept,
  renderCard,
}: {
  open: readonly HillDecision[];
  closed: readonly HillDecision[];
  kept: ReadonlyMap<string, string>;
  renderCard: (decision: HillDecision) => ReactNode;
}) {
  useLocale();
  const [answeredOpen, setAnsweredOpen] = useState(open.length === 0);
  const answeredId = useId();
  return (
    <div className="flex flex-col gap-7">
      {open.length === 0 ? (
        <HillClear answered={closed.filter((d) => d.state === "answered").length} />
      ) : (
        <div data-slot="hill-open" className="flex flex-col gap-7">
          {HILL_PRIORITIES.map((priority) => {
            const group = open.filter((d) => d.priority === priority);
            return group.length === 0 ? null : <PriorityGroup key={priority} priority={priority} decisions={group} renderCard={renderCard} />;
          })}
        </div>
      )}
      {closed.length > 0 && (
        <section data-slot="hill-answered" className="flex flex-col gap-2">
          <SectionHeader
            label={t("hill.answered")}
            count={closed.length}
            open={answeredOpen}
            onToggle={setAnsweredOpen}
            controls={answeredId}
          />
          <Collapse open={answeredOpen}>
            <ListGroup as="ul" id={answeredId}>
              {closed.map((decision) => (
                <ClosedRow key={decision.id} decision={decision} kept={kept.get(decision.id)} />
              ))}
            </ListGroup>
          </Collapse>
        </section>
      )}
    </div>
  );
}

/**
 * A card wired to the bridge: its answer state and its send come from `useHillAnswer`, the machine's
 * tint from the crew roster (none on a solo install), and a trick's icon from the tricks list.
 */
export function LiveDecisionCard({ decision }: { decision: HillDecision }) {
  const { state, send } = useHillAnswer(decision.id);
  const { servers } = useCrew();
  const { tricks } = useTricksState();
  const { from } = decision;
  const trickIcon = from.kind === "trick" ? tricks.find((trick) => trick.id === from.trickId)?.icon : undefined;
  return (
    <DecisionCard
      decision={decision}
      answer={state}
      onSend={(intent, text) => void send(intent, text)}
      hostSlot={hostSlot(servers, from.memberId ?? undefined)}
      trickIcon={trickIcon}
    />
  );
}
