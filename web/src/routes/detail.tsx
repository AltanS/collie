import { useEffect, useRef } from "react";
import { useLoaderData, useLocation, useParams } from "react-router";

import { AgentChat } from "@/components/agent-chat";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { useLoadingStalled } from "@/hooks/use-loading-stalled";
import { useNav } from "@/hooks/use-nav";
import { type PaneData } from "@/lib/loaders";
import { GLIDE_PAIRS, glideBack } from "@/lib/glide";
import { canStepBack, homePath, panePath, readFrom, upTarget } from "@/lib/nav";
import { paneScopeKey } from "@/lib/scope";
import { findPane, paneScope } from "@/lib/hosts";
import { setStatus } from "@/lib/status";
import type { AgentView } from "@/lib/types";
import { useRootData } from "@/lib/route-data";

// Pane detail route. Pane output comes from this route's loader; the pane's metadata comes from the
// shared snapshot (root loader). The pane may be an agent OR a bare shell. A just-created shell
// isn't in the snapshot yet, so we fall back to the `freshPane` passed via navigation state — the
// composer stays live immediately while polling catches the snapshot up. Keyed by paneId so
// switching panes remounts the composer fresh.
export function DetailRoute() {
  // SAFETY: this is the `/pane/:paneId` route's element and `paneLoader` returns `PaneData`; the
  // element does not mount until that loader has resolved. React Router types a data-mode
  // `useLoaderData()` as `unknown`.
  const pane = useLoaderData() as PaneData;
  const root = useRootData();
  const { paneId = "" } = useParams();
  // The session this pane belongs to (undefined = primary), read from the pane loader so every
  // navigation and write below stays scoped to it.
  const scope = pane.scope;
  const nav = useNav();
  const location = useLocation();
  const stalled = useLoadingStalled();
  const dashView = useDashPrefs().prefs.dashView;

  // SAFETY: `location.state` is whatever the navigation that got here attached — `unknown` by
  // definition. The only shape Collie ever puts there is `{ freshPane }` (components/agent-list's
  // optimistic open), and the optional chain means any other state reads as "not carried".
  const fresh = (location.state as { freshPane?: AgentView } | null)?.freshPane;
  const inSnapshot =
    root.agents.some((a) => a.paneId === paneId) ||
    root.shellPanes.some((p) => p.paneId === paneId);
  // The freshPane is a bootstrap only — used before a just-created pane first appears in a snapshot.
  // Once it's been seen, retire it; otherwise the stale copy masks a pane that has since closed
  // (e.g. you ran `exit` in its shell), stranding you on a dead view.
  //
  // Track *which* pane has been seen, not just a boolean: DetailRoute doesn't remount on a pane→pane
  // navigation (only `key={paneId}` on AgentChat does), so a lifetime boolean would carry the prior
  // pane's "seen" state onto a freshly-created one — disabling its freshPane fallback before the
  // snapshot catches up, so `gone` flips true and the effect below bounces you Home. That's the
  // "create a tab from inside an open pane sends me home" bug.
  const seenPaneId = useRef<string | null>(null);
  if (inSnapshot) seenPaneId.current = paneId;
  const seen = seenPaneId.current === paneId;

  // Looked up WITHIN the scope's host: `w1:p1` exists on every machine in a crew, so a match by id
  // alone could hand this view another machine's pane — rendering its space, tab and cwd around a
  // mirror of, and a composer typing into, the one the URL actually addresses. Solo panes carry no
  // host and match unconditionally, so this is the same lookup it has always been.
  const agent =
    findPane(root.agents, paneId, scope, root.servers, root.sessions) ??
    findPane(root.shellPanes, paneId, scope, root.servers, root.sessions) ??
    (fresh && fresh.paneId === paneId && !seen ? fresh : undefined);
  const gone = !agent;

  // Recover from a closed pane: once a healthy snapshot no longer has it, go up a level instead of
  // leaving you on a dead "agent gone" view. Guarded on a connected, non-stale snapshot so a
  // transient poll failure or reconnect doesn't evict a still-valid pane. Up, not a replace onto
  // Home: the dead pane must not stay in history for the next swipe to land on (ADR 0067). Once per
  // pane, because an up can be a step back, and a second one would climb a level too far.
  const exited = useRef<string | null>(null);
  useEffect(() => {
    if (gone && root.bridge === "connected" && !root.error && exited.current !== paneId) {
      exited.current = paneId;
      // The operator did not close this pane from this phone. It went away under them — from
      // another device, from the terminal itself, or because the agent exited — and a poll is what
      // noticed. The status (and the orbit round it turns) is what stops the eviction that follows
      // being the first thing they see.
      setStatus("Pane closed", "info");
      nav.up(homePath(scope));
    }
  }, [gone, root.bridge, root.error, nav, scope, paneId]);

  // Up one level: to the space or the dashboard the pane was opened from (ADR 0067).
  const up = () => nav.up(homePath(scope));
  // The back arrow glides the header's dot, tile and name back down into the row this pane was
  // opened from (lib/glide.ts, the `pane` pair, rule 1), when the arrow lands where such a row can
  // be: the dashboard's Panes or Focus list, or a space. Not the dashboard's Changes tab, which lists
  // workspaces, so the arrow slides there as it always did. Where the row is gone or off screen, the
  // engine crossfades. The landing is the same resolution `nav.up` runs (`upTarget`).
  const backArrow = () => {
    const lands = upTarget(location.pathname, readFrom(location.state), homePath(scope), canStepBack());
    const rowsThere = GLIDE_PAIRS.pane.origin(lands) && (lands !== "/" || dashView !== "changes");
    if (rowsThere) glideBack("pane", panePath(paneId, scope), up);
    else up();
  };

  return (
    <AgentChat
      // Keyed by the pane's FULL address, not its id. The key exists to remount the composer on a
      // pane switch so a draft never follows you into another terminal — and `w1:p1` is a different
      // terminal in every session and on every machine. Keyed by the id alone, walking from
      // `w1:p1` on one session to `w1:p1` on another kept the same mounted composer, draft and all.
      // `paneScopeKey` is the same triple every per-pane cache is keyed by.
      key={paneScopeKey(scope, paneId)}
      paneId={paneId}
      scope={scope}
      agent={agent}
      agents={root.agents}
      shellPanes={root.shellPanes}
      tabs={root.tabs}
      servers={root.servers}
      text={pane.text}
      logicalText={pane.logicalText}
      requestedLines={pane.requestedLines}
      revision={pane.revision}
      device={root.device}
      bridge={root.bridge}
      error={root.error}
      stalled={stalled}
      onBack={up}
      onBackArrow={backArrow}
      // Pane to pane is a sideways move: it replaces, and the pane's way up comes along.
      onSelect={(id) =>
        nav.side(
          panePath(
            id,
            paneScope(
              scope,
              findPane([...root.agents, ...root.shellPanes], id, scope, root.servers, root.sessions),
              root.servers,
              root.sessions,
            ),
          ),
        )
      }
    />
  );
}
