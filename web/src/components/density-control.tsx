import { Rows3 } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { setDenseKeysEnabled, useDenseKeysEnabled } from "@/lib/density";

// The dense key surfaces, beside Theme and the two font cards: all of them are "how this phone
// presents itself", and this one is the same shape of decision — set once, per device, standing.
//
// It is not in the pane's Display dock, which is explicitly "how the MIRROR looks" and holds prefs
// the operator flips while watching output. This changes the chrome around the mirror instead, and
// changing it mid-session moves every control under the thumb — a page-level setting, deliberately
// a walk away from the pane.
//
// Off by default: an install that never opens Settings keeps the layout it already has.
export function DensityControl() {
  useLocale();
  const enabled = useDenseKeysEnabled();

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Rows3 className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.density.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.density.description")}</p>
          </div>
        </div>
        <div className="flex h-6 w-11 shrink-0 items-center justify-center">
          <Switch
            checked={enabled}
            onCheckedChange={setDenseKeysEnabled}
            aria-label={t("settings.density.title")}
          />
        </div>
      </div>
    </Card>
  );
}
