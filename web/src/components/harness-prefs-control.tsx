import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { harnessLabel } from "@/components/chat-cards";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { registeredAgents } from "@/lib/harness/registry";
import { prefKey, setHarnessStatusLineShown, useHarnessStatusLineShown } from "@/lib/harness-prefs";

// Settings → Harness configurations. One row per harness the web has an adapter for, because the
// adapter is what lifts a status line out of the screen: a harness without one has no strip to turn
// off. The rows come from the adapter registry (`registeredAgents()`, in registration order, which
// puts Claude Code first) and are named by `harnessLabel`, so adding a harness adapter adds its row
// here with no second list to keep in step. Two registry keys can name one harness (agy and
// antigravity); the store folds them (`prefKey`), so they share one row, "Antigravity".
//
// ON by default for every harness — the reasoning sits at the default in lib/harness-prefs.ts. The
// switch is the way OUT of a strip the operator can see, for the harness whose belt pills already
// say what the strip says (Claude Code's Tasks and Agents pills).
export function HarnessPrefsControl() {
  useLocale();
  // Through the same alias the store uses, so `agy` and `antigravity` make one row.
  const harnesses = [...new Set(registeredAgents().map(prefKey))];

  return (
    <Card className="gap-0 py-0">
      {harnesses.map((id, i) => (
        <HarnessStatusLineRow key={id} id={id} first={i === 0} />
      ))}
    </Card>
  );
}

function HarnessStatusLineRow({ id, first }: { id: string; first: boolean }) {
  const shown = useHarnessStatusLineShown(id);
  const name = harnessLabel(id);

  return (
    <div
      data-harness={id}
      className={cn("flex items-center justify-between gap-4 px-4 py-3", !first && "border-t border-border")}
    >
      <div className="min-w-0">
        <div className="font-medium">{name}</div>
        <div className="text-sm">{t("settings.harnesses.statusLine.label")}</div>
        <p className="text-xs text-muted-foreground">{t("settings.harnesses.statusLine.description")}</p>
      </div>
      <Switch
        checked={shown}
        onCheckedChange={(on) => setHarnessStatusLineShown(id, on)}
        aria-label={`${name}: ${t("settings.harnesses.statusLine.label")}`}
      />
    </div>
  );
}
