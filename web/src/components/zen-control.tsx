import { Maximize2 } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { setAutoZenEnabled, setZenEnabled, useAutoZenEnabled, useZenEnabled } from "@/lib/zen";
import { cn } from "@/lib/utils";

// Zen mode's availability gate, next to Haptics and Hands-free: all three are "how this phone treats
// you". The pane's own actions sheet hosts zen's ENTRY, but not this — a persisted per-device
// capability toggle is not a rendering pref, and it is not something you reach for mid-session.
// Default off, so the extra menu row only appears for people who asked for it.
//
// The auto-landscape sub-row is NotifyPrefsControl's shape (a header switch plus a dependent row
// below it), not a second card: the two bits are the same feature at different granularity, and a
// device that has never turned zen on has nothing for the sub-row to gate. Disabled rather than
// hidden while the header switch is off, so turning zen on doesn't also silently flip a choice the
// operator can no longer see; the stored preference underneath is untouched either way (lib/zen.ts
// defaults it ON, which is inert until the header switch above it goes on).
export function ZenControl() {
  useLocale();
  const enabled = useZenEnabled();
  const autoLandscape = useAutoZenEnabled();

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Maximize2 className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.zen.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.zen.description")}</p>
          </div>
        </div>
        <div className="flex h-6 w-11 shrink-0 items-center justify-center">
          <Switch
            checked={enabled}
            onCheckedChange={setZenEnabled}
            aria-label={t("settings.zen.title")}
          />
        </div>
      </div>

      {/* The sub-row's text hangs under the header's TEXT, not under its icon: `pl-12` is the card's
          own `px-4` (16px) plus the icon gutter above it (a `size-5` glyph and `gap-3` = 32px), so
          one left edge runs down the card. Deliberately NOT NotifyPrefsControl's flush `px-4`: its
          rows are PEERS under a single header, so a shared left edge at the card edge is right
          there. This row is a DEPENDENT of the titled row above it, and starting it in that row's
          icon gutter reads as a second heading rather than as something the switch above governs. */}
      <div className="flex items-center justify-between gap-4 border-t border-border py-3 pl-12 pr-4">
        <div className="min-w-0">
          <div className={cn("text-sm font-medium", !enabled && "text-muted-foreground")}>
            {t("settings.zen.auto.label")}
          </div>
          <p className="text-xs text-muted-foreground">{t("settings.zen.auto.hint")}</p>
        </div>
        <Switch
          checked={autoLandscape}
          disabled={!enabled}
          onCheckedChange={setAutoZenEnabled}
          aria-label={t("settings.zen.auto.label")}
        />
      </div>
    </Card>
  );
}
