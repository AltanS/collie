// The held sends above the composer's box (M56 spec 15): one queued row per request the bridge keeps
// for a pane. A send the harness could not take while its turn ran waits there, in the bridge, and
// goes out when the pane reads free; the row says so and offers Cancel. A request that closed without
// reaching the agent stays as a row with its text, so nothing the person typed is lost: Resend sends
// it again as a new request, Dismiss lets it go. The rows come from the snapshot, never from phone
// state, so a second phone on the same pane sees the same queue.

import { useState } from "react";

import { QUEUED_BLOCK, QUEUED_BUTTON, QUEUED_HEAD, QUEUED_LABEL, QUEUED_TEXT } from "@/components/queued-block";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { useLocale } from "@/hooks/use-locale";
import { cancelHeldSend, isApiErrorStatus } from "@/lib/api";
import { describeThrownError } from "@/lib/api-error-message";
import { t, type MessageKey } from "@/lib/i18n";
import type { Scope } from "@/lib/scope";
import { setStatus } from "@/lib/status";
import type { HeldRow } from "@/lib/surface/send";

/** What a tap on an ended row sends: the row again, or the text it left in the box submitted or discarded. */
export type HeldAction = "resend" | "submit" | "discard";

/** The label a row wears: what the bridge is doing with it, or why it never went out. */
function labelKey(row: HeldRow): MessageKey {
  if (row.state === "held") return "composer.held.queued";
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

interface HeldRowsProps {
  paneId: string;
  scope?: Scope | undefined;
  rows: readonly HeldRow[];
  /** False on a crew member's pane (the cancel route does not cross a link) and on a locked composer: the rows show, with no buttons. */
  canAct: boolean;
  /** A send from the composer is running; Resend waits so two requests do not race for the box. */
  sending: boolean;
  /** Send for an ended row: again by its id (`resend`), or its text in the box submitted or discarded. True when the bridge took it. */
  onSend: (row: HeldRow, action: HeldAction) => Promise<boolean>;
  /** An action ended: the caller refreshes the snapshot. */
  onChanged: () => void;
}

export function HeldRows({ paneId, scope, rows, canAct, sending, onSend, onChanged }: HeldRowsProps) {
  useLocale();
  // The request whose call is in flight: its buttons wait, the others stay live.
  const [busy, setBusy] = useState<string | null>(null);

  async function release(row: HeldRow): Promise<void> {
    try {
      const answer = await cancelHeldSend(row.requestId, paneId, scope);
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

  return (
    <Collapse open={rows.length > 0}>
      {rows.length > 0 && (
        <div data-slot="held-rows" className="mb-2 flex flex-col gap-1">
          {rows.map((row) => {
            const disabled = busy !== null;
            return (
              <div key={row.requestId} data-slot="held-row" data-state={row.state} className={QUEUED_BLOCK}>
                <div className={QUEUED_HEAD}>
                  <p className={QUEUED_LABEL}>{t(labelKey(row))}</p>
                  {canAct && row.state === "held" && (
                    <Button type="button" variant="outline" size="sm" className={QUEUED_BUTTON} disabled={disabled} aria-label={t("composer.held.cancelAria")} onClick={() => void act(row, () => release(row))}>
                      {t("composer.held.cancel")}
                    </Button>
                  )}
                  {canAct && row.state === "ended" && (
                    <span className="flex items-center gap-1">
                      {canResend(row) && (
                        <Button type="button" variant="outline" size="sm" className={QUEUED_BUTTON} disabled={disabled || sending} aria-label={t("composer.held.resendAria")} onClick={() => void resend(row)}>
                          {t("composer.held.resend")}
                        </Button>
                      )}
                      {row.outcome === "typed_not_submitted" && (
                        <>
                          <Button type="button" variant="outline" size="sm" className={QUEUED_BUTTON} disabled={disabled || sending} aria-label={t("composer.held.submitAria")} onClick={() => void settle(row, "submit")}>
                            {t("composer.held.submit")}
                          </Button>
                          <Button type="button" variant="outline" size="sm" className={QUEUED_BUTTON} disabled={disabled || sending} aria-label={t("composer.held.discardAria")} onClick={() => void settle(row, "discard")}>
                            {t("composer.held.discard")}
                          </Button>
                        </>
                      )}
                      {row.outcome !== "typed_not_submitted" && (
                        <Button type="button" variant="outline" size="sm" className={QUEUED_BUTTON} disabled={disabled} aria-label={t("composer.held.dismissAria")} onClick={() => void act(row, () => release(row))}>
                          {t("composer.held.dismiss")}
                        </Button>
                      )}
                    </span>
                  )}
                </div>
                <p className={QUEUED_TEXT}>{row.text}</p>
              </div>
            );
          })}
        </div>
      )}
    </Collapse>
  );
}
