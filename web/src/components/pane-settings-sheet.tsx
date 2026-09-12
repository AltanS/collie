import { Switch } from "@/components/ui/switch";
import { BottomSheet } from "@/components/ui/sheet";
import { useCacheWatch } from "@/hooks/use-cache-watch";
import { useLocale } from "@/hooks/use-locale";
import { usePushControl } from "@/hooks/use-push";
import { t } from "@/lib/i18n";
import type { Scope } from "@/lib/scope";
import type { CacheWatchState } from "@/lib/types";

// One pane's own settings. Today that is exactly one row: warn me before this pane's prompt cache goes
// cold (ADR 0042).
//
// ── WHY IT IS A SHEET AND NOT A HEADER BUTTON ────────────────────────────────
// `agent-chat.tsx` states the header's budget as a rule — one Leave, one flexible Identity, at most two
// Actions — and the row already spent its Action slot on the ⋮. A third icon would take that width back
// off the pane name, so the entry point is a row inside the actions sheet.
//
// ── THE SWITCH IS DISABLED FOR THREE REASONS, AND IT SAYS WHICH ──────────────
// Push is not enabled on this device (nothing would arrive); the global switch in Settings already
// covers every pane (the switch then reads ON, because it IS on — there is no per-pane off that
// overrides the global one); or the pane names no harness session, so there is nothing to key a watch
// by. A disabled switch with no sentence is the shape this deliberately avoids.

interface PaneSettingsSheetProps {
  open: boolean;
  onClose: () => void;
  /** The pane this sheet is about. Undefined while nothing is selected. */
  paneId: string | undefined;
  /** Session scope for the read and the write — the machine the PANE lives on. */
  scope?: Scope;
}

export function PaneSettingsSheet({ open, onClose, paneId, scope }: PaneSettingsSheetProps) {
  useLocale();
  const { state: push } = usePushControl();
  const { state, busy, toggle } = useCacheWatch(paneId, open, scope);

  // Push first, because it is the only one of the three that is about this DEVICE rather than this pane,
  // and the remedy is on another screen.
  // `null` is "not asked yet", not "off": it disables the switch below with the ordinary hint rather
  // than claiming a refusal nothing has established.
  const pushOff = push !== null && (push.availability !== "ready" || !push.subscribed);

  return (
    <BottomSheet open={open} onClose={onClose} title={t("paneSettings.title")}>
      <PaneSettingsView
        state={state}
        busy={busy}
        pushOff={pushOff}
        pushKnown={push !== null}
        onToggle={(next) => void toggle(next)}
      />
    </BottomSheet>
  );
}

/**
 * The rows, with every value handed in.
 *
 * Split from the controller for the reason the playground exists: its five cards are states no fetch can
 * reach there (nothing on that page is stubbed, by rule), and the real markup with a fixture is worth
 * more to review than a stubbed hook.
 */
export function PaneSettingsView({
  state,
  busy,
  pushOff,
  pushKnown = true,
  onToggle,
}: {
  /** Null until the bridge answers. The switch is disabled and the hint is the ordinary one. */
  state: CacheWatchState | null;
  busy: boolean;
  /** Push is not usable on this device. The first of the three reasons, and the only device-level one. */
  pushOff: boolean;
  /** False while the browser has not been asked yet — disables without claiming a refusal. */
  pushKnown?: boolean;
  onToggle: (next: boolean) => void;
}) {
  useLocale();
  const globalOn = state?.global === true;
  const unwatchable = state !== null && !state.watchable;
  const hint = hintFor({ pushOff, globalOn, unwatchable, warnSeconds: state?.warnSeconds });

  return (
    <div className="flex items-center justify-between gap-4 px-4 pb-4">
      <div className="min-w-0">
        <div className="text-sm font-medium">{t("paneSettings.cacheWatch.label")}</div>
        <p className="text-xs leading-snug text-muted-foreground">{hint}</p>
      </div>
      <Switch
        // The global switch reads as ON here rather than as "off but covered": the warning for this
        // pane IS going out, and a switch that said otherwise would be the lie the hint then has to
        // correct.
        checked={globalOn || state?.on === true}
        disabled={busy || state === null || !pushKnown || pushOff || globalOn || unwatchable}
        onCheckedChange={onToggle}
        aria-label={t("paneSettings.cacheWatch.label")}
      />
    </div>
  );
}

/**
 * Which sentence sits under the label. The three refusals first, in the order the operator can act on
 * them: this device, then Settings, then the pane itself. The ordinary hint is the fall-through.
 */
function hintFor(input: {
  pushOff: boolean;
  globalOn: boolean;
  unwatchable: boolean;
  warnSeconds: number | undefined;
}): string {
  if (input.pushOff) return t("paneSettings.cacheWatch.pushOff");
  if (input.globalOn) return t("paneSettings.cacheWatch.globalOn");
  if (input.unwatchable) return t("paneSettings.cacheWatch.noSession");
  return t("paneSettings.cacheWatch.hint", { minutes: minutes(input.warnSeconds) });
}

/** The window in whole minutes, from the bridge's own number. One is the floor, so "0 minutes" is unsayable. */
function minutes(warnSeconds: number | undefined): string {
  return String(Math.max(1, Math.round((warnSeconds ?? 300) / 60)));
}
