import type { Handle } from "remix/component";
import { Pencil, XCircle } from "lucide";

import { closeTab, renameTab } from "@web/lib/api";
import { describeApiError, describeThrownError } from "@web/lib/api-error-message";
import { ambientHost } from "@web/lib/hosts";
import { t, tn } from "@web/lib/i18n";
import type { Scope } from "@web/lib/scope";
import type { TabView } from "@web/lib/types";

import { snapshot } from "../lib/data";
import { useLocale } from "../lib/i18n-store";
import { kick, noteTopology } from "../lib/polling";
import { buzz } from "../lib/prefs";
import { setStatus } from "../lib/status";
import { Icon } from "../ui/icon";
import { BottomSheet } from "../ui/sheet";
import { ActionRow, DestructiveActionRow, pendingConfirm, RenameView } from "./action-rows";
import { capability } from "./capability";
import { crewOf, hostWriteBlock } from "./crew";
import { HostChip } from "./host-chip";
import { bridgeWrite, writeRefusal } from "./writes";

// Port of web/src/components/tab-actions-sheet.tsx: a held tab pill's menu, Rename and Close tab.
// Close names its blast radius ("Close 3 panes?") because it kills every pane in the tab; it arms on
// the first tap and runs on the second. Same rows, same gates and the same shape as the pane sheet.
export interface TabActionsSheetProps {
  open: boolean;
  onClose: () => void;
  tab: TabView | null;
  scope?: Scope;
  readOnly?: boolean;
  onRenamed?: () => void;
  onClosed?: (tabId: string) => void;
}

export function TabActionsSheet(handle: Handle<TabActionsSheetProps>) {
  useLocale(handle);
  let mode: "actions" | "rename" = "actions";
  let saving = false;
  let closing = false;
  let shownFor: string | null = null;
  const confirm = pendingConfirm(() => void handle.update(), handle.signal);

  const save = async (value: string): Promise<void> => {
    const tab = handle.props.tab;
    const label = value.trim();
    if (tab === null || saving || label === "") return;
    saving = true;
    void handle.update();
    try {
      const res = await bridgeWrite(() => renameTab(tab.tabId, label, handle.props.scope));
      if (res.ok) {
        setStatus(t("space.tab.renamed"), "success");
        kick();
        handle.props.onRenamed?.();
        handle.props.onClose();
      } else {
        setStatus(describeApiError(res, t("space.tab.renameFailed")), "error");
      }
    } catch (error) {
      setStatus(describeThrownError(error), "error");
    } finally {
      saving = false;
      if (!handle.signal.aborted) void handle.update();
    }
  };

  const requestClose = async (): Promise<void> => {
    const tab = handle.props.tab;
    if (tab === null || closing) return;
    if (!confirm.confirm(tab.tabId)) {
      void handle.update();
      return;
    }
    closing = true;
    buzz();
    void handle.update();
    try {
      const res = await bridgeWrite(() => closeTab(tab.tabId, handle.props.scope));
      if (!res.ok) {
        setStatus(describeApiError(res, t("space.tab.closeFailed")), "error");
        return;
      }
      handle.props.onClose();
      noteTopology();
      kick();
      handle.props.onClosed?.(tab.tabId);
    } catch (error) {
      setStatus(describeThrownError(error), "error");
    } finally {
      closing = false;
      if (!handle.signal.aborted) void handle.update();
    }
  };

  return () => {
    const { open, onClose, tab, scope } = handle.props;
    const opening = open ? (tab?.tabId ?? "") : null;
    if (opening !== shownFor) {
      shownFor = opening;
      mode = "actions";
      confirm.reset();
    }
    const crew = crewOf(snapshot.get().data);
    const host = ambientHost(crew.servers, scope?.host);
    const hostBlock = hostWriteBlock(crew, host);
    const readOnly = handle.props.readOnly === true || writeRefusal() !== undefined;
    const canRename = capability("renameTab");
    const canClose = capability("closeTab");
    const paneCount = tab?.paneCount ?? 0;
    const confirmLabel = paneCount > 0 ? tn("space.tab.closeConfirm", paneCount) : t("space.tab.closeConfirmPlain");
    const armed = tab !== null && confirm.pending() === tab.tabId;
    return (
      <BottomSheet
        open={open}
        onClose={onClose}
        title={tab ? t("space.tab.titleWithLabel", { label: tab.label }) : t("space.tab.titleFallback")}
      >
        <div data-testid="tab-actions-sheet">
          {readOnly ? (
            <p class="py-2 text-sm text-muted-foreground">{t("space.tab.readOnly")}</p>
          ) : hostBlock !== undefined ? (
            <p class="py-2 text-sm text-muted-foreground">{t("space.tab.hostBlockSuffix", { hostBlock })}</p>
          ) : mode === "actions" ? (
            <div class="flex flex-col gap-1">
              <HostChip host={host} variant="target" class="mb-1 self-start" />
              {canRename.capable ? (
                <ActionRow
                  testId="tab-action-rename"
                  icon={<Icon icon={Pencil} class="size-4 shrink-0 text-muted-foreground" />}
                  label={t("space.tab.rename")}
                  onClick={() => {
                    mode = "rename";
                    void handle.update();
                  }}
                />
              ) : null}
              {canClose.capable ? (
                <DestructiveActionRow
                  testId="tab-action-close"
                  icon={<Icon icon={XCircle} class="size-4 shrink-0" />}
                  label={t("space.tab.close")}
                  confirmLabel={confirmLabel}
                  closingLabel={t("space.tab.closing")}
                  armed={armed}
                  closing={closing}
                  onClick={() => void requestClose()}
                />
              ) : null}
              {!canRename.capable && !canClose.capable ? (
                <p class="py-2 text-sm leading-snug text-muted-foreground">
                  {canRename.note || canClose.note || t("space.tab.empty.fallback")}
                </p>
              ) : null}
            </div>
          ) : (
            <RenameView
              initial={tab?.label ?? ""}
              onSave={(value) => void save(value)}
              onBack={() => {
                mode = "actions";
                void handle.update();
              }}
              saving={saving}
              allowEmpty={false}
              placeholder={t("space.tab.placeholder")}
            />
          )}
        </div>
      </BottomSheet>
    );
  };
}
