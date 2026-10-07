import { Hand as HandIcon } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { handOf, useDisplayPrefs, type Hand } from "@/hooks/use-display-prefs";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

// Which thumb the pane screen is laid out for. A per-device choice, stored with the display prefs and
// read by the pane when it mounts (components/agent-chat.tsx), so a change shows the next time a pane
// opens. It sits with appearance, directly under the belt's size: both decide how the same belt is
// drawn. `left` is the belt's true mirror (components/actions-row.tsx, `Hand`) plus Send and Attach
// on the left of the reply field (components/composer.tsx).
export function HandControl() {
  useLocale();
  const { prefs, setHand } = useDisplayPrefs();
  const options: { value: Hand; label: string }[] = [
    { value: "right", label: t("settings.hand.right") },
    { value: "left", label: t("settings.hand.left") },
  ];

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <HandIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.hand.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.hand.description")}</p>
          </div>
        </div>
      </div>

      <div className="border-t border-border p-2">
        <Segmented
          options={options}
          value={handOf(prefs)}
          onChange={setHand}
          label={t("settings.hand.title")}
          semantics="choice"
        />
      </div>
    </Card>
  );
}
