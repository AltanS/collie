import { MonitorPlay } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { setFollowTerminalEnabled, useFollowTerminalEnabled } from "@/lib/follow-terminal";

// "Follow terminal" — the phone follows the operator's own screen. Off by default, and its card says
// which way the arrow points, because the reverse (the phone moving the terminal) is the thing an
// operator would be right to worry about: that only ever happens on a tap of "Show in terminal".
//
// Shown on every multiplexer, unlike the "Show in terminal" row: following needs only the focus a
// snapshot already reports, which is on the contract's floor. Nothing to gate, nothing to hide.
export function FollowTerminalControl() {
  useLocale();
  const enabled = useFollowTerminalEnabled();

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <MonitorPlay className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.followTerminal.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.followTerminal.description")}</p>
          </div>
        </div>
        <div className="flex h-6 w-11 shrink-0 items-center justify-center">
          <Switch
            checked={enabled}
            onCheckedChange={setFollowTerminalEnabled}
            aria-label={t("settings.followTerminal.title")}
          />
        </div>
      </div>
    </Card>
  );
}
