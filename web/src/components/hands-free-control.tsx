import { Mic } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { setHandsFreeEnabled, useHandsFree, useSttCapability } from "@/lib/stt";

// The one voice SETTING (ADR 0029). Everything else about speech-to-text is an operator act on the
// keyboard — `collie stt setup` mints the credential, exactly as `collie pair` does — so this page
// carries the single question the phone gets to answer: does a finished transcript go into the
// message box, or straight out?
//
// DEFAULT OFF, and it stays a deliberate act. With it on, words nobody has read reach a real
// terminal; the send still takes the guarded reply path, but the review step is the operator, and
// this switch is where they waive it. The composer keeps two refusals the switch cannot express — a
// draft already in the box, and a password prompt on screen — and both fall back to inserting.
//
// Hidden where there is no microphone at all: no provider configured, or a browser that cannot
// record (an insecure origin has no `mediaDevices`). Same predicate as the composer's button, so the
// two can never disagree — a toggle for a feature that is absent teaches the user the app lies.
export function HandsFreeControl() {
  useLocale();
  const stt = useSttCapability();
  const enabled = useHandsFree();
  if (stt === null) return null;

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Mic className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.handsFree.title")}</div>
            <p className="text-sm text-muted-foreground">
              {t("settings.handsFree.description")}
            </p>
          </div>
        </div>
        <div className="flex h-6 w-11 shrink-0 items-center justify-center">
          <Switch
            checked={enabled}
            onCheckedChange={setHandsFreeEnabled}
            aria-label={t("settings.handsFree.ariaLabel")}
          />
        </div>
      </div>
      {!stt.available && stt.reason !== undefined && (
        <p className="border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
          {stt.reason}
        </p>
      )}
    </Card>
  );
}
