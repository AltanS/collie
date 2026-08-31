import { MonitorDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapse } from "@/components/ui/collapse";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { promptInstall, useInstallOffer } from "@/lib/install";

// The PWA install card. Present ONLY while the browser holds an install offer (lib/install.ts) —
// which is what makes it honest: a browser that cannot install this way (iOS Safari), a device
// that already installed, and an insecure origin all render nothing, instead of a button that
// cannot deliver. That absence-as-answer is also why there is no "how to install on iOS" prose
// here: the share-sheet path belongs to docs, not to a card that would then be visible always.
//
// Arrival goes through `Collapse` (DESIGN.md §1): the offer usually lands after first paint, and a
// card popping into the middle of Settings at full height is exactly the shift §2 forbids.
export function InstallControl() {
  useLocale();
  const offered = useInstallOffer();

  return (
    <Collapse open={offered}>
      {offered ? (
        <Card className="gap-0 py-0">
          <div className="flex items-center justify-between gap-4 p-4">
            <div className="flex min-w-0 items-start gap-3">
              <MonitorDown className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="font-medium">{t("settings.install.title")}</div>
                <p className="text-sm text-muted-foreground">{t("settings.install.description")}</p>
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
  );
}
