import { Vibrate } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { hapticsSupported, setHapticsEnabled, useHapticsEnabled } from "@/lib/haptics";

// Haptics live in SETTINGS, not the pane's Display dock: that dock is explicitly "how the mirror
// looks", and a buzz is device behaviour, not a rendering pref. Default on.
//
// Hidden entirely where the platform has no vibrate API (iOS Safari) — a toggle that provably
// cannot do anything is worse than no toggle, because flipping it teaches the user the app lies.
export function HapticsControl() {
  useLocale();
  const enabled = useHapticsEnabled();
  if (!hapticsSupported()) return null;

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Vibrate className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.haptics.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.haptics.description")}</p>
          </div>
        </div>
        <div className="flex h-6 w-11 shrink-0 items-center justify-center">
          <Switch
            checked={enabled}
            onCheckedChange={setHapticsEnabled}
            aria-label={t("settings.haptics.title")}
          />
        </div>
      </div>
    </Card>
  );
}
