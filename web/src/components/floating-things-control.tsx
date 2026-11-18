import { Icon } from "@/components/icons/icon";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

/**
 * Whether tricks may draw small moving pictures over the app (the `float` place, lib/tricks/float.ts).
 * ON by default: the pictures never cover a question and never block a tap, and each trick still has its
 * own switch in Settings → Tricks. Off hides every picture at once, on this device only.
 */
export function FloatingThingsControl() {
  useLocale();
  const { prefs, setFloatingThings } = useDashPrefs();

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Icon name="mods" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.floatingThings.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.floatingThings.description")}</p>
          </div>
        </div>
        <Switch checked={prefs.floatingThings} onCheckedChange={setFloatingThings} aria-label={t("settings.floatingThings.title")} />
      </div>
    </Card>
  );
}
