import { useId, useState, useSyncExternalStore } from "react";
import { Check, Loader2 } from "lucide-react";

import { OptionButton, OptionGroupCaption, optionSurface, PromptPanel } from "@/components/option-button";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/hooks/use-locale";
import { answerAsk, apiErrorStatus, postAskAnswer } from "@/lib/api";
import { describeThrownError } from "@/lib/api-error-message";
import { cacheClockNow, subscribeCacheClock } from "@/lib/cache-clock";
import {
  answerable,
  answered,
  effectKey,
  formFields,
  formReady,
  formValues,
  freshCard,
  optionTone,
  pickedAfter,
  polled,
  pressed,
  secondaryLabel,
  sent,
  textLimit,
  textReady,
  visibleOptions,
  type AnswerResult,
  type AskAnswer,
  type AskCardState,
  EMPTY_DRAFT,
  type FormDraft,
} from "@/lib/ask";
import { timeLeft } from "@/lib/format";
import { answerOfAskReply, contractOptionFor, type ProgramContractAsk } from "@/lib/program-ask";
import { t } from "@/lib/i18n";
import type { Scope } from "@/lib/scope";
import { onBridgeClock } from "@/lib/server-clock";
import { isProgramSession, useSessionCard } from "@/lib/session-cards";
import type { Ask, AskField, AskOption } from "@/lib/types";
import { mintRequestId } from "@/lib/worktree-name";

// A DURABLE PROGRAM'S ASK, AS A CARD (ADR 0100).
//
// It wears the permission card's own look (PromptPanel, OptionGroupCaption, OptionButton), so an ask
// from a program reads like a Claude permission card. What differs is where it comes from: the card
// is drawn from DATA the pane carries, and a tap answers by the ask's id and revision with a request
// id minted for the tap, through the answer route. No keys, no screen, no read-back.
//
// ONLY A PERSON'S TAP POSTS. The one call to the route is `tap()`, and `tap()` is reached from a
// button's onClick and from nothing else: no effect, no timer and no poll result sends an answer.
// "Try again" is a tap too, and it carries the SAME request id as the tap it retries, so the bridge
// answers from its receipt instead of resolving the ask twice.
//
// FOUR KINDS (WIRE.md 7.14). A permission draws its options by their effect. A choice draws them as
// plain rows: one tap sends one pick, or with `multiple` the rows toggle and a Send button sends the
// set. A text ask draws one field and a Send button. A form draws its fields stacked under one Send
// button. Each is one tap, one request id, one post: the same rule for all four, and the fields'
// drafts live in a child keyed by the ask's revision, so a changed ask starts with empty fields
// instead of a stale answer to a question that moved.
//
// STRINGS FROM THE PROGRAM are React text nodes only, as every string in this app is. The bridge
// cleaned and capped them; a card of a kind this version does not know is drawn with its words and
// no buttons.
//
// THE SEND PROTOCOL ON THIS MACHINE (M56 spec 14). When the pane's Surface carries a contract ask for
// this card (the program's oldest open ask, on a pane of this machine the bridge marks `sendProtocol`),
// a one-tap answer goes to `POST /api/ask/<id>` with the contract's hash and numbered option, and the
// bridge's structured driver answers the program by its own ask id. The card and its states stay the
// same. A text, a form, a choice of several and "Always allow" keep the answer route (lib/program-ask.ts).
//
// THE RECEIPTS (M55 spec 14). The caption names the program that asks, by its session's name. An ask
// with `expiresAt` shows the time left under its title, on the page's one shared clock
// (lib/cache-clock.ts) moved onto the bridge's (lib/server-clock.ts): the bridge drops the ask at
// `expiresAt`, so a phone whose own clock is off must not count to another moment. Past it the line
// says "Expired" and the buttons stay: the estimate may be a second off, the program answers a late
// tap with its own 409, and the next read drops the ask. A too-late answer says who decided first
// when the program told: the program, the clock, or another answer.

/** A transport error as an answer: a refusal the bridge made on purpose says so, anything else may have arrived. */
function thrownAnswer(status: number | undefined, message: string): AnswerResult {
  if (status === 400 || status === 401 || status === 403) return { outcome: "refused", detail: message };
  return { outcome: "unknown" };
}

export interface AskCardProps {
  /** The ask as the last poll drew it. A newer revision of the same ask replaces what the card shows. */
  ask: Ask;
  paneId: string;
  scope?: Scope;
  /** This device may not write, or the pane's machine is not taking writes. The buttons are off. */
  disabled?: boolean;
  /** The pane is drawn from saved or frozen data: the buttons are off and the card says why. */
  offline?: boolean;
  /** An answer reached the bridge and changed what is current (taken, too late, stale): read the pane again. */
  onSettled?: () => void;
  /** The contract ask the pane's Surface carries, on a pane whose taps go to `POST /api/ask` (lib/send-path.ts). */
  contract?: ProgramContractAsk | null;
}

export function AskCard({ ask, paneId, scope, disabled = false, offline = false, onSettled, contract = null }: AskCardProps) {
  useLocale();
  const session = useSessionCard(scope);
  // A program's ask names the program; a terminal pane's card keeps the plain caption.
  const program = session !== null && isProgramSession(session) ? session.name : null;
  const [card, setCard] = useState<AskCardState>(() => freshCard(ask));
  // A newer form of this ask from the poll replaces the card, unless a tap is in flight (lib/ask.ts).
  // Adjusted during render, as React documents for state derived from a prop.
  const next = polled(card, ask);
  if (next !== card) setCard(next);

  const busy = card.phase === "sending";

  /** A press on a permission option's button. "Always allow" arms on the first press and posts on the second. */
  function onPress(option: AskOption) {
    if (disabled || offline || busy) return;
    const press = pressed(card, option);
    setCard(press.state);
    if (press.post) void send({ optionId: option.id }, false, press.state);
  }

  async function send(answer: AskAnswer, again: boolean, from: AskCardState = card) {
    if (disabled || offline || busy) return;
    // A retry reuses the id of the tap it retries, and only after an unknown outcome.
    const requestId = again && card.requestId !== null ? card.requestId : mintRequestId();
    const tappedFrom = from;
    setCard(sent(tappedFrom, answer, requestId));
    // A one-tap answer to the contract ask goes through the Send Protocol's Ask; anything else keeps the answer route.
    const viaAsk = contract !== null && "optionId" in answer ? contractOptionFor(tappedFrom.ask, contract, answer.optionId) : null;
    let result: AnswerResult;
    try {
      result =
        contract !== null && viaAsk !== null
          ? answerOfAskReply(await postAskAnswer(contract.ask.id, { pane: paneId, hash: contract.ask.hash, optionId: viaAsk, origin: "person_tap" }, scope))
          : await answerAsk(paneId, { requestId, askId: tappedFrom.ask.id, revision: tappedFrom.ask.revision, ...answer }, scope);
    } catch (error) {
      result = thrownAnswer(apiErrorStatus(error), describeThrownError(error));
    }
    setCard((now) => answered(now, result));
    if (result.outcome === "taken" || result.outcome === "too-late" || result.outcome === "stale" || result.outcome === "maybe-applied") {
      onSettled?.();
    }
  }

  return (
    <AskCardFace
      card={card}
      program={program}
      disabled={disabled}
      offline={offline}
      onPress={onPress}
      onSend={(answer, again) => void send(answer, again)}
    />
  );
}

export interface AskCardFaceProps {
  /** Where the card stands, as lib/ask.ts's own steps left it. */
  card: AskCardState;
  /** The program that asks, by its session's name, or null for a terminal pane: the caption names it. */
  program: string | null;
  disabled?: boolean;
  offline?: boolean;
  /** A press on a permission option's button. */
  onPress: (option: AskOption) => void;
  /** An answer to send. `again` is "Try again" after an unknown outcome, which reuses the tap's request id. */
  onSend: (answer: AskAnswer, again: boolean) => void;
}

/**
 * The card's face for one state, with no state of its own: {@link AskCard} holds the state and the one
 * post, and hands each step here. The states playground draws a settled card through it, from a state the
 * real steps of lib/ask.ts built, because a page with no bridge behind it cannot reach one by a tap.
 */
export function AskCardFace({ card, program, disabled = false, offline = false, onPress, onSend }: AskCardFaceProps) {
  useLocale();
  // Taken closes the card. The program drops the ask from the next poll; until then nothing is drawn.
  if (card.phase === "taken") return null;

  const shown = card.ask;
  const options = visibleOptions(shown);
  const canAnswer = answerable(shown);
  const busy = card.phase === "sending";
  // Off for good in these phases: the answer was taken, or someone else made it, or it is refused.
  // `unknown` leaves only "Try again" (the same intent); `stale` on an old machine cannot be tapped.
  const settled = card.phase === "late" || card.phase === "maybe" || card.phase === "refused";
  const frozen = disabled || offline || busy || settled || card.phase === "unknown" || (card.phase === "stale" && card.older);
  const retryAnswer = card.phase === "unknown" ? card.answer : null;
  const note = noteFor(card, offline);

  return (
    // The slot is how the composer's "Go to the question" finds the card (lib/dialog-focus.ts).
    <div data-slot="ask-card">
      <PromptPanel ariaLabel={shown.title}>
        <OptionGroupCaption>{program !== null ? t("ask.captionNamed", { name: program }) : t("ask.caption")}</OptionGroupCaption>
        <p data-slot="ask-title" className="font-content pl-0.5 text-sm leading-snug font-medium text-foreground wrap-anywhere">
          {shown.title}
        </p>
        {shown.expiresAt !== undefined ? <AskExpiry expiresAt={shown.expiresAt} /> : null}
        {shown.reason !== undefined ? (
          <p data-slot="ask-reason" className="font-content pl-0.5 text-sm leading-snug whitespace-pre-line text-muted-foreground wrap-anywhere">
            {shown.reason}
          </p>
        ) : null}
        {shown.cleaned === true ? (
          <p data-slot="ask-cleaned" className="pl-0.5 text-xs leading-snug text-muted-foreground">
            {t("ask.cleaned")}
          </p>
        ) : null}
        {shown.tool !== undefined ? (
          <p
            data-slot="ask-tool"
            className="rounded-lg border border-border/60 bg-muted/30 px-2 py-1 font-mono text-xs leading-snug wrap-anywhere"
          >
            <span className="font-medium text-foreground">{shown.tool.name}</span>
            {shown.tool.summary !== "" ? <span className="text-muted-foreground"> {shown.tool.summary}</span> : null}
          </p>
        ) : null}
        {note !== null ? (
          <p data-slot="ask-note" role="status" className="pl-0.5 text-xs leading-snug text-muted-foreground wrap-anywhere">
            {note}
          </p>
        ) : null}
        {canAnswer && shown.kind === "choice" ? (
          <ChoiceBody key={shown.revision} ask={shown} options={options} frozen={frozen} busy={busy} sending={card.answer} onSend={(answer) => onSend(answer, false)} />
        ) : canAnswer && shown.kind === "text" ? (
          <TextBody key={shown.revision} ask={shown} frozen={frozen} busy={busy} onSend={(answer) => onSend(answer, false)} />
        ) : canAnswer && shown.kind === "form" ? (
          <FormBody key={shown.revision} ask={shown} frozen={frozen} busy={busy} onSend={(answer) => onSend(answer, false)} />
        ) : canAnswer ? (
          <div className="flex flex-col gap-1">
            {options.map((option) => {
              const inFlight = busy && card.optionId === option.id;
              const effect = option.effect ?? "cancel"; // visibleOptions keeps only options with an effect
              // Collie's words lead; the program's own label is the quiet second line (lib/ask.ts).
              const main = card.armed === option.id ? t("ask.alwaysArmed", { tool: shown.tool?.name ?? "" }) : t(effectKey(effect));
              return (
                <OptionButton
                  key={option.id}
                  tone={inFlight ? "busy" : optionTone(option.effect)}
                  label={main}
                  description={secondaryLabel(option.label, t(effectKey(effect)))}
                  disabled={frozen}
                  onClick={() => onPress(option)}
                  trailing={
                    inFlight ? (
                      <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" aria-label={t("prompt.sendingAria")} />
                    ) : null
                  }
                />
              );
            })}
          </div>
        ) : (
          <p data-slot="ask-not-answerable" className="pl-0.5 text-xs leading-snug text-muted-foreground">
            {t("ask.notAnswerable")}
          </p>
        )}
        {retryAnswer !== null ? (
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={disabled || offline}
            onClick={() => onSend(retryAnswer, true)}
          >
            {t("ask.retry")}
          </Button>
        ) : null}
      </PromptPanel>
    </div>
  );
}

/**
 * The page clock moved onto the bridge's (lib/server-clock.ts): `expiresAt` is compared there, so a
 * phone whose own clock is off still counts down to the moment the bridge drops the ask.
 */
function askClockNow(): number {
  return onBridgeClock(cacheClockNow());
}

/**
 * The time left on an ask, one muted line under its title. Its own component, so only a card with an
 * expiry subscribes to the page clock: a terminal's card never ticks.
 */
function AskExpiry({ expiresAt }: { expiresAt: string }) {
  const now = useSyncExternalStore(subscribeCacheClock, askClockNow, askClockNow);
  const left = timeLeft(expiresAt, now);
  if (left === null) return null;
  return (
    <p data-slot="ask-expiry" className="pl-0.5 text-xs leading-snug text-muted-foreground tabular-nums">
      {left.kind === "expired" ? t("ask.expired") : t("ask.expiresIn", { time: left.text })}
    </p>
  );
}

/** The line a too-late answer says: who decided first when the program told, else the plain "not taken". */
function lateNote(card: AskCardState): string {
  switch (card.decided?.by) {
    case "program":
      return t("ask.decidedInProgram");
    case "timeout":
      return t("ask.timedOut");
    case "phone":
      return t("ask.late");
    case undefined:
      // Not "Already answered": after a wake the same question may come back under the same id.
      return t("ask.notTaken");
  }
}

/** The one line a phase says under the question, or null while the card is simply waiting for a tap. */
function noteFor(card: AskCardState, offline: boolean): string | null {
  switch (card.phase) {
    case "late":
      return lateNote(card);
    case "stale":
      return card.older ? t("ask.stale.older") : t("ask.stale");
    case "unknown":
      return t("ask.unknown");
    case "maybe":
      return t("ask.maybe");
    case "refused":
      return card.detail !== "" ? card.detail : t("ask.refused");
    case "idle":
    case "sending":
    case "taken":
      return offline ? t("prompt.reconnectNote") : null;
  }
}

interface BodyProps {
  ask: Ask;
  /** Every control is off: a tap is in flight, the card is settled, or this device may not write. */
  frozen: boolean;
  /** A tap is in flight: the Send button shows its spinner. */
  busy: boolean;
  onSend: (answer: AskAnswer) => void;
}

/** The Send button of a text ask, a multiple choice or a form. */
function SendButton({ ready, frozen, busy, onClick }: { ready: boolean; frozen: boolean; busy: boolean; onClick: () => void }) {
  return (
    <Button type="button" data-slot="ask-send" className="h-11" disabled={frozen || !ready} onClick={onClick}>
      {busy ? <Loader2 className="size-4 animate-spin" aria-label={t("prompt.sendingAria")} /> : null}
      {t("ask.send")}
    </Button>
  );
}

/** A row that toggles: a pick of a multiple choice. `aria-pressed` says whether it is in the set. */
function PickRow({ label, on, disabled, onClick }: { label: string; on: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={on} disabled={disabled} onClick={onClick} className={optionSurface(on ? "selected" : "default")}>
      <span aria-hidden className="mt-px flex size-5 shrink-0 items-center justify-center rounded-md border border-border bg-background">
        {on ? <Check className="size-3.5" /> : null}
      </span>
      <span className="font-content min-w-0 flex-1 text-sm leading-snug font-medium wrap-anywhere text-foreground">{label}</span>
    </button>
  );
}

/** A choice ask: plain rows. One tap sends one pick; with `multiple` the rows toggle and Send sends the set. */
function ChoiceBody({
  ask,
  options,
  frozen,
  busy,
  sending,
  onSend,
}: BodyProps & { options: AskOption[]; sending: AskAnswer | null }) {
  const [picked, setPicked] = useState<string[]>([]);
  if (ask.multiple === true) {
    return (
      <div className="flex flex-col gap-1">
        <p data-slot="ask-hint" className="pl-0.5 text-xs leading-snug text-muted-foreground">
          {t("ask.pickMany")}
        </p>
        {options.map((option) => (
          <PickRow
            key={option.id}
            label={option.label}
            on={picked.includes(option.id)}
            disabled={frozen}
            onClick={() => setPicked((now) => pickedAfter(now, option.id, true))}
          />
        ))}
        <SendButton ready={picked.length > 0} frozen={frozen} busy={busy} onClick={() => onSend({ optionIds: picked })} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {options.map((option) => {
        const inFlight = busy && sending !== null && "optionIds" in sending && sending.optionIds.includes(option.id);
        return (
          <OptionButton
            key={option.id}
            tone={inFlight ? "busy" : "default"}
            label={option.label}
            disabled={frozen}
            onClick={() => onSend({ optionIds: [option.id] })}
            trailing={
              inFlight ? (
                <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" aria-label={t("prompt.sendingAria")} />
              ) : null
            }
          />
        );
      })}
    </div>
  );
}

const FIELD_CLASS =
  "h-11 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60";

/** One line of typed text, with its count. Enter sends when `onEnter` is given, unless an IME composition is open. */
function LineField({
  id,
  label,
  value,
  limit,
  placeholder,
  disabled,
  onChange,
  onEnter,
}: {
  id?: string;
  label: string;
  value: string;
  limit: number;
  placeholder?: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onEnter?: () => void;
}) {
  const count = [...value.trim()].length;
  return (
    <div className="flex flex-col gap-0.5">
      <input
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing && onEnter !== undefined) {
            e.preventDefault();
            onEnter();
          }
        }}
        enterKeyHint={onEnter === undefined ? "next" : "send"}
        autoComplete="off"
        className={FIELD_CLASS}
      />
      <p data-slot="ask-count" className={count > limit ? "pl-0.5 text-[11px] leading-tight text-destructive" : "pl-0.5 text-[11px] leading-tight text-muted-foreground"}>
        {t("ask.count", { count, max: limit })}
      </p>
    </div>
  );
}

/** A text ask: one field and a Send button. The answer is the trimmed line. */
function TextBody({ ask, frozen, busy, onSend }: BodyProps) {
  const [line, setLine] = useState("");
  const ready = textReady(line, ask);
  const submit = () => {
    if (ready && !frozen) onSend({ text: line.trim() });
  };
  return (
    <div className="flex flex-col gap-1">
      <LineField
        label={ask.title}
        value={line}
        limit={textLimit(ask)}
        placeholder={ask.placeholder}
        disabled={frozen}
        onChange={setLine}
        onEnter={submit}
      />
      <SendButton ready={ready} frozen={frozen} busy={busy} onClick={submit} />
    </div>
  );
}

/** One field of a form, by its kind. A toggle is a switch, a choice is a select, a text is a line. */
function FormField({
  field,
  line,
  on,
  disabled,
  onLine,
  onFlag,
}: {
  field: AskField;
  line: string;
  on: boolean;
  disabled: boolean;
  onLine: (line: string) => void;
  onFlag: (on: boolean) => void;
}) {
  const id = useId();
  const caption = (
    <span className="font-content text-sm leading-snug font-medium text-foreground wrap-anywhere">
      {field.label}
      {field.required === true ? <span className="text-xs font-normal text-muted-foreground"> {t("ask.required")}</span> : null}
    </span>
  );
  if (field.kind === "toggle") {
    return (
      <div data-slot="ask-field" className="flex min-h-11 items-center justify-between gap-3 pl-0.5">
        <span id={id}>{caption}</span>
        <Switch checked={on} onCheckedChange={onFlag} disabled={disabled} aria-labelledby={id} />
      </div>
    );
  }
  return (
    <div data-slot="ask-field" className="flex flex-col gap-1">
      <label htmlFor={id} className="pl-0.5">
        {caption}
      </label>
      {field.kind === "choice" ? (
        <Select id={id} value={line} disabled={disabled} onChange={(e) => onLine(e.target.value)}>
          <option value="">{t("ask.choose")}</option>
          {(field.options ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </Select>
      ) : (
        <LineField id={id} label={field.label} value={line} limit={textLimit(field)} disabled={disabled} onChange={onLine} />
      )}
    </div>
  );
}

/** A form ask: its fields stacked, and one Send button. */
function FormBody({ ask, frozen, busy, onSend }: BodyProps) {
  const [draft, setDraft] = useState<FormDraft>(EMPTY_DRAFT);
  const ready = formReady(ask, draft);
  return (
    <div className="flex flex-col gap-2">
      {formFields(ask).map((field) => (
        <FormField
          key={field.id}
          field={field}
          line={draft.lines[field.id] ?? ""}
          on={draft.flags[field.id] === true}
          disabled={frozen}
          onLine={(line) => setDraft((now) => ({ ...now, lines: { ...now.lines, [field.id]: line } }))}
          onFlag={(on) => setDraft((now) => ({ ...now, flags: { ...now.flags, [field.id]: on } }))}
        />
      ))}
      <SendButton ready={ready} frozen={frozen} busy={busy} onClick={() => onSend({ values: formValues(ask, draft) })} />
    </div>
  );
}
