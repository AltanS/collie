import { Move } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { paneNavOf, useDisplayPrefs, type PaneNav } from "@/hooks/use-display-prefs";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

// How the pane screen moves between panes and spaces by gesture (M70 spec 03, ADR 0121): Two fingers
// (the default), Joystick or Off. A per-device choice, stored with the display prefs like the hand, and
// read by the pane when it mounts (components/agent-chat.tsx), so a change shows the next time a pane
// opens. It sits beside Large-screen layout: both decide how the pane screen is arranged and moved.
// The gesture is an extra: the switcher, the sidebar and the space header stay the accessible way.
export function PaneNavControl() {
  useLocale();
  const { prefs, setPaneNav } = useDisplayPrefs();
  const options: { value: PaneNav; label: string }[] = [
    { value: "twoFingers", label: t("settings.paneNav.twoFingers") },
    { value: "joystick", label: t("settings.paneNav.joystick") },
    { value: "off", label: t("settings.paneNav.off") },
  ];

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Move className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.paneNav.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.paneNav.hint")}</p>
          </div>
        </div>
      </div>

      <div className="border-t border-border p-2">
        {/* `tight`: "Two fingers" (and "Deux doigts", "Disattivato") clipped under px-4 on a phone. */}
        <Segmented options={options} value={paneNavOf(prefs)} onChange={setPaneNav} label={t("settings.paneNav.title")} semantics="choice" tight />
      </div>
    </Card>
  );
}
