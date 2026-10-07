// THE PANE'S COMPOSER ISLAND (S3): the composer, its keys tray and its belt, the bottom of a pane page.
// Keyed by pane in the document (`data-rmx-key="composer-<pane key>"`), so the draft of one pane never
// shows in another: a sideways move builds a new instance, which reads its own pane's saved draft.
//
// THE SERVER DRAWS THE STAND-IN (routes/pane/composer.tsx `ComposerStandIn`): the same boxes, so the
// screen above keeps its height while the island's chunk loads. The island hydrates after the first
// paint (islands/registry.ts, "the two-step mount") and then draws the real composer, once the screen
// island has published its first reading of the pane (islands/pane-controller.ts). Until then it keeps
// the stand-in.
//
// THE FIRST RENDER IS ALWAYS THE STAND-IN, even when the reading is already there. Hydration adopts the
// server's nodes for the first render's tree and does not take away an attribute the tree lacks, so a
// first render of the real composer kept the stand-in's `inert` and `aria-hidden` on its root: a field
// nobody could type into. The real composer comes with the update queued after that first render.
import { clientEntry, type Handle } from "remix/component";

import { paneRowKey } from "@web/lib/hosts";
import { t } from "@web/lib/i18n";
import { changesPath } from "@web/lib/nav";
import type { AgentView } from "@web/lib/types";

import { address, config, paneStore, snapshot } from "../lib/data";
import { useLocale } from "../lib/i18n-store";
import { pairing } from "../lib/pairing";
import { focus } from "../lib/polling";
import { onServer } from "../lib/server-render";
import { scheduleUpdate, useStore } from "../lib/store";
import { href } from "../routes";
import { Composer, ComposerStandIn } from "../routes/pane/composer";
import { findPane, writeGate } from "../routes/pane/data";
import { paneScopeKey } from "@web/lib/scope";
import { Collapse } from "../ui/collapse";
import { ISLAND } from "./ids";
import { noteSent, paneController, type PaneController } from "./pane-controller";
import { openSheet } from "./sheet-store";

export interface PaneComposerIslandProps {
  paneId: string;
}

/** Another pane of the herd waits on its operator (routes/pane/switcher-sheet.tsx, kept out of this chunk). */
function needsYouElsewhere(here: AgentView | undefined, panes: readonly AgentView[]): boolean {
  const hereKey = here === undefined ? null : paneRowKey(here);
  return panes.some((a) => a.status === "blocked" && paneRowKey(a) !== hereKey);
}

export const PaneComposerIsland = clientEntry(ISLAND.composer, function PaneComposerIsland(handle: Handle<PaneComposerIslandProps>) {
  useLocale(handle);
  const paneId = handle.props.paneId;
  const { scope } = address.get();
  const readController = useStore(handle, paneController);
  const readSnapshot = useStore(handle, snapshot);
  const readConfig = useStore(handle, config);
  const readPairing = useStore(handle, pairing);
  const readPane = useStore(handle, paneStore(paneScopeKey(scope, paneId)));
  let watched: PaneController | null = null;
  let rendered = false;

  const watch = (controller: PaneController): void => {
    if (watched === controller) return;
    watched = controller;
    controller.view.subscribe(() => scheduleUpdate(handle), handle.signal);
    controller.ui.subscribe(() => scheduleUpdate(handle), handle.signal);
  };

  return () => {
    const c = readController();
    const controller = c !== null && c.paneId === paneId ? c : null;
    if (controller !== null) watch(controller);
    const view = controller?.view.get() ?? null;
    const zen = controller?.ui.get().zen ?? false;
    let body;
    const first = !rendered;
    rendered = true;
    if (first && !onServer()) handle.queueTask(() => handle.update());
    if (first || controller === null || view === null) {
      const pane = findPane(readSnapshot().data, paneId);
      const gate = writeGate({
        gone: readPane().status === 404,
        shell: pane?.kind === "shell",
        snapshot: readSnapshot().data,
        config: readConfig().data,
        notPaired: readPairing().refused,
      });
      body = <ComposerStandIn key={`composer-standin:${paneId}`} paneId={paneId} scope={scope} gate={gate} />;
    } else {
      const pane = view.pane;
      const shell = pane?.kind === "shell";
      const others = view.herd.filter((p) => p.paneId !== paneId);
      body = (
        <Composer
          key={`composer:${controller.key}`}
          paneId={paneId}
          scope={scope}
          agent={shell ? undefined : pane?.agent}
          isShell={shell}
          gate={view.gate}
          dialogOwns={view.dialogOwns}
          dialogUnread={view.card?.kind === "unread-dialog"}
          unsupportedKeys={readConfig().data?.mux?.unsupportedKeys ?? []}
          target={controller.target}
          rawDraft={view.rawDraft}
          paneText={view.token}
          chatShown={false}
          // Changes is a static-shell route: a document load.
          changes={view.changes ? { label: t("chat.changes.label"), onClick: () => window.location.assign(href(changesPath(paneId, scope))) } : undefined}
          switcher={
            others.length > 0
              ? { onOpen: () => openSheet({ kind: "switcher" }), peek: controller.peek, label: t("chat.switcher.aria"), needsYou: needsYouElsewhere(pane, view.herd) }
              : null
          }
          onSent={() => {
            noteSent(controller);
            focus.set({ paneId, following: true });
          }}
          onFocusChange={(focused) => controller.ui.update((ui) => ({ ...ui, composerFocused: focused }))}
        />
      );
    }
    return (
      <Collapse open={!zen}>
        <div class="relative shrink-0" data-slot="composer-region">
          {body}
        </div>
      </Collapse>
    );
  };
});
