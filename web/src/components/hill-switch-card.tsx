import { Icon } from "@/components/icons/icon";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useHillSwitch } from "@/hooks/use-hill-switch";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

// Settings → Alerts → The Hill: one row, one switch (bridge/hill/switch.ts). On by default. Off, agents
// and tricks cannot post and the Hill leaves the bar; the open Decisions stay on the bridge and come back
// when it is on again. It sits first on Alerts, above the push switches, because it is the one that
// decides whether there is anything to be told about at all, and because nothing above it can grow and
// push it (the push block below mounts late). The value rides on the snapshot, so the row is drawn from
// the first frame with no reading of its own.

/** The controller: the bridge's value from the root data, the write through `useHillSwitch`. */
export function HillSwitchControl() {
  const sw = useHillSwitch();
  return <HillSwitchCard on={sw.on} disabled={sw.busy || !sw.canWrite} onToggle={(next) => void sw.set(next)} />;
}

/** The row itself, every value handed in, so the playground draws the real markup in both positions. */
export function HillSwitchCard({ on, disabled, onToggle }: { on: boolean; disabled: boolean; onToggle: (next: boolean) => void }) {
  useLocale();
  return (
    <Card className="gap-0 py-0" data-slot="hill-switch">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Icon name="hill" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.hill.label")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.hill.hint")}</p>
          </div>
        </div>
        <Switch checked={on} disabled={disabled} onCheckedChange={onToggle} aria-label={t("settings.hill.label")} />
      </div>
    </Card>
  );
}
