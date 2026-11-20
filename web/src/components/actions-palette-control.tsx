import { Icon } from "@/components/icons/icon";
import { Card } from "@/components/ui/card";
import { SwitchRow } from "@/components/ui/switch-row";
import { useLocale } from "@/hooks/use-locale";
import { setActionsPaletteOn, useActionsPaletteOn } from "@/lib/actions-palette-store";
import { t } from "@/lib/i18n";

// Whether this device uses the Actions palette (ADR 0165). On by default. Off, the Belt's button and
// the shortcut open the pane list again, and no header carries an Actions button. Stored per device,
// beside the large-screen layout, and it takes effect at once, because every door reads the store.
export function ActionsPaletteControl() {
  useLocale();
  const on = useActionsPaletteOn();
  return (
    <Card className="gap-0 p-1 py-1">
      <SwitchRow
        icon={<Icon name="open-actions" className="size-5 shrink-0 text-muted-foreground" />}
        label={t("settings.actionsPalette.title")}
        hint={t("settings.actionsPalette.hint")}
        checked={on}
        onChange={(next) => {
          setActionsPaletteOn(next);
          return Promise.resolve(null);
        }}
      />
    </Card>
  );
}
