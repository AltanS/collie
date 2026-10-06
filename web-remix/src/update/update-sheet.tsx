// The blocking sheet for a stale app: the bridge serves a newer build than this page runs.
//
// Mounted by the shell beside the idle cover (a sibling of the app, never inside it), so it covers
// every route. It cannot be dismissed: the one way out is Reload, which gets onto the new bundle
// through the worker swap (update/pwa.ts). While the new worker downloads, the button says so and
// waits; the page reloads on the controller swap, not on the tap.
//
// Strings are web/'s: the band's own sentence as the title (`pwa.updateAvailable`), the System
// page's "Server build" row, the update screen's "This phone" row, the root error's "Reload".
import { on, ref, type Handle } from "remix/component";
import { Download } from "lucide";

import { buildLabel } from "@web/lib/build";
import { t } from "@web/lib/i18n";

import { serverBuild } from "../lib/api";
import { useLocale } from "../lib/i18n-store";
import { useStore } from "../lib/store";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { precacheProgress, updateStage } from "./pwa";
import { reloadOntoServerBuild, staleBuild } from "./self-update";

export function UpdateSheet(handle: Handle) {
  const readStale = useStore(handle, staleBuild);
  const readStage = useStore(handle, updateStage);
  const readProgress = useStore(handle, precacheProgress);
  const readServer = useStore(handle, serverBuild);
  useLocale(handle);
  const titleId = `update-sheet-${handle.id}`;
  let panel: HTMLElement | null = null;
  let wasOpen = false;

  // Keep keyboard focus inside the sheet: it is modal, and the app behind it is not inert.
  const trapTab = (event: KeyboardEvent): void => {
    if (event.key !== "Tab" || panel === null || readStale() === null) return;
    const focusable = [...panel.querySelectorAll<HTMLElement>("button:not([disabled])")];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      panel.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  handle.queueTask(() => window.addEventListener("keydown", trapTab, { signal: handle.signal }));

  return () => {
    const stale = readStale();
    const open = stale !== null;
    if (open && !wasOpen) handle.queueTask(() => panel?.focus());
    wasOpen = open;
    if (!open) return null;
    const installing = readStage() === "installing";
    const progress = readProgress();
    const downloading =
      progress !== null && progress.total > 0
        ? t("updateScreen.device.downloading", { done: progress.done, total: progress.total })
        : t("pwa.updateInstalling");
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="update-sheet"
        class="fixed inset-x-0 top-0 z-[60] flex h-(--app-h) flex-col justify-end bg-black/50"
      >
        <div
          tabIndex={-1}
          mix={ref((node: HTMLDivElement) => {
            panel = node;
          })}
          class="mx-auto w-full max-w-screen-sm rounded-t-md border-t border-rule bg-card px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)_+_1rem)] shadow-2xl outline-none duration-200 animate-in slide-in-from-bottom"
        >
          <div class="flex items-start gap-3">
            <Icon icon={Download} class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <h2 id={titleId} class="text-base font-semibold">
              {t("pwa.updateAvailable")}
            </h2>
          </div>
          <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt class="text-muted-foreground">{t("updateScreen.phone")}</dt>
            <dd class="min-w-0 truncate font-mono text-[13px]">{buildLabel()}</dd>
            <dt class="text-muted-foreground">{t("settings.connection.row.serverBuild")}</dt>
            <dd class="min-w-0 truncate font-mono text-[13px]" data-testid="update-sheet-server">
              {readServer() ?? stale}
            </dd>
          </dl>
          <p aria-live="polite" class="mt-3 min-h-5 text-sm text-muted-foreground">
            {installing ? downloading : ""}
          </p>
          <Button size="lg" class="mt-3 w-full" disabled={installing} mix={on("click", reloadOntoServerBuild)}>
            {installing ? t("settings.buildStamp.updating") : t("error.root.reload")}
          </Button>
        </div>
      </div>
    );
  };
}
