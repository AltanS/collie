import { Icon } from "@/components/icons/icon";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { setProjectPictures, useProjectPicturesOn } from "@/lib/project-picture";

/**
 * Whether this device shows project pictures (ADR 0160, lib/project-picture.ts): the picture a
 * repository's `collie.toml` names, in place of the agent logo. On
 * until the person turns it off. Off shows the agent logo everywhere, puts no picture
 * on a push, and drops the copies the device kept. Per device, and never written to a bridge.
 */
export function ProjectPicturesControl() {
  useLocale();
  const on = useProjectPicturesOn();

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Icon name="image" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.projectPictures.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.projectPictures.hint")}</p>
          </div>
        </div>
        <Switch checked={on} onCheckedChange={setProjectPictures} aria-label={t("settings.projectPictures.title")} />
      </div>
    </Card>
  );
}
