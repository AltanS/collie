import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { Icon } from "@/components/icons/icon";

/**
 * Whether a pinch zooms the whole page (lib/page-zoom.ts holds the guard). ON by default, so the
 * browser's zoom stays there for anyone who needs bigger text; off is for a stray pinch. A per-device
 * choice, beside the Zoom pill, because both answer what a zoom gesture does on this phone.
 */
export function PageZoomControl() {
  useLocale();
  const { prefs, setPageZoom } = useDashPrefs();

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Icon name="zoom" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.pageZoom.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.pageZoom.description")}</p>
          </div>
        </div>
        <Switch checked={prefs.pageZoom} onCheckedChange={setPageZoom} aria-label={t("settings.pageZoom.title")} />
      </div>
    </Card>
  );
}
