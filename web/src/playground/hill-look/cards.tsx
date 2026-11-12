// Part B of the "Hill look" round: the Decision card. B0 is today's card (the real `DecisionCard`);
// B1 to B3 are three directions built on the same behaviour (`useDecisionAnswer`, the real
// `OptionButton` with its armed second tap). DEV-ONLY.

import { useId, type ReactNode } from "react";

import { DecisionCard } from "@/components/decision-card";
import { Icon } from "@/components/icons/icon";
import { MarkdownText } from "@/components/markdown-text";
import { NoPromptsBadge } from "@/components/no-prompts-badge";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { HILL_IDLE } from "@/hooks/use-hill-answer";
import type { HillDecision } from "@/lib/hill/wire";
import { cn } from "@/lib/utils";

import { playgroundMedia } from "../fixtures/hill/decisions";
import {
  AnswerField,
  DecisionOption,
  DismissButton,
  goesTo,
  HostLine,
  ImageStrip,
  PeakGlyph,
  PRIORITY_WORD,
  SenderMark,
  sideBySide,
  useAge,
  useDecisionAnswer,
  type DecisionAnswer,
} from "./parts";

export type CardId = "B0" | "B1" | "B2" | "B3";

const noSend = () => {};

/**
 * Two quiet taps on one row: "More" opens the body and the links, "Add a note" opens an optional
 * note. Each part arrives through Collapse (DESIGN.md §11). A required answer is not behind a tap.
 */
function Tools({ decision, answer, className, placeholder }: { decision: HillDecision; answer: DecisionAnswer; className?: string; placeholder?: string }) {
  const bodyId = useId();
  const noteId = useId();
  const hasMore = decision.body.trim() !== "" || decision.links.length > 0;
  const optional = decision.text === "optional";
  if (!hasMore && !optional) return null;
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="-mx-3 flex items-center justify-between">
        {hasMore ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={answer.moreOpen}
            aria-controls={bodyId}
            onClick={() => answer.setMoreOpen(!answer.moreOpen)}
            className="h-11 px-3 text-muted-foreground"
          >
            {answer.moreOpen ? "Less" : "More"}
            <Icon name="expand" aria-hidden className={cn("transition-transform motion-reduce:transition-none", answer.moreOpen && "rotate-180")} />
          </Button>
        ) : (
          <span />
        )}
        {optional && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={answer.noteOpen}
            aria-controls={noteId}
            onClick={() => answer.setNoteOpen(!answer.noteOpen)}
            className="h-11 px-3 text-muted-foreground"
          >
            <Icon name="add-note" aria-hidden />
            Add a note
          </Button>
        )}
      </div>
      <Collapse open={answer.moreOpen}>
        <div id={bodyId} className="flex flex-col gap-2 pb-2">
          {decision.body.trim() !== "" && <MarkdownText text={decision.body} showLinkTargets />}
          {decision.links.map((link) => (
            <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center gap-2 text-sm font-medium">
              <Icon name="open-external" aria-hidden className="size-4 text-muted-foreground" />
              <span className="font-content truncate">{link.label}</span>
            </a>
          ))}
        </div>
      </Collapse>
      {optional && (
        <Collapse open={answer.noteOpen}>
          <div id={noteId} className="flex flex-col gap-2 pb-2">
            <AnswerField decision={decision} answer={answer} placeholder={placeholder} />
            {decision.options.length > 0 && <p className="text-xs text-muted-foreground">The note goes with the option you tap.</p>}
            <SendWords decision={decision} answer={answer} />
          </div>
        </Collapse>
      )}
    </div>
  );
}

/** A required written answer: always open, with its hint and Send. */
function Required({ decision, answer, placeholder }: { decision: HillDecision; answer: DecisionAnswer; placeholder?: string }) {
  if (decision.text !== "required") return null;
  return (
    <div className="flex flex-col gap-2">
      <AnswerField decision={decision} answer={answer} placeholder={placeholder} />
      <RequiredHint decision={decision} />
      <SendWords decision={decision} answer={answer} />
    </div>
  );
}

/** Send, for a written answer: the primary act when there are no options, else the outline one. */
function SendWords({ decision, answer }: { decision: HillDecision; answer: DecisionAnswer }) {
  if (decision.text === "none") return null;
  return (
    <Button
      type="button"
      variant={decision.options.length === 0 ? "default" : "outline"}
      disabled={answer.text === null}
      onClick={answer.sendWords}
      className="h-11 w-full"
    >
      <Icon name="send" aria-hidden />
      Send answer
    </Button>
  );
}

function RequiredHint({ decision }: { decision: HillDecision }) {
  if (decision.text !== "required" || decision.options.length === 0) return null;
  return <p className="text-xs text-muted-foreground">Write your answer first. A button sends it with your choice.</p>;
}

function Unattended({ decision }: { decision: HillDecision }) {
  if (decision.target?.unattended !== true) return null;
  return <NoPromptsBadge label="runs without prompts" className="h-5 px-1.5 py-0 text-[11px] leading-none" />;
}

// ── B1: calm and typographic ────────────────────────────────────────────────────────────────────────
// Air, a bigger title, the summary in a reading size, the advice set as a quote between two rules,
// numbered options like the terminal's own menu. Identity is a small mark in the meta line.

export function CardCalm({ decision }: { decision: HillDecision }) {
  const answer = useDecisionAnswer(decision);
  const age = useAge(decision.at);
  const rec = answer.recommended;
  return (
    <article aria-label={`Decision: ${decision.title}`} className="flex flex-col gap-4 rounded-md border border-border bg-card p-5 shadow-xs">
      <header className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <PeakGlyph priority={decision.priority} />
        <span className={cn("shrink-0 font-semibold", decision.priority === "now" ? "text-status-working" : "text-foreground")}>{PRIORITY_WORD[decision.priority]}</span>
        <span aria-hidden className="text-border">|</span>
        <SenderMark decision={decision} className="size-4" />
        <span className="min-w-0 truncate text-foreground">{decision.from.label}</span>
        <HostLine decision={decision} className="shrink" />
        <span className="ml-auto shrink-0 tabular-nums">{age}</span>
      </header>

      <div className="flex flex-col gap-1.5">
        <h3 className="font-content text-[19px] font-semibold leading-snug tracking-tight text-balance">{decision.title}</h3>
        <p className="font-content line-clamp-3 text-[15px] leading-relaxed text-muted-foreground">{decision.summary}</p>
      </div>

      <ImageStrip decision={decision} />

      {decision.recommends !== null && rec !== undefined && (
        <figure className="flex flex-col gap-1.5 border-y border-border py-3">
          <blockquote className="font-content text-[15px] leading-relaxed text-foreground">
            <span aria-hidden className="mr-0.5 text-muted-foreground">“</span>
            {decision.recommends.why}
            <span aria-hidden className="ml-0.5 text-muted-foreground">”</span>
          </blockquote>
          <figcaption className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Icon name="recommended" aria-hidden className="size-3.5 text-status-working" />
            <span>
              {decision.from.label} suggests <span className="font-semibold text-foreground">{rec.label}</span>
            </span>
          </figcaption>
        </figure>
      )}

      <Tools decision={decision} answer={answer} className="-my-2" />

      {decision.options.length > 0 && (
        <div className="flex flex-col gap-2">
          {decision.options.map((option, i) => (
            <DecisionOption
              key={option.intent}
              option={option}
              answer={answer}
              keyLabel={i + 1}
              className="min-h-12 px-3"
              trailing={
                <span aria-hidden className="flex size-4 shrink-0 items-center justify-center text-status-working">
                  {rec?.intent === option.intent ? <Icon name="recommended" className="size-3.5" /> : null}
                </span>
              }
            />
          ))}
        </div>
      )}

      <Required decision={decision} answer={answer} />

      <footer className="-mb-2 flex min-w-0 items-center gap-2">
        <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{goesTo(decision)}</span>
          <Unattended decision={decision} />
        </p>
        <DismissButton answer={answer} className="-mr-3" />
      </footer>
    </article>
  );
}

// ── B2: the sender carries the card ───────────────────────────────────────────────────────────────
// It opens with who asks, their mark large, the machine in its colour, the priority as a stamp. The
// advice is the agent's own line beside its mark, and the option it picked carries that mark too. A
// `now` card wears the caution ink on its whole edge, uniform on four sides.

function Stamp({ decision, className }: { decision: HillDecision; className?: string }) {
  const p = decision.priority;
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-sm border px-1.5 text-[11px] font-semibold",
        p === "now" ? "border-status-working/50 text-status-working" : p === "today" ? "border-border text-foreground" : "border-border text-muted-foreground",
        className,
      )}
    >
      <PeakGlyph priority={p} className="h-2.5 w-[15px]" />
      {PRIORITY_WORD[p]}
    </span>
  );
}

export function CardSender({ decision, grouped = false }: { decision: HillDecision; grouped?: boolean }) {
  const answer = useDecisionAnswer(decision);
  const age = useAge(decision.at);
  const rec = answer.recommended;
  const two = sideBySide(decision.options);
  return (
    <article
      aria-label={`Decision: ${decision.title}`}
      className={cn("flex flex-col rounded-md border bg-card shadow-sm", decision.priority === "now" ? "border-status-working/50" : "border-border")}
    >
      {grouped ? (
        // Inside a sender's group the group heading already says who asks: the card keeps the stamp and the age.
        <header className="flex min-w-0 items-center gap-2 px-4 pt-3.5">
          <Stamp decision={decision} />
          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{age}</span>
        </header>
      ) : (
        <header className="flex min-w-0 items-center gap-3 px-4 pb-1 pt-4">
          <SenderMark decision={decision} className="size-10" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[15px] font-semibold leading-tight">{decision.from.label}</span>
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <HostLine decision={decision} />
              <span aria-hidden>·</span>
              <span className="shrink-0 tabular-nums">{age}</span>
            </span>
          </div>
          <Stamp decision={decision} />
        </header>
      )}

      <div className={cn("flex flex-col gap-3 px-4 pb-2", grouped ? "pt-2" : "pt-3")}>
        <div className="flex flex-col gap-1">
          <h3 className="font-content text-[17px] font-semibold leading-snug">{decision.title}</h3>
          <p className="font-content line-clamp-3 text-sm leading-relaxed text-foreground/85">{decision.summary}</p>
        </div>

        <ImageStrip decision={decision} size="lg" />

        {decision.recommends !== null && rec !== undefined && (
          <div className="flex items-start gap-2">
            <SenderMark decision={decision} className="mt-0.5 size-6" />
            <div className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2">
              <p className="text-sm">
                <span className="text-muted-foreground">My pick: </span>
                <span className="font-semibold">{rec.label}</span>
              </p>
              <p className="font-content text-[13px] leading-snug text-muted-foreground">{decision.recommends.why}</p>
            </div>
          </div>
        )}

        <Tools decision={decision} answer={answer} className="-my-1" placeholder={`A note for ${decision.from.label}`} />

        {decision.options.length > 0 && (
          <div className={cn("grid gap-2", two ? "grid-cols-2" : "grid-cols-1")}>
            {decision.options.map((option) => (
              <DecisionOption
                key={option.intent}
                option={option}
                answer={answer}
                className="min-h-12 px-3"
                trailing={
                  rec?.intent === option.intent ? (
                    <SenderMark decision={decision} className="size-4" iconClassName="size-3" />
                  ) : (
                    <span aria-hidden className="size-4 shrink-0" />
                  )
                }
              />
            ))}
          </div>
        )}

        <Required decision={decision} answer={answer} placeholder={`Answer ${decision.from.label}`} />
      </div>

      <footer className="flex min-w-0 items-center gap-2 border-t border-border px-4">
        <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 py-2 text-xs text-muted-foreground">
          <Icon name="send" aria-hidden className="size-3 shrink-0" />
          <span>{decision.target === null ? `To the ${decision.from.label} trick` : `To ${decision.target.label}${decision.target.host === null ? "" : ` on ${decision.target.host}`}`}</span>
          <Unattended decision={decision} />
        </p>
        <DismissButton answer={answer} className="-mr-3" />
      </footer>
    </article>
  );
}

// ── B3: a ticket from the agent ───────────────────────────────────────────────────────────────────
// The top half is the request, filed like a slip: From, Asked, Goes to, the subject, the picture
// strip, the pick. A perforation with two notches, then the stub you answer on. Sharp, mono id.

function SlipRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-px text-[11px] text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5 text-[13px]">{children}</dd>
    </>
  );
}

export function CardTicket({ decision }: { decision: HillDecision }) {
  const answer = useDecisionAnswer(decision);
  const age = useAge(decision.at);
  const rec = answer.recommended;
  return (
    <article aria-label={`Decision: ${decision.title}`} className="relative flex flex-col overflow-hidden rounded-md border border-rule bg-card shadow-sm">
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <span className="label-caps text-[10px] font-semibold tracking-[0.08em] text-muted-foreground">Decision</span>
          <span className="font-mono text-[11px] text-muted-foreground">#{decision.id.slice(-6)}</span>
          <span
            className={cn(
              "ml-auto inline-flex h-6 items-center gap-1.5 rounded-sm border px-1.5 text-[10px] font-bold uppercase tracking-[0.08em]",
              decision.priority === "now" ? "border-status-working text-status-working" : decision.priority === "today" ? "border-foreground/60 text-foreground" : "border-border text-muted-foreground",
            )}
          >
            <PeakGlyph priority={decision.priority} className="h-2.5 w-[15px]" />
            {PRIORITY_WORD[decision.priority]}
          </span>
        </div>

        <dl className="grid grid-cols-[3.25rem_1fr] gap-x-2 gap-y-1">
          <SlipRow label="From">
            <SenderMark decision={decision} className="size-4" />
            <span className="truncate font-medium">{decision.from.label}</span>
            <HostLine decision={decision} className="text-xs text-muted-foreground" />
          </SlipRow>
          <SlipRow label="Asked">
            <span className="tabular-nums text-muted-foreground">{age} ago</span>
          </SlipRow>
        </dl>

        <div className="flex flex-col gap-1 pt-1">
          <h3 className="font-content text-lg font-semibold leading-snug">{decision.title}</h3>
          <p className="font-content line-clamp-3 text-sm leading-relaxed text-muted-foreground">{decision.summary}</p>
        </div>

        <ImageStrip decision={decision} size="sm" />

        {decision.recommends !== null && rec !== undefined && (
          <div className="flex flex-col gap-0.5 rounded-sm border border-dashed border-border px-3 py-2">
            <p className="flex items-center gap-1.5 text-sm">
              <Icon name="recommended" aria-hidden className="size-3.5 text-status-working" />
              <span className="text-muted-foreground">Recommends</span>
              <span className="font-semibold">{rec.label}</span>
            </p>
            <p className="font-content text-[13px] leading-snug text-muted-foreground">{decision.recommends.why}</p>
          </div>
        )}

        <Tools decision={decision} answer={answer} className="-my-2" />
      </div>

      {/* The perforation: a dashed rule and two notches cut from the card's edge. The notch is a circle
          of the page colour, half of it clipped by the card, so only its inner half shows. */}
      <div aria-hidden className="relative mx-3 h-0 border-t border-dashed border-rule">
        <span className="absolute -left-[25px] -top-[11px] size-[22px] rounded-full border border-rule bg-background" />
        <span className="absolute -right-[25px] -top-[11px] size-[22px] rounded-full border border-rule bg-background" />
      </div>

      <div className="flex flex-col gap-2 p-4 pt-4">
        {decision.options.length > 0 && (
          <div className="grid grid-cols-1 gap-2">
            {decision.options.map((option, i) => (
              <DecisionOption
                key={option.intent}
                option={option}
                answer={answer}
                keyLabel={String.fromCharCode(65 + i)}
                className="min-h-12"
                trailing={
                  <span aria-hidden className="flex size-4 shrink-0 items-center justify-center text-status-working">
                    {rec?.intent === option.intent ? <Icon name="recommended" className="size-3.5" /> : null}
                  </span>
                }
              />
            ))}
          </div>
        )}
        <Required decision={decision} answer={answer} />
        <div className="-mb-2 flex min-w-0 items-center gap-2">
          <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{goesTo(decision)}</span>
            <Unattended decision={decision} />
          </p>
          <DismissButton answer={answer} className="-mr-3" />
        </div>
      </div>
    </article>
  );
}

/** One card in the option's look. */
export function LookCard({ option, decision }: { option: CardId; decision: HillDecision }) {
  if (option === "B1") return <CardCalm decision={decision} />;
  if (option === "B2") return <CardSender decision={decision} />;
  if (option === "B3") return <CardTicket decision={decision} />;
  return <DecisionCard decision={decision} answer={HILL_IDLE} onSend={noSend} mediaSource={playgroundMedia} />;
}
