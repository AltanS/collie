import { useCallback, useEffect, useState } from "react";
import { FolderGit2, GitBranch, Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { describeApiError } from "@/lib/api-error-message";
import { createWorktree, listWorktrees, openWorktree, removeWorktree } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useHoldReload } from "@/lib/reload-guard";
import type { Scope } from "@/lib/scope";
import type { CreatedPane, WorktreeView } from "@/lib/types";

interface WorktreeSheetProps {
  open: boolean;
  onClose: () => void;
  /** The space the sheet was opened from — the repo context every route is scoped to. */
  workspaceId: string;
  scope?: Scope;
  /** Where to go once a checkout is showing. The sheet never moves the desktop's screen. */
  onOpened: (pane: CreatedPane) => void;
  /** A removal happened, so the caller can re-read the herd. */
  onRemoved: () => void;
}

// The worktree sheet: the repo's checkouts, a field to branch a new one, and per-row open/remove.
//
// THREE BEHAVIOURS ARE LOAD-BEARING, and each is somebody's probed reality rather than a choice:
//
//  • **Remove is hidden for a checkout no space is showing.** Removal is addressed by space
//    (ADR 0032), so there would be nothing to name. The row says so instead of failing on tap.
//  • **A dirty checkout arms a SECOND, differently-worded confirmation.** The first pair of taps
//    means "remove it"; only after the multiplexer refuses does the row offer to discard the work,
//    in those words. `force` is never sent on a first attempt.
//  • **A half-created worktree offers "open", never "create again".** When the branch was made and
//    only the opening failed, creating again refuses (the path is taken) — so the error carries its
//    own recovery action.
export function WorktreeSheet({
  open,
  onClose,
  workspaceId,
  scope,
  onOpened,
  onRemoved,
}: WorktreeSheetProps) {
  useLocale();
  const [worktrees, setWorktrees] = useState<WorktreeView[] | null>(null);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set when a create half-succeeded: the branch exists, so the only way forward is to open it. */
  const [strandedPath, setStrandedPath] = useState<string | null>(null);
  /** Which checkout the multiplexer has refused to remove for being dirty. */
  const [dirty, setDirty] = useState<string | null>(null);
  const confirm = usePendingConfirm();

  // A half-typed branch name must survive a self-update the same way a half-typed path does.
  useHoldReload("worktrees", open);

  const reload = useCallback(async () => {
    const res = await listWorktrees(workspaceId, scope);
    if (res.ok) {
      setWorktrees(res.worktrees);
      setError(null);
    } else {
      setWorktrees([]);
      setError(describeApiError(res));
    }
  }, [workspaceId, scope]);

  useEffect(() => {
    if (!open) return;
    setBranch("");
    setError(null);
    setDirty(null);
    setStrandedPath(null);
    void reload();
  }, [open, reload]);

  async function create() {
    const name = branch.trim();
    if (name === "" || busy !== null) return;
    setBusy("create");
    const res = await createWorktree(workspaceId, name, scope);
    setBusy(null);
    if (res.ok) {
      onOpened(res.pane);
      onClose();
      return;
    }
    setError(describeApiError(res));
    // The branch is on disk and only the opening failed — offer THAT, since creating again refuses.
    if (res.code === "worktree.created_not_opened") setStrandedPath(name);
    await reload();
  }

  async function show(path: string) {
    if (busy !== null) return;
    setBusy(path);
    const res = await openWorktree(workspaceId, path, scope);
    setBusy(null);
    if (res.ok) {
      // `alreadyOpen` is an answer, not a failure: either way the pane below is where to go.
      onOpened(res.pane);
      onClose();
      return;
    }
    setError(describeApiError(res));
    await reload();
  }

  async function remove(worktree: WorktreeView) {
    const target = worktree.openWorkspaceId;
    if (target === null || busy !== null) return;
    // Two taps to remove. A third — worded as discarding — only after the mux says it is dirty.
    if (!confirm.confirm(worktree.path)) return;
    const force = dirty === worktree.path;
    setBusy(worktree.path);
    const res = await removeWorktree(workspaceId, target, force, scope);
    setBusy(null);
    confirm.reset();
    if (res.ok) {
      setDirty(null);
      onRemoved();
      await reload();
      return;
    }
    setError(describeApiError(res));
    // Arm the discarding confirmation, and only for the checkout that actually refused.
    if (res.code === "worktree.dirty") setDirty(worktree.path);
    await reload();
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={t("worktree.section")}>
      <div className="flex flex-col gap-3">
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
        <Button onClick={() => void create()} disabled={branch.trim() === "" || busy !== null} className="h-11">
          {busy === "create" ? t("worktree.creating") : t("worktree.create")}
        </Button>

        {error !== null && (
          <p role="alert" className="whitespace-pre-line text-xs text-destructive">
            {error}
          </p>
        )}
        {strandedPath !== null && (
          <Button variant="outline" onClick={() => void reload()} className="h-10">
            {t("worktree.recoverOpen")}
          </Button>
        )}

        <ul className="flex flex-col gap-1">
          {worktrees?.length === 0 && (
            <li className="px-1 py-2 text-xs text-muted-foreground">{t("worktree.empty")}</li>
          )}
          {(worktrees ?? []).map((worktree) => (
            <li key={worktree.path} className="flex items-center gap-2 rounded-lg px-1 py-1.5">
              <GitBranch className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {worktree.branch ?? t("worktree.detached")}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {worktree.linked ? worktree.path : t("worktree.mainCheckout")}
                </span>
              </span>
              <button
                type="button"
                onClick={() => void show(worktree.path)}
                disabled={busy !== null}
                className="rounded-md px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-60"
              >
                {busy === worktree.path ? t("worktree.opening") : t("worktree.open")}
              </button>
              {/* Only a checkout a space is showing can be removed — otherwise there is nothing to
                  name (ADR 0032), so the row explains rather than offering a tap that must fail. */}
              {worktree.linked && worktree.openWorkspaceId !== null && (
                <button
                  type="button"
                  onClick={() => void remove(worktree)}
                  disabled={busy !== null}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-60"
                >
                  {busy === worktree.path ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Trash2 className="size-3.5" aria-hidden />
                  )}
                  {confirm.pending === worktree.path
                    ? dirty === worktree.path
                      ? t("worktree.removeForce")
                      : t("worktree.removeConfirm")
                    : t("worktree.remove")}
                </button>
              )}
              {worktree.linked && worktree.openWorkspaceId === null && (
                <span className="px-2 text-[11px] text-muted-foreground">{t("worktree.notOpenHint")}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </BottomSheet>
  );
}

/** The trailing icon the space route hangs the sheet off. Hidden where there is no repo. */
export function WorktreeButton({ onClick }: { onClick: () => void }) {
  useLocale();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("worktree.section")}
      className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent"
    >
      <FolderGit2 className="size-4" aria-hidden />
      {t("worktree.section")}
    </button>
  );
}
