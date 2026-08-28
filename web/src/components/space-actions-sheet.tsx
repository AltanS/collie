import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";

import { DestructiveActionRow } from "@/components/action-sheet-rows";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import * as api from "@/lib/api";
import { describeApiError, describeThrownError } from "@/lib/api-error-message";
import { t } from "@/lib/i18n";
import { useMuxCapability } from "@/lib/mux-capability";
import { setStatus } from "@/lib/status";
import type { Scope } from "@/lib/scope";
import type { WorkspaceView } from "@/lib/types";

interface SpaceActionsSheetProps {
  open: boolean;
  onClose: () => void;
  /** The space these actions target. Null while nothing is selected (sheet closed). */
  space: WorkspaceView | null;
  scope?: Scope;
  /** This device isn't authorised to write — the destructive row is not offered at all. */
  readOnly?: boolean;
  /** Fired after a successful removal, so the parent can revalidate the herd. */
  onRemoved: () => void;
}

// Long-press a space → its actions, the same shape a tab's and a pane's take. Today there is exactly
// one, and it exists only for a worktree: **remove the checkout**, which closes this space with it.
//
// WHY THE ONLY ACTION IS A WORKTREE'S. Collie cannot close a space — there is no `closeSpace`
// capability and no route, deliberately. So this sheet is NOT a back door to one: it offers removal
// only where the thing being removed is a git worktree, and the space going away is Herdr's own
// consequence of that (`worktree.remove` closes it), never a separate power Collie granted itself.
//
// TWO TAPS, THEN A THIRD ONLY IF IT IS DIRTY. The first pair means "remove it"; `force` is never
// sent on a first attempt. Only after the multiplexer refuses does the row re-arm with wording that
// names the loss, so discarding uncommitted work is always its own decision.
export function SpaceActionsSheet({
  open,
  onClose,
  space,
  scope,
  readOnly = false,
  onRemoved,
}: SpaceActionsSheetProps) {
  useLocale();
  const canRemove = useMuxCapability("removeWorktree");
  const confirm = usePendingConfirm();
  const [removing, setRemoving] = useState(false);
  /** Set once the multiplexer has refused THIS checkout for being dirty — what arms the discard. */
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (open) {
      setDirty(false);
      setRemoving(false);
      confirm.reset();
    }
    // `confirm` is stable-by-construction (refs inside); keying on `open` is the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const isWorktree = space?.isWorktree === true;
  const offered = isWorktree && canRemove && !readOnly;

  async function requestRemove() {
    if (space === null || removing) return;
    if (!confirm.confirm(space.workspaceId)) return;
    setRemoving(true);
    try {
      const res = await api.removeWorktree(space.workspaceId, space.workspaceId, dirty, scope);
      if (res.ok) {
        setStatus(res.forced ? t("worktree.removedForced") : t("worktree.removed"), "info");
        onRemoved();
        onClose();
        return;
      }
      setStatus(describeApiError(res), "error");
      // Re-arm as a discard, and only for a refusal that actually was about uncommitted work.
      if (res.code === "worktree.dirty") setDirty(true);
    } catch (thrown) {
      setStatus(describeThrownError(thrown), "error");
    } finally {
      setRemoving(false);
      confirm.reset();
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={space?.label ?? ""}>
      <div className="flex flex-col gap-1">
        {offered ? (
          <DestructiveActionRow
            icon={<Trash2 className="size-4 shrink-0" />}
            label={t("worktree.remove")}
            confirmLabel={dirty ? t("worktree.removeForce") : t("worktree.removeConfirm")}
            closingLabel={t("worktree.removing")}
            armed={confirm.pending === space?.workspaceId}
            closing={removing}
            onClick={() => void requestRemove()}
          />
        ) : (
          <p className="py-2 text-sm leading-snug text-muted-foreground">
            {/* Honest about which of the three reasons it is, rather than one shrug for all. */}
            {readOnly
              ? t("space.actions.readOnly")
              : isWorktree
                ? t("space.actions.noRemoveCapability")
                : t("space.actions.notAWorktree")}
          </p>
        )}
      </div>
    </BottomSheet>
  );
}
