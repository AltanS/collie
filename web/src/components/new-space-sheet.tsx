import { useEffect, useState } from "react";
import { Server } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { listWorktrees } from "@/lib/api";
import { hostHealth, writeRefusal } from "@/lib/host-health";
import { HOST_TEXT_CLASSES, hostSlot, isMultiHost, leadHost } from "@/lib/hosts";
import { usePack } from "@/components/pack-provider";
import type { Scope } from "@/lib/scope";
import type { HostHealth } from "@/lib/host-health";
import type { ServerSummary, WorktreeView } from "@/lib/types";
import { Collapse } from "@/components/ui/collapse";
import { BottomSheet } from "@/components/ui/sheet";
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
 * A member's tier-2 health, with the same fallback `server-switcher.tsx` uses: mounted outside a
 * `PackProvider` there is no derived map, so re-derive with no clock at all — which skips the
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
  const worktreesOffered = repos.length > 0 && onCreateWorktree !== undefined;
  // WHICH MACHINE this space is created on. The roster and its tier-2 health come from the provider
  // rather than a prop, for the same reason `HostChip` reads them there: this sheet is mounted from
  // a list, not from a route, and the hide rule below has to hold wherever it is mounted.
  const { servers, health } = usePack();
  const multiHost = isMultiHost(servers);
  // The member id, never `?h=`'s spelling: the lead has a real id here and only becomes an absent
  // `host` on the way out (see `create`), which is what keeps a solo/lead URL bare.
  const [host, setHost] = useState<string | undefined>(undefined);
  const chosen = multiHost ? host : undefined;
  const chosenServer = servers.find((s) => s.id === chosen);
  // The refusal for the machine actually selected. On a solo install there is no host dimension at
  // all, so there is nothing to refuse and the button behaves exactly as it did.
  const refusal = chosenServer ? writeRefusal(memberHealth(health, chosenServer)) : undefined;
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
      setMode("space");
      // Default to the first repo, which is the most recently used one: the list arrives in the
      // spaces list's own order, so the top entry is the repo you were last in.
      setRepo(repos[0]?.workspaceId ?? "");
      setHost(defaultHost(servers, health, scope?.host));
    }
    // `repos` is derived per render; keying the reset on `open` alone is deliberate — a poll that
    // reorders the repos must not wipe a half-typed branch name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || mode !== "worktree" || repo === "") {
      setUnopened([]);
      return;
    }
    let live = true;
    void (async () => {
      const res = await listWorktrees(repo, scope);
      // A read the operator asked for by opening this tab — not a poll, so it runs once per repo
      // choice and never on the list behind it.
      if (live) setUnopened(res.ok ? res.worktrees.filter((w) => w.linked && w.openWorkspaceId === null) : []);
    })();
    return () => {
      live = false;
    };
  }, [open, mode, repo, scope]);

  function create() {
    if (refusal !== undefined) return;
    // The lead carries no `?h=` — absent means the lead — so selecting it restores the bare URL,
    // exactly as `server-switcher.tsx` does. Solo passes nothing and keeps the ambient scope.
    const at: Scope | undefined = multiHost
      ? { ...scope, host: chosen === leadHost(servers) ? undefined : chosen }
      : undefined;
    onCreate({ label: label.trim() || undefined, cwd: cwd.trim() || undefined }, at);
    onClose();
  }

  function createWorktree() {
    const name = branch.trim();
    if (name === "" || repo === "" || onCreateWorktree === undefined) return;
    onCreateWorktree(repo, name);
    onClose();
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={t("space.new.title")}>
      <div className="flex flex-col gap-3">
        {/* WHERE this lands, above WHAT it is. A pack's "+" used to create silently on whichever
            machine the list happened to be pointed at; the one thing an operator must not have to
            guess is which terminal a new shell just opened on. Solo renders none of this — the
            predicate is `isMultiHost`, the same data-not-mode rule every host surface keeps. */}
        {multiHost && (
          <div className="flex flex-col gap-1">
            <span id="new-space-host" className="text-xs font-medium text-muted-foreground">
              {t("space.new.host.label")}
            </span>
            <div
              role="radiogroup"
              aria-labelledby="new-space-host"
              // Same ground and same selected mark as the tab strip below, because it is the same
              // question shape; scrolls sideways rather than wrapping, so a nine-machine pack keeps
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
                    // LISTED (PACK_PROTOCOL.md §10.2) and still reachable by a screen reader, which
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

        {/* Only where there is a choice to make: one tab is not a tab strip, it is noise. */}
        {worktreesOffered && (
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
              <select
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                className="h-11 rounded-lg border border-border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {repos.map((candidate) => (
                  <option key={candidate.workspaceId} value={candidate.workspaceId}>
                    {candidate.label}
                  </option>
                ))}
              </select>
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
            <Button onClick={createWorktree} disabled={branch.trim() === ""} className="mt-1 h-11">
              {t("worktree.create")}
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
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t("space.new.label.label")}</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("space.new.label.placeholder")}
            className="h-11 rounded-lg border border-border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        </label>
        <Button onClick={create} disabled={refusal !== undefined} className="mt-1 h-11">
          {t("space.new.create")}
        </Button>
        </>
        )}
      </div>
    </BottomSheet>
  );
}
