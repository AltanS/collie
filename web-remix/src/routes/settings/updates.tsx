// /settings/updates, read-only: what `GET /api/update/check` says about this machine.
//
// The React page (web/src/routes/updates.tsx) is a check button over the update card, which starts a
// run (ADR 0044, 0064). This build shows the state and starts nothing: no `POST /api/update/check`,
// no `POST /api/update`. The read rides the poll beat while the page is open, and a failed read keeps
// the last answer on screen with the check's own error line under it.
import type { Handle } from "remix/component";
import { RefreshCw } from "lucide";

import { timeAgo } from "@web/lib/format";
import { t, tn } from "@web/lib/i18n";
import { settingsPath } from "@web/lib/nav";
import type { UpdateCheckResponse } from "@web/lib/types";

import { address } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { want } from "../../lib/polling";
import { useStore } from "../../lib/store";
import { Card } from "../../ui/card";
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
  return () => {
    const { data, error } = readCheck();
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
          {error !== undefined ? (
            <p class="border-t border-border px-4 py-2.5 text-xs text-status-blocked">{t("settings.update.error")}</p>
          ) : null}
        </Card>
      </SettingsPage>
    );
  };
}
