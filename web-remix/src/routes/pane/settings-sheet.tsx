import type { Handle } from "remix/component";
import { Pencil } from "lucide";

import { t } from "@web/lib/i18n";
import { scopeKey, type Scope } from "@web/lib/scope";
import type { AgentView, CacheWatchState } from "@web/lib/types";

import { ActionRow } from "../../chips/action-rows";
import { bridgeWrite, writeRefusal } from "../../chips/writes";
import { bridgeGet, bridgeSend } from "../../lib/api";
import { useLocale } from "../../lib/i18n-store";
import { setStatus } from "../../lib/status";
import { scheduleUpdate, useStore } from "../../lib/store";
import { Icon } from "../../ui/icon";
import { BottomSheet } from "../../ui/sheet";
import { Switch } from "../../ui/switch";
import { mutate } from "../settings/mutate";
import { getPushState, pushState } from "../settings/push";

// Port of web/src/components/pane-settings-sheet.tsx and hooks/use-cache-watch.ts: one pane's own
// settings. Warn me before this pane's prompt cache goes cold (ADR 0042), and Rename (the pane name
// in the header opens this sheet, so the row that edits the name sits here too; it hands over to the
// pane menu's rename view and carries no second flow).
//
// THE SWITCH IS DISABLED FOR THREE REASONS, AND IT SAYS WHICH. Push is not enabled on this device
// (nothing would arrive); the global switch in Settings already covers every pane (the switch then
// reads ON, because it IS on: there is no per-pane off that overrides the global one); or the pane
// names no harness session, so there is nothing to key a watch by. A disabled switch with no
// sentence is the shape this deliberately avoids.
//
// The read happens when the sheet OPENS, because the answer moves: the global switch may have been
// turned on from Settings since, and `warnSeconds` is the bridge's number, not this build's. The
// toggle is optimistic and REVERTS LOUDLY on failure (`mutate` publishes the sentence); the
// bridge's merged view is the last word.

export interface PaneSettingsSheetProps {
  open: boolean;
  onClose: () => void;
  /** The pane this sheet is about. Null while nothing is selected. */
  pane: AgentView | null;
  /** Session scope for the read and the write: the machine the PANE lives on. */
  scope: Scope | undefined;
  /**
   * Open the rename flow. Absent hides the row: the pane cannot be renamed here (read-only device,
   * an unreachable machine, a multiplexer with no rename).
   */
  onRename?: (() => void) | undefined;
}

const cacheWatchPath = (paneId: string): string => `/api/notifications/cache-watch?pane=${encodeURIComponent(paneId)}`;

export function PaneSettingsSheet(handle: Handle<PaneSettingsSheetProps>) {
  useLocale(handle);
  const readPush = useStore(handle, pushState);
  let state: CacheWatchState | null = null;
  let busy = false;
  /** What the reading on screen was asked for; null while the sheet is shut. */
  let shownFor: string | null = null;

  const load = (paneId: string, scope: Scope | undefined, key: string): void => {
    void (async () => {
      try {
        const next = await bridgeGet<CacheWatchState>(cacheWatchPath(paneId), scope, handle.signal);
        if (handle.signal.aborted || shownFor !== key) return;
        state = next;
        scheduleUpdate(handle);
      } catch {
        // No reading: the sheet renders its switch disabled, which is the honest shape.
      }
    })();
  };

  const toggle = async (next: boolean): Promise<void> => {
    const { pane, scope } = handle.props;
    if (pane === null || state === null || busy) return;
    const refused = writeRefusal();
    if (refused !== undefined) {
      setStatus(refused, "error");
      return;
    }
    const key = shownFor;
    state = { ...state, on: next }; // optimistic
    busy = true;
    void handle.update();
    const res = await mutate(() => bridgeWrite(() => bridgeSend<CacheWatchState>("POST", cacheWatchPath(pane.paneId), { on: next }, scope, handle.signal)));
    if (handle.signal.aborted) return;
    busy = false;
    // The sheet closed or moved to another pane under the write: its reading is not ours to touch.
    if (shownFor === key) {
      if (res.ok) state = res.value; // reconcile: the bridge's merged view is the last word
      else state = state === null ? state : { ...state, on: !next }; // revert, and `mutate` said why
    }
    void handle.update();
  };

  return () => {
    const { open, onClose, pane, scope, onRename } = handle.props;
    // A fresh open (or another pane) starts from no reading and asks again, after this render commits.
    const key = open && pane !== null ? `${scopeKey(scope)}\u0000${pane.paneId}` : null;
    if (key !== shownFor) {
      shownFor = key;
      state = null;
      if (key !== null && pane !== null) {
        const paneId = pane.paneId;
        handle.queueTask(() => {
          load(paneId, scope, key);
          // Push first, because it is the one reason about this DEVICE and its remedy is elsewhere.
          void getPushState();
        });
      }
    }
    // `null` is "not asked yet", not "off": it disables the switch with the ordinary hint rather
    // than claiming a refusal nothing has established.
    const push = readPush();
    const pushOff = push !== null && (push.availability !== "ready" || !push.subscribed);
    return (
      <BottomSheet open={open} onClose={onClose} title={t("paneSettings.title")}>
        <PaneSettingsView
          state={state}
          busy={busy}
          pushOff={pushOff}
          pushKnown={push !== null}
          onToggle={(next) => void toggle(next)}
          onRename={onRename}
        />
      </BottomSheet>
    );
  };
}

export interface PaneSettingsViewProps {
  /** Null until the bridge answers. The switch is disabled and the hint is the ordinary one. */
  state: CacheWatchState | null;
  busy: boolean;
  /** Push is not usable on this device. */
  pushOff: boolean;
  /** False while the browser has not been asked yet: disables without claiming a refusal. */
  pushKnown?: boolean;
  onToggle: (next: boolean) => void;
  /** The Rename row, above the switch. Absent hides it. */
  onRename?: (() => void) | undefined;
}

/** The rows, with every value handed in (web/ split it the same way, for its playground). */
export function PaneSettingsView(handle: Handle<PaneSettingsViewProps>) {
  useLocale(handle);
  return () => {
    const { state, busy, pushOff, pushKnown = true, onRename } = handle.props;
    const globalOn = state?.global === true;
    const unwatchable = state !== null && !state.watchable;
    const hint = hintFor({ pushOff, globalOn, unwatchable, warnSeconds: state?.warnSeconds });
    return (
      <div class="flex flex-col gap-3 pb-4">
        {onRename !== undefined && (
          <div class="px-1">
            <ActionRow
              icon={<Icon icon={Pencil} class="size-4 shrink-0 text-muted-foreground" />}
              label={t("paneActions.rename.label")}
              onClick={() => handle.props.onRename?.()}
              testId="pane-settings-rename"
            />
          </div>
        )}
        <div class="flex items-center justify-between gap-4 px-4">
          <div class="min-w-0">
            <div class="text-sm font-medium">{t("paneSettings.cacheWatch.label")}</div>
            <p class="text-xs leading-snug text-muted-foreground">{hint}</p>
          </div>
          <Switch
            // The global switch reads as ON here rather than as "off but covered": the warning for
            // this pane IS going out, and a switch that said otherwise would be the lie the hint
            // then has to correct.
            checked={globalOn || state?.on === true}
            disabled={busy || state === null || !pushKnown || pushOff || globalOn || unwatchable}
            onCheckedChange={(next) => handle.props.onToggle(next)}
            aria-label={t("paneSettings.cacheWatch.label")}
          />
        </div>
      </div>
    );
  };
}

/**
 * Which sentence sits under the label. The three refusals first, in the order the operator can act
 * on them: this device, then Settings, then the pane itself. The ordinary hint is the fall-through.
 */
function hintFor(input: { pushOff: boolean; globalOn: boolean; unwatchable: boolean; warnSeconds: number | undefined }): string {
  if (input.pushOff) return t("paneSettings.cacheWatch.pushOff");
  if (input.globalOn) return t("paneSettings.cacheWatch.globalOn");
  if (input.unwatchable) return t("paneSettings.cacheWatch.noSession");
  return t("paneSettings.cacheWatch.hint", { minutes: minutes(input.warnSeconds) });
}

/** The window in whole minutes, from the bridge's own number. One is the floor, so "0 minutes" is unsayable. */
function minutes(warnSeconds: number | undefined): string {
  return String(Math.max(1, Math.round((warnSeconds ?? 300) / 60)));
}
