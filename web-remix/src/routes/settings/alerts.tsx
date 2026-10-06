// Settings → Alerts: when Collie speaks up. Port of web/'s PushControl, NotifyPrefsControl and
// SnoozeControl, in web's order.
//
// The two bridge-wide cards (which events push, and the quiet hours) are mounted while push state is
// still UNKNOWN and only leave once we positively learn the bridge has no VAPID keys. They go through
// `Collapse`, so neither a late arrival nor that departure shoves the page.
import { on, type Handle } from "remix/component";
import { Bell, BellOff, BellRing } from "lucide";

import { t, type MessageKey } from "@web/lib/i18n";
import { availabilityNote, reasonText } from "@web/lib/push-copy";
import type { NotifyPrefs } from "@web/lib/types";

import { snapshot } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { useStore } from "../../lib/store";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Collapse } from "../../ui/collapse";
import { Switch } from "../../ui/switch";
import {
  applySnooze,
  forgetWatched,
  loadNotifyPrefs,
  loadWatchList,
  notifyBusy,
  notifyPrefs,
  snoozeBusy,
  toggleNotify,
  watchBusy,
  watchList,
} from "./alerts-data";
import { describeError } from "./mutate";
import { CardHead, Spinner, SwitchSlot } from "./parts";
import { disablePush, enablePush, getPushState, pushState } from "./push";

/** The push switch. The row stays mounted and explains itself: a missing switch teaches nothing. */
export function PushControl(handle: Handle) {
  const readState = useStore(handle, pushState);
  useLocale(handle);
  let busy = false;
  let error = "";
  void getPushState();

  async function toggle(next: boolean): Promise<void> {
    error = "";
    busy = true;
    void handle.update();
    try {
      if (next) {
        const res = await enablePush();
        if (handle.signal.aborted) return;
        if (!res.ok) error = reasonText(res.reason);
      } else {
        await disablePush();
        if (handle.signal.aborted) return;
      }
    } catch (thrown) {
      if (handle.signal.aborted) return;
      error = describeError(thrown instanceof Error ? thrown : new Error(String(thrown)));
    }
    try {
      await getPushState();
    } finally {
      busy = false;
      if (!handle.signal.aborted) void handle.update();
    }
  }

  return () => {
    const state = readState();
    const on_ = state !== null && !state.userDisabled && state.subscribed;
    const blocked = state !== null && state.availability !== "ready";
    // Capability and permission refusals block enabling; a failed config read stays retryable.
    const disabled = busy || state === null || (blocked && !on_ && state.availability !== "unavailable");
    const note = state !== null && blocked ? availabilityNote(state.availability) : "";
    return (
      <Card class="gap-0 py-0" data-testid="push-card">
        <CardHead icon={Bell} title={t("settings.push.title")} description={t("settings.push.description")}>
          <SwitchSlot>
            {state === null ? (
              <Spinner />
            ) : (
              <Switch checked={on_} disabled={disabled} aria-label={t("settings.push.title")} onCheckedChange={(next) => void toggle(next)} />
            )}
          </SwitchSlot>
        </CardHead>
        <Collapse open={note !== ""}>
          <p class="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">{note}</p>
        </Collapse>
        <Collapse open={error !== ""}>
          <p role="alert" class="border-t border-border px-4 py-2.5 text-xs text-status-blocked">
            {error}
          </p>
        </Collapse>
      </Card>
    );
  };
}

const ROWS: ReadonlyArray<{ key: keyof NotifyPrefs; labelKey: MessageKey; hintKey: MessageKey }> = [
  { key: "blocked", labelKey: "settings.notify.blocked.label", hintKey: "settings.notify.blocked.hint" },
  { key: "done", labelKey: "settings.notify.done.label", hintKey: "settings.notify.done.hint" },
  { key: "updates", labelKey: "settings.notify.updates.label", hintKey: "settings.notify.updates.hint" },
  // Machine alerts (ADR 0084). Above `cache` so the watched panes stay under the switch they belong to.
  { key: "machines", labelKey: "settings.notify.machines.label", hintKey: "settings.notify.machines.hint" },
  // The only one that is ALSO switchable per pane (ADR 0042): the hint says so.
  { key: "cache", labelKey: "settings.notify.cache.label", hintKey: "settings.notify.cache.hint" },
];

/**
 * Which lifecycle events are worth a push, bridge-wide. The rows render before the values land: the
 * list is static, so the card's SHAPE is known from the first frame, and the switches stay disabled
 * until the real values arrive.
 */
export function NotifyPrefsControl(handle: Handle) {
  const readPrefs = useStore(handle, notifyPrefs);
  const readBusy = useStore(handle, notifyBusy);
  const readList = useStore(handle, watchList);
  const readWatchBusy = useStore(handle, watchBusy);
  useLocale(handle);
  void loadNotifyPrefs(handle.signal);
  void loadWatchList(handle.signal);
  return () => {
    const prefs = readPrefs();
    const busy = readBusy();
    const entries = readList();
    const count = entries?.length ?? 0;
    return (
      <Card class="gap-0 py-0" data-testid="notify-card">
        <CardHead icon={BellRing} title={t("settings.notify.title")} description={t("settings.notify.description")}>
          {prefs === null ? <Spinner /> : null}
        </CardHead>
        {ROWS.map((row) => (
          <div key={row.key} class="flex items-center justify-between gap-4 border-t border-border px-4 py-3">
            <div class="min-w-0">
              <div class="text-sm font-medium">{t(row.labelKey)}</div>
              <p class="text-xs text-muted-foreground">{t(row.hintKey)}</p>
            </div>
            <Switch
              checked={prefs?.[row.key] ?? false}
              disabled={busy || prefs === null}
              aria-label={t(row.labelKey)}
              onCheckedChange={(next) => void toggleNotify(row.key, next)}
            />
          </div>
        ))}
        {/* The panes watched one by one. The heading is there from the first frame; only rows are pending. */}
        <div class="flex items-center justify-between gap-4 border-t border-border px-4 py-3">
          <div class="text-sm font-medium">{t("settings.notify.watched.title")}</div>
          <span class="text-xs text-muted-foreground tabular-nums">{entries === null ? "" : count}</span>
        </div>
        {count === 0 ? (
          <p class="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">{t("settings.notify.watched.empty")}</p>
        ) : (
          <ul class="divide-y divide-border border-t border-border" data-testid="watched-list">
            {entries?.map((entry) => (
              <li key={entry.id} class="flex items-center justify-between gap-3 px-4 py-2.5">
                <div class="min-w-0">
                  <div class="truncate text-sm">{entry.label}</div>
                  {entry.host === undefined ? null : <p class="truncate text-xs text-muted-foreground">{entry.host}</p>}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  class="shrink-0"
                  disabled={readWatchBusy()}
                  aria-label={t("settings.notify.watched.removeAria", { label: entry.label })}
                  mix={on("click", () => void forgetWatched(entry.id))}
                >
                  {t("settings.notify.watched.remove")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    );
  };
}

const PRESETS: ReadonlyArray<{ labelKey: MessageKey; minutes: number }> = [
  { labelKey: "settings.snooze.preset.min30", minutes: 30 },
  { labelKey: "settings.snooze.preset.hour1", minutes: 60 },
  { labelKey: "settings.snooze.preset.hour4", minutes: 240 },
];

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * "Do not disturb" for push: a global snooze with presets, server-enforced and self-resuming. The
 * deadline rides the snapshot, so it stays in step across devices. The spinner beside the title is the
 * echo of the tap; a failure is published by `mutate`, and the description keeps stating the truth.
 */
export function SnoozeControl(handle: Handle) {
  const readSnap = useStore(handle, snapshot);
  const readBusy = useStore(handle, snoozeBusy);
  useLocale(handle);
  return () => {
    const until = readSnap().data?.notifications?.snoozedUntil ?? null;
    const snoozed = until !== null && until > Date.now();
    const busy = readBusy();
    return (
      <Card class="gap-0 py-0" data-testid="snooze-card">
        <CardHead
          icon={BellOff}
          title={t("settings.snooze.title")}
          description={snoozed ? t("settings.snooze.description.active", { time: formatTime(until) }) : t("settings.snooze.description.idle")}
        >
          {busy ? <Spinner /> : null}
        </CardHead>
        <div class="flex items-center gap-2 border-t border-border p-3">
          {snoozed ? (
            <Button variant="secondary" size="sm" disabled={busy} mix={on("click", () => void applySnooze(null))}>
              {t("settings.snooze.resume")}
            </Button>
          ) : (
            PRESETS.map((preset) => (
              <Button
                key={preset.labelKey}
                variant="outline"
                size="sm"
                disabled={busy}
                mix={on("click", () => void applySnooze(Date.now() + preset.minutes * 60_000))}
              >
                {t(preset.labelKey)}
              </Button>
            ))
          )}
        </div>
      </Card>
    );
  };
}

/** The two bridge-wide cards, gone only when push is positively `server-off` (see the file header). */
export function BridgeWideAlerts(handle: Handle) {
  const readState = useStore(handle, pushState);
  return () => (
    <Collapse open={readState()?.availability !== "server-off"}>
      <div class="space-y-4">
        <NotifyPrefsControl />
        <SnoozeControl />
      </div>
    </Collapse>
  );
}
