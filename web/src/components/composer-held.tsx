// The sends the bridge holds for a pane (M56 spec 15), drawn as ONE card that floats over the mirror's
// bottom edge (ADR 0061, amended 2026-10-18). A send the harness could not take while its turn ran waits
// in the bridge, and goes out when the pane reads free; the row says so and offers Cancel. A request that
// closed without reaching the agent stays as a row with its text, so nothing the person typed is lost:
// Resend sends it again as a new request, Dismiss lets it go. On a crew member's pane the row keeps
// Cancel and Dismiss (the lead forwards them to the member, issue 740) and draws no Resend, Submit or
// Discard, which would need the Send Protocol across the link. The rows come from the snapshot, never
// from phone state, so a second phone on the same pane sees the same queue.
//
// THE CARD HOLDS NO SPACE. The rows used to sit in the composer's flow, so each held send grew the
// footer and moved the belt, the field and the mirror's tail. The composer now places this card in the
// floating notice slot (portalled into the pane view's slot, else floated above its own top edge), so a
// row arriving or leaving moves nothing. One row shows as it always did: label, buttons, the text
// clamped to three lines. Two or more collapse into one head, a count when every row waits, else the first
// row's own label, with the first text under it and a Show all toggle; no per-row button shows while
// collapsed, because a Cancel on a count would not say which row it cancels. Show all lists every row, each
// as a single row, inside the card, scrolling there when the queue is long. The open state lives here,
// in memory, and dies with the card: the composer keys the card by pane, and it also collapses by
// itself once the rows drop to one or none.

import { useEffect, useState, type ReactNode } from "react";

import { QUEUED_BUTTON, QUEUED_FLOAT, QUEUED_FLOAT_TEXT, QUEUED_HEAD, QUEUED_LABEL } from "@/components/queued-block";
import { RawMirror } from "@/components/raw-mirror";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/hooks/use-locale";
import { cancelHeldSend, isApiErrorStatus } from "@/lib/api";
import { describeThrownError } from "@/lib/api-error-message";
import type { StyledLine } from "@/lib/blocks";
import { t, tn, type MessageKey } from "@/lib/i18n";
import { holdsMask } from "@/lib/masked-text";
import type { Scope } from "@/lib/scope";
import { setStatus } from "@/lib/status";
import type { HeldRow } from "@/lib/surface/send";
import { cn } from "@/lib/utils";

/** What a tap on an ended row sends: the row again, or the text it left in the box submitted or discarded. */
export type HeldAction = "resend" | "submit" | "discard";

/** The sentence of a row that waits, by what holds it: a turn, something open at the box, or a draft. */
function heldKey(row: HeldRow): MessageKey {
  switch (row.cause) {
    case "not_free":
    case "bound":
    case "probe_failed":
      return "composer.held.box";
    case "draft_present":
      return "composer.held.draft";
    default:
      // A turn, or a row from a bridge that keeps no cause. A turn the harness would take a message in,
      // were its version read, says so (#594).
      return row.versionUnread === true ? "composer.held.versionUnread" : "composer.held.queued";
  }
}

/** A row that waited two minutes in the hold (M102 spec 12): it shows the screen and offers Send it now. */
function isLong(row: HeldRow): boolean {
  return row.state === "held" && row.heldLong === true;
}

/** The label a row wears: what the bridge is doing with it, or why it never went out. */
function labelKey(row: HeldRow): MessageKey {
  if (isLong(row)) return "composer.held.long";
  if (row.state === "held") return heldKey(row);
  if (row.state === "running") return "composer.held.sending";
  if (row.outcome === "unknown") return "composer.held.unknown";
  if (row.outcome === "typed_not_submitted") return "composer.held.typed";
  if (row.outcome === "expired") return "composer.held.expired";
  if (row.outcome === "refused" && row.reason === "pane_gone") return "composer.held.paneGone";
  return "composer.held.failed";
}

/**
 * A row whose pane is gone has nowhere to send its text again. One that ended `unknown` may have reached
 * the agent, so a second send could double it; one that ended `typed_not_submitted` has its text in the box.
 */
function canResend(row: HeldRow): boolean {
  if (row.state !== "ended") return false;
  if (row.outcome === "unknown" || row.outcome === "typed_not_submitted") return false;
  return !(row.outcome === "refused" && row.reason === "pane_gone");
}

/**
 * How a mail row ended with nothing of the message in the person's box: the bridge settled it before any
 * key (`refused`), its clock ran out (`expired`), or it went out or was taken back (`sent`, `effective`,
 * `cancelled`, which leave no row at all today). Any other end may have left the message's text there.
 */
const NOTHING_IN_THE_BOX = new Set<HeldRow["outcome"]>(["refused", "expired", "cancelled", "sent", "effective"]);

/**
 * The rows the card draws. The one typed line of a WalkyTalky message (`walky`) has its own places on the
 * phone, the held mark above the box and the pane's Messages sheet, so a row of it that waits, is going
 * out, or ended with nothing in the box is left out: two cards for one message was the fault (2026-11-13).
 * A mail row that ended with its text possibly in the person's input box stays, with its words and its
 * actions: `typed_not_submitted` (any reason: the line the bridge could not take out of the box again) and
 * `unknown` (a write went out and nothing proved the end). The mark does not cover a message that ended,
 * and without the row the person would not know why the box holds another agent's words. The test is the
 * other way round on purpose: an end this list does not know is drawn. Every row of the person's own
 * sends stays.
 */
export function drawnHeldRows(rows: readonly HeldRow[]): readonly HeldRow[] {
  return rows.filter((row) => row.walky === undefined || (row.state === "ended" && !NOTHING_IN_THE_BOX.has(row.outcome)));
}

interface HeldCardProps {
  paneId: string;
  scope?: Scope | undefined;
  /** The snapshot's rows, oldest first. The caller mounts the card only while there is at least one. */
  rows: readonly HeldRow[];
  /** False on a locked composer: the rows show, with no row buttons. */
  canAct: boolean;
  /**
   * False on a crew member's pane: the Send Protocol does not cross a link, so Resend, Submit and Discard
   * are not drawn there. Cancel and Dismiss are, through the pane route the lead forwards (issue 740).
   * Absent reads as true.
   */
  canSend?: boolean;
  /** A send from the composer is running; Resend waits so two requests do not race for the box. */
  sending: boolean;
  /** Send for an ended row: again by its id (`resend`), or its text in the box submitted or discarded. True when the bridge took it. */
  onSend: (row: HeldRow, action: HeldAction) => Promise<boolean>;
  /** An action ended: the caller refreshes the snapshot. */
  onChanged: () => void;
  /** A Cancel the bridge took: the row's words, so the caller can give them back to the box. */
  onReturn?: ((words: string) => void) | undefined;
  /**
   * The pane's live screen, drawn under the label of a long row (a row held two minutes). Absent: no screen box.
   */
  screen?: { lines: StyledLine[]; wrap: boolean };
  /** Send it now on a long row: cancel the row, then send its text once past the hold. True when the bridge took it. */
  onSendNow: (row: HeldRow) => Promise<boolean>;
}

/** The live screen of a long row: one scroller that opens at its bottom, bounded so the card stays small. */
function HeldScreen({ lines, wrap }: { lines: StyledLine[]; wrap: boolean }) {
  return (
    <div data-slot="held-screen" className="flex max-h-40 min-w-0 flex-col">
      <RawMirror lines={lines} wrap={wrap} anchor="bottom" className="min-h-0 overflow-y-auto overscroll-contain" />
    </div>
  );
}

/** Lines of a row's text in the card: a row on its own or in the open list, and the first of several while collapsed. */
const CLAMP_ONE = "line-clamp-3";
const CLAMP_COLLAPSED = "line-clamp-2";

export function HeldCard({ paneId, scope, rows, canAct, canSend = true, sending, onSend, onChanged, onReturn, screen, onSendNow }: HeldCardProps) {
  useLocale();
  // The request whose call is in flight: its buttons wait, the others stay live.
  const [busy, setBusy] = useState<string | null>(null);
  // Show all. Per card, in memory only; see the header for what resets it.
  const [showAll, setShowAll] = useState(false);

  const several = rows.length >= 2;
  const open = several && showAll;
  // Collapses when the queue drains to one row or none, so the next queue starts collapsed. `open` already
  // hides a stale `showAll` in the same render; this only forgets it.
  useEffect(() => {
    if (!several) setShowAll(false);
  }, [several]);

  async function release(row: HeldRow, giveBack = false): Promise<void> {
    try {
      const answer = await cancelHeldSend(row.requestId, paneId, scope);
      // The row went and nothing was sent: its words go back to the person, never nowhere. Not the one
      // typed line of a WalkyTalky message (`walky`): that is another agent's text, and it stays in the
      // inbox, so putting it in the box would pass it off as the person's own words.
      if (giveBack && answer.result === "cancelled" && row.walky === undefined) onReturn?.(row.text);
      // A stored receipt means the request already went out; none means it is going out now.
      if (answer.result === "refused") setStatus(t(answer.receipt === undefined ? "composer.held.cancelLate" : "composer.held.wentOut"), "warn");
    } catch (error) {
      // An unknown id is a row another phone already took away: the refresh below drops it.
      if (!isApiErrorStatus(error, 404)) setStatus(describeThrownError(error), "error");
    }
  }

  async function act(row: HeldRow, run: () => Promise<void>): Promise<void> {
    if (busy !== null) return;
    setBusy(row.requestId);
    try {
      await run();
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  // Resend: the bridge drops the old row itself once it took the new request, so nothing is dismissed here.
  const resend = (row: HeldRow) => act(row, async () => void (await onSend(row, "resend")));

  // Submit and Discard: dismiss only after the bridge took the request; a refusal keeps the row.
  const settle = (row: HeldRow, action: "submit" | "discard") =>
    act(row, async () => {
      if (await onSend(row, action)) await release(row);
    });

  // Send it now: the composer cancels the row and sends its text once past the hold. A row whose
  // text holds the bridge's mask is not sent from here, it would type the dots.
  const sendNow = (row: HeldRow) => act(row, async () => void (await onSendNow(row)));

  /** The buttons a row's state allows, at the right of its label. Nothing when the composer may not act. */
  function actions(row: HeldRow): ReactNode {
    const disabled = busy !== null;
    if (!canAct) return null;
    if (row.state === "held") {
      const cancel = (
        <Button type="button" variant="outline" size="sm" className={QUEUED_BUTTON} disabled={disabled} aria-label={t("composer.held.cancelAria")} onClick={() => void act(row, () => release(row, true))}>
          {t("composer.held.cancel")}
        </Button>
      );
      if (!isLong(row) || !canSend || holdsMask(row.text)) return cancel;
      return (
        <span className="flex items-center gap-1">
          <Button type="button" variant="outline" size="sm" className={QUEUED_BUTTON} disabled={disabled || sending} aria-label={t("composer.held.sendNowAria")} onClick={() => void sendNow(row)}>
            {t("composer.held.sendNow")}
          </Button>
          {cancel}
        </span>
      );
    }
    if (row.state !== "ended") return null;
    return (
      <span className="flex items-center gap-1">
        {canSend && canResend(row) && (
          <Button type="button" variant="outline" size="sm" className={QUEUED_BUTTON} disabled={disabled || sending} aria-label={t("composer.held.resendAria")} onClick={() => void resend(row)}>
            {t("composer.held.resend")}
          </Button>
        )}
        {canSend && row.outcome === "typed_not_submitted" && (
          <>
            <Button type="button" variant="outline" size="sm" className={QUEUED_BUTTON} disabled={disabled || sending} aria-label={t("composer.held.submitAria")} onClick={() => void settle(row, "submit")}>
              {t("composer.held.submit")}
            </Button>
            <Button type="button" variant="outline" size="sm" className={QUEUED_BUTTON} disabled={disabled || sending} aria-label={t("composer.held.discardAria")} onClick={() => void settle(row, "discard")}>
              {t("composer.held.discard")}
            </Button>
          </>
        )}
        {/* A typed row keeps Dismiss too: once the box no longer holds its text (cleared at the keys, or
            changed by the harness), Submit and Discard are refused and the row would stay for an hour. */}
        <Button type="button" variant="outline" size="sm" className={QUEUED_BUTTON} disabled={disabled} aria-label={t("composer.held.dismissAria")} onClick={() => void act(row, () => release(row))}>
          {t("composer.held.dismiss")}
        </Button>
      </span>
    );
  }

  // The screen shows once per card, under the first long row (or the collapsed head), never once per row.
  const firstLong = rows.find(isLong);
  const screenBox = screen === undefined ? null : <HeldScreen lines={screen.lines} wrap={screen.wrap} />;

  /** One row as it was on its own: label, its buttons, the text clamped. */
  function rowBlock(row: HeldRow, className?: string): ReactNode {
    return (
      <div key={row.requestId} data-slot="held-row" data-state={row.state} className={cn("flex min-w-0 flex-col gap-1", className)}>
        <div className={QUEUED_HEAD}>
          <p className={QUEUED_LABEL}>{t(labelKey(row))}</p>
          {actions(row)}
        </div>
        <p className={cn(QUEUED_FLOAT_TEXT, CLAMP_ONE)}>{row.text}</p>
        {row === firstLong && screenBox}
      </div>
    );
  }

  const first = rows[0];
  if (first === undefined) return null;

  if (!several) {
    return (
      <div data-slot="held-card" data-mode="single" className={QUEUED_FLOAT}>
        {rowBlock(first)}
      </div>
    );
  }

  // Every row waiting for the turn: one count says it. Else the first row's own label, which is the
  // one the next send is about to act on.
  const allHeld = rows.every((row) => row.state === "held");
  const headLabel = firstLong !== undefined ? t("composer.held.long") : allHeld ? tn("composer.held.count", rows.length) : t(labelKey(first));
  const head = (
    <div data-slot="held-head" className={QUEUED_HEAD}>
      <p className={QUEUED_LABEL}>{headLabel}</p>
      {/* Not an action on the queue, so it stays on a crew member's pane and a locked composer. */}
      <Button type="button" variant="outline" size="sm" className={QUEUED_BUTTON} aria-expanded={open} aria-label={t(open ? "composer.held.showLessAria" : "composer.held.showAllAria")} onClick={() => setShowAll(!open)}>
        {t(open ? "chat.card.diff.less" : "composer.held.showAll")}
      </Button>
    </div>
  );

  if (!open) {
    return (
      <div data-slot="held-card" data-mode="collapsed" className={QUEUED_FLOAT}>
        {head}
        <p className={cn(QUEUED_FLOAT_TEXT, CLAMP_COLLAPSED)}>{first.text}</p>
        {screenBox !== null && firstLong !== undefined && screenBox}
      </div>
    );
  }

  return (
    <div data-slot="held-card" data-mode="expanded" className={QUEUED_FLOAT}>
      {head}
      {/* Oldest first, the next to send on top. A long queue scrolls here and not the page; `overscroll-contain` keeps the mirror under the card still. */}
      <div data-slot="held-list" className="max-h-[45dvh] divide-y divide-dashed divide-status-working/25 overflow-y-auto overscroll-contain">
        {rows.map((row) => rowBlock(row, "py-1.5 first:pt-0 last:pb-0"))}
      </div>
    </div>
  );
}
