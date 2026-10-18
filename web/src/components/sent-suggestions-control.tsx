import { TextCursorInput } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { sentSuggestionsOf, useDisplayPrefs } from "@/hooks/use-display-prefs";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

// Whether a shell pane offers lines from Sent above its box while the person types (M61). A per-device
// choice, stored with the display prefs (`collie:display-prefs:v4`, no key of its own) and read by the
// composer on its next render. On by default. It turns off the strip's Sent rows only: the Sent button
// and the sheet stay, an agent pane's command suggestions in the same strip do not read it, and the
// bridge keeps recording either way (that switch is the bridge's COLLIE_SENT).
export function SentSuggestionsControl() {
  useLocale();
  const { prefs, setSentSuggestions } = useDisplayPrefs();

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <TextCursorInput className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.sentSuggestions.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.sentSuggestions.description")}</p>
          </div>
        </div>
        <div className="flex h-6 w-11 shrink-0 items-center justify-center">
          <Switch
            checked={sentSuggestionsOf(prefs)}
            onCheckedChange={setSentSuggestions}
            aria-label={t("settings.sentSuggestions.title")}
          />
        </div>
      </div>
    </Card>
  );
}
