import { useState } from "react";
import { HardDrive, Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { keepChatOf, useDisplayPrefs } from "@/hooks/use-display-prefs";
import { useLocale } from "@/hooks/use-locale";
import { type KeepChat } from "@/lib/chat-tail";
import { t } from "@/lib/i18n";
import { clearStore } from "@/lib/store";

/**
 * "Keep chat on this phone": how long the newest Chat turns of each pane stay on the device, so a cold
 * open with the bridge out of reach can still draw them (M46 spec 09, lib/chat-tail.ts).
 *
 * Off, 1 day (the default) or 7 days. The value is read at each write, so a change applies from the
 * next write on, and Off also deletes every tail already kept, at once.
 *
 * In Device rather than Appearance, though the value lives with the display prefs: it decides what
 * this phone KEEPS, a standing decision about the device beside the Changes search and zen's
 * availability, not about how a surface looks.
 *
 * "Clear saved copies now" sits under the choice: it deletes EVERY record the on-device store holds
 * (the herd, each pane's last-seen text and every Chat tail, lib/store.ts `clearStore`), at once,
 * and leaves the pairing, the drafts and the setting alone. A short line then says it is done.
 */
export function KeepChatControl() {
  useLocale();
  const { prefs, setKeepChat } = useDisplayPrefs();
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);

  async function clearNow() {
    setClearing(true);
    setCleared(false);
    // Never rejects (ADR 0087 rule 9): the store reports nothing and keeps running.
    await clearStore();
    setClearing(false);
    setCleared(true);
  }
  const options: { value: KeepChat; label: string }[] = [
    { value: "off", label: t("settings.keepChat.off") },
    { value: "1d", label: t("settings.keepChat.day") },
    { value: "7d", label: t("settings.keepChat.week") },
  ];

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <HardDrive className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.keepChat.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.keepChat.description")}</p>
          </div>
        </div>
      </div>

      <div className="border-t border-border p-2">
        <Segmented
          options={options}
          value={keepChatOf(prefs)}
          onChange={setKeepChat}
          label={t("settings.keepChat.title")}
          semantics="choice"
        />
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border p-2 pl-4">
        {/* Always rendered, empty until the first clear: appearing late would grow the card. */}
        <p role="status" className="min-w-0 text-sm text-muted-foreground">
          {cleared ? t("settings.keepChat.cleared") : ""}
        </p>
        <Button variant="outline" size="sm" className="h-9 shrink-0" disabled={clearing} onClick={clearNow}>
          {clearing ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
          {t("settings.keepChat.clearNow")}
        </Button>
      </div>
    </Card>
  );
}
