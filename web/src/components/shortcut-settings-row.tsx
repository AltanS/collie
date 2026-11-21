import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useLocale } from "@/hooks/use-locale";
import { useHardwareKeyboardSeen } from "@/lib/hardware-keyboard";
import { t } from "@/lib/i18n";
import { openShortcutHelp } from "@/lib/shortcuts/help";

// Settings, Keys and touch: Keyboard shortcuts (M108). The visible control of the `help` action: a button that
// opens the same sheet `prefix+?` opens. A row, not a switch, because it is an action and not a state
// (the argument of `TourControl`). Offered only on a device that has shown a hardware key press
// (lib/hardware-keyboard.ts): the width is no sign of one, a large tablet has none, and a list of
// keys is no use to a person who cannot press them.
export function ShortcutSettingsRow() {
  useLocale();
  const hasKeyboard = useHardwareKeyboardSeen();
  if (!hasKeyboard) return null;
  return (
    <Card className="gap-0 py-0" data-slot="settings-shortcuts">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Icon name="keys-drawer" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("shortcuts.list.title")}</div>
            <p className="text-sm text-muted-foreground">{t("shortcuts.settings.description")}</p>
          </div>
        </div>
        <Button type="button" variant="outline" className="min-h-11 shrink-0 px-4" aria-label={t("shortcuts.settings.buttonAria")} onClick={() => openShortcutHelp("all")}>
          {t("shortcuts.settings.button")}
        </Button>
      </div>
    </Card>
  );
}
