import type { Handle, RemixNode } from "remix/component";
import { Copy, Maximize2, MessagesSquare, Monitor, Pencil, Pin, PinOff, ScrollText, Search, SlidersHorizontal, SquareTerminal, XCircle } from "lucide";

import { closePane, focusPane, renamePane } from "@web/lib/api";
import { describeApiError, describeThrownError } from "@web/lib/api-error-message";
import { t } from "@web/lib/i18n";
import { paneName } from "@web/lib/pane-name";
import type { PaneView } from "@web/lib/pane-view";
import type { Scope } from "@web/lib/scope";
import type { AgentView } from "@web/lib/types";

import { config, snapshot } from "../lib/data";
import { useLocale } from "../lib/i18n-store";
import { dropPin, pinMatcher, pins, setPinned } from "../lib/pins";
import { kick, noteTopology } from "../lib/polling";
import { buzz } from "../lib/prefs";
import { setStatus } from "../lib/status";
import { useStore } from "../lib/store";
import { Icon } from "../ui/icon";
import { BottomSheet } from "../ui/sheet";
import { ActionRow, DestructiveActionRow, pendingConfirm, RenameView } from "./action-rows";
import { capability } from "./capability";
import { crewOf, hostWriteBlock } from "./crew";
import { HostChip } from "./host-chip";
import { bridgeWrite, writeRefusal } from "./writes";

// Port of web/src/components/pane-actions-sheet.tsx: one pane's menu. The dashboard opens it with a
// hold on a row (ADR 0070), the pane header with its ⋮.
//
// THE READ ROWS LEAD (find, history, copy, the Chat/Terminal switch, pane settings, zen, then the
// caller's `extraRows`, then Pin/Unpin): they change this device or the view and type into no
// terminal, so they stay open on a read-only device and on a quiet machine. Every read row closes
// the sheet, then calls its callback. Pin/Unpin is last of them, so a row the operator knows never
// moves, and it is the first row on the two doors that pass no reads.
//
// THE WRITE ROWS (rename, show in terminal, close) each ask their OWN capability and are hidden when
// the multiplexer cannot back them; an empty list speaks the adapter's reason. A read-only device
// and an unreachable machine get one sentence in their place. Close arms on the first tap and runs
// on the second; a close also drops the pane's pin and starts the topology burst.
export interface PaneActionsSheetProps {
  open: boolean;
  onClose: () => void;
  pane: AgentView | null;
  /** The pane's own scope (machine and session); the ambient one when absent. */
  scope?: Scope;
  readOnly?: boolean;
  /** Every pane the caller's list holds, for the pin store's prune (web/'s `herd`). */
  herd?: readonly AgentView[];
  /** A pin or unpin moved the row; without it the sheet says so in the status line. */
  onPinChange?: (pane: AgentView, pinned: boolean) => void;
  onRenamed?: () => void;
  onClosed?: (paneId: string) => void;
  /** Open straight into the rename view. */
  openInRename?: boolean;
  onFind?: () => void;
  onHistory?: () => void;
  onCopyOutput?: () => void;
  paneView?: PaneView;
  onPaneViewChange?: (view: PaneView) => void;
  paneViewNote?: string;
  onSettings?: () => void;
  onZen?: () => void;
  /** More read rows, drawn after Zen and before Pin (the pane screen's raw-mirror toggle). */
  extraRows?: RemixNode;
}

const NO_HERD: readonly AgentView[] = [];
const ROW_ICON = "size-4 shrink-0 text-muted-foreground";

export function PaneActionsSheet(handle: Handle<PaneActionsSheetProps>) {
  useLocale(handle);
  const readPins = useStore(handle, pins);
  let mode: "actions" | "rename" = "actions";
  let saving = false;
  let closing = false;
  let focusing = false;
  let shownFor: string | null = null;
  const confirm = pendingConfirm(() => void handle.update(), handle.signal);

  const scope = (): Scope | undefined => handle.props.scope;

  const finish = (): void => {
    handle.props.onClose();
  };

  const save = async (value: string): Promise<void> => {
    const pane = handle.props.pane;
    if (pane === null || saving) return;
    const next = value.trim();
    saving = true;
    void handle.update();
    try {
      const res = await bridgeWrite(() => renamePane(pane.paneId, next, scope()));
      if (res.ok) {
        setStatus(next ? t("paneActions.status.renamed") : t("paneActions.status.labelCleared"), "success");
        kick();
        handle.props.onRenamed?.();
        finish();
      } else {
        setStatus(describeApiError(res, t("paneActions.status.renameFailed")), "error");
      }
    } catch (error) {
      setStatus(describeThrownError(error), "error");
    } finally {
      saving = false;
      if (!handle.signal.aborted) void handle.update();
    }
  };

  const requestClose = async (): Promise<void> => {
    const pane = handle.props.pane;
    if (pane === null || closing) return;
    if (!confirm.confirm(pane.paneId)) {
      void handle.update();
      return;
    }
    closing = true;
    buzz();
    void handle.update();
    try {
      const res = await bridgeWrite(() => closePane(pane.paneId, scope()));
      if (!res.ok) {
        setStatus(describeApiError(res, t("paneActions.status.closeFailed")), "error");
        return;
      }
      finish();
      dropPin(pane);
      noteTopology();
      kick();
      handle.props.onClosed?.(pane.paneId);
    } catch (error) {
      setStatus(describeThrownError(error), "error");
    } finally {
      closing = false;
      if (!handle.signal.aborted) void handle.update();
    }
  };

  const showInTerminal = async (): Promise<void> => {
    const pane = handle.props.pane;
    if (pane === null || focusing) return;
    focusing = true;
    try {
      const res = await bridgeWrite(() => focusPane(pane.paneId, scope()));
      if (res.ok) {
        setStatus(t("paneActions.focus.done"), "success");
        finish();
      } else {
        setStatus(describeApiError(res, t("paneActions.focus.failed")), "error");
      }
    } catch (error) {
      setStatus(describeThrownError(error), "error");
    } finally {
      focusing = false;
    }
  };

  const togglePin = (): void => {
    const pane = handle.props.pane;
    if (pane === null) return;
    const next = !pinMatcher(pins.get())(pane);
    finish();
    setPinned(pane, next, handle.props.herd ?? NO_HERD);
    if (handle.props.onPinChange) handle.props.onPinChange(pane, next);
    else setStatus(next ? t("paneActions.pin.done") : t("paneActions.unpin.done"), "success");
  };

  const read = (run: (() => void) | undefined) => (): void => {
    finish();
    run?.();
  };

  return () => {
    const p = handle.props;
    const { open, pane } = p;
    // A fresh open (or another pane) starts on the actions list with nothing armed.
    const opening = open ? (pane?.paneId ?? "") : null;
    if (opening !== shownFor) {
      shownFor = opening;
      confirm.reset();
      const canRenameNow = capability("renamePane").capable;
      mode = open && p.openInRename === true && canRenameNow ? "rename" : "actions";
    }
    const pinned = pane !== null && pinMatcher(readPins())(pane);
    const crew = crewOf(snapshot.get().data);
    const readOnly = p.readOnly === true || writeRefusal() !== undefined;
    const hostBlock = hostWriteBlock(crew, pane?.host);
    const canRename = capability("renamePane");
    const canClose = capability("closePane");
    const canFocus = capability("setFocus");
    const localMux = config.get().data?.mux?.name ?? "";
    const focusMux = pane?.host === undefined || pane.host === crew.lead ? localMux : "";
    const armed = pane !== null && confirm.pending() === pane.paneId;
    return (
      <BottomSheet
        open={open}
        onClose={p.onClose}
        title={
          pane ? (
            <span class="flex min-w-0 items-center gap-1.5">
              <span data-slot="pane-actions-title-name" class="min-w-0 truncate">
                {paneName(pane)}
              </span>
              <HostChip host={pane.host} variant="target" />
            </span>
          ) : (
            t("paneActions.title.fallback")
          )
        }
      >
        <div data-testid="pane-actions-sheet">
          {mode === "actions" && pane ? (
            <div class="mb-1 flex flex-col gap-1">
              {p.onFind ? <ActionRow icon={<Icon icon={Search} class={ROW_ICON} />} label={t("chat.find.label")} onClick={read(p.onFind)} /> : null}
              {p.onHistory ? (
                <ActionRow icon={<Icon icon={ScrollText} class={ROW_ICON} />} label={t("chat.history.label")} onClick={read(p.onHistory)} />
              ) : null}
              {p.onCopyOutput ? (
                <ActionRow icon={<Icon icon={Copy} class={ROW_ICON} />} label={t("chat.copyOutput.label")} onClick={read(p.onCopyOutput)} />
              ) : null}
              {p.paneView !== undefined && p.onPaneViewChange ? (
                <ActionRow
                  icon={<Icon icon={p.paneView === "chat" ? SquareTerminal : MessagesSquare} class={ROW_ICON} />}
                  label={t(p.paneView === "chat" ? "chat.mode.terminal" : "chat.mode.chat")}
                  hint={p.paneViewNote}
                  onClick={read(() => handle.props.onPaneViewChange?.(handle.props.paneView === "chat" ? "terminal" : "chat"))}
                />
              ) : null}
              {p.onSettings ? (
                <ActionRow icon={<Icon icon={SlidersHorizontal} class={ROW_ICON} />} label={t("paneActions.settings.label")} onClick={read(p.onSettings)} />
              ) : null}
              {p.onZen ? <ActionRow icon={<Icon icon={Maximize2} class={ROW_ICON} />} label={t("chat.zen.label")} onClick={read(p.onZen)} /> : null}
              {p.extraRows ?? null}
              <ActionRow
                testId="pane-action-pin"
                icon={<Icon icon={pinned ? PinOff : Pin} class={ROW_ICON} />}
                label={pinned ? t("paneActions.unpin.label") : t("paneActions.pin.label")}
                onClick={togglePin}
              />
            </div>
          ) : null}
          {readOnly ? (
            <p class="py-2 text-sm text-muted-foreground">{t("paneActions.readOnly")}</p>
          ) : hostBlock !== undefined ? (
            <p class="py-2 text-sm text-muted-foreground">{t("paneActions.hostBlockSuffix", { hostBlock })}</p>
          ) : mode === "actions" ? (
            <div class="flex flex-col gap-1">
              {canRename.capable ? (
                <ActionRow
                  testId="pane-action-rename"
                  icon={<Icon icon={Pencil} class={ROW_ICON} />}
                  label={t("paneActions.rename.label")}
                  onClick={() => {
                    mode = "rename";
                    void handle.update();
                  }}
                />
              ) : null}
              {canFocus.capable ? (
                <ActionRow
                  testId="pane-action-focus"
                  icon={<Icon icon={Monitor} class={ROW_ICON} />}
                  label={focusMux ? t("paneActions.focus.labelWithMux", { mux: focusMux }) : t("paneActions.focus.labelFallback")}
                  onClick={() => void showInTerminal()}
                />
              ) : null}
              {canClose.capable ? (
                <DestructiveActionRow
                  testId="pane-action-close"
                  icon={<Icon icon={XCircle} class="size-4 shrink-0" />}
                  label={t("paneActions.close.label")}
                  confirmLabel={t("paneActions.close.confirm")}
                  closingLabel={t("paneActions.close.closing")}
                  armed={armed}
                  closing={closing}
                  onClick={() => void requestClose()}
                />
              ) : null}
              {!canRename.capable && !canClose.capable && !canFocus.capable ? (
                <p class="py-2 text-sm leading-snug text-muted-foreground">
                  {canRename.note || canClose.note || canFocus.note || t("paneActions.empty.fallback")}
                </p>
              ) : null}
            </div>
          ) : (
            <RenameView
              initial={pane?.paneLabel ?? ""}
              onSave={(value) => void save(value)}
              onBack={() => {
                mode = "actions";
                void handle.update();
              }}
              saving={saving}
              allowEmpty
              placeholder={t("paneActions.rename.placeholder")}
            />
          )}
        </div>
      </BottomSheet>
    );
  };
}
