import { useCallback, useRef } from "react";

import { useNav } from "@/hooks/use-nav";
import { paneScope } from "@/lib/hosts";
import { t } from "@/lib/i18n";
import { findScopedPane } from "@/lib/tricks/places";
import type { LinkTarget } from "@/lib/tricks/render";
import { panePath } from "@/lib/nav";
import { useOptionalRootData } from "@/lib/route-data";
import { setStatus } from "@/lib/status";

// WHERE A TRICK'S LINK GOES (M94 slice 03, the draft half removed in step 3). One hook for every place
// a trick draws a `row` with `href` or a `link`: the belt's marks on a pane, and the view on a trick
// session's screen.
//
// THE LINK RULE: a session's scope key opens that Session one level down, so back comes here; an
// http(s) address opens in a new tab, with `noopener`, and the phone stays where it is. A key whose
// session is gone says so and moves nothing.
//
// THERE IS NO DRAFT. Nothing in tricks writes into a reply box (design section 7, the tree's rule that
// the bridge never sets `composer.draft`): the frame's fix button copies its line on the phone instead.

export interface TrickHandlers {
  /** The link handler for one part, by the host its trick runs on (the part key's first piece). */
  linkFor: (tricksHost: string) => (target: LinkTarget) => void;
}

export function useTrickHandlers(): TrickHandlers {
  const data = useOptionalRootData();
  const nav = useNav();
  // Read through a ref, so the handler a view holds stays one function across polls.
  const live = useRef({ data, nav });
  live.current = { data, nav };

  const linkFor = useCallback(
    (tricksHost: string) => (target: LinkTarget) => {
      if (target.url !== undefined) {
        window.open(target.url, "_blank", "noopener,noreferrer");
        return;
      }
      const { data: root, nav: go } = live.current;
      if (root === undefined) return;
      const pane = findScopedPane(target.session, [...root.agents, ...root.shellPanes], tricksHost);
      if (pane === undefined) {
        setStatus(t("tricks.link.gone"), "warn");
        return;
      }
      go.down(panePath(pane.paneId, paneScope(root.scope, pane, root.servers, root.sessions)));
    },
    [],
  );

  return { linkFor };
}
