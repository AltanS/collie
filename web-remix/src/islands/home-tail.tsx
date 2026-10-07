// THE HOME TAIL ISLAND (S3): the dashboard's Launch and Spaces sections, under the list, inside the
// `home-list` frame. Each reads on its own (Launch asks the bridge for its launchers after the first
// paint, Spaces filters with a field the operator types into), which server HTML cannot do. The frame's
// reloads keep this island (the runtime pairs it by module and export, REMIX3.md), so the typed filter
// and the fetched launchers survive the beat.
//
// It draws nothing while "Needs you" filters the list, or before the first snapshot, as home.tsx does.
import { clientEntry, type Handle } from "remix/component";

import { ambientHost, ambientPanes } from "@web/lib/hosts";
import { spacePath } from "@web/lib/nav";
import { isolateSpaces } from "@web/lib/spaces";
import type { AgentView } from "@web/lib/types";

import { creating, SPACE_CREATE_KEY } from "../chips/space-actions";
import { address, snapshot } from "../lib/data";
import { useLocale } from "../lib/i18n-store";
import { dashPrefs, setDashPref } from "../lib/prefs";
import { useStore } from "../lib/store";
import { href } from "../routes";
import { LaunchStrip } from "../routes/home/launch-strip";
import { SpaceOverview } from "../routes/home/space-overview";
import { ShellProvider } from "../shell/context";
import { ISLAND } from "./ids";
import { islandShellModels } from "./shell-models";

const COLLAPSE_THRESHOLD = 8;

type NewSpaceModule = typeof import("../routes/home/new-space-sheet");
/** The new-space sheet's module: loaded on the first tap of "New space", never at start (S3). */
let newSpace: NewSpaceModule | null = null;
const NO_PANES: AgentView[] = [];

export const HomeTail = clientEntry(ISLAND.homeTail, function HomeTail(handle: Handle) {
  useLocale(handle);
  const snap = useStore(handle, snapshot);
  const prefs = useStore(handle, dashPrefs);
  const where = useStore(handle, address);
  const readCreating = useStore(handle, creating);
  let newSpaceOpen = false;

  return () => {
    const loaded = snap();
    const body = loaded.data;
    const p = prefs();
    if (body === undefined || (p.dashView === "dashboard" && p.needsYouOnly)) return null;
    const scope = where().scope;
    const servers = body.servers;
    const nav = ambientPanes(body.agents ?? NO_PANES, body.shellPanes ?? NO_PANES, scope, servers, body.sessions);
    const workspaces = body.workspaces ?? [];
    return (
      <ShellProvider models={islandShellModels()}>
        <LaunchStrip open={p.launchOpen} onOpenChange={(open) => setDashPref("launchOpen", open)} />
        <SpaceOverview
          workspaces={isolateSpaces(workspaces, p.isolatedSpace)}
          agents={nav.agents}
          shellPanes={nav.shellPanes}
          host={ambientHost(servers, scope.host)}
          // A space's overview is the static shell's: a document load.
          onOpen={(id) => window.location.assign(href(spacePath(id, scope)))}
          onNewSpace={() => {
            // Mounted closed first, then opened on the next frame, so the sheet slides in.
            void (async () => {
              newSpace = await import("../routes/home/new-space-sheet");
              void handle.update();
              requestAnimationFrame(() => {
                newSpaceOpen = true;
                void handle.update();
              });
            })();
          }}
          creatingSpace={readCreating().has(SPACE_CREATE_KEY)}
          open={p.spacesOpen ?? workspaces.length <= COLLAPSE_THRESHOLD}
          onOpenChange={(open) => setDashPref("spacesOpen", open)}
        />
        {newSpace === null ? null : (
          <newSpace.NewSpaceSheet
            open={newSpaceOpen}
            onClose={() => {
              newSpaceOpen = false;
              void handle.update();
            }}
          />
        )}
      </ShellProvider>
    );
  };
});
