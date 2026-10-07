// THE SHEETS ISLAND (S3): every bottom sheet an islands page opens. One sheet at a time, named by the
// sheet store (islands/sheet-store.ts); each sheet's module loads on its first open (the actions sheet
// alone is about 40 KB with its rename and close flows), so a page that never opens one never loads one.
//
// A sheet mounts closed and opens on the next frame, so its entrance runs as it does in the static
// shell, where every sheet is mounted from the start. The switcher also opens out of a pull on the belt
// (`SheetPeek`): the first pull loads its module, and the panel follows the finger from then on.
import { clientEntry, type Handle, type RemixNode } from "remix/component";

import { dashPrefs, setDashPref } from "../lib/prefs";
import { paneScope } from "@web/lib/hosts";
import { historyPath } from "@web/lib/nav";
import { isReadOnly, type AgentView } from "@web/lib/types";

import { address, snapshot } from "../lib/data";
import { useLocale } from "../lib/i18n-store";
import { isNotPaired } from "../lib/pairing";
import { kick } from "../lib/polling";
import { onServer } from "../lib/server-render";
import { createStore, scheduleUpdate, useStore } from "../lib/store";
import { href } from "../routes";
import { ShellProvider } from "../shell/context";
import { ISLAND } from "./ids";
import { paneController, type PaneController } from "./pane-controller";
import { closeSheet, openSheet, sheetRequest, type SheetRequest } from "./sheet-store";
import { islandShellModels } from "./shell-models";
import { refreshSnapshotFrames } from "./snapshot-frames";

type ActionsModule = typeof import("../chips/pane-actions-sheet");
type SettingsModule = typeof import("../routes/pane/settings-sheet");
type CacheModule = typeof import("../chips/cache-sheet");
type SwitcherModule = typeof import("../routes/pane/switcher-sheet");

interface Modules {
  actions?: ActionsModule;
  settings?: SettingsModule;
  cache?: CacheModule;
  switcher?: SwitcherModule;
}

const modules: Modules = {};
const modulesVersion = createStore(0);
const loading = new Set<keyof Modules>();

/** Load one sheet's module into `modules`. */
async function importSheet(name: keyof Modules): Promise<void> {
  switch (name) {
    case "actions":
      modules.actions = await import("../chips/pane-actions-sheet");
      return;
    case "settings":
      modules.settings = await import("../routes/pane/settings-sheet");
      return;
    case "cache":
      modules.cache = await import("../chips/cache-sheet");
      return;
    case "switcher":
      modules.switcher = await import("../routes/pane/switcher-sheet");
      return;
  }
}

function load(name: keyof Modules): void {
  if (modules[name] !== undefined || loading.has(name)) return;
  loading.add(name);
  void (async () => {
    await importSheet(name);
    modulesVersion.update((v) => v + 1);
  })();
}

function moduleFor(request: SheetRequest): keyof Modules {
  switch (request.kind) {
    case "row-actions":
    case "pane-actions":
      return "actions";
    case "pane-settings":
      return "settings";
    case "cache":
      return "cache";
    case "switcher":
      return "switcher";
  }
}

/** The dashboard row a hold named, from the snapshot (its pane id, and its machine and session when the list shows several). */
function heldPane(request: Extract<SheetRequest, { kind: "row-actions" }>): AgentView | null {
  const data = snapshot.get().data;
  const all = [...(data?.agents ?? []), ...(data?.shellPanes ?? [])];
  return (
    all.find(
      (p) =>
        p.paneId === request.paneId &&
        (request.host === undefined || request.host === "" || p.host === request.host) &&
        (request.session === undefined || request.session === "" || p.session === request.session),
    ) ?? null
  );
}

export const Sheets = clientEntry(ISLAND.sheets, function Sheets(handle: Handle) {
  useLocale(handle);
  const readRequest = useStore(handle, sheetRequest);
  const readController = useStore(handle, paneController);
  useStore(handle, modulesVersion);
  const readSnapshot = useStore(handle, snapshot);
  /** The request on screen: mounted closed for one frame, then open. */
  let shown: SheetRequest | null = null;
  let open = false;
  let watched: PaneController | null = null;

  const watch = (controller: PaneController): void => {
    if (watched === controller) return;
    watched = controller;
    controller.view.subscribe(() => scheduleUpdate(handle), handle.signal);
    controller.peek.addEventListener("start", () => load("switcher"), { signal: handle.signal });
  };

  const close = (): void => {
    open = false;
    closeSheet();
  };

  return () => {
    if (onServer()) return null;
    const request = readRequest();
    const controller = readController();
    if (controller !== null) watch(controller);
    if (request !== null) load(moduleFor(request));
    if (request !== shown) {
      if (request !== null) {
        // A new sheet: mount it closed, open it after this commit (the entrance needs a frame closed).
        shown = request;
        open = false;
        handle.queueTask(() =>
          requestAnimationFrame(() => {
            if (shown === request && sheetRequest.get() === request) {
              open = true;
              scheduleUpdate(handle);
            }
          }),
        );
      } else {
        open = false;
      }
    }
    const view = controller?.view.get() ?? null;
    const { scope } = address.get();
    const data = readSnapshot().data;
    const readOnly = isReadOnly(data?.device) || isNotPaired();
    const herd = [...(data?.agents ?? []), ...(data?.shellPanes ?? [])];
    const nodes: RemixNode[] = [];
    const showing = shown;
    const isOpen = (kind: SheetRequest["kind"]): boolean => open && showing?.kind === kind && readRequest() !== null;

    if (modules.actions !== undefined) {
      const { PaneActionsSheet } = modules.actions;
      if (showing?.kind === "row-actions") {
        const held = heldPane(showing);
        nodes.push(
          <PaneActionsSheet
            key="row-actions"
            open={isOpen("row-actions") && held !== null}
            onClose={close}
            pane={held}
            scope={held === null ? scope : paneScope(scope, held, data?.servers, data?.sessions)}
            readOnly={readOnly}
            herd={herd}
            // The list is server HTML: a pin moves its row on the next frame answer, asked for now.
            onPinChange={() => refreshSnapshotFrames()}
          />,
        );
      } else if (controller !== null && view !== null) {
        const pane = view.pane ?? null;
        nodes.push(
          <PaneActionsSheet
            key="pane-actions"
            open={isOpen("pane-actions")}
            onClose={close}
            pane={pane}
            scope={scope}
            readOnly={view.readOnly}
            herd={view.herd}
            onRenamed={kick}
            onClosed={() => controller.acts.goUp()}
            onFind={view.hasText ? () => void controller.acts.openFind() : undefined}
            // History and Chat are the static shell's: a document load.
            onHistory={view.history ? () => window.location.assign(href(historyPath(controller.paneId, scope))) : undefined}
            onCopyOutput={view.hasText && "clipboard" in navigator ? () => void controller.acts.copyOutput() : undefined}
            paneView={dashPrefs.get().paneView}
            onPaneViewChange={(next) => {
              setDashPref("paneView", next);
              if (next === "chat") window.location.reload();
            }}
            onSettings={() => openSheet({ kind: "pane-settings" })}
            onZen={view.zenAvailable && view.hasText ? () => controller.acts.enterZen() : undefined}
          />,
        );
      }
    }
    if (modules.settings !== undefined && controller !== null && view !== null) {
      const { PaneSettingsSheet } = modules.settings;
      nodes.push(<PaneSettingsSheet key="settings" open={isOpen("pane-settings")} onClose={close} pane={view.pane ?? null} scope={scope} />);
    }
    if (modules.cache !== undefined && view !== null) {
      const { CacheSheet } = modules.cache;
      nodes.push(<CacheSheet key="cache" open={isOpen("cache")} onClose={close} cache={view.pane?.cache} host={view.pane?.host} />);
    }
    if (modules.switcher !== undefined && controller !== null && view !== null) {
      const { SwitcherSheet } = modules.switcher;
      nodes.push(
        <SwitcherSheet
          key="switcher"
          open={isOpen("switcher")}
          onClose={close}
          peek={controller.peek}
          here={view.pane}
          agents={data?.agents ?? []}
          shellPanes={data?.shellPanes ?? []}
          scope={scope}
          readOnly={view.readOnly}
          onPick={(pane) => controller.acts.goToPane(pane)}
        />,
      );
    }
    return <ShellProvider models={islandShellModels()}>{nodes}</ShellProvider>;
  };
});
