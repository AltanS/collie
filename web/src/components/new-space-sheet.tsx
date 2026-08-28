import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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

interface NewSpaceSheetProps {
  open: boolean;
  onClose: () => void;
  onCreate: (opts: { label?: string; cwd?: string }) => void;
  /**
   * The repos a worktree could be branched from. EMPTY means the worktree tab is not offered at
   * all — either the multiplexer cannot do it, or nothing open sits in a repo. Hiding it beats
   * showing a tab whose only content would be "no repos".
   */
  repos?: readonly WorktreeRepo[];
  /** Branch a worktree from `workspaceId`. Absent alongside an empty `repos`. */
  onCreateWorktree?: (workspaceId: string, branch: string) => void;
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
    }
    // `repos` is derived per render; keying the reset on `open` alone is deliberate — a poll that
    // reorders the repos must not wipe a half-typed branch name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function create() {
    onCreate({ label: label.trim() || undefined, cwd: cwd.trim() || undefined });
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
                  "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
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
                className="h-11 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                className="h-11 rounded-lg border border-border bg-background px-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <Button onClick={createWorktree} disabled={branch.trim() === ""} className="mt-1 h-11">
              {t("worktree.create")}
            </Button>
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
            className="h-11 rounded-lg border border-border bg-background px-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t("space.new.label.label")}</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("space.new.label.placeholder")}
            className="h-11 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <Button onClick={create} className="mt-1 h-11">
          {t("space.new.create")}
        </Button>
        </>
        )}
      </div>
    </BottomSheet>
  );
}
