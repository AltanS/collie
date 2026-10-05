import { useEffect, useRef, useState } from "react";
import { BellRing, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/hooks/use-locale";
import { setMachineAlerts } from "@/lib/api";
import { t } from "@/lib/i18n";
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
// (DESIGN.md §11, a contextual notice; lib/ack-manifest.ts files it as `inline`). One status
// line holds all three words, always mounted at a fixed height so none of them moves the rows. A
// failure puts the controls back on the rules the bridge last reported, because a rule that did not
// land must not stay on screen as if it had.
//
// ── THE CARD NEVER FETCHES ───────────────────────────────────────────────────
// The rules arrive as a prop from the page's loader (the poll loop keeps them current). The card keeps
// a local copy only until the prop moves, so the controls do not flash the old rules between the answer
// and the next poll.

const THRESHOLDS = [0.8, 0.9, 0.95] as const;
const DURATIONS = [5, 10, 30, 60] as const;
/** What a switch turns on to, before the operator picks anything else. */
const DEFAULT_RULE: MachineAlertRule = { above: 0.9, forMin: 10 };
const METRICS = ["cpu", "mem"] as const satisfies readonly MachineMetric[];

/** A stable empty list for the `firing` default, so the prop keeps one identity across renders. */
const NOT_FIRING: readonly MachineMetric[] = [];

type SaveState = "idle" | "saving" | "saved" | "failed";

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
}

export function MachineAlertsControl({ machineId, alerts, firing = NOT_FIRING, onSaved, onOpenAlerts }: MachineAlertsControlProps) {
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
    setState("failed");
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
        {saving && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />}
      </div>

      {METRICS.map((metric) => (
        <RuleRow
          key={metric}
          metric={metric}
          rule={shown[metric]}
          firing={firing.includes(metric)}
          busy={saving}
          onToggle={(on) => void save(withRule(metric, on ? DEFAULT_RULE : null))}
          onChange={(rule) => void save(withRule(metric, rule))}
        />
      ))}

      {/* One line, always mounted at one height: Saving, Saved and Could not save take turns in it. */}
      <p
        role="status"
        className={cn(
          "flex min-h-8 items-center border-t border-border px-4 text-xs",
          state === "failed" ? "text-status-blocked" : "text-muted-foreground",
        )}
      >
        {state === "saving" && t("machines.alerts.saving")}
        {state === "saved" && t("machines.alerts.saved")}
        {state === "failed" && t("machines.alerts.failed")}
      </p>

      <div className="flex flex-wrap items-center gap-x-1 border-t border-border px-4 py-1 text-xs text-muted-foreground">
        <span>{t("machines.alerts.push")}</span>
        {onOpenAlerts !== undefined && (
          <Button variant="link" size="sm" className="h-11 px-0 text-xs" onClick={onOpenAlerts}>
            {t("machines.alerts.pushLink")}
          </Button>
        )}
      </div>
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
      {rule !== undefined && (
        <div className="mt-3 space-y-3">
          <Segmented
            label={t("machines.alerts.above", { metric: label })}
            options={withCurrent(THRESHOLDS, rule.above).map((v) => ({ value: v, label: formatPercent(v) }))}
            value={rule.above}
            disabled={busy}
            onChange={(above) => onChange({ ...rule, above })}
          />
          <Segmented
            label={t("machines.alerts.for", { metric: label })}
            options={withCurrent(DURATIONS, rule.forMin).map((v) => ({ value: v, label: t("machines.alerts.minutes", { count: v }) }))}
            value={rule.forMin}
            disabled={busy}
            onChange={(forMin) => onChange({ ...rule, forMin })}
          />
        </div>
      )}
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
