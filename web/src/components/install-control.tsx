import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/icons/icon";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapse } from "@/components/ui/collapse";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { probeShareSheetInstall, promptInstall, useInstallOffer } from "@/lib/install";
import { useRememberedAnswer } from "@/lib/remembered-shape";
import { cn } from "@/lib/utils";

/**
 * How long a device that was offered the install last time waits for the browser to offer it again
 * before the card's place is given back. The browser has no "no offer" answer to wait for, so this is
 * the bound: past it, the card's place goes (one shift, once) and the device remembers that.
 */
export const INSTALL_WAIT_MS = 3000;

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
  // CALM LOAD. The offer arrives after the first paint, on a cold open of this page, and a card that
  // enters the flow then pushes the list down. A device that was offered it last time draws the card's
  // place from the first frame: the real card, `invisible` (same height at any width and in any
  // language), swapped for the visible one when the offer lands. There is no "no" from the browser, so
  // the place is given back after INSTALL_WAIT_MS, once, and that is remembered. A spent offer gives it back at once.
  const [gaveUp, setGaveUp] = useState(false);
  const sawOffer = useRef(false);
  const expected = useRememberedAnswer("settings-install-card", offered ? true : gaveUp ? false : undefined) === true;
  // An offer that was held and is now spent (the button, or an install by any path) is the answer "no".
  useEffect(() => {
    if (offered) sawOffer.current = true;
    else if (sawOffer.current) setGaveUp(true);
  }, [offered]);
  useEffect(() => {
    if (!expected || offered) return;
    const timer = setTimeout(() => setGaveUp(true), INSTALL_WAIT_MS);
    return () => clearTimeout(timer);
  }, [expected, offered]);
  const held = expected && !offered && !shareSheet;

  return (
    <>
      <Collapse open={offered || held}>
        {offered || held ? (
          <Card className={cn("gap-0 py-0", !offered && "invisible")} data-place={offered ? undefined : "held"}>
            <div className="flex items-center justify-between gap-4 p-4">
              <div className="flex min-w-0 items-start gap-3">
                <Icon name="install-app" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
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
            <Icon name="share-menu" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
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

/**
 * The same offer as one compact row, for the large screen's section list (components/settings-shell.tsx): the icon
 * and "Install the app", the whole row the button, the description in `title`. Drawn only while the browser holds
 * the offer, and arriving through `Collapse` like the card. On iOS (an iPad wide enough for the list) there is no
 * offer to take, so the row is no button: the title and, under it, the share-sheet line, wrapped.
 */
export function InstallRow({ className, shareSheet = probeShareSheetInstall() }: { className: string; shareSheet?: boolean }) {
  useLocale();
  const offered = useInstallOffer();
  return (
    <>
      <Collapse open={offered}>
        {offered ? (
          <button type="button" data-slot="settings-install-row" title={t("settings.install.description")} onClick={() => void promptInstall()} className={className}>
            <Icon name="install-app" className="size-5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{t("settings.install.title")}</span>
          </button>
        ) : null}
      </Collapse>
      {shareSheet && !offered ? (
        <div data-slot="settings-install-row" className="flex items-start gap-2.5 px-2 py-2.5 text-sm">
          <Icon name="share-menu" className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.install.title")}</div>
            <p className="text-xs text-muted-foreground">{t("settings.install.iosHint")}</p>
          </div>
        </div>
      ) : null}
    </>
  );
}
