// THE HEADER ACTIONS ISLAND (S3): the right cluster of the server-drawn header.
//
//   - On the dashboard: the server switcher and the session switcher (each hides itself on one machine
//     or one session). The gear beside them is a plain link in server HTML.
//   - On a pane: the ⋮, which opens the pane's actions sheet (islands/sheet-store.ts), and the find bar,
//     which takes the whole header row over while it is open (the static shell's override row,
//     shell/header.tsx `OverrideRow`, drawn here over the row instead of in it).
import { clientEntry, on, type Handle } from "remix/component";
import { ArrowLeft, EllipsisVertical } from "lucide";

import { t } from "@web/lib/i18n";

import { useLocale } from "../lib/i18n-store";
import { onServer } from "../lib/server-render";
import { scheduleUpdate, useStore } from "../lib/store";
import { FindBar } from "../routes/pane/find-bar";
import { ServerSwitcher } from "../routes/home/server-switcher";
import { SessionSwitcher } from "../routes/home/session-switcher";
import { Icon } from "../ui/icon";
import { ISLAND } from "./ids";
import { paneController, type PaneController } from "./pane-controller";
import { openSheet } from "./sheet-store";

export interface HeaderActionsProps {
  page: "home" | "pane";
  /** A pane page whose pane is gone: no ⋮. */
  gone?: boolean;
}

export const HeaderActions = clientEntry(ISLAND.headerActions, function HeaderActions(handle: Handle<HeaderActionsProps>) {
  useLocale(handle);
  const readController = useStore(handle, paneController);
  let watched: PaneController | null = null;
  const watch = (controller: PaneController): void => {
    if (watched === controller) return;
    watched = controller;
    controller.find.state.subscribe(() => scheduleUpdate(handle), handle.signal);
    controller.view.subscribe(() => scheduleUpdate(handle), handle.signal);
  };

  return () => {
    if (handle.props.page === "home") {
      return (
        <div class="flex items-center gap-1" data-slot="header-actions">
          <ServerSwitcher />
          <SessionSwitcher />
        </div>
      );
    }
    const controller = onServer() ? null : readController();
    if (controller !== null) watch(controller);
    const findOpen = controller?.find.state.get().open === true;
    const gone = handle.props.gone === true;
    return (
      <div class="flex items-stretch gap-2 pr-3" data-slot="header-actions">
        {gone ? (
          <div class="w-11 shrink-0" />
        ) : (
          <button
            type="button"
            data-testid="header-menu"
            aria-label={t("chat.paneMenu.aria")}
            class="grid min-h-11 w-11 shrink-0 place-items-center self-stretch rounded-md text-muted-foreground transition-colors active:bg-muted/60 active:text-foreground"
            mix={on("click", () => openSheet({ kind: "pane-actions" }))}
          >
            <Icon icon={EllipsisVertical} class="size-5" />
          </button>
        )}
        {findOpen && controller !== null ? (
          <div data-slot="header-find" class="absolute inset-0 z-10 flex items-center gap-2 bg-background py-1 pr-2 pl-4">
            <button
              type="button"
              data-testid="header-back"
              aria-label={t("find.closeAria")}
              class="grid size-11 shrink-0 place-items-center rounded-md text-foreground active:bg-muted/60"
              mix={on("click", () => controller.find.close())}
            >
              <Icon icon={ArrowLeft} class="size-5" />
            </button>
            <span class="min-w-0 flex-1" />
            <FindBar find={controller.find} />
          </div>
        ) : null}
      </div>
    );
  };
});
