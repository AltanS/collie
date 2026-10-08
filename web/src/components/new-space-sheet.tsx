import { useEffect, useRef, useState } from "react";
import { Server } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { listWorktrees } from "@/lib/api";
import { hostHealth, writeRefusal } from "@/lib/host-health";
import { HOST_TEXT_CLASSES, hostSlot, isMultiHost, leadHost } from "@/lib/hosts";
import { useCrew } from "@/components/crew-provider";
import type { Scope } from "@/lib/scope";
import type { HostHealth } from "@/lib/host-health";
import type { Launcher, ServerSummary, WorktreeBaseChoice, WorktreeView } from "@/lib/types";
import { Collapse } from "@/components/ui/collapse";
import { OneOf } from "@/components/ui/one-of";
import { Select } from "@/components/ui/select";
import { Segmented } from "@/components/ui/segmented";
import {
  SHELL_CHOICE,
  defaultLauncher,
  pickedStart,
  rememberLauncher,
  startFromBase,
  startFromChoices,
  type StartFrom,
} from "@/lib/branch-off";
import { branchOffName, mintRequestId } from "@/lib/worktree-name";
import { BottomSheet } from "@/components/ui/sheet";
import { FolderSections } from "@/components/new-space-folders";
import { useFolders } from "@/lib/folders";
import { useHoldReload } from "@/lib/reload-guard";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

/** A repo the sheet can branch a worktree from — one entry per repo, however many spaces show it. */
export interface WorktreeRepo {
  /** The space the worktree call is addressed to (every route is scoped to a space). */
  workspaceId: string;
  repoRoot: string;
  /** What to call it in the picker: the space's own label, which the operator already recognises. */
  label: string;
}

/** Stable empty default: a fresh `[]` per render would break referential equality downstream. */
const NO_REPOS: readonly WorktreeRepo[] = [];

/**
 * "New agent on a branch" (ADR 0089): the sheet opened from a pane's ⋯ menu rather than from the
 * dashboard's "+". It opens straight on the worktree side, with the pane's repo chosen and a fresh
 * branch name typed, and adds the one question the dashboard's sheet does not ask: which agent to
 * start in the new shell.
 */
export interface BranchOffSetup {
  /** The pane's space, which is the repo the sheet opens on. Must be one of `repos`. */
  workspaceId: string;
  /** This scope's launcher rows. The picker offers them, plus a plain shell. */
  launchers: readonly Launcher[];
  /**
   * The branch the pane is on, when it is on a named one. It is the second segment of "Start from",
   * and only when it differs from the repo's default branch. Absent or `null` (a detached head, an
   * older bridge) leaves no choice to make.
   */
  branch?: string | null;
  /**
   * Run the create. Resolves true once the phone has moved to the new space, which closes the sheet.
   * `launcher` is a row's `command`, absent for a shell; `requestId` is one per sheet opening and is
   * reused by a retry, so a second tap after a lost reply replays rather than creating again. `base`
   * is where the branch starts: the default branch, or the pane's own branch as a ref.
   */
  onCreate: (
    workspaceId: string,
    branch: string,
    extras: { requestId: string; launcher?: string; base: WorktreeBaseChoice },
  ) => Promise<boolean>;
}

/**
 * A member's tier-2 health, with the same fallback `server-switcher.tsx` uses: mounted outside a
 * `CrewProvider` there is no derived map, so re-derive with no clock at all — which skips the
 * presented-stale tolerance and hands back the lead's plain boolean, the answer this sheet would
 * have given before the threshold existed.
 */
function memberHealth(health: Map<string, HostHealth>, s: ServerSummary): HostHealth {
  return health.get(s.id) ?? hostHealth(s, { at: 0, pollMs: 0 });
}

/**
 * Which machine the "+" should create on, before the operator touches anything.
 *
 * The scope's host, because that is the machine this list is already showing and therefore the one
 * the create targets today — falling back to the lead, which is what an absent `?h=` means
 * everywhere else. If that machine is not taking writes we move to the first that is, rather than
 * opening on a default that can only refuse. When NOTHING is writable — which needs a roster with no
 * lead in it, since the lead's own health is always writable (lib/host-health.ts) — we still land on
 * a member, so the sheet names the machine it would have used and states the refusal rather than
 * showing a live-looking form over a create that cannot happen.
 */
function defaultHost(
  servers: readonly ServerSummary[],
  health: Map<string, HostHealth>,
  want: string | undefined,
): string | undefined {
  if (!isMultiHost(servers)) return undefined;
  const wanted = want ?? leadHost(servers);
  const writable = (id: string | undefined): boolean =>
    servers.some((s) => s.id === id && writeRefusal(memberHealth(health, s)) === undefined);
  if (writable(wanted)) return wanted;
  const firstWritable = servers.find((s) => writeRefusal(memberHealth(health, s)) === undefined);
  return firstWritable?.id ?? wanted ?? servers[0]?.id;
}

interface NewSpaceSheetProps {
  open: boolean;
  onClose: () => void;
  /**
   * Create the space. The second argument is the scope the create is ADDRESSED to — the host
   * picker's answer, which overrides the ambient one for this create and for the navigation that
   * follows it. Omitted (solo, and every caller that never renders the picker) means "the ambient
   * scope", exactly as before.
   */
  onCreate: (opts: { label?: string; cwd?: string }, at?: Scope) => void;
  /**
   * The repos a worktree could be branched from. EMPTY means the worktree tab is not offered at
   * all — either the multiplexer cannot do it, or nothing open sits in a repo. Hiding it beats
   * showing a tab whose only content would be "no repos".
   */
  repos?: readonly WorktreeRepo[];
  /** Branch a worktree from `workspaceId`. Absent alongside an empty `repos`. */
  onCreateWorktree?: (workspaceId: string, branch: string) => void;
  /** Show a worktree that exists on disk but is not open as a space. */
  onOpenWorktree?: (workspaceId: string, path: string) => void;
  /** Session scope for the listing read. */
  scope?: Scope;
  /** Open as "New agent on a branch" (ADR 0089). Absent is the dashboard's sheet, exactly as before. */
  branchOff?: BranchOffSetup;
  /** The side the sheet opens on. Absent is the plain space. A "worktree" with no `repos` falls back to it. */
  initialMode?: "space" | "worktree";
}

// Create a new space (workspace). Both fields are optional and dictation-friendly: leave the
// directory blank to open the shell in your home dir (it's a shell — cd from there), or set a path
// for a specific project. The new space opens a fresh shell you launch your own agent in.
export function NewSpaceSheet({
  open,
  onClose,
  onCreate,
  repos = NO_REPOS,
  onCreateWorktree,
  onOpenWorktree,
  scope,
  branchOff,
  initialMode = "space",
}: NewSpaceSheetProps) {
  useLocale();
  const [label, setLabel] = useState("");
  const [cwd, setCwd] = useState("");
  // Which kind of space this will be. Two tabs rather than two entry points: from the spaces list
  // there is no "current space" to carry a repo, so the worktree side has to ask which repo anyway
  // — and once it asks, the choice belongs beside the plain one, not behind a second button.
  const [mode, setMode] = useState<"space" | "worktree">("space");
  const [branch, setBranch] = useState("");
  const [repo, setRepo] = useState("");
  const worktreesOffered = repos.length > 0 && (onCreateWorktree !== undefined || branchOff !== undefined);
  // The branch-off half (ADR 0089). `launcherChoice` is a row's command or SHELL_CHOICE; a choice
  // whose row is not (or no longer) in this scope's list reads as the shell, so the picker never
  // shows a value it has no option for.
  const [launcherChoice, setLauncherChoice] = useState(SHELL_CHOICE);
  const launcherRows = branchOff?.launchers ?? [];
  const pickedLauncher = launcherRows.some((r) => r.command === launcherChoice) ? launcherChoice : SHELL_CHOICE;
  // Whether the operator moved the picker in this opening: until they do, a row list that arrives
  // after the sheet opened may still supply the remembered default.
  const launcherTouched = useRef(false);
  // "Start from" (ADR 0089, amended). `defaultBranch` is what the bridge said the repo's default is:
  // `undefined` until the answer arrives (and for good from a bridge that predates the field), `null`
  // for a repo with none to name. `startPick` is the operator's tap; `null` until they make one, so
  // the shown segment follows the default rule without any effect to set it.
  const [defaultBranch, setDefaultBranch] = useState<string | null | undefined>(undefined);
  const [startPick, setStartPick] = useState<StartFrom | null>(null);
  // The pane's branch belongs to the pane's repo. Choosing another repo in the picker leaves it
  // nothing to be a base of, so the control goes with it and the create sends the default.
  const startChoices =
    branchOff !== undefined && repo === branchOff.workspaceId
      ? startFromChoices(branchOff.branch, defaultBranch)
      : null;
  const shownStart = pickedStart(startPick);
  // ONE create per opening. The state paints the busy button; the ref is the guard, because it is
  // already set inside the handler a second tap lands in, before React has re-rendered.
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  // One request id per opening, kept across a failed or lost create so a retry replays it. The bridge
  // replays a known id, so the id must name ONE request: `lastAsk` is the fields the id was last used
  // with, and a create with other fields mints a new id (see `createBranchOff`).
  const requestId = useRef("");
  const lastAsk = useRef<string | null>(null);
  // WHICH MACHINE this space is created on. The roster and its tier-2 health come from the provider
  // rather than a prop, for the same reason `HostChip` reads them there: this sheet is mounted from
  // a list, not from a route, and the hide rule below has to hold wherever it is mounted.
  const { servers, health } = useCrew();
  const multiHost = isMultiHost(servers);
  // The member id, never `?h=`'s spelling: the lead has a real id here and only becomes an absent
  // `host` on the way out (see `create`), which is what keeps a solo/lead URL bare.
  const [host, setHost] = useState<string | undefined>(undefined);
  const chosen = multiHost ? host : undefined;
  const chosenServer = servers.find((s) => s.id === chosen);
  // The refusal for the machine actually selected. On a solo install there is no host dimension at
  // all, so there is nothing to refuse and the button behaves exactly as it did.
  const refusal = chosenServer ? writeRefusal(memberHealth(health, chosenServer)) : undefined;
  // The scope a create would be ADDRESSED to. The lead carries no `?h=` — absent means the lead — so
  // selecting it restores the bare URL, exactly as `server-switcher.tsx` does. Solo has no picker and
  // keeps the ambient scope.
  const target: Scope | undefined = multiHost
    ? { ...scope, host: chosen === leadHost(servers) ? undefined : chosen }
    : scope;
  // That machine's own folder list (#289): read when the sheet opens and when the picker moves, never
  // polled. A machine on an older version has none, and the sheet then renders as it always did.
  const { folders, star } = useFolders(target, open);
  // What the list holds NOW, for a tap that lands on a row the Collapse is still fading out after the
  // picker moved: a folder from the previous machine must never reach this machine's field.
  const shownFolders = useRef(folders);
  shownFolders.current = folders;
  const isShown = (folder: string): boolean =>
    shownFolders.current.recent.includes(folder) || shownFolders.current.favourites.includes(folder);
  const createButton = useRef<HTMLButtonElement>(null);
  /**
   * Worktrees of the chosen repo that NOTHING is showing.
   *
   * The ones that are open are already spaces in the list behind this sheet — offering them again
   * here would be the same thing under two names. These are the only worktrees the phone has no
   * other route to, which is exactly why they are here and not in a panel of their own.
   */
  const [unopened, setUnopened] = useState<WorktreeView[]>([]);

  // Don't let a self-update reload yank this tab/space form out from under a half-typed
  // directory/label — hold while it's open; the self-updater shows the banner and updates on close.
  useHoldReload("new-space", open);

  useEffect(() => {
    if (open) {
      setLabel("");
      setCwd("");
      setBranch("");
      setMode(initialMode);
      // Default to the first repo, which is the most recently used one: the list arrives in the
      // spaces list's own order, so the top entry is the repo you were last in.
      setRepo(repos[0]?.workspaceId ?? "");
      setHost(defaultHost(servers, health, scope?.host));
      setCreating(false);
      creatingRef.current = false;
      if (branchOff !== undefined) {
        setMode("worktree");
        setRepo(branchOff.workspaceId);
        setBranch(branchOffName());
        setLauncherChoice(defaultLauncher(branchOff.launchers));
        launcherTouched.current = false;
        setStartPick(null);
        requestId.current = mintRequestId();
        lastAsk.current = null;
      }
    }
    // `repos` is derived per render; keying the reset on `open` alone is deliberate — a poll that
    // reorders the repos must not wipe a half-typed branch name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The rows are read when the pane view mounts, so they may land after the sheet opened. Until the
  // operator has touched the picker, the remembered default is re-read against them.
  const launcherCount = branchOff?.launchers.length ?? 0;
  useEffect(() => {
    if (!open || branchOff === undefined || launcherTouched.current) return;
    setLauncherChoice(defaultLauncher(branchOff.launchers));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, launcherCount]);

  // Only a sheet that can OPEN one lists them. A boolean, not the callback: a caller's inline arrow is
  // a new function every render, and the read must not re-run on each one.
  const listsUnopened = onOpenWorktree !== undefined;
  // The same read names the repo's default branch, which "Start from" labels its first segment with.
  // Only a branch-off has a pane to start from, so only it needs the name.
  const namesDefault = branchOff !== undefined;
  useEffect(() => {
    if (!open || mode !== "worktree" || repo === "" || !(listsUnopened || namesDefault)) {
      setUnopened([]);
      setDefaultBranch(undefined);
      return;
    }
    let live = true;
    setDefaultBranch(undefined);
    void (async () => {
      // A read the operator asked for by opening this tab — not a poll, so it runs once per repo
      // choice and never on the list behind it. A read that fails leaves nothing to list and no
      // default to name, which is the sheet as it was before either existed.
      const res = await listWorktrees(repo, scope).catch(() => null);
      if (!live) return;
      setUnopened(listsUnopened && res?.ok ? res.worktrees.filter((w) => w.linked && w.openWorkspaceId === null) : []);
      setDefaultBranch(res?.ok ? res.defaultBranch : undefined);
    })();
    return () => {
      live = false;
    };
  }, [open, mode, repo, scope, listsUnopened, namesDefault]);

  function create() {
    if (refusal !== undefined) return;
    // Solo passes nothing and keeps the ambient scope, exactly as before the picker existed.
    const at: Scope | undefined = multiHost ? target : undefined;
    onCreate({ label: label.trim() || undefined, cwd: cwd.trim() || undefined }, at);
    onClose();
  }

  /** A folder row's tap: fill the field and move to Create. Never a create by itself. */
  function fillFolder(folder: string) {
    if (!isShown(folder)) return;
    setCwd(folder);
    createButton.current?.focus();
  }

  function toggleStar(folder: string, starred: boolean) {
    if (!isShown(folder)) return;
    void star(folder, starred);
  }

  function createWorktree() {
    const name = branch.trim();
    if (name === "" || repo === "") return;
    if (branchOff !== undefined) {
      void createBranchOff(branchOff, name);
      return;
    }
    if (onCreateWorktree === undefined) return;
    onCreateWorktree(repo, name);
    onClose();
  }

  /**
   * The branch-off create. The sheet STAYS OPEN while it runs, with the button busy, because a
   * create can take a minute and a sheet that closed at once would leave the operator looking at the
   * pane they came from with no sign that anything is happening. It closes once the phone has moved.
   */
  async function createBranchOff(setup: BranchOffSetup, name: string) {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    rememberLauncher(pickedLauncher);
    // An unchanged retry keeps its id: that is the point of it, a lost reply replays instead of
    // creating twice. A retry with another branch, agent or repo is a different request, and the
    // bridge would answer it with the OLD worktree if it kept the id.
    const base = startFromBase(startChoices, startPick);
    const ask = JSON.stringify([repo, name, pickedLauncher, base]);
    if (lastAsk.current !== null && lastAsk.current !== ask) requestId.current = mintRequestId();
    lastAsk.current = ask;
    try {
      const moved = await setup.onCreate(repo, name, {
        requestId: requestId.current,
        launcher: pickedLauncher === SHELL_CHOICE ? undefined : pickedLauncher,
        base,
      });
      if (moved) onClose();
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={branchOff !== undefined ? t("paneActions.branchOff.label") : t("space.new.title")}
    >
      <div className="flex flex-col gap-3">
        {/* WHERE this lands, above WHAT it is. A crew's "+" used to create silently on whichever
            machine the list happened to be pointed at; the one thing an operator must not have to
            guess is which terminal a new shell just opened on. Solo renders none of this — the
            predicate is `isMultiHost`, the same data-not-mode rule every host surface keeps. */}
        {/* No host row when branching off a pane: that create is lead-local (ADR 0089), and the
            pane already fixed the machine. */}
        {multiHost && branchOff === undefined && (
          <div className="flex flex-col gap-1">
            <span id="new-space-host" className="text-xs font-medium text-muted-foreground">
              {t("space.new.host.label")}
            </span>
            <div
              role="radiogroup"
              aria-labelledby="new-space-host"
              // Same ground and same selected mark as the tab strip below, because it is the same
              // question shape; scrolls sideways rather than wrapping, so a nine-machine crew keeps
              // one row. `min-h-11` per DESIGN.md §6, and a floor rather than a height.
              className="flex gap-1 overflow-x-auto rounded-lg bg-muted p-1"
            >
              {servers.map((s) => {
                const h = memberHealth(health, s);
                const reason = writeRefusal(h);
                const slot = hostSlot(servers, s.id);
                const selected = chosen === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    // `aria-disabled`, not `disabled`: a member that cannot take writes is still
                    // LISTED (CREW_PROTOCOL.md §10.2) and still reachable by a screen reader, which
                    // is how the reason gets read out at all. A real `disabled` would remove both.
                    aria-disabled={reason !== undefined}
                    aria-label={reason}
                    title={reason}
                    onClick={() => {
                      if (reason !== undefined) return;
                      setHost(s.id);
                    }}
                    className={cn(
                      "flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors",
                      selected
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                      reason !== undefined && "opacity-50",
                    )}
                  >
                    {/* The tint lands on the GLYPH ONLY (DESIGN.md §4), and the name is always drawn
                        beside it — the chip is never colour alone. */}
                    <Server
                      className={cn(
                        "size-3.5 shrink-0",
                        slot === null ? "text-muted-foreground" : HOST_TEXT_CLASSES[slot],
                      )}
                      aria-hidden
                    />
                    <span className="truncate">{s.name || s.id}</span>
                  </button>
                );
              })}
            </div>
            {/* Only reachable when NO member is taking writes — every other machine is selectable,
                so the default already moved off a refusing one. In flow, hence Collapse (§1). */}
            <Collapse open={refusal !== undefined}>
              {refusal !== undefined ? (
                <p className="pt-1 text-[11px] leading-tight text-status-blocked">{refusal}</p>
              ) : null}
            </Collapse>
          </div>
        )}

        {/* Only where there is a choice to make: one tab is not a tab strip, it is noise. A branch-off
            has no choice to make, it is a worktree by definition. */}
        {worktreesOffered && branchOff === undefined && (
          <div role="tablist" className="flex gap-1 rounded-lg bg-muted p-1">
            {(["space", "worktree"] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={mode === option}
                onClick={() => setMode(option)}
                className={cn(
                  // min-h, never h: the floor stands above whatever the label needs, so a longer
                  // translation grows the strip rather than being clipped (DESIGN.md §6).
                  "flex-1 min-h-11 rounded-md px-3 text-sm font-medium transition-colors",
                  mode === option
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option === "space" ? t("space.new.tab.plain") : t("space.new.tab.worktree")}
              </button>
            ))}
          </div>
        )}

        {mode === "worktree" && worktreesOffered ? (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">{t("space.new.repo.label")}</span>
              <Select value={repo} onChange={(e) => setRepo(e.target.value)}>
                {repos.map((candidate) => (
                  <option key={candidate.workspaceId} value={candidate.workspaceId}>
                    {candidate.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">{t("worktree.branchLabel")}</span>
              <input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder={t("worktree.branchPlaceholder")}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="h-11 rounded-lg border border-border bg-background px-3 font-mono text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              />
            </label>
            {/* Where the branch starts. It arrives from the listing read above, after the sheet is
                open, and it is in flow, so it comes in through Collapse (DESIGN.md §1, §2). The
                condition stays in the children, per Collapse's contract. */}
            <Collapse open={startChoices !== null}>
              {startChoices !== null ? (
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">{t("branchOff.startFrom.label")}</span>
                  <Segmented
                    label={t("branchOff.startFrom.label")}
                    value={shownStart}
                    onChange={setStartPick}
                    options={[
                      { value: "default", label: startChoices.defaultBranch },
                      { value: "branch", label: t("branchOff.startFrom.thisBranch") },
                    ]}
                  />
                  {/* Only on "This branch", where the words matter: an uncommitted edit does not
                      travel. A slot that opens and closes, so it moves nothing around it. */}
                  <Collapse open={shownStart === "branch"}>
                    {shownStart === "branch" ? (
                      <p className="pt-1 text-[11px] leading-tight text-muted-foreground">
                        {t("branchOff.startFrom.note", { branch: startChoices.paneBranch })}
                      </p>
                    ) : null}
                  </Collapse>
                </div>
              ) : null}
            </Collapse>
            {branchOff !== undefined && (
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">{t("branchOff.agentLabel")}</span>
                <Select
                  value={pickedLauncher}
                  onChange={(e) => {
                    launcherTouched.current = true;
                    setLauncherChoice(e.target.value);
                  }}
                >
                  <option value={SHELL_CHOICE}>{t("branchOff.shell")}</option>
                  {launcherRows.map((row) => (
                    <option key={row.command} value={row.command}>
                      {row.label}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <Button
              onClick={createWorktree}
              disabled={branch.trim() === "" || creating}
              aria-busy={creating || undefined}
              className="mt-1 h-11"
            >
              {/* The word changes while a create runs, so both words share one reserved box
                  (DESIGN.md §2): the button keeps its width whichever is showing. */}
              <OneOf
                active={creating ? "creating" : "create"}
                className="justify-items-center"
                options={[
                  { key: "create", node: t("worktree.create") },
                  { key: "creating", node: t("worktree.creating") },
                ]}
              />
            </Button>
            {/* This list arrives from a read that runs when the repo is chosen, so it appears in
                flow under the button — the one thing DESIGN.md §1 says may only ever happen
                through Collapse. The condition stays in the children, per its contract. */}
            <Collapse open={unopened.length > 0 && onOpenWorktree !== undefined}>
              {unopened.length > 0 && onOpenWorktree !== undefined ? (
                <div className="flex flex-col gap-1 border-t border-border pt-3">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("worktree.orOpenExisting")}
                  </span>
                  {unopened.map((worktree) => (
                    <button
                      key={worktree.path}
                      type="button"
                      onClick={() => {
                        onOpenWorktree(repo, worktree.path);
                        onClose();
                      }}
                      className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-accent"
                    >
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {worktree.branch ?? t("worktree.detached")}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t("worktree.open")}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </Collapse>
          </>
        ) : (
        <>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t("space.new.dir.label")}</span>
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder={t("space.new.dir.placeholder")}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="h-11 rounded-lg border border-border bg-background px-3 font-mono text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        </label>
        <FolderSections folders={folders} onUse={fillFolder} onStar={toggleStar} />
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t("space.new.label.label")}</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("space.new.label.placeholder")}
            className="h-11 rounded-lg border border-border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        </label>
        <Button ref={createButton} onClick={create} disabled={refusal !== undefined} className="mt-1 h-11">
          {t("space.new.create")}
        </Button>
        </>
        )}
      </div>
    </BottomSheet>
  );
}
