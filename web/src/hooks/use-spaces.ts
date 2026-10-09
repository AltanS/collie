import { useCallback, useRef, useState } from "react";
import { useRevalidator } from "react-router";

import * as api from "@/lib/api";
import { describeApiError, describeThrownError } from "@/lib/api-error-message";
import { t } from "@/lib/i18n";
import { setStatus } from "@/lib/status";
import { stampTopology } from "@/lib/poll-intent";
import { panePath } from "@/lib/nav";
import { useNav } from "@/hooks/use-nav";
import {
  isReadOnly,
  type AgentView,
  type CreateResponse,
  type WorktreeBaseChoice,
  type WorktreeFolderChoice,
} from "@/lib/types";
import { usePairing } from "@/lib/pairing";
import { scopeKey, type Scope } from "@/lib/scope";
import { useOptionalRootData } from "@/lib/route-data";

/** What the New page asks `start` to do. Exactly one `what`; `branch` makes it a new branch first. */
export interface StartAsk {
  what: api.StartWhat;
  /** The folder, as typed or picked; absent is home (or a row's pinned folder). */
  cwd?: string;
  /** One id per intent, minted by the page and kept by a retry of the same ask. */
  requestId: string;
  /** The chosen machine is older than 1.19.0: a shell goes through its plain space create. */
  legacyShell?: boolean;
  branch?: { cwd: string; name: string; base: WorktreeBaseChoice; folder: WorktreeFolderChoice };
}

/**
 * What became of a Start. `done`: the phone moved to the new pane. `refused`: the bridge or a gate
 * said no, and `message` says why in the operator's language; the PAGE shows it (a status line
 * published here would land on a screen with no status surface, and linger until the next one).
 * `unknown`: no answer that says whether it ran (ADR 0091).
 */
export type StartOutcome =
  | { kind: "done" }
  | { kind: "refused"; message: string }
  | { kind: "unknown" };

/**
 * The key a tab create in flight is held under in `creatingTab`: the space's machine, its session
 * and its id. A crew's machines number their spaces from `w1` each (lib/pane-groups.ts), so the bare
 * id would let the lead's `w1` and a peer's `w1` share one spinner, and a tap on one would be
 * swallowed while the other is in flight. `scope` is the one the create was sent with; absent is
 * the lead's primary session, as everywhere.
 */
export function tabCreateKey(workspaceId: string, scope: Scope | undefined): string {
  return `${scopeKey(scope)}\u0000${workspaceId}`;
}

// Shared "create a tab/space/worktree, then jump into its fresh shell" flow, used by the home space
// view and the detail Herdr palette. The new pane won't be in the snapshot until the next poll, so
// we pass it through navigation state (`freshPane`) — the detail route falls back to it so the
// composer is live immediately (no "agent gone" flash) while a revalidate catches the snapshot up.
//
// THE SAVED-COPY GATE (2026-10-08). Nothing saved on the phone can act (M46, ADR 0087 rule 8), and
// every create here is a write aimed at ids read from a snapshot. A cold open draws the dimmed saved
// herd for a while before the bridge answers; ids can be reused by then, so a tap on a "+" or a
// launcher row would act on a space that is not the one on screen. So the same refusal the read-only
// gates give (the hook's floating status, nothing sent) is given while the root snapshot is a saved
// copy, and while the caller's own `canWrite` says no: the pane view passes its pane's liveness
// (`isLive`, lib/liveness.ts), which the dashboard cannot, because it reads no pane. The controls stay
// drawn, as `workspace-new-tab.tsx` says they must: a control that comes and goes moves what is
// around it.
export function useSpaceActions(canWrite?: () => boolean) {
  const nav = useNav();
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
  // Read through refs for the reason the gates above are: the callbacks below stay stable.
  const savedCopyRef = useRef(false);
  savedCopyRef.current = root?.stale === true;
  const canWriteRef = useRef(canWrite);
  canWriteRef.current = canWrite;
  /** True while a create must be refused for want of a live read. */
  const notLive = useCallback((): boolean => savedCopyRef.current || !(canWriteRef.current?.() ?? true), []);
  /** {@link notLive}, said through the status line (every caller but the New page's `start`). */
  const refusedAsSavedCopy = useCallback((): boolean => {
    if (!notLive()) return false;
    setStatus(t("space.readOnly.savedCopy"), "error");
    return true;
  }, [notLive]);
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
    // New page can aim a create at another machine in the crew. The navigation has to use
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
      // A topology write: whichever view the operator lands back on (the tab strip they just left,
      // the dashboard behind it) should not wait out an idle-timed gap to show the new pane.
      stampTopology();
      revalidatorRef.current.revalidate();
      // `open`: a step DOWN from a dashboard or a space, SIDEWAYS from a pane (a new tab opened
      // from inside one), so the new pane's way up is the level the operator started from (ADR 0067).
      nav.open(panePath(p.paneId, at ?? scopeRef.current), { freshPane: fresh });
    },
    [nav],
  );

  // ONE create per Space's "+" at a time — the same shape as `launch` below, and for the same
  // reason: a create is a round trip, an impatient second tap on a phone is normal, and every tap
  // that gets through makes another throwaway tab the operator then has to close. Keyed by the
  // space's full address (`tabCreateKey`), not global, so a different Space's "+" stays live while
  // this one is in flight, and so is the same-numbered Space on another machine.
  const [creatingTab, setCreatingTab] = useState<ReadonlySet<string>>(() => new Set());
  const creatingTabRef = useRef<Set<string>>(new Set());
  const newTab = useCallback(
    // `at` is the scope the space lives on, as `newSpace` takes it, and it addresses the create AND
    // the step into the new pane. The dashboard's workspace headings pass their own group's
    // (M40/03): that list holds every machine in a crew, and the ambient scope names only the one
    // the URL is on, so a peer's heading sent ambiently would open the tab in the LEAD's space of
    // the same number. Absent means the ambient scope, which is right for the two tab strips: they
    // draw a space of the addressed machine and session only.
    async (workspaceId: string, at?: Scope) => {
      if (readOnlyRef.current) return setStatus(blockedText(), "error");
      if (refusedAsSavedCopy()) return;
      const scope = at ?? scopeRef.current;
      const key = tabCreateKey(workspaceId, scope);
      if (creatingTabRef.current.has(key)) return;
      creatingTabRef.current.add(key);
      setCreatingTab(new Set(creatingTabRef.current));
      try {
        open(await api.createTab(workspaceId, {}, scope), "tab", scope);
      } catch (e) {
        setStatus(describeThrownError(e), "error");
      } finally {
        creatingTabRef.current.delete(key);
        setCreatingTab(new Set(creatingTabRef.current));
      }
    },
    [open, blockedText, refusedAsSavedCopy],
  );

  // ONE Space create in flight at a time, globally — there is only ever one New page on screen,
  // unlike tabs where each Space has its own. Also guards `start`: both create a space, and sharing
  // the flag means either control's trigger shows busy the same way.
  const [creatingSpace, setCreatingSpace] = useState(false);
  const creatingSpaceRef = useRef(false);

  // `at` overrides the ambient scope for this one create — the New page's host picker. It is
  // optional and defaults to the ambient scope, so every existing caller is unchanged and a solo
  // install never has one to pass.
  const newSpace = useCallback(
    async (opts: { label?: string; cwd?: string } = {}, at?: Scope) => {
      if (readOnlyRef.current) return setStatus(blockedText(), "error");
      if (refusedAsSavedCopy()) return;
      if (creatingSpaceRef.current) return;
      creatingSpaceRef.current = true;
      setCreatingSpace(true);
      const scope = at ?? scopeRef.current;
      try {
        open(await api.createWorkspace(opts, scope), "space", scope);
      } catch (e) {
        setStatus(describeThrownError(e), "error");
      } finally {
        creatingSpaceRef.current = false;
        setCreatingSpace(false);
      }
    },
    [open, blockedText, refusedAsSavedCopy],
  );

  // THE NEW PAGE'S ONE START (M48, ADR 0091, ADR 0093, ADR 0095): an agent, a row, a shell or a one-off line, in a folder, and
  // optionally on a new branch. Same write gates and the same in-flight flag as a space create, and
  // the same `open` on success. It answers what became of it, because the page, not the status line,
  // owns the one case a toast cannot carry: an outcome nobody can confirm. Then nothing is said here
  // and nothing is re-sent; the page says so and offers the operator a retry with the SAME request
  // id, which lands on the first start's receipt if it did run.
  const start = useCallback(
    async (ask: StartAsk, at?: Scope): Promise<StartOutcome> => {
      if (readOnlyRef.current) return { kind: "refused", message: blockedText() };
      if (notLive()) return { kind: "refused", message: t("space.readOnly.savedCopy") };
      // Another create is in flight: the page's button is already busy, so there is nothing to say.
      if (creatingSpaceRef.current) return { kind: "refused", message: "" };
      creatingSpaceRef.current = true;
      setCreatingSpace(true);
      const scope = at ?? scopeRef.current;
      try {
        if (ask.what.kind === "run") {
          // A one-off line never starts on a branch; the page switches that off, and the bridge refuses it too.
          if (ask.branch !== undefined) return { kind: "refused", message: t("apiError.launch.run_no_branch") };
          const res = await api.startRun(ask.what.line, { cwd: ask.cwd, requestId: ask.requestId }, scope);
          if (!res.ok) return { kind: "refused", message: describeApiError(res) };
          open(res, "space", scope);
          return { kind: "done" };
        }
        if (ask.branch !== undefined) {
          const res = await api.createWorktreeAt(
            { cwd: ask.branch.cwd, branch: ask.branch.name, base: ask.branch.base, folder: ask.branch.folder, requestId: ask.requestId, what: ask.what },
            scope,
          );
          if (!res.ok) return { kind: "refused", message: describeApiError(res) };
          open(res, "space", scope);
          if (ask.what.kind !== "shell" && !res.launcherStarted) setStatus(t("branchOff.launcherFailed"), "error");
          return { kind: "done" };
        }
        // A machine older than 1.19.0 starts no plain shell by id: its own space create opens one.
        const res =
          ask.what.kind === "shell" && ask.legacyShell === true
            ? await api.createWorkspace(ask.cwd === undefined ? {} : { cwd: ask.cwd }, scope)
            : await api.startLaunch(ask.what, { cwd: ask.cwd, requestId: ask.requestId }, scope);
        if (!res.ok) return { kind: "refused", message: describeApiError(res) };
        open(res, "space", scope);
        return { kind: "done" };
      } catch (e) {
        if (api.outcomeUnknown(e)) return { kind: "unknown" };
        return { kind: "refused", message: describeThrownError(e) };
      } finally {
        creatingSpaceRef.current = false;
        setCreatingSpace(false);
      }
    },
    [open, blockedText, notLive],
  );

  // A launcher arrives as a SPACE (from the dashboard) or a TAB beside a named pane (from the
  // switcher), and takes the same `open` route either way for the same reason: the bridge matched
  // the row and created the pane, so what comes back is a created pane like any other.
  //
  // ONE launch per row at a time. A launch is slower than any other create — the bridge waits for
  // the new shell to finish drawing before it types — so an impatient second tap on a phone is
  // normal, and every tap that gets through makes another throwaway pane the operator then has to
  // close. The guard is per COMMAND, not global: two different launchers are two different
  // intentions and both are honoured. The ref IS the guard — it is already current inside the
  // callback the first tap is still running — while the state is only what disables the row.
  const [launching, setLaunching] = useState<ReadonlySet<string>>(() => new Set());
  const launchingRef = useRef<Set<string>>(new Set());
  const launch = useCallback(
    // `beside` is the pane id to open a tab next to — the switcher's row passes the current pane;
    // the dashboard's row passes nothing, and the bridge creates a throwaway Space instead.
    async (command: string, beside?: string) => {
      if (readOnlyRef.current) return setStatus(blockedText(), "error");
      if (refusedAsSavedCopy()) return;
      if (launchingRef.current.has(command)) return;
      launchingRef.current.add(command);
      setLaunching(new Set(launchingRef.current));
      try {
        open(await api.launch(command, beside, scopeRef.current), beside !== undefined ? "tab" : "space");
      } catch (e) {
        setStatus(describeThrownError(e), "error");
      } finally {
        launchingRef.current.delete(command);
        setLaunching(new Set(launchingRef.current));
      }
    },
    [open, blockedText, refusedAsSavedCopy],
  );

  return {
    start,
    newTab,
    newSpace,
    launch,
    launching,
    creatingTab,
    creatingSpace,
  };
}
