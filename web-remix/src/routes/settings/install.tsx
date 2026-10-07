// The PWA install card (web/src/components/install-control.tsx, web/src/lib/install.ts). Present ONLY
// while the browser holds an install offer, which is what makes it honest: an installed device and an
// insecure origin both draw nothing, instead of a button that cannot deliver. iOS never fires the
// offer (install lives in the share sheet), so there the card is prose naming the steps, shown while
// it applies. The offer arrives through `Collapse`: it usually lands after first paint, and a card
// popping into the middle of Settings is the shift DESIGN.md §2 forbids.
//
// web/'s module cannot be imported (its hook is React), so the listeners and the offer are here, once,
// at module scope for the page's life: `beforeinstallprompt` is fired once and never again.
import { on, type Handle } from "remix/component";
import { MonitorDown, Share } from "lucide";

import { t } from "@web/lib/i18n";
import { installsViaShareSheet } from "@web/lib/install";

import { useLocale } from "../../lib/i18n-store";
import { createStore, useStore } from "../../lib/store";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Collapse } from "../../ui/collapse";
import { CardHead } from "./parts";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isInstallPrompt(event: Event): event is InstallPromptEvent {
  return "prompt" in event && "userChoice" in event;
}

let held: InstallPromptEvent | null = null;
/** Whether an install offer is on the table. */
export const installOffered = createStore<boolean>(false);

// Browser only: the bridge imports this module to render documents (S1), and has no window.
if ("window" in globalThis) {
  window.addEventListener("beforeinstallprompt", (event) => {
    if (!isInstallPrompt(event)) return;
    event.preventDefault();
    held = event;
    installOffered.set(true);
  });
  window.addEventListener("appinstalled", () => {
    held = null;
    installOffered.set(false);
  });
}

export async function promptInstall(): Promise<void> {
  const offer = held;
  if (offer === null) return;
  held = null;
  installOffered.set(false);
  try {
    await offer.prompt();
  } catch {
    // a dismissed or blocked prompt is not an error
  }
}

/** Apple touch device not yet running installed: the one case with no offer and an install path. */
function probeShareSheetInstall(): boolean {
  const touch = navigator.maxTouchPoints > 0;
  const apple = /iPhone|iPad|iPod|Mac/.test(`${navigator.platform} ${navigator.userAgent}`);
  if (!touch || !apple) return false;
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches || ("standalone" in navigator && navigator.standalone === true);
  return installsViaShareSheet(touch, apple, standalone);
}

export function InstallControl(handle: Handle) {
  const readOffer = useStore(handle, installOffered);
  useLocale(handle);
  const shareSheet = probeShareSheetInstall();
  return () => {
    const offered = readOffer();
    return (
      <>
        <Collapse open={offered}>
          <Card class="gap-0 py-0" data-testid="install-card">
            <CardHead icon={MonitorDown} title={t("settings.install.title")} description={t("settings.install.description")}>
              {/* min-h-11: a one-shot action button keeps the 44 px floor like any other target. */}
              <Button type="button" variant="outline" class="min-h-11 shrink-0 px-4" mix={on("click", () => void promptInstall())}>
                {t("settings.install.button")}
              </Button>
            </CardHead>
          </Card>
        </Collapse>
        {/* The offer wins if both are somehow true. The hint's fact is known at first render and never changes. */}
        <Collapse open={shareSheet && !offered}>
          <Card class="gap-0 py-0">
            <CardHead icon={Share} title={t("settings.install.title")} description={t("settings.install.iosHint")} />
          </Card>
        </Collapse>
      </>
    );
  };
}
