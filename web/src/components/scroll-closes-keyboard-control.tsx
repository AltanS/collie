import { Icon } from "@/components/icons/icon";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

/**
 * Whether a finger scroll towards older text closes the soft keyboard while the reply box has focus
 * (hooks/use-reading-releases-keyboard.ts). ON by default; off keeps the keyboard up while the person reads
 * back. A per-device choice, beside Enter sends, because both decide how the reply box and a keyboard meet.
 */
export function ScrollClosesKeyboardControl() {
  useLocale();
  const { prefs, setScrollClosesKeyboard } = useDashPrefs();

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Icon name="keys-drawer" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.scrollClosesKeyboard.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.scrollClosesKeyboard.hint")}</p>
          </div>
        </div>
        <Switch
          checked={prefs.scrollClosesKeyboard}
          onCheckedChange={setScrollClosesKeyboard}
          aria-label={t("settings.scrollClosesKeyboard.title")}
        />
      </div>
    </Card>
  );
}
