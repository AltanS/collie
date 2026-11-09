import { useEffect, useId, useState, useSyncExternalStore } from "react";

import { HillBodyImages, HillCardImage, hillMediaSource, type HillMediaSource } from "@/components/hill-media";
import { Icon } from "@/components/icons/icon";
import { MarkdownText } from "@/components/markdown-text";
import { NoPromptsBadge } from "@/components/no-prompts-badge";
import { OptionButton } from "@/components/option-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapse } from "@/components/ui/collapse";
import { CopyableBlock } from "@/components/ui/copyable-block";
import { ListGroup } from "@/components/ui/list-group";
import { Notice, type NoticeTone } from "@/components/ui/notice";
import { OneOf } from "@/components/ui/one-of";
import { useArm } from "@/hooks/use-arm";
import type { HillAnswerState } from "@/hooks/use-hill-answer";
import { useLocale } from "@/hooks/use-locale";
import { cacheClockNow, subscribeCacheClock } from "@/lib/cache-clock";
import { linkHost } from "@/lib/hill/reader";
import type { HillDecision, HillOption, HillPriority, HillReceipt } from "@/lib/hill/wire";
import { HILL_ANSWER_TEXT_MAX } from "@/lib/hill/wire";
import { ageWords, priorityWord, receiptWords, targetLabel, targetLine } from "@/lib/hill/words";
import { t } from "@/lib/i18n";
import { onBridgeClock } from "@/lib/server-clock";
import { cn } from "@/lib/utils";

// A DECISION, AS A CARD ON THE HILL (M96).
//
// An agent posted a question with its options, and the person answers it here. Top to bottom: the
// meta line (priority, who posted it, its machine, how old it is), the title, the summary, the
// recommendation when the poster made one, "More" for the body and the links, the options, the text
// field, the line that says where the answer goes, and a quiet Dismiss at the card's end. A decision
// with images shows the first under the summary; a tap on it opens "More", where every image is drawn
// in order (components/hill-media.tsx).
//
// ── IT WEARS THE APP'S OWN PIECES ──────────────────────────────────────────────────────────────────
// The card is `ui/card.tsx`, the panel the Machines list and the Settings cards are; its options are
// the `OptionButton` rows a program's ask and a permission card answer with, so a question from an
// agent reads the same wherever it is asked; what happened after a tap is a `Notice` box in the card
// (DESIGN.md §11, a contextual notice); the body is Chat's own Markdown, with its link rules. Every
// string the poster wrote is `font-content`, never the app's face (DESIGN.md §5).
//
// ── NOTHING IS CHOSEN FOR THE PERSON ───────────────────────────────────────────────────────────────
// The recommended option carries a small mark and the line above says which one and why. It is never
// pre-selected and never focused: a recommendation the person does not read must not become the
// answer by default.
//
// ── ARM, THEN SEND ─────────────────────────────────────────────────────────────────────────────────
// An option with `confirm` asks for a second tap: the first one arms it, the button shows the confirm
// word in the armed tint (DESIGN.md §4) for ARM_MS, a tap inside ARM_DWELL_MS is the same touch landing
// twice, and the second tap after it sends (`useArm`, the belt Stop's rule). One button of a card is
// armed at a time, Dismiss included, which asks for its own second tap the same way.
//
// ── THE CARD SAYS WHAT HAPPENED, IN PLACE ──────────────────────────────────────────────────────────
// After a tap the card says "Sending…", then the receipt in words. An answer that landed leaves the
// open list when the next list arrives. A refusal keeps the card open and takes a new answer. A gone
// target keeps the person's words on screen with Copy, so nothing they wrote is lost. A request that
// got no answer says "Not sent." with Try again, which sends the same attempt with the same request
// id (`useHillAnswer`). The card owns no network: `onSend` is the caller's.

/** Two short options sit side by side; more than two, a long label or an explanation stack them. */
const SIDE_BY_SIDE_LABEL_MAX = 16;

function sideBySide(options: readonly HillOption[]): boolean {
  return options.length === 2 && options.every((o) => o.label.length <= SIDE_BY_SIDE_LABEL_MAX && o.detail === undefined);
}

/** The bridge's clock, ticked once a second by the page's one shared clock (lib/cache-clock.ts). */
function hillClockNow(): number {
  return onBridgeClock(cacheClockNow());
}

/** The priority chip: `now` in the caution ink, `today` plain, `later` muted. Words, so colour is never the only carrier. */
const PRIORITY_INK = {
  now: "border-status-working/40 text-status-working",
  today: "text-foreground",
  later: "text-muted-foreground",
} satisfies Record<HillPriority, string>;

function PriorityChip({ priority }: { priority: HillPriority }) {
  return (
    <Badge variant="outline" data-slot="decision-priority" data-priority={priority} className={cn("h-5 px-1.5 py-0 text-[11px] leading-none", PRIORITY_INK[priority])}>
      {priorityWord(priority)}
    </Badge>
  );
}

/** The age on the meta line, against the bridge's clock. */
function Age({ at }: { at: number }) {
  const now = useSyncExternalStore(subscribeCacheClock, hillClockNow, hillClockNow);
  return <span className="ml-auto shrink-0 tabular-nums">{ageWords(at, now)}</span>;
}

/** Which notice tone a receipt wears: it landed, it may have, or it did not. */
function receiptTone(receipt: HillReceipt): NoticeTone {
  if (receipt.code === "ok") {
    if (receipt.trick === "failed") return "info";
    return receipt.delivery === "typed" || receipt.delivery === "none" ? "success" : "info";
  }
  if (receipt.code === "unknown") return "info";
  return "danger";
}

/** True when the card takes no more answers: one is in flight, or the bridge took or closed it. */
function lockedBy(answer: HillAnswerState): boolean {
  if (answer.phase === "sending") return true;
  if (answer.phase !== "answered") return false;
  // A refusal is an answer that changed nothing: the card stays open for another one. The bridge's
  // `denied` (this device may not answer) changes nothing either, and says so in the notice.
  return answer.receipt.code !== "rejected" && answer.receipt.code !== "denied";
}

/** The words the person sent with an answer that did not reach its target, kept with Copy. */
export function KeptWords({ text }: { text: string }) {
  useLocale();
  return (
    <div data-slot="decision-kept" className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{t("hill.kept")}</span>
      <CopyableBlock text={text} label={t("hill.copy")}>
        <p className="font-content whitespace-pre-wrap break-words rounded-sm border border-border px-3 py-2 pr-9 text-sm">{text}</p>
      </CopyableBlock>
    </div>
  );
}

/** What happened after the tap, in the card's own chrome. Null while nothing has been sent. */
function AnswerStatus({ decision, answer, onRetry }: { decision: HillDecision; answer: HillAnswerState; onRetry: () => void }) {
  if (answer.phase === "idle") return null;
  if (answer.phase === "sending") {
    return (
      <Notice variant="box" tone="neutral" announce="status" icon={<Icon name="busy" className="animate-spin" />}>
        {t("hill.sending")}
      </Notice>
    );
  }
  if (answer.phase === "failed") {
    return (
      <Notice
        variant="box"
        tone="danger"
        announce="alert"
        icon={<Icon name="error" />}
        action={
          <Button type="button" variant="outline" size="sm" data-slot="decision-retry" className="h-8" onClick={onRetry}>
            <Icon name="retry" aria-hidden />
            {t("hill.retry")}
          </Button>
        }
      >
        {t("hill.receipt.failed")}
      </Notice>
    );
  }
  const { receipt } = answer;
  const tone = receiptTone(receipt);
  const kept = receipt.code === "gone" && answer.text !== null && answer.text.trim() !== "" ? answer.text : null;
  return (
    <div className="flex flex-col gap-2">
      <Notice
        variant="box"
        tone={tone}
        announce={tone === "danger" ? "alert" : "status"}
        icon={<Icon name={tone === "danger" ? "error" : "answered"} />}
      >
        <span data-slot="decision-receipt" data-code={receipt.code}>
          {receiptWords(receipt, answer.intent, targetLabel(decision), decision.from.kind === "trick" ? decision.from.label : null)}
        </span>
      </Notice>
      {kept !== null && <KeptWords text={kept} />}
    </div>
  );
}

/**
 * One Decision. `answer` is where this card's answer is (`useHillAnswer`, or a fixed state in the
 * playground), `onSend` sends one: an option's intent, `answer` for words alone, or `dismiss`.
 * `mediaSource` says where an image's bytes are: the bridge's route unless the playground says otherwise.
 */
export function DecisionCard({
  decision,
  answer,
  onSend,
  mediaSource = hillMediaSource,
}: {
  decision: HillDecision;
  answer: HillAnswerState;
  onSend: (intent: string, text: string | null) => void;
  mediaSource?: HillMediaSource;
}) {
  useLocale();
  const [draft, setDraft] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const { armed, tap, disarm } = useArm<string>();
  const bodyId = useId();
  const hintId = useId();
  const locked = lockedBy(answer);

  // A card that takes no more answers holds no armed button: the arm was for an answer not yet given.
  useEffect(() => {
    if (locked) disarm();
  }, [locked, disarm]);

  const words = draft.trim();
  const text = words === "" ? null : words;
  const required = decision.text === "required";
  const fieldShown = decision.text !== "none";
  const optionsBlocked = locked || (required && text === null);
  const hasMore = decision.body.trim() !== "" || decision.links.length > 0 || decision.media.length > 0;
  const firstImage = decision.media[0];
  const recommended = decision.options.find((o) => o.intent === decision.recommends?.intent);
  const sendingIntent = answer.phase === "sending" ? answer.intent : null;
  const target = decision.target;
  const goesTo = targetLine(decision);

  function choose(option: HillOption) {
    if (optionsBlocked) return;
    if (option.confirm !== undefined) {
      if (tap(`option:${option.intent}`) !== "fire") return;
    } else disarm();
    onSend(option.intent, text);
  }

  function sendWords() {
    if (locked || text === null) return;
    disarm();
    onSend("answer", text);
  }

  function dismiss() {
    if (locked) return;
    if (tap("dismiss") !== "fire") return;
    onSend("dismiss", null);
  }

  function retry() {
    if (answer.phase !== "failed") return;
    onSend(answer.intent, answer.text);
  }

  const dismissArmed = armed === "dismiss";

  return (
    <Card
      role="group"
      aria-label={t("hill.card.aria", { title: decision.title })}
      data-slot="decision-card"
      data-id={decision.id}
      data-phase={answer.phase}
      className="gap-0 py-0"
    >
      <div className="flex flex-col gap-3 p-4">
        <div data-slot="decision-meta" className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <PriorityChip priority={decision.priority} />
          <span className="min-w-0 truncate">{decision.from.label}</span>
          {decision.from.kind === "trick" && (
            <span className="shrink-0">
              <span aria-hidden>· </span>
              {t("hill.trick")}
            </span>
          )}
          {decision.from.host !== null && (
            <span className="min-w-0 shrink truncate">
              <span aria-hidden>· </span>
              {decision.from.host}
            </span>
          )}
          <Age at={decision.at} />
        </div>

        <div className="flex flex-col gap-1">
          <h3 data-slot="decision-title" className="font-content line-clamp-2 break-words text-base font-semibold leading-snug">
            {decision.title}
          </h3>
          <p data-slot="decision-summary" className="font-content whitespace-pre-wrap break-words text-sm">
            {decision.summary}
          </p>
        </div>

        {firstImage !== undefined && (
          <HillCardImage src={mediaSource(decision.id, firstImage)} media={firstImage} count={decision.media.length} onOpen={() => setMoreOpen(true)} />
        )}

        {decision.recommends !== null && recommended !== undefined && (
          <div data-slot="decision-recommends" className="flex flex-col gap-0.5">
            <p className="text-sm font-medium">{t("hill.recommended", { label: recommended.label })}</p>
            <p className="font-content text-xs text-muted-foreground">{decision.recommends.why}</p>
          </div>
        )}

        {hasMore && (
          <div className="flex flex-col">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-slot="decision-more"
              aria-expanded={moreOpen}
              aria-controls={moreOpen ? bodyId : undefined}
              onClick={() => setMoreOpen((open) => !open)}
              className="-ml-3 h-11 self-start px-3 text-muted-foreground"
            >
              {t(moreOpen ? "hill.less" : "hill.more")}
              <Icon name="expand" aria-hidden className={cn("transition-transform motion-reduce:transition-none", moreOpen && "rotate-180")} />
            </Button>
            <Collapse open={moreOpen}>
              <div id={bodyId} data-slot="decision-body" className="flex flex-col gap-3 pt-1">
                {decision.body.trim() !== "" && <MarkdownText text={decision.body} />}
                {decision.media.length > 0 && <HillBodyImages decisionId={decision.id} media={decision.media} source={mediaSource} />}
                {decision.links.length > 0 && (
                  <ListGroup as="ul">
                    {decision.links.map((link) => (
                      <li key={link.href}>
                        <a
                          href={link.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-slot="decision-link"
                          className="flex min-h-11 min-w-0 items-center gap-3 px-3.5 py-2 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          <Icon name="open-external" aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                          <span className="font-content min-w-0 flex-1 truncate text-sm font-medium">{link.label}</span>
                          <span className="min-w-0 max-w-[45%] shrink truncate font-mono text-[11px] text-muted-foreground">{linkHost(link.href)}</span>
                        </a>
                      </li>
                    ))}
                  </ListGroup>
                )}
              </div>
            </Collapse>
          </div>
        )}

        {decision.options.length > 0 && (
          <div data-slot="decision-options" className={cn("grid gap-2", sideBySide(decision.options) ? "grid-cols-2" : "grid-cols-1")}>
            {decision.options.map((option) => {
              const isArmed = armed === `option:${option.intent}`;
              const busy = sendingIntent === option.intent;
              const isRecommended = recommended?.intent === option.intent;
              return (
                <OptionButton
                  key={option.intent}
                  data-slot="decision-option"
                  data-intent={option.intent}
                  tone={busy ? "busy" : isArmed ? "armed" : "default"}
                  label={isArmed && option.confirm !== undefined ? option.confirm : option.label}
                  aria-label={isArmed && option.confirm !== undefined ? t("hill.armed", { label: option.confirm }) : undefined}
                  aria-describedby={required && fieldShown ? hintId : undefined}
                  description={option.detail}
                  disabled={optionsBlocked}
                  onClick={() => choose(option)}
                  className="min-h-11 items-center"
                  trailing={
                    // One 16px slot on every option, so the spinner or the mark arriving moves no label.
                    <span aria-hidden className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                      {busy ? (
                        <Icon name="busy" className="size-3.5 animate-spin" />
                      ) : isRecommended ? (
                        <Icon name="recommended" data-slot="decision-recommended-mark" className="size-3.5" />
                      ) : null}
                    </span>
                  }
                />
              );
            })}
            {/* The mark is decorative; a reader hears which option it is here. */}
            {recommended !== undefined && <span className="sr-only">{t("hill.recommended", { label: recommended.label })}</span>}
          </div>
        )}
        {/* A live region on the button itself is unreliable; this one announces the armed wording. */}
        <span className="sr-only" aria-live="polite">
          {armed === null ? "" : armed === "dismiss" ? t("hill.dismissArmed") : t("hill.armed", { label: decision.options.find((o) => `option:${o.intent}` === armed)?.confirm ?? "" })}
        </span>

        {fieldShown && (
          <div className="flex flex-col gap-2">
            <textarea
              data-slot="decision-text"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                // An armed confirm was for the answer as it read when it was armed: new words need a new first tap.
                if (armed?.startsWith("option:")) disarm();
              }}
              placeholder={t(required ? "hill.text.required" : "hill.text.optional")}
              aria-label={t("hill.text.aria")}
              maxLength={HILL_ANSWER_TEXT_MAX}
              rows={2}
              disabled={locked}
              // Off, as the composer has it: on Android Chrome a tap on a marked word opens the
              // browser's suggestion menu, which takes the focus and hides the keyboard.
              spellCheck={false}
              className="min-h-11 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-base text-foreground placeholder:text-muted-foreground disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
            {required && decision.options.length > 0 && (
              <p id={hintId} data-slot="decision-required-hint" className="text-xs text-muted-foreground">
                {t("hill.text.requiredHint")}
              </p>
            )}
            <Button
              type="button"
              variant={decision.options.length === 0 ? "default" : "outline"}
              data-slot="decision-send"
              disabled={locked || text === null}
              onClick={sendWords}
              className="h-11 w-full"
            >
              {sendingIntent === "answer" ? <Icon name="busy" aria-hidden className="animate-spin" /> : <Icon name="send" aria-hidden />}
              {t("hill.send")}
            </Button>
          </div>
        )}

        <Collapse open={answer.phase !== "idle"}>
          <div data-slot="decision-status">
            <AnswerStatus decision={decision} answer={answer} onRetry={retry} />
          </div>
        </Collapse>

        <div className="flex min-w-0 items-center gap-2">
          {goesTo !== null ? (
            <p data-slot="decision-target" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="min-w-0 break-words">{goesTo}</span>
              {target?.unattended === true && <NoPromptsBadge label={t("hill.unattended")} className="h-5 px-1.5 py-0 text-[11px] leading-none" />}
            </p>
          ) : (
            <span className="flex-1" />
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-slot="decision-dismiss"
            disabled={locked}
            onClick={dismiss}
            className={cn(
              "-mr-3 h-11 shrink-0 px-3",
              // The armed tint on the box it already has: the border is reserved by the button's base string.
              dismissArmed ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/10 hover:text-destructive" : "text-muted-foreground",
            )}
          >
            {/* Both words in one slot, sized by the wider, so arming moves nothing beside it (DESIGN.md §2). */}
            <OneOf
              active={dismissArmed ? "armed" : "rest"}
              className="inline-grid"
              options={[
                { key: "rest", node: t("hill.dismiss") },
                { key: "armed", node: t("hill.dismissArmed") },
              ]}
            />
          </Button>
        </div>
      </div>
    </Card>
  );
}
