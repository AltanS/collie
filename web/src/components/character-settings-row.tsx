import { Card } from "@/components/ui/card";
import { SettingsNavRow } from "@/components/settings-nav-row";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { useDesignPrefs } from "@/lib/design";
import { t } from "@/lib/i18n";
import { markName } from "@/lib/mark-ids";
import { characterPath } from "@/lib/nav";
import { useScope } from "@/lib/session";

/**
 * The row Settings → Look and feel keeps for the header's character: its value in two or three words and
 * a chevron to the page that lists them (components/character-picker.tsx). It only reads the design
 * store; the choice is made on the page below.
 */
export function CharacterSettingsRow() {
  useLocale();
  const nav = useNav();
  const scope = useScope();
  const chosen = useDesignPrefs().mark;
  const caption = chosen === undefined ? t("settings.character.fromTheme") : markName(chosen);
  return (
    <Card className="gap-0 py-0" data-slot="character-row">
      <SettingsNavRow icon="theme" title={t("settings.character.title")} caption={caption} onOpen={() => nav.down(characterPath(scope))} />
    </Card>
  );
}
