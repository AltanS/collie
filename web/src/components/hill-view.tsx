import { useId, useState, type ReactNode } from "react";

import { RouteHeader } from "@/components/app-header";
import { DecisionCard, KeptWords } from "@/components/decision-card";
import { Icon } from "@/components/icons/icon";
import { SectionHeader } from "@/components/section-header";
import { StatusDot } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { ListGroup, LIST_ROW_CORNERS } from "@/components/ui/list-group";
import { useHillAnswer } from "@/hooks/use-hill-answer";
import { useLocale } from "@/hooks/use-locale";
import type { HillDecision } from "@/lib/hill/wire";
import { answerLine, stateWord } from "@/lib/hill/words";
import { t, tn } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// THE HILL (M96): the open Decisions agents posted, as cards, most urgent first, and under them a fold
// "Answered" with the closed ones the bridge serves. One view, its own route (`/hill`), reached from
// the Dashboard's row while something is open. "Hill" is the view's name, the same in every language.
//
// This file draws; it reads nothing. The route hands it the store's lists (lib/hill/store.ts) and a
// card for each decision, so the playground can hand it fixtures and fixed card states instead.

/** The header: back to the Dashboard, the title, and how many need you under it while any do. */
export function HillHeader({ count, onBack }: { count: number; onBack: () => void }) {
  useLocale();
  return (
    <RouteHeader
      width="column"
      override={
        <>
          <Button
            variant="ghost"
            size="icon"
            // 44px, the tap floor every control in this row shares. size="icon" alone is 36px.
            className="size-11"
            onClick={onBack}
            aria-label={t("hill.back")}
          >
            <Icon name="back" className="size-5" />
          </Button>
          <div className="flex min-w-0 flex-col">
            <h1 className="min-w-0 truncate text-lg font-semibold leading-tight tracking-tight">{t("hill.title")}</h1>
            {count > 0 && (
              <p data-slot="hill-count" className="truncate text-xs text-muted-foreground tabular-nums">
                {tn("hill.count", count)}
              </p>
            )}
          </div>
        </>
      }
    />
  );
}

/** One closed decision under Answered: its title, its state in words, and for an answer where it went. */
function ClosedRow({ decision, kept }: { decision: HillDecision; kept: string | undefined }) {
  // The closed list holds closed decisions only (lib/hill/reader.ts); an open one would have no words here.
  if (decision.state === "open") return null;
  const word = stateWord(decision.state);
  const line = decision.state === "answered" && decision.answer !== null ? `${word} · ${answerLine(decision)}` : word;
  return (
    <li data-slot="hill-closed-row" data-state={decision.state} className="flex min-w-0 flex-col gap-0.5 px-3.5 py-2.5">
      <span className="font-content truncate text-sm font-medium">{decision.title}</span>
      <span data-slot="hill-closed-line" className="truncate text-xs text-muted-foreground">
        {line}
      </span>
      {kept !== undefined && (
        <div className="pt-1.5">
          <KeptWords text={kept} />
        </div>
      )}
    </li>
  );
}

/**
 * The view's body: the cards, or the empty state, then the Answered fold. `renderCard` draws one open
 * decision (`renderCard`); `kept` holds the words of answers that did not reach their target, per decision.
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
  const [answeredOpen, setAnsweredOpen] = useState(false);
  const answeredId = useId();
  return (
    <div className="flex flex-col gap-6">
      {open.length === 0 ? (
        <div data-slot="hill-empty" className="flex flex-col gap-1 py-6">
          <p className="text-sm font-medium text-muted-foreground">{t("hill.empty.title")}</p>
          <p className="text-sm text-muted-foreground">{t("hill.empty.body")}</p>
        </div>
      ) : (
        <div data-slot="hill-open" className="flex flex-col gap-3">
          {open.map((decision) => renderCard(decision))}
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

/** A card wired to the bridge: its answer state and its send come from `useHillAnswer`. */
export function LiveDecisionCard({ decision }: { decision: HillDecision }) {
  const { state, send } = useHillAnswer(decision.id);
  return <DecisionCard decision={decision} answer={state} onSend={(intent, text) => void send(intent, text)} />;
}

/**
 * The Dashboard's way in (M96): one row at the top of the list, drawn only while a Decision is open.
 * "3 Decisions need you", the most urgent one's title under it, and a chevron; a tap opens the Hill.
 * The row is the Programs section's own flat row in a `ListGroup`, the needs-you mark in front.
 * Whether it is drawn at all is the caller's (`routes/home.tsx`, through `Collapse`).
 */
export function HillEntryRow({ count, title, onOpen }: { count: number; title: string; onOpen: () => void }) {
  useLocale();
  return (
    <ListGroup>
      <button
        type="button"
        data-slot="hill-entry"
        onClick={onOpen}
        className={cn("w-full text-left transition-colors hover:bg-muted/50 active:scale-[0.99]", LIST_ROW_CORNERS)}
      >
        <div className={cn("flex flex-row items-center gap-3 px-3.5 py-2.5", LIST_ROW_CORNERS)}>
          <StatusDot status="blocked" className="size-2.5" />
          <div className="min-w-0 flex-1">
            <div data-slot="hill-entry-count" className="flex h-5 min-w-0 items-center truncate font-medium tabular-nums">
              {tn("hill.entry", count)}
            </div>
            <div data-slot="hill-entry-title" className="font-content h-4 min-w-0 truncate text-xs leading-4 text-muted-foreground">
              {title}
            </div>
          </div>
          <Icon name="row-go" aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </div>
      </button>
    </ListGroup>
  );
}
