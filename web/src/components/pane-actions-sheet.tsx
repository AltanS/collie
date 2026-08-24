import { useEffect, useRef, useState } from "react";
import { Pencil, XCircle } from "lucide-react";

import { BottomSheet } from "@/components/ui/sheet";
import { ActionRow, DestructiveActionRow, RenameView } from "@/components/action-sheet-rows";
import { HostChip } from "@/components/host-chip";
import { useHostWriteBlock } from "@/components/pack-provider";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { useLocale } from "@/hooks/use-locale";
import * as api from "@/lib/api";
import { describeApiError, describeThrownError } from "@/lib/api-error-message";
import { t } from "@/lib/i18n";
import { useMuxCapability } from "@/lib/mux-capability";
import { setStatus } from "@/lib/status";
import { paneDisplayName } from "@/lib/types";
import type { AgentView } from "@/lib/types";
import type { Scope } from "@/lib/scope";

interface PaneActionsSheetProps {
  open: boolean;
  onClose: () => void;
  /** The pane these actions target. Null while nothing is selected (sheet closed). */
  pane: AgentView | null;
  /** Session scope for the rename/close writes (undefined = primary). */
  scope?: Scope;
  /** This device isn't authorised to write — show a read-only note instead of the actions. */
  readOnly?: boolean;
  /** Fired after a successful rename so the parent can revalidate (the label lands on the next poll). */
  onRenamed: () => void;
  /** Fired after a successful close, with the closed pane id — the parent navigates Home if it's the
   *  pane currently open, or revalidates so it drops out of the list. */
  onClosed: (paneId: string) => void;
}

type Mode = "actions" | "rename";

// Long-press actions for a single pane: rename (set/clear its label) and close (kill). Reached by
// long-pressing a pane pill. Opens on an action-list view (Rename / Close pane); rename is a second
// tap away so the sheet doesn't shove a keyboard-triggering input at you just to close a pane. The
// action rows + rename view are the SHARED pieces (action-sheet-rows) the tab sheet also uses, so the
// two stay identical. The label is user text rendered only into an <input> value / text node — never
// markup — so it stays within the pane-output XSS boundary. Both actions are writes, so under
// read-only they're replaced by a note.
export function PaneActionsSheet({
  open,
  onClose,
  pane,
  scope,
  readOnly = false,
  onRenamed,
  onClosed,
}: PaneActionsSheetProps) {
  useLocale();
  const [mode, setMode] = useState<Mode>("actions");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const { pending, confirm, reset } = usePendingConfirm();
  const inputRef = useRef<HTMLInputElement>(null);
  // Rename and close are writes, and both are §10.3 writes to a specific machine — the PANE's, read
  // off the row rather than from the ambient scope, because a pane's host is the only thing that
  // says where closing it kills a terminal. Undefined on a solo install and on a reachable host, so
  // this sheet is byte-identical to today everywhere except a pack with a quiet member.
  const hostBlock = useHostWriteBlock(pane?.host);
  // What the multiplexer underneath can actually do to a pane (M10/06) — asked per row, below.
  const canRename = useMuxCapability("renamePane");
  const canClose = useMuxCapability("closePane");

  // Reset to the action list — and reprefill the label — whenever the sheet opens on a (new) pane,
  // AND whenever it closes, so reopening never lands you mid-rename. Intentionally NOT keyed on the
  // live label, so a background poll landing while you type can't clobber your edit.
  useEffect(() => {
    setMode("actions");
    if (!open) return;
    setLabel(pane?.paneLabel ?? "");
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pane?.paneId]);

  // Autofocus the label input when rename mode opens, so the phone keyboard pops without a second tap.
  useEffect(() => {
    if (mode === "rename") inputRef.current?.focus();
  }, [mode]);

  async function save() {
    if (!pane || saving) return;
    const next = label.trim();
    setSaving(true);
    try {
      const res = await api.renamePane(pane.paneId, next, scope);
      if (res.ok) {
        setStatus(next ? t("paneActions.status.renamed") : t("paneActions.status.labelCleared"), "success");
        onRenamed();
        onClose();
      } else {
        setStatus(describeApiError(res, t("paneActions.status.renameFailed")), "error");
      }
    } catch (e) {
      setStatus(describeThrownError(e), "error");
    } finally {
      setSaving(false);
    }
  }

  // Two-tap: the first tap arms (row flips to "Tap again to close"), the second closes.
  async function requestClose() {
    if (!pane || closing) return;
    if (!confirm(pane.paneId)) return;
    setClosing(true);
    try {
      const res = await api.closePane(pane.paneId, scope);
      if (res.ok) {
        onClose();
        onClosed(pane.paneId);
      } else {
        setStatus(describeApiError(res, t("paneActions.status.closeFailed")), "error");
      }
    } catch (e) {
      setStatus(describeThrownError(e), "error");
    } finally {
      setClosing(false);
    }
  }

  const confirming = !!pane && pending === pane.paneId;

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={pane ? paneDisplayName(pane) : t("paneActions.title.fallback")}
    >
      {readOnly ? (
        <p className="py-2 text-sm text-muted-foreground">{t("paneActions.readOnly")}</p>
      ) : hostBlock ? (
        // Refused BEFORE anything is attempted (§10.3): no queue, no retry, no "try anyway" — the
        // lead would answer `host_unreachable` and the operator would be left guessing whether a
        // close half-landed. Offering the actions greyed out would suggest they're one tap from
        // working; naming the machine and its last-seen age says what to actually wait for.
        <p className="py-2 text-sm text-muted-foreground">
          {t("paneActions.hostBlockSuffix", { hostBlock })}
        </p>
      ) : mode === "actions" ? (
        <div className="flex flex-col gap-1">
          {/* Close kills a real terminal; on a pack the sheet says which machine's before you arm
              the two-tap. Renders nothing on a single-host install. */}
          <HostChip host={pane?.host} variant="target" className="mb-1 self-start" />
          {/* Each row asks its OWN capability, not one "can this sheet do things" flag: a
              multiplexer that renames but will not close is an ordinary shape, and a single gate
              would take the other row down with it. A row a multiplexer cannot back is HIDDEN — the
              sheet is a list of things you can do, and a permanently dead entry in it is worse than
              a shorter list (the same argument the host block above makes about greying out). Both
              rows are present on every adapter shipped today. */}
          {canRename.capable && (
            <ActionRow
              icon={<Pencil className="size-4 shrink-0 text-muted-foreground" />}
              label={t("paneActions.rename.label")}
              onClick={() => setMode("rename")}
            />
          )}
          {canClose.capable && (
            <DestructiveActionRow
              icon={<XCircle className="size-4 shrink-0" />}
              label={t("paneActions.close.label")}
              confirmLabel={t("paneActions.close.confirm")}
              closingLabel={t("paneActions.close.closing")}
              armed={confirming}
              closing={closing}
              onClick={() => void requestClose()}
            />
          )}
          {/* An EMPTY sheet is the one case that must speak. Long-pressing a pane and being handed
              a blank box says nothing at all, so when every row is gone the adapter's own reason
              takes their place — hide the meaningless, explain the expected. */}
          {!canRename.capable && !canClose.capable && (
            <p className="py-2 text-sm leading-snug text-muted-foreground">
              {canRename.note || canClose.note || t("paneActions.empty.fallback")}
            </p>
          )}
        </div>
      ) : (
        <RenameView
          inputRef={inputRef}
          label={label}
          onLabelChange={setLabel}
          onSave={() => void save()}
          onBack={() => setMode("actions")}
          saving={saving}
          // A blank pane field clears the label (blank → null on the bridge), so Save stays enabled.
          canSave={true}
          placeholder={t("paneActions.rename.placeholder")}
        />
      )}
    </BottomSheet>
  );
}
