// /settings/updates, read-only: what `GET /api/update/check` says about this machine.
//
// The React page (web/src/routes/updates.tsx) is a check button over the update card, which starts a
// run (ADR 0044, 0064). This build has the check button (`POST /api/update/check`, the manual look at
// upstream, with web's busy state: a spinner and "Checking…", disabled while it runs) and the state
// under it, and starts NO update run: no `POST /api/update`. The read rides the poll beat while the
// page is open, and a failed read keeps the last answer on screen with the check's own error line
// under it. Until the first read answers the page says so with a spinner, not with the prompt text.
import { on, type Handle } from "remix/component";
import { LoaderCircle, RefreshCw } from "lucide";

import { timeAgo } from "@web/lib/format";
import { t, tn } from "@web/lib/i18n";
import { settingsPath } from "@web/lib/nav";
import type { UpdateCheckResponse } from "@web/lib/types";

import { bridgeSend } from "../../lib/api";
import { address } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { want } from "../../lib/polling";
import { useStore } from "../../lib/store";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Collapse } from "../../ui/collapse";
import { Icon } from "../../ui/icon";
import { loadUpdateCheck, updateCheck } from "./update-check";
import { SettingsPage } from "./page";

export const UPDATE_CHECK_SOURCE = { key: "update-check", poll: loadUpdateCheck };

function running(update: UpdateCheckResponse | undefined): string {
  if (!update) return t("settings.update.check.prompt");
  if (update.checkedAt) {
    return t("settings.update.check.runningChecked", { current: update.current, checked: timeAgo(update.checkedAt) });
  }
  return t("settings.update.check.running", { current: update.current });
}

function newest(update: UpdateCheckResponse): string {
  if (update.latest === null) return t("settings.updateCard.unknownLatest");
  const upToDate = !update.releaseAvailable && !update.bridgeStale && !update.majorAvailable;
  return upToDate ? t("settings.updateCard.upToDate") : t("settings.updateCard.newest", { version: update.latest });
}

function preflightLine(update: UpdateCheckResponse): string {
  const report = update.preflight;
  if (report === null) return t("settings.updateCard.preflightUnavailable");
  const red = report.checks.filter((c) => c.verdict === "red").length;
  const amber = report.checks.filter((c) => c.verdict === "amber").length;
  const parts = [tn("settings.updateCard.summary.checks", report.checks.length)];
  if (red > 0) parts.push(tn("settings.updateCard.summary.red", red));
  if (amber > 0) parts.push(tn("settings.updateCard.summary.amber", amber));
  if (update.crew && update.crew.length > 0) parts.push(tn("settings.updateCard.summary.peers", update.crew.length));
  return parts.join(" · ");
}

export function UpdatesRoute(handle: Handle) {
  want(UPDATE_CHECK_SOURCE, handle.signal);
  const readCheck = useStore(handle, updateCheck);
  const where = useStore(handle, address);
  useLocale(handle);
  let busy = false;
  let failed = false;

  // web's `UpdateCheckControl.check`: the bridge is fail-soft (a GitHub error keeps the prior state and
  // still answers 200), so a `checkedAt` that did not advance is a failed check, not "Up to date".
  const check = async (signal: AbortSignal): Promise<void> => {
    busy = true;
    failed = false;
    void handle.update();
    const prior = updateCheck.get().data?.checkedAt ?? null;
    try {
      const result = await bridgeSend<{ checkedAt: number | null }>("POST", "/api/update/check", undefined, undefined, signal);
      if (signal.aborted) return;
      if (result.checkedAt === null || result.checkedAt === prior) failed = true;
      else await loadUpdateCheck(signal);
    } catch {
      if (signal.aborted) return;
      failed = true;
    }
    busy = false;
    void handle.update();
  };

  return () => {
    const { data, error } = readCheck();
    // The first read is still out: nothing is known about this machine yet (web's `pending`).
    const first = data === undefined && error === undefined;
    return (
      <SettingsPage title="updates.title" backLabel="updates.nav.back" up={settingsPath(where().scope)}>
        <Card class="gap-0 py-0" data-testid="update-check">
          <div class="flex items-start gap-3 p-4">
            <Icon icon={RefreshCw} class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div class="min-w-0">
              <div class="font-medium">{t("settings.update.title")}</div>
              <p class="text-sm text-muted-foreground">{running(data)}</p>
            </div>
          </div>
          <div class="flex items-center gap-3 border-t border-border p-3">
            <Button variant="outline" size="sm" disabled={busy} data-testid="update-check-button" mix={on("click", (_event, signal) => void check(signal))}>
              {busy ? <Icon icon={LoaderCircle} class="size-4 animate-spin" /> : null}
              {busy ? t("settings.update.checking") : t("settings.update.action")}
            </Button>
            {first ? (
              <span role="status" data-testid="update-check-pending" class="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Icon icon={LoaderCircle} class="size-3.5 animate-spin" />
                {t("settings.updateCard.checking")}
              </span>
            ) : !busy && failed ? (
              <span class="text-xs text-status-blocked">{t("settings.update.error")}</span>
            ) : null}
          </div>
          <Collapse open={data !== undefined}>
            {data ? (
              <dl class="flex flex-col divide-y divide-border border-t border-border text-sm">
                <div class="px-4 py-2.5">{newest(data)}</div>
                {data.majorAvailable ? (
                  <div class="px-4 py-2.5">{t("settings.updateCard.majorNote", { version: data.majorAvailable })}</div>
                ) : null}
                {data.restartNeeded ? <div class="px-4 py-2.5">{t("settings.updateBanner.restartNeeded")}</div> : null}
                <div class="px-4 py-2.5 text-muted-foreground">{preflightLine(data)}</div>
              </dl>
            ) : null}
          </Collapse>
          <Collapse open={error !== undefined}>
            <p class="border-t border-border px-4 py-2.5 text-xs text-status-blocked">{t("settings.update.error")}</p>
          </Collapse>
        </Card>
      </SettingsPage>
    );
  };
}
