import { MessagesSquare } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

/**
 * Whether this device offers Chat at all — the opt-in, and the first thing filed under Experiments.
 *
 * OFF by default. 1.15.0 ships Chat's reader for six harnesses and its screen on the first pass, and
 * two things are known to be incomplete on the day it ships: codex tool calls are invisible until
 * spec 12 lands, and hermes can lose a turn with no reducer able to tell (ADR 0073's Consequences).
 * Default-on would make those the first impression of the release. Default-off with a named switch
 * makes them the cost of opting in, and the caveat under the description names both rather than
 * leaving them to be discovered.
 *
 * It is the AVAILABILITY, not the mode. Turning it on hands the operator Chat at once — an opted-in
 * device reads `DashPrefs.paneView`, whose stored default is `chat` for exactly that reason — and
 * the pane's ⋮ menu is where the mode itself is then chosen, once, for the whole device (ADR 0071's
 * shape). lib/pane-view.ts holds the argument for why those are two values and not one.
 *
 * "Terminal stays the default, and the default flips in 2.0" is still true, and this switch is what
 * makes it true: a device that never opens this row draws terminals. When the gate goes in 2.0, the
 * stored default underneath IS the flip.
 */
export function ChatExperimentControl() {
  useLocale();
  const { prefs, setChatExperiment } = useDashPrefs();

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <MessagesSquare className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.experiments.chat.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.experiments.chat.description")}</p>
          </div>
        </div>
        <Switch
          checked={prefs.chatExperiment}
          onCheckedChange={setChatExperiment}
          aria-label={t("settings.experiments.chat.title")}
        />
      </div>

      {/* What is known to be missing, named rather than discovered. It hangs under the header's TEXT
          — `pl-12` is the card's own `px-4` plus the icon gutter above it — so one left edge runs
          down the card, the shape ZenControl's dependent row already uses. */}
      <div className="border-t border-border py-3 pl-12 pr-4">
        <p className="text-xs leading-snug text-muted-foreground">{t("settings.experiments.chat.caveat")}</p>
      </div>
    </Card>
  );
}
