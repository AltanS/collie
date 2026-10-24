import { PanelLeft } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { setWideLayoutMode, useWideLayoutMode, type WideLayoutMode } from "@/lib/wide-layout-store";

// Whether this device may show the large-screen layout (ADR 0120): the sidebar and the strip of pane
// columns. Auto follows the window (600px wide and 480px tall); Off keeps the phone layout at every
// width, for a screen where the layout misbehaves. A per-device choice stored beside the layout itself,
// and it takes effect at once, because the width class reads it.
export function WideLayoutControl() {
  useLocale();
  const mode = useWideLayoutMode();
  const options: { value: WideLayoutMode; label: string }[] = [
    { value: "auto", label: t("settings.wideLayout.auto") },
    { value: "off", label: t("settings.wideLayout.off") },
  ];

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <PanelLeft className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.wideLayout.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.wideLayout.hint")}</p>
          </div>
        </div>
      </div>

      <div className="border-t border-border p-2">
        <Segmented
          options={options}
          value={mode}
          onChange={setWideLayoutMode}
          label={t("settings.wideLayout.title")}
          semantics="choice"
        />
      </div>
    </Card>
  );
}
