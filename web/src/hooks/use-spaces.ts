import { useCallback, useRef } from "react";
import { useNavigate, useRevalidator, useRouteLoaderData } from "react-router";

import * as api from "@/lib/api";
import { setStatus } from "@/lib/status";
import { panePath } from "@/lib/nav";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { isReadOnly, type AgentView, type CreateResponse } from "@/lib/types";

// Shared "create a tab/space, then jump into its fresh shell" flow, used by the home space view and
// the detail Herdr palette. The new pane won't be in the snapshot until the next poll, so we pass
// it through navigation state (`freshPane`) — the detail route falls back to it so the composer is
// live immediately (no "agent gone" flash) while a revalidate catches the snapshot up.
export function useSpaceActions() {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  // revalidator changes identity each revalidation cycle; keep the callbacks stable via a ref so
  // they don't break a memoized child when passed as props.
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;

  // Creating a tab/space is a sensitive (structural) action — a read-only device can't, and the
  // bridge rejects it anyway. Short-circuit centrally so every create entry point (tab strip,
  // space list, command palette) is covered with one friendly notice. Read via a ref so the
  // returned callbacks stay stable across revalidations.
  const root = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData | undefined;
  const readOnlyRef = useRef(false);
  readOnlyRef.current = isReadOnly(root?.device);
  // The session the new tab/space must be created in (and navigated into). Read via a ref so the
  // returned callbacks stay stable across revalidations, like readOnly above.
  const sessionRef = useRef<string | undefined>(undefined);
  sessionRef.current = root?.session;

  const open = useCallback(
    (res: CreateResponse, what: "tab" | "space") => {
      if (!res.ok) {
        setStatus(res.error, "error");
        return;
      }
      const p = res.pane;
      const fresh: AgentView = {
        paneId: p.paneId,
        workspaceId: p.workspaceId,
        workspaceLabel: p.workspaceLabel,
        workspaceNumber: 0,
        tabId: p.tabId,
        agent: "shell",
        status: "unknown",
        cwd: p.cwd,
        focused: false,
        kind: "shell",
      };
      setStatus(`New ${what} ready — launch your agent`, "success");
      revalidatorRef.current.revalidate();
      navigate(panePath(p.paneId, sessionRef.current), { state: { freshPane: fresh } });
    },
    [navigate],
  );

  const newTab = useCallback(
    async (workspaceId: string) => {
      if (readOnlyRef.current) return setStatus("Read-only — device not authorised", "error");
      try {
        open(await api.createTab(workspaceId, {}, sessionRef.current), "tab");
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e), "error");
      }
    },
    [open],
  );

  const newSpace = useCallback(
    async (opts: { label?: string; cwd?: string } = {}) => {
      if (readOnlyRef.current) return setStatus("Read-only — device not authorised", "error");
      try {
        open(await api.createWorkspace(opts, sessionRef.current), "space");
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e), "error");
      }
    },
    [open],
  );

  return { newTab, newSpace };
}
