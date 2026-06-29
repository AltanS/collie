import { useNavigate, useRevalidator } from "react-router-dom";

import * as api from "@/lib/api";
import { setStatus } from "@/lib/status";
import { panePath } from "@/lib/nav";
import type { AgentView, CreateResponse } from "@/lib/types";

// Shared "create a tab/space, then jump into its fresh shell" flow, used by the home space view and
// the detail Herdr palette. The new pane won't be in the snapshot until the next poll, so we pass
// it through navigation state (`freshPane`) — the detail route falls back to it so the composer is
// live immediately (no "agent gone" flash) while a revalidate catches the snapshot up.
export function useSpaceActions() {
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  function open(res: CreateResponse, what: "tab" | "space") {
    if (!res.ok || !res.pane) {
      setStatus(res.error ?? `New ${what} failed`, "error");
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
    revalidator.revalidate();
    navigate(panePath(p.paneId), { state: { freshPane: fresh } });
  }

  async function newTab(workspaceId: string) {
    try {
      open(await api.createTab(workspaceId), "tab");
    } catch (e) {
      setStatus((e as Error).message, "error");
    }
  }

  async function newSpace(opts: { label?: string; cwd?: string } = {}) {
    try {
      open(await api.createWorkspace(opts), "space");
    } catch (e) {
      setStatus((e as Error).message, "error");
    }
  }

  return { newTab, newSpace };
}
