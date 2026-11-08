import { Icon } from "@/components/icons/icon";

import { Card } from "@/components/ui/card";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

/**
 * What Settings → Voice says when it has nothing to show. The index always offers the Voice row (a
 * row that comes and goes teaches nobody where to look), so the page owes an answer to "why is it
 * empty": this host offers no Whistle and no speech option, and this phone holds no model.
 *
 * The controller (components/speech-control.tsx) draws it only once the host's config and its speech
 * option have both been read and this phone has looked for its own copy. Until then "nothing is
 * offered" and "not asked yet" look the same, and a sentence that appears and is replaced by the
 * hub a moment later would move everything under it (DESIGN.md §2).
 */
export function VoiceEmpty() {
  useLocale();
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start gap-3 p-4">
        <Icon name="mic" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 text-sm text-muted-foreground">{t("settings.voice.empty")}</p>
      </div>
    </Card>
  );
}
