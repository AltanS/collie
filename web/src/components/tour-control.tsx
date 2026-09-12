import { Compass } from "lucide-react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { homePath } from "@/lib/nav";
import { useScope } from "@/lib/session";
import { resetTour } from "@/lib/tour";

// "Show the tour again", and the ONLY way back to a tour that was interrupted: the tour is marked
// seen the moment it opens, so a phone that lost the tab on slide 2 recovers here and nowhere else.
// The description must therefore never promise the tour will come back on its own.
//
// The row ends in a BUTTON, not a Switch, because it is an action and not a state — the same
// argument `InstallControl` makes for its one-shot offer. The tap navigates home, because the tour
// host lives at the data root and the operator should watch the slides over the dashboard they
// describe, not over the settings page.
export function TourControl() {
  useLocale();
  const navigate = useNavigate();
  const scope = useScope();

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Compass className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.tour.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.tour.description")}</p>
          </div>
        </div>
        {/* min-h-11 rather than the compact size: §6's 44px tap floor applies to a one-shot action
            button like any other target. */}
        <Button
          type="button"
          variant="outline"
          className="min-h-11 shrink-0 px-4"
          onClick={() => {
            resetTour();
            navigate(homePath(scope));
          }}
        >
          {t("settings.tour.button")}
        </Button>
      </div>
    </Card>
  );
}
