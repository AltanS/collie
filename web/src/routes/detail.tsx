import { useEffect, useRef } from "react";
import { useLoaderData, useLocation, useNavigate, useParams, useRouteLoaderData } from "react-router-dom";

import { AgentChat } from "@/components/agent-chat";
import type { HomeData, PaneData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import { setStatus } from "@/lib/status";
import type { AgentView } from "@/lib/types";

// Pane detail route. Pane output comes from this route's loader; the pane's metadata comes from the
// shared snapshot (root loader). The pane may be an agent OR a bare shell. A just-created shell
// isn't in the snapshot yet, so we fall back to the `freshPane` passed via navigation state — the
// composer stays live immediately while polling catches the snapshot up. Keyed by paneId so
// switching panes remounts the composer fresh.
export function DetailRoute() {
  const pane = useLoaderData() as PaneData;
  const root = useRouteLoaderData("root") as HomeData;
  const { paneId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  const fresh = (location.state as { freshPane?: AgentView } | null)?.freshPane;
  const inSnapshot =
    root.agents.some((a) => a.paneId === paneId) ||
    root.shellPanes.some((p) => p.paneId === paneId);
  // The freshPane is a bootstrap only — used before a just-created pane first appears in a snapshot.
  // Once it's been seen, retire it; otherwise the stale copy masks a pane that has since closed
  // (e.g. you ran `exit` in its shell), stranding you on a dead view.
  const seen = useRef(false);
  if (inSnapshot) seen.current = true;

  const agent =
    root.agents.find((a) => a.paneId === paneId) ??
    root.shellPanes.find((p) => p.paneId === paneId) ??
    (fresh && fresh.paneId === paneId && !seen.current ? fresh : undefined);
  const tabLabel = root.tabs.find((t) => t.tabId === agent?.tabId)?.label;
  const gone = !agent;

  // Recover from a closed pane: once a healthy snapshot no longer has it, bounce Home instead of
  // leaving you on a dead "agent gone" view. Guarded on a connected, non-stale snapshot so a
  // transient poll failure or reconnect doesn't evict a still-valid pane.
  useEffect(() => {
    if (gone && root.bridge === "connected" && !root.error) {
      setStatus("Pane closed", "info");
      navigate("/", { replace: true });
    }
  }, [gone, root.bridge, root.error, navigate]);

  return (
    <AgentChat
      key={paneId}
      paneId={paneId}
      agent={agent}
      agents={root.agents}
      shellPanes={root.shellPanes}
      workspaces={root.workspaces}
      tabs={root.tabs}
      tabLabel={tabLabel}
      text={pane.text}
      onBack={() => navigate("/")}
      onSelect={(id) => navigate(panePath(id))}
    />
  );
}
