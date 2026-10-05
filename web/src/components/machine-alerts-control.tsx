import { useEffect, useRef, useState } from "react";
import { BellRing, Check, CircleAlert, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapse } from "@/components/ui/collapse";
import { OneOf } from "@/components/ui/one-of";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/hooks/use-locale";
import { isApiErrorStatus, setMachineAlerts } from "@/lib/api";
import { t } from "@/lib/i18n";
import { ALERT_DURATIONS, ALERT_THRESHOLDS, DEFAULT_ALERT_RULE } from "@/lib/machine-alerts";
import { formatPercent } from "@/lib/machine-units";
import { mutate } from "@/lib/mutate";
import type { MachineAlertRule, MachineAlerts, MachineMetric } from "@/lib/types";
import { cn } from "@/lib/utils";

// The alert rules of ONE machine, on its page: for CPU and for memory a switch, a threshold and a
// duration. The bridge holds one rule per metric per machine and pushes once when a value stays at or
// above the threshold for that long.
//
// ── A CHANGE POSTS THE WHOLE OBJECT ──────────────────────────────────────────
// The bridge replaces a machine's rules from the body, and a missing key removes that rule. So every
// change builds the complete `MachineAlerts` (the other metric's rule included) and posts that; a
// partial body would silently delete the metric the operator did not touch.
//
// ── SAVING, SAVED, COULD NOT SAVE: IN THE CARD ───────────────────────────────
// The answer outlives the operator's next tap and belongs beside the control that asked
// (DESIGN.md §11, a contextual notice; lib/ack-manifest.ts files it as `inline`). The card's last
// line is one slot with two faces (`ui/one-of.tsx`): at rest it says where the push goes and links
// to Settings, and after a tap it says Saving, Saved or what went wrong, each with its own mark, so
// no state is told by colour alone. The slot keeps the taller face's height, so no word moves the
// rows, and an idle card has no empty band waiting for a status. A screen reader hears the status
// from one live line that is always mounted. A failure puts the controls back on the rules the
// bridge last reported, because a rule that did not land must not stay on screen as if it had.
//
// A switch turned on opens its threshold and duration rows with `ui/collapse.tsx`, so the rows
// under it slide instead of jumping.
//
// ── THE CARD NEVER FETCHES ───────────────────────────────────────────────────
// The rules arrive as a prop from the page's loader (the poll loop keeps them current). The card keeps
// a local copy only until the prop moves, so the controls do not flash the old rules between the answer
// and the next poll.

const METRICS = ["cpu", "mem"] as const satisfies readonly MachineMetric[];

/** A stable empty list for the `firing` default, so the prop keeps one identity across renders. */
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
  /** Called after a successful save, so the page can re-ask the loader at once. */
  onSaved?: () => void;
  /** The "Alerts" settings link; absent in a harness that has no router. */
  onOpenAlerts?: () => void;
  /**
   * This machine reports no load yet (an older member), so no rule on it could ever fire. The card
   * then holds its title and one line saying the machine needs updating, and no control: a switch
   * that saves a rule nothing will evaluate is a promise the machine cannot keep.
   */
  needsUpdate?: boolean;
}

export function MachineAlertsControl({
  machineId,
  alerts,
  firing = NOT_FIRING,
  onSaved,
  onOpenAlerts,
  needsUpdate = false,
}: MachineAlertsControlProps) {
  useLocale();
  const [state, setState] = useState<SaveState>("idle");
  // The rules as the operator last set them, tied to the prop they were set against. Once the prop
  // moves (the poll after a save), the prop is the truth again.
  const [local, setLocal] = useState<{ base: string; alerts: MachineAlerts } | null>(null);
  const propKey = JSON.stringify(alerts);
  const shown = local !== null && local.base === propKey ? local.alerts : alerts;
  const saving = state === "saving";

  // A save that lands after the card unmounted must not set state, nor call back into a page that left.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (state !== "saved") return undefined;
    const timer = setTimeout(() => setState("idle"), SAVED_MS);
    return () => clearTimeout(timer);
  }, [state]);

  async function save(next: MachineAlerts) {
    setLocal({ base: propKey, alerts: next });
    setState("saving");
    // `ownError`: the failure is told in this card's own status line, not twice.
    const res = await mutate(() => setMachineAlerts(machineId, next), { ownError: true });
    if (!alive.current) return;
    if (res.ok) {
      setLocal({ base: propKey, alerts: res.value.alerts });
      setState("saved");
      onSaved?.();
      return;
    }
    setLocal(null);
    // A write refused with 403 is the pairing gate (or the proxy's list): the remedy is to pair this
    // device, and "could not save" would send the operator hunting for a fault that is not there.
    setState(isApiErrorStatus(res.error, 403) ? "unpaired" : "failed");
  }

  /** The complete object with one metric's rule replaced, or removed when `rule` is null. */
  function withRule(metric: MachineMetric, rule: MachineAlertRule | null): MachineAlerts {
    const next: MachineAlerts = {};
    for (const m of METRICS) {
      const kept = m === metric ? rule : (shown[m] ?? null);
      if (kept !== null) next[m] = kept;
    }
    return next;
  }

  if (needsUpdate) {
    return (
      <Card className="gap-0 py-0" data-slot="machine-alerts-update">
        <div className="flex items-start gap-3 p-4">
          <BellRing className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("machines.alerts.title")}</div>
            <p className="text-sm text-muted-foreground">{t("machines.alerts.needsUpdate")}</p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <BellRing className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("machines.alerts.title")}</div>
            <p className="text-sm text-muted-foreground">{t("machines.alerts.description")}</p>
          </div>
        </div>
      </div>

      {METRICS.map((metric) => (
        <RuleRow
          key={metric}
          metric={metric}
          rule={shown[metric]}
          firing={firing.includes(metric)}
          busy={saving}
          onToggle={(on) => void save(withRule(metric, on ? DEFAULT_ALERT_RULE : null))}
          onChange={(rule) => void save(withRule(metric, rule))}
        />
      ))}

      {/* The status, for a screen reader: one live line, always mounted, never seen. */}
      <p role="status" className="sr-only">
        {statusWords(state)}
      </p>
      <OneOf
        active={state === "idle" ? "push" : "status"}
        className="min-h-11 items-center border-t border-border px-4 py-1 text-xs"
        options={[
          {
            key: "push",
            node: (
              <div className="flex flex-wrap items-center gap-x-1 text-muted-foreground">
                <span>{t("machines.alerts.push")}</span>
                {onOpenAlerts !== undefined && (
                  <Button variant="link" size="sm" className="h-11 px-0 text-xs" onClick={onOpenAlerts}>
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
                aria-hidden
                className={cn(
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
}

function RuleRow({
  metric,
  rule,
  firing,
  busy,
  onToggle,
  onChange,
}: {
  metric: MachineMetric;
  rule: MachineAlertRule | undefined;
  firing: boolean;
  busy: boolean;
  onToggle: (on: boolean) => void;
  onChange: (rule: MachineAlertRule) => void;
}) {
  const label = t(metric === "cpu" ? "machines.alerts.cpu" : "machines.alerts.mem");
  return (
    <div className="border-t border-border px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">{label}</div>
          {firing && <p className="text-xs font-medium text-status-blocked">{t("machines.alerts.firingNow")}</p>}
        </div>
        <Switch checked={rule !== undefined} disabled={busy} onCheckedChange={onToggle} aria-label={label} />
      </div>
      <Collapse open={rule !== undefined}>
        {rule !== undefined && (
          <div className="space-y-3 pt-3">
            <Segmented
              label={t("machines.alerts.above", { metric: label })}
              options={withCurrent(ALERT_THRESHOLDS, rule.above).map((v) => ({ value: v, label: formatPercent(v) }))}
              value={rule.above}
              disabled={busy}
              onChange={(above) => onChange({ ...rule, above })}
            />
            <Segmented
              label={t("machines.alerts.for", { metric: label })}
              options={withCurrent(ALERT_DURATIONS, rule.forMin).map((v) => ({ value: v, label: t("machines.alerts.minutes", { count: v }) }))}
              value={rule.forMin}
              disabled={busy}
              onChange={(forMin) => onChange({ ...rule, forMin })}
            />
          </div>
        )}
      </Collapse>
    </div>
  );
}

/**
 * The shipped choices, plus the stored value when it is none of them (a rule set from the CLI or by a
 * newer shell). Dropping it would show a switch that is on with nothing selected beneath it.
 */
function withCurrent(options: readonly number[], current: number): number[] {
  return options.includes(current) ? [...options] : [...options, current].toSorted((a, b) => a - b);
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

/** The mark beside the words: a spinner while saving, a check once saved, a warning on a failure. */
function StatusMark({ state }: { state: SaveState }) {
  if (state === "saving") return <Loader2 className="size-3.5 shrink-0 motion-safe:animate-spin" aria-hidden />;
  if (state === "saved") return <Check className="size-3.5 shrink-0 text-status-done" aria-hidden />;
  if (state === "failed" || state === "unpaired") return <CircleAlert className="size-3.5 shrink-0" aria-hidden />;
  return null;
}
