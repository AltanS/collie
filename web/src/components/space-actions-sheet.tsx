import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";

import { BottomSheet } from "@/components/ui/sheet";
import { ActionRow, RenameView } from "@/components/action-sheet-rows";
import { HostChip } from "@/components/host-chip";
import { useAmbientHost, useHostWriteBlock } from "@/components/crew-provider";
import * as api from "@/lib/api";
import { describeApiError, describeThrownError } from "@/lib/api-error-message";
import { useMuxDeclared } from "@/lib/mux-capability";
import { setStatus } from "@/lib/status";
import { stampTopology } from "@/lib/poll-intent";
import type { WorkspaceView } from "@/lib/types";
import type { Scope } from "@/lib/scope";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

interface SpaceActionsSheetProps {
  open: boolean;
  onClose: () => void;
  /** The space these actions target. Null while nothing is selected (sheet closed). */
  space: WorkspaceView | null;
  /** Session scope for the rename write (undefined = primary). */
  scope?: Scope;
  /** This device isn't authorised to write: show a read-only note instead of the actions. */
  readOnly?: boolean;
  /** A saved copy is on screen (see PaneActionsSheet.savedCopy): the write is replaced by a note. */
  savedCopy?: boolean;
  /** Fired after a successful rename so the parent can revalidate (the name lands on the next poll). */
  onRenamed: () => void;
}

type Mode = "actions" | "rename";

// Long-press actions for a single space, the shape of the tab sheet one level up and with one row: Rename. A
// space is closed or made by hand in no multiplexer Collie drives except through the program that lays it out, so
// Rename is the only act, and it exists only on a machine whose multiplexer declares `renameSpace` (a durable
// program that takes renames, WIRE.md 7.8). Like the tab sheet it opens on the action list, with the input behind
// its own tap so opening the sheet never raises a keyboard. A space name cannot be cleared, so a blank field
// cannot be saved. The name is user text, rendered only into an <input> value or a text node, never markup.
export function SpaceActionsSheet({
  open,
  onClose,
  space,
  scope,
  readOnly = false,
  savedCopy = false,
  onRenamed,
}: SpaceActionsSheetProps) {
  useLocale();
  const [mode, setMode] = useState<Mode>("actions");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset to the action list, and reprefill the name, whenever the sheet opens on a (new) space and whenever it
  // closes. Not keyed on the live label, so a background poll landing while you type cannot clobber your edit.
  useEffect(() => {
    setMode("actions");
    if (!open) return;
    setLabel(space?.label ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, space?.workspaceId]);

  // Autofocus the input when rename mode opens, so the phone keyboard pops without a second tap.
  useEffect(() => {
    if (mode === "rename") inputRef.current?.focus();
  }, [mode]);

  const trimmed = label.trim();

  async function save() {
    if (!space || saving || !trimmed || savedCopy) return;
    setSaving(true);
    try {
      const res = await api.renameSpace(space.workspaceId, trimmed, scope);
      if (res.ok) {
        setStatus(t("space.tab.renamed"), "success");
        // The same catch-up as a tab close: the list should not wait out an idle-timed gap to show
        // the new name (pane-actions-sheet.tsx says why the revalidate alone can read the old one).
        stampTopology();
        onRenamed();
        onClose();
      } else {
        setStatus(describeApiError(res, t("space.tab.renameFailed")), "error");
      }
    } catch (e) {
      setStatus(describeThrownError(e), "error");
    } finally {
      setSaving(false);
    }
  }

  // A space has no host of its own: the list is the LEAD's, and the write is addressed by the ambient scope. So
  // the chip names the machine the write will land on, and the same host decides whether it may be attempted at
  // all (§10.3). Both are undefined on a solo install and on a reachable host.
  const host = useAmbientHost(scope?.host);
  const hostBlock = useHostWriteBlock(host);
  // The program's own control: asked of the machine the write will land on, and ABSENT until a bridge said yes.
  const canRename = useMuxDeclared("renameSpace", scope);
  // No History row (M53 spec 12): a durable program's history is its machine's home, the conversation list,
  // so the sheet spec 11 gave one to has nothing to add, and no other multiplexer ever drew it.

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={space ? t("space.space.titleWithLabel", { label: space.label }) : t("space.space.titleFallback")}
    >
      {readOnly ? (
        <p className="py-2 text-sm text-muted-foreground">{t("space.space.readOnly")}</p>
      ) : savedCopy ? (
        <p className="py-2 text-sm text-muted-foreground">{t("space.readOnly.savedCopy")}</p>
      ) : hostBlock ? (
        <p className="py-2 text-sm text-muted-foreground">{t("space.space.hostBlockSuffix", { hostBlock })}</p>
      ) : mode === "actions" ? (
        <div className="flex flex-col gap-1">
          <HostChip host={host} variant="target" className="mb-1 self-start" />
          {canRename ? (
            <ActionRow
              icon={<Pencil className="size-4 shrink-0 text-muted-foreground" />}
              label={t("space.tab.rename")}
              onClick={() => setMode("rename")}
            />
          ) : (
            <p className="py-2 text-sm leading-snug text-muted-foreground">{t("space.space.empty.fallback")}</p>
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
          canSave={!!trimmed}
          placeholder={t("space.space.placeholder")}
        />
      )}
    </BottomSheet>
  );
}
