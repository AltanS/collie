import { Wrench } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

/**
 * Whether a session view draws the agent's tool calls.
 *
 * OFF by default. A working session is mostly tool calls — one turn can be forty reads and a grep —
 * so a thread that draws them all is a thread you scroll past to find the paragraph you came for.
 * What the agent SAID is what the page is for; what it DID is one tap away, per turn.
 *
 * A per-device choice, like zen's availability and the Changes depth, and it sits in Appearance
 * because it decides what the page DRAWS. It is read by the History page today
 * (components/transcript-view.tsx) and by the Chat stream when that lands.
 *
 * FIND OVERRIDES IT, and that is not this card's business to say: a search matching inside a
 * command's output must be able to show what it matched, so the view draws every part while a query
 * is on screen. Mentioning it here would describe a state the reader is not in.
 */
export function ToolCallsControl() {
  useLocale();
  const { prefs, setShowToolCalls } = useDashPrefs();

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Wrench className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.tools.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.tools.description")}</p>
          </div>
        </div>
        <Switch
          checked={prefs.showToolCalls}
          onCheckedChange={setShowToolCalls}
          aria-label={t("settings.tools.title")}
        />
      </div>
    </Card>
  );
}
