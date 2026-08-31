import { MonitorDown, Share } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapse } from "@/components/ui/collapse";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { probeShareSheetInstall, promptInstall, useInstallOffer } from "@/lib/install";

// The PWA install card. Present ONLY while the browser holds an install offer (lib/install.ts) —
// which is what makes it honest: a device that already installed and an insecure origin both render
// nothing, instead of a button that cannot deliver.
//
// iOS is the one deliberate exception to absence-as-answer. Its browsers never fire the offer —
// install lives in the share sheet — so the honest button can never exist there, and the people
// with the least-known install path were the only ones the card said nothing to. They get prose
// instead of a button: one line naming the share-sheet steps, shown exactly while it applies
// (an Apple touch device, not yet running installed — lib/install.ts's probe).
//
// Arrival goes through `Collapse` (DESIGN.md §1): the offer usually lands after first paint, and a
// card popping into the middle of Settings at full height is exactly the shift §2 forbids. The iOS
// hint does NOT collapse in: its fact is known at first render and never changes, so it is simply
// there, with nothing to animate.
export function InstallControl({ shareSheet = probeShareSheetInstall() }: { shareSheet?: boolean }) {
  useLocale();
  const offered = useInstallOffer();

  return (
    <>
      <Collapse open={offered}>
        {offered ? (
          <Card className="gap-0 py-0">
            <div className="flex items-center justify-between gap-4 p-4">
              <div className="flex min-w-0 items-start gap-3">
                <MonitorDown className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="font-medium">{t("settings.install.title")}</div>
                  <p className="text-sm text-muted-foreground">
                    {t("settings.install.description")}
                  </p>
                </div>
              </div>
              {/* min-h-11 rather than the compact size: this is a one-shot action button, and §6's
                  44px floor applies to it like any other tap target. */}
              <Button
                type="button"
                variant="outline"
                className="min-h-11 shrink-0 px-4"
                onClick={() => void promptInstall()}
              >
                {t("settings.install.button")}
              </Button>
            </div>
          </Card>
        ) : null}
      </Collapse>
      {/* The offer wins if both are somehow true: a browser that CAN prompt should, and one card is
          enough. In practice the two never coexist — no iOS browser fires the offer. */}
      {shareSheet && !offered ? (
        <Card className="gap-0 py-0">
          <div className="flex min-w-0 items-start gap-3 p-4">
            <Share className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="font-medium">{t("settings.install.title")}</div>
              <p className="text-sm text-muted-foreground">{t("settings.install.iosHint")}</p>
            </div>
          </div>
        </Card>
      ) : null}
    </>
  );
}
