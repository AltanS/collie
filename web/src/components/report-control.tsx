import { Bug } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { reportOfferOf, useDisplayPrefs } from "@/hooks/use-display-prefs";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { openReport } from "@/lib/report/store";

// Settings, System: Report a problem (ADR 0123). The switch turns the card after failed sends on or off
// for this device (on by default: the rule collects nothing and sends nothing). The button opens the same
// sheet the card opens, with no pane: it reports this machine's setup and the problems this phone noted.
// A pane's own report opens from that pane's menu.
export function ReportControl() {
  useLocale();
  const { prefs, setReportOffer } = useDisplayPrefs();
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Bug className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.report.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.report.description")}</p>
          </div>
        </div>
        <div className="flex h-6 w-11 shrink-0 items-center justify-center">
          <Switch checked={reportOfferOf(prefs)} onCheckedChange={setReportOffer} aria-label={t("settings.report.title")} />
        </div>
      </div>
      <div className="border-t border-border px-4 py-3">
        <Button type="button" variant="outline" className="h-11 w-full" data-slot="settings-report-open" onClick={() => openReport({})}>
          {t("settings.report.open")}
        </Button>
      </div>
    </Card>
  );
}
