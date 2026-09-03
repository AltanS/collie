import { useEffect, useRef, useState } from "react";
import { Pencil, XCircle } from "lucide-react";

import { BottomSheet } from "@/components/ui/sheet";
import { ActionRow, DestructiveActionRow, RenameView } from "@/components/action-sheet-rows";
import { HostChip } from "@/components/host-chip";
import { useAmbientHost, useHostWriteBlock } from "@/components/pack-provider";
import { useActionEcho } from "@/hooks/use-action-echo";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import * as api from "@/lib/api";
import { describeApiError, describeThrownError } from "@/lib/api-error-message";
import { useMuxCapability } from "@/lib/mux-capability";
import { setStatus } from "@/lib/status";
import { stampTopology } from "@/lib/poll-intent";
import type { TabView } from "@/lib/types";
import type { Scope } from "@/lib/scope";
import { t, tn } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

interface TabActionsSheetProps {
  open: boolean;
  onClose: () => void;
  /** The tab these actions target. Null while nothing is selected (sheet closed). */
  tab: TabView | null;
  /** Session scope for the rename/close writes (undefined = primary). */
  scope?: Scope;
  /** This device isn't authorised to write — show a read-only note instead of the actions. */
  readOnly?: boolean;
  /** Fired after a successful rename so the parent can revalidate (the label lands on the next poll). */
  onRenamed: () => void;
  /** Fired after a successful close, with the closed tab id — the parent falls back to "All"/Home if
   *  it was the selected/viewed tab, or revalidates so it drops out of the strip. */
  onClosed: (tabId: string) => void;
}

type Mode = "actions" | "rename";

// Long-press actions for a single tab — the SAME structure as the pane sheet (the user asked for
// them to match): opens on an action-list view (Rename / Close tab), with rename tucked behind its
// own tap so opening the sheet never shoves a keyboard-triggering input at you. Shares the action
// rows + rename view (action-sheet-rows) with the pane sheet so the two can't drift. Two differences
// from a pane, both live-verified: a tab label can't be cleared (herdr stores "" literally and
// rejects null), so a blank field can't be saved; and closing a tab kills EVERY pane inside it, so
// the confirm names the blast radius. The label is user text rendered only into an <input> value /
// text node — never markup. Both actions are writes, so under read-only they're replaced by a note.
export function TabActionsSheet({
  open,
  onClose,
  tab,
  scope,
  readOnly = false,
  onRenamed,
  onClosed,
}: TabActionsSheetProps) {
  useLocale();
  const [mode, setMode] = useState<Mode>("actions");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  // Same press echo as the pane sheet's close row, for the same reason and deliberately in the same
  // shape — these two sheets are required to stay identical, which is why their rows are shared
  // components. See components/pane-actions-sheet.tsx for the full argument; the short form is that
  // a spinner alone acknowledged nothing until the next poll dropped the tab out of the strip, and
  // this tap kills every pane in the tab, so it is the last one that should feel unheard.
  const closeEcho = useActionEcho();
  const { pending, confirm, reset } = usePendingConfirm();
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset to the action list — and reprefill the label — whenever the sheet opens on a (new) tab, AND
  // whenever it closes, so reopening never lands you mid-rename. Intentionally NOT keyed on the live
  // label, so a background poll landing while you type can't clobber your edit.
  useEffect(() => {
    setMode("actions");
    if (!open) return;
    setLabel(tab?.label ?? "");
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab?.tabId]);

  // Autofocus the label input when rename mode opens, so the phone keyboard pops without a second tap.
  useEffect(() => {
    if (mode === "rename") inputRef.current?.focus();
  }, [mode]);

  const trimmed = label.trim();

  async function save() {
    if (!tab || saving || !trimmed) return;
    setSaving(true);
    try {
      const res = await api.renameTab(tab.tabId, trimmed, scope);
      if (res.ok) {
        setStatus(t("space.tab.renamed"), "success");
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

  // Two-tap: the first tap arms (row flips to the blast-radius confirm), the second closes.
  //
  // Both failure branches stay at this call site — the refusal is already reported in this sheet's
  // own words, so it is not a `lib/mutate.ts` swallow site. No success `setStatus`: the tab leaving
  // the strip is the outcome, and the echo is the acceptance. `tab` is copied to a local first,
  // because narrowing does not survive into the async closure.
  async function requestClose() {
    if (!tab || closeEcho.pending) return;
    const target = tab;
    if (!confirm(target.tabId)) return;
    await closeEcho.run(target.tabId, async () => {
      try {
        const res = await api.closeTab(target.tabId, scope);
        if (!res.ok) {
          setStatus(describeApiError(res, t("space.tab.closeFailed")), "error");
          return false;
        }
        onClose();
        // Same catch-up as a create: the strip the operator just closed a tab out of should not
        // wait out an idle-timed gap to show it gone.
        stampTopology();
        onClosed(target.tabId);
        return true;
      } catch (e) {
        setStatus(describeThrownError(e), "error");
        return false;
      }
    });
  }

  const confirming = !!tab && pending === tab.tabId;
  // A tab has no host of its own — the tab list is the LEAD's, and both writes here are addressed by
  // the ambient scope. So the chip names the machine the write will land on: `?h=` when set,
  // otherwise the lead. Nothing renders on a single-host install.
  const host = useAmbientHost(scope?.host);
  // …and the same host is what decides whether either write may be attempted at all (§10.3). Same
  // gate as the pane sheet, one dimension up: undefined on a solo install and on a reachable host.
  const hostBlock = useHostWriteBlock(host);
  // The tab verbs the multiplexer underneath declares (M10/06) — asked per row, below.
  const canRename = useMuxCapability("renameTab");
  const canClose = useMuxCapability("closeTab");
  // Closing a tab kills every pane in it — name the blast radius on the confirm so it's honest. The
  // count rides on the tab record (snapshot `pane_count`); fall back to a plain confirm if it's 0.
  const paneCount = tab?.paneCount ?? 0;
  const confirmLabel = paneCount > 0 ? tn("space.tab.closeConfirm", paneCount) : t("space.tab.closeConfirmPlain");

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={tab ? t("space.tab.titleWithLabel", { label: tab.label }) : t("space.tab.titleFallback")}
    >
      {readOnly ? (
        <p className="py-2 text-sm text-muted-foreground">{t("space.tab.readOnly")}</p>
      ) : hostBlock ? (
        // Refused before it is attempted (§10.3) — closing a tab kills every pane in it, and a
        // half-known outcome on that is the worst one to hand somebody.
        <p className="py-2 text-sm text-muted-foreground">
          {t("space.tab.hostBlockSuffix", { hostBlock })}
        </p>
      ) : mode === "actions" ? (
        <div className="flex flex-col gap-1">
          <HostChip host={host} variant="target" className="mb-1 self-start" />
          {/* Per-row capability gating, one dimension up from the pane sheet and for exactly the
              same reasons — see the note there. The two sheets must stay identical in shape, which
              is why the rows themselves are shared components. */}
          {canRename.capable && (
            <ActionRow
              icon={<Pencil className="size-4 shrink-0 text-muted-foreground" />}
              label={t("space.tab.rename")}
              onClick={() => setMode("rename")}
            />
          )}
          {canClose.capable && (
            <DestructiveActionRow
              icon={<XCircle className="size-4 shrink-0" />}
              label={t("space.tab.close")}
              confirmLabel={confirmLabel}
              closingLabel={t("space.tab.closing")}
              armed={confirming}
              // The only member of this echo group, so the group flag says the same thing as
              // `phaseOf(tabId)` without needing a tab that may be null here.
              closing={closeEcho.pending}
              onClick={() => void requestClose()}
            />
          )}
          {!canRename.capable && !canClose.capable && (
            <p className="py-2 text-sm leading-snug text-muted-foreground">
              {canRename.note || canClose.note || t("space.tab.empty.fallback")}
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
          // A tab has no "clear" (herdr stores "" literally, rejects null), so a blank field can't be
          // saved — Save disables. This is the one rename difference from a pane.
          canSave={!!trimmed}
          placeholder={t("space.tab.placeholder")}
        />
      )}
    </BottomSheet>
  );
}
