// The alert rules of ONE machine, on the Alerts view of its page (web/src/components/machine-alerts-control.tsx):
// for CPU, memory and disk a switch, a threshold and a duration. Disk is judged on the fullest filesystem,
// and its row shows only for a machine that reports disks (or already holds a disk rule, so a rule is
// never hidden while it lives).
//
// A CHANGE POSTS THE WHOLE OBJECT. The bridge replaces a machine's rules from the body, and a missing key
// removes that rule, so every change builds the complete `MachineAlerts` (the other metrics' rules
// included) and posts that.
//
// SAVING, SAVED, COULD NOT SAVE: IN THE CARD. The card's last line is one slot with two faces (`OneOf`):
// at rest it says where the push goes and links to Settings, after a tap it says Saving, Saved or what
// went wrong, each with its own mark. A screen reader hears the status from one live line that is always
// mounted. A failure puts the controls back on the rules the bridge last reported. A switch turned on
// opens its threshold and duration rows through `Collapse`.
//
// THE CARD NEVER FETCHES THE RULES: they arrive as a prop from the census (the beat keeps them current).
// It keeps a local copy only until the prop moves, so the controls do not flash the old rules between the
// answer and the next beat. The write goes through `bridgeSend`, which feeds `notePairing`.
import { on, type Handle } from "remix/component";
import { BellRing, Check, CircleAlert, LoaderCircle } from "lucide";

import { t } from "@web/lib/i18n";
import { ALERT_DURATIONS, ALERT_THRESHOLDS, DEFAULT_ALERT_RULE } from "@web/lib/machine-alerts";
import { formatPercent } from "@web/lib/machine-units";
import type { MachineAlertRule, MachineAlerts, MachineMetric } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { ApiError, bridgeSend } from "../../lib/api";
import { useLocale } from "../../lib/i18n-store";
import { kick } from "../../lib/polling";
import { scheduleUpdate } from "../../lib/store";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Collapse } from "../../ui/collapse";
import { Icon } from "../../ui/icon";
import { OneOf } from "../../ui/one-of";
import { Segmented } from "../../ui/segmented";
import { Switch } from "../../ui/switch";
import { machineAlertsUrl } from "../../lib/urls";

const METRICS = ["cpu", "mem", "disk"] as const satisfies readonly MachineMetric[];

const RULE_LABEL = {
  cpu: "machines.alerts.cpu",
  mem: "machines.alerts.mem",
  disk: "machines.alerts.disk",
} as const satisfies Record<MachineMetric, string>;

const NOT_FIRING: readonly MachineMetric[] = [];

type SaveState = "idle" | "saving" | "saved" | "failed" | "unpaired";

/** How long "Saved" stays before the line empties again. */
const SAVED_MS = 3000;

export interface MachineAlertsControlProps {
  machineId: string;
  /** The rules the bridge last reported for this machine. */
  alerts: MachineAlerts;
  /** The metrics whose episode is open now, said in words beside their switch. */
  firing?: readonly MachineMetric[];
  /** The "Alerts" settings link. */
  onOpenAlerts?: () => void;
  /**
   * This machine reports no load yet (an older member), so no rule on it could ever fire. The card then
   * holds its title and one line saying the machine needs updating, and no control.
   */
  needsUpdate?: boolean;
  /** The machine reports disks, so a disk rule can be judged. Without it the disk row is hidden. */
  hasDisks?: boolean;
}

/** The shipped choices, plus the stored value when it is none of them (a rule set from the CLI). */
export function withCurrent(options: readonly number[], current: number): number[] {
  return options.includes(current) ? [...options] : [...options, current].toSorted((a, b) => a - b);
}

/** The complete object with one metric's rule replaced, or removed when `rule` is null. */
export function withRule(shown: MachineAlerts, metric: MachineMetric, rule: MachineAlertRule | null): MachineAlerts {
  const next: MachineAlerts = {};
  for (const m of METRICS) {
    const kept = m === metric ? rule : (shown[m] ?? null);
    if (kept !== null) next[m] = kept;
  }
  return next;
}

/** The words of one save state, or nothing at rest. */
function statusWords(state: SaveState): string {
  switch (state) {
    case "idle":
      return "";
    case "saving":
      return t("machines.alerts.saving");
    case "saved":
      return t("machines.alerts.saved");
    case "failed":
      return t("machines.alerts.failed");
    case "unpaired":
      return t("machines.alerts.notPaired");
  }
}

export function MachineAlertsControl(handle: Handle<MachineAlertsControlProps>) {
  useLocale(handle);
  let state: SaveState = "idle";
  // The rules as the operator last set them, tied to the prop they were set against.
  let local: { base: string; alerts: MachineAlerts } | null = null;
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  handle.signal.addEventListener("abort", () => clearTimeout(savedTimer), { once: true });

  const save = async (next: MachineAlerts): Promise<void> => {
    const base = JSON.stringify(handle.props.alerts);
    local = { base, alerts: next };
    state = "saving";
    clearTimeout(savedTimer);
    scheduleUpdate(handle);
    try {
      const res = await bridgeSend<{ alerts: MachineAlerts }>(
        "POST",
        machineAlertsUrl(handle.props.machineId),
        // SAFETY: MachineAlerts is plain JSON (rules of numbers); the cast only widens it to the wire type.
        JSON.parse(JSON.stringify(next)),
        undefined,
        handle.signal,
      );
      if (handle.signal.aborted) return;
      local = { base, alerts: res.alerts };
      state = "saved";
      savedTimer = setTimeout(() => {
        state = "idle";
        scheduleUpdate(handle);
      }, SAVED_MS);
      // Ask the census again at once, so the rules come back from the bridge.
      kick();
    } catch (error) {
      if (handle.signal.aborted) return;
      local = null;
      // A 403 is the pairing gate: the remedy is to pair this device, and "could not save" would send
      // the operator hunting for a fault that is not there.
      state = error instanceof ApiError && error.status === 403 ? "unpaired" : "failed";
    }
    scheduleUpdate(handle);
  };

  return () => {
    const { alerts, firing = NOT_FIRING, onOpenAlerts, needsUpdate = false, hasDisks = false } = handle.props;
    const propKey = JSON.stringify(alerts);
    const shown = local !== null && local.base === propKey ? local.alerts : alerts;
    const saving = state === "saving";

    if (needsUpdate) {
      return (
        <Card class="gap-0 py-0" data-slot="machine-alerts-update">
          <div class="flex items-start gap-3 p-4">
            <Icon icon={BellRing} class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div class="min-w-0">
              <div class="font-medium">{t("machines.alerts.title")}</div>
              <p class="text-sm text-muted-foreground">{t("machines.alerts.needsUpdate")}</p>
            </div>
          </div>
        </Card>
      );
    }

    return (
      <Card class="gap-0 py-0" data-testid="machine-alerts">
        <div class="flex items-center justify-between gap-4 p-4">
          <div class="flex min-w-0 items-start gap-3">
            <Icon icon={BellRing} class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div class="min-w-0">
              <div class="font-medium">{t("machines.alerts.title")}</div>
              <p class="text-sm text-muted-foreground">{t("machines.alerts.description")}</p>
            </div>
          </div>
        </div>

        {METRICS.filter((metric) => metric !== "disk" || hasDisks || shown.disk !== undefined).map((metric) => (
          <RuleRow
            key={metric}
            metric={metric}
            rule={shown[metric]}
            firing={firing.includes(metric)}
            busy={saving}
            onToggle={(enabled) => void save(withRule(shown, metric, enabled ? DEFAULT_ALERT_RULE : null))}
            onChange={(rule) => void save(withRule(shown, metric, rule))}
          />
        ))}

        {/* The status, for a screen reader: one live line, always mounted, never seen. */}
        <p role="status" class="sr-only">
          {statusWords(state)}
        </p>
        <OneOf
          active={state === "idle" ? "push" : "status"}
          class="min-h-11 items-center border-t border-border px-4 py-1 text-xs"
          options={[
            {
              key: "push",
              node: (
                <div class="flex flex-wrap items-center gap-x-1 text-muted-foreground">
                  <span>{t("machines.alerts.push")}</span>
                  {onOpenAlerts === undefined ? null : (
                    <Button variant="link" size="sm" class="h-11 px-0 text-xs" mix={on("click", () => handle.props.onOpenAlerts?.())}>
                      {t("machines.alerts.pushLink")}
                    </Button>
                  )}
                </div>
              ),
            },
            {
              key: "status",
              node: (
                <p
                  aria-hidden="true"
                  class={cn(
                    "flex items-center gap-1.5 py-2",
                    state === "failed" || state === "unpaired" ? "font-medium text-status-blocked" : "text-muted-foreground",
                  )}
                >
                  <StatusMark state={state} />
                  {statusWords(state)}
                </p>
              ),
            },
          ]}
        />
      </Card>
    );
  };
}

interface RuleRowProps {
  metric: MachineMetric;
  rule: MachineAlertRule | undefined;
  firing: boolean;
  busy: boolean;
  onToggle: (on: boolean) => void;
  onChange: (rule: MachineAlertRule) => void;
}

function RuleRow(handle: Handle<RuleRowProps>) {
  return () => {
    const { metric, rule, firing, busy } = handle.props;
    const label = t(RULE_LABEL[metric]);
    return (
      <div class="border-t border-border px-4 py-3" data-metric={metric}>
        <div class="flex items-center justify-between gap-4">
          <div class="min-w-0">
            <div class="text-sm font-medium">{label}</div>
            {firing ? <p class="text-xs font-medium text-status-blocked">{t("machines.alerts.firingNow")}</p> : null}
          </div>
          <Switch checked={rule !== undefined} disabled={busy} onCheckedChange={(next) => handle.props.onToggle(next)} aria-label={label} />
        </div>
        <Collapse open={rule !== undefined}>
          {rule === undefined ? null : (
            <div class="space-y-3 pt-3">
              <Segmented
                label={t("machines.alerts.above", { metric: label })}
                options={withCurrent(ALERT_THRESHOLDS, rule.above).map((v) => ({ value: v, label: formatPercent(v) }))}
                value={rule.above}
                disabled={busy}
                onChange={(above) => handle.props.onChange({ ...rule, above: Number(above) })}
              />
              <Segmented
                label={t("machines.alerts.for", { metric: label })}
                options={withCurrent(ALERT_DURATIONS, rule.forMin).map((v) => ({ value: v, label: t("machines.alerts.minutes", { count: v }) }))}
                value={rule.forMin}
                disabled={busy}
                onChange={(forMin) => handle.props.onChange({ ...rule, forMin: Number(forMin) })}
              />
            </div>
          )}
        </Collapse>
      </div>
    );
  };
}

/** The mark beside the words: a spinner while saving, a check once saved, a warning on a failure. */
function StatusMark(handle: Handle<{ state: SaveState }>) {
  return () => {
    const { state } = handle.props;
    if (state === "saving") return <Icon icon={LoaderCircle} class="size-3.5 shrink-0 motion-safe:animate-spin" />;
    if (state === "saved") return <Icon icon={Check} class="size-3.5 shrink-0 text-status-done" />;
    if (state === "failed" || state === "unpaired") return <Icon icon={CircleAlert} class="size-3.5 shrink-0" />;
    return null;
  };
}
