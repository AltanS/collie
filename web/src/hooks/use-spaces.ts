import { useCallback, useRef } from "react";
import { useNavigate, useRevalidator } from "react-router";

import * as api from "@/lib/api";
import { describeApiError, describeThrownError } from "@/lib/api-error-message";
import { t } from "@/lib/i18n";
import { setStatus } from "@/lib/status";
import { panePath } from "@/lib/nav";
import { isReadOnly, type AgentView, type CreateResponse } from "@/lib/types";
import { usePairing } from "@/lib/pairing";
import type { Scope } from "@/lib/scope";
import { useOptionalRootData } from "@/lib/route-data";

// Shared "create a tab/space/worktree, then jump into its fresh shell" flow, used by the home space
// view and the detail Herdr palette. The new pane won't be in the snapshot until the next poll, so
// we pass it through navigation state (`freshPane`) — the detail route falls back to it so the
// composer is live immediately (no "agent gone" flash) while a revalidate catches the snapshot up.
export function useSpaceActions() {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  // revalidator changes identity each revalidation cycle; keep the callbacks stable via a ref so
  // they don't break a memoized child when passed as props.
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;

  const root = useOptionalRootData();
  const readOnlyRef = useRef(false);
  // Either write gate refusing is the same answer here: the create would 403 anyway. The notice
  // names the pairing gate first where it applies, because that one is fixable from this phone.
  const { refused: notPaired } = usePairing();
  readOnlyRef.current = isReadOnly(root?.device) || notPaired;
  const notPairedRef = useRef(false);
  notPairedRef.current = notPaired;
  // The scope (machine + named session) the new tab/space must be created in, and navigated into.
  // Read via a ref so the returned callbacks stay stable across revalidations, like readOnly above.
  const scopeRef = useRef<Scope | undefined>(undefined);
  scopeRef.current = root?.scope;

  const blockedText = useCallback(
    () =>
      notPairedRef.current
        ? t("space.readOnly.notPaired")
        : t("space.readOnly.deviceUnauthorised"),
    [],
  );

  const open = useCallback(
    // `at` is the scope the create was ADDRESSED to, which is not always the ambient one: the
    // new-space sheet can aim a create at another machine in the pack. The navigation has to use
    // the SAME scope, or the phone would open the new pane's id on the machine it was looking at —
    // where that id is a different terminal, which is the one mistake the host dimension exists to
    // prevent. Absent means the ambient scope, which is every caller that cannot re-address.
    (res: CreateResponse, what: "tab" | "space", at?: Scope) => {
      if (!res.ok) {
        setStatus(describeApiError(res), "error");
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
      const noun = what === "tab" ? t("space.noun.tab") : t("space.noun.space");
      setStatus(t("space.create.ready", { what: noun }), "success");
      revalidatorRef.current.revalidate();
      navigate(panePath(p.paneId, at ?? scopeRef.current), { state: { freshPane: fresh } });
    },
    [navigate],
  );

  const newTab = useCallback(
    async (workspaceId: string) => {
      if (readOnlyRef.current) return setStatus(blockedText(), "error");
      try {
        open(await api.createTab(workspaceId, {}, scopeRef.current), "tab");
      } catch (e) {
        setStatus(describeThrownError(e), "error");
      }
    },
    [open, blockedText],
  );

  // `at` overrides the ambient scope for this one create — the new-space sheet's host picker. It is
  // optional and defaults to the ambient scope, so every existing caller is unchanged and a solo
  // install never has one to pass.
  const newSpace = useCallback(
    async (opts: { label?: string; cwd?: string } = {}, at?: Scope) => {
      if (readOnlyRef.current) return setStatus(blockedText(), "error");
      const scope = at ?? scopeRef.current;
      try {
        open(await api.createWorkspace(opts, scope), "space", scope);
      } catch (e) {
        setStatus(describeThrownError(e), "error");
      }
    },
    [open, blockedText],
  );

  // A worktree arrives as a SPACE and is therefore acknowledged as one: same write gate, same
  // freshPane bootstrap, same revalidate, same status line (ADR 0032 — the multiplexer opens it,
  // so what comes back is a created pane like any other). Routing both through `open` is what
  // stops the two newest mutations being the only creates that flash "agent gone" on arrival.
  const newWorktree = useCallback(
    async (workspaceId: string, branch: string) => {
      if (readOnlyRef.current) return setStatus(blockedText(), "error");
      try {
        open(await api.createWorktree(workspaceId, branch, scopeRef.current), "space");
      } catch (e) {
        setStatus(describeThrownError(e), "error");
      }
    },
    [open, blockedText],
  );

  // `alreadyOpen` is an ANSWER, not a refusal — either way the pane below is where to go — so this
  // reads exactly like a create and never branches on it.
  const showWorktree = useCallback(
    async (workspaceId: string, path: string) => {
      if (readOnlyRef.current) return setStatus(blockedText(), "error");
      try {
        open(await api.openWorktree(workspaceId, path, scopeRef.current), "space");
      } catch (e) {
        setStatus(describeThrownError(e), "error");
      }
    },
    [open, blockedText],
  );

  // A launcher arrives as a SPACE too, and takes the same route for the same reason: the bridge
  // matched the row and created the pane, so what comes back is a created pane like any other.
  const launch = useCallback(
    async (command: string) => {
      if (readOnlyRef.current) return setStatus(blockedText(), "error");
      try {
        open(await api.launch(command, scopeRef.current), "space");
      } catch (e) {
        setStatus(describeThrownError(e), "error");
      }
    },
    [open, blockedText],
  );

  return { newTab, newSpace, newWorktree, showWorktree, launch };
}
