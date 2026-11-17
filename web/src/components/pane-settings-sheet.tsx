import { Icon } from "@/components/icons/icon";

import { ActionRow } from "@/components/action-sheet-rows";
import { Collapse } from "@/components/ui/collapse";
import { Switch } from "@/components/ui/switch";
import { BottomSheet } from "@/components/ui/sheet";
import { SendReceipts } from "@/components/send-receipts";
import { useCacheWatch } from "@/hooks/use-cache-watch";
import { useLocale } from "@/hooks/use-locale";
import { usePushControl } from "@/hooks/use-push";
import { accountName, useAccounts, type AccountRow } from "@/lib/accounts";
import { t, type MessageKey } from "@/lib/i18n";
import { useRememberedAnswer } from "@/lib/remembered-shape";
import type { Scope } from "@/lib/scope";
import type { CacheWatchState } from "@/lib/types";

// One pane's own settings: warn me before this pane's prompt cache goes cold (ADR 0042), and Rename.
// The pane name in the header opens this sheet (1.17.0), so the row that edits the name sits here
// too; it hands over to the ⋮ sheet's own rename view and carries no second flow.
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
  /** Open the rename flow. Absent hides the row: the pane cannot be renamed here (read-only device,
   *  an unreachable machine, a multiplexer with no rename), and the ⋮ sheet hides its own the same way. */
  onRename?: () => void;
  /** The pane's hook source (M56 spec 11), from the snapshot. Absent hides the row: an older bridge. */
  hooks?: "live" | "holds" | "none";
  /** A program's conversation (M56 spec 14): no cache switch, because a program has no prompt cache. The receipts stay. */
  program?: boolean;
  /**
   * Change login (M101): the session's agent, and where a tap goes. Absent hides the row: a crew
   * member's pane (profiles are per machine and a sign-in is not started over the crew link), a
   * read-only device, a program. The row shows only when a row of this machine's Profiles list names
   * this pane in its `panes`: a session in a folder no profile names gets no row, never Default's.
   */
  changeLogin?: { harness: string; onOpen: (accountId: string) => void };
}

export function PaneSettingsSheet({ open, onClose, paneId, scope, onRename, hooks, program = false, changeLogin }: PaneSettingsSheetProps) {
  useLocale();
  const { state: push } = usePushControl();
  const { state, busy, toggle } = useCacheWatch(paneId, open && !program, scope);
  // This machine's own profiles, read only while the sheet is open and the row can show.
  const accounts = useAccounts(undefined, open && changeLogin !== undefined);
  const account =
    paneId === undefined ? undefined : accounts.body?.accounts.find((a) => a.harness === changeLogin?.harness && a.panes?.includes(paneId) === true);
  // CALM LOAD (row 19). The row enters when that read lands, inside a sheet the person already opened. This
  // device remembers whether the machine had the profiles feature (the fact the Settings index keeps for its
  // Profiles row, lib/remembered-shape.ts: the same meaning, the same machine). While the read is in flight and
  // the fact is true, the row's place is held; the read then fills it, or closes it when no profile names this pane.
  const featureSeen = useRememberedAnswer("settings-accounts-row", accounts.status === "ready" ? true : accounts.status === "unavailable" ? false : undefined);
  const changeLoginPending = open && changeLogin !== undefined && accounts.status === "loading" && featureSeen === true;

  // Push first, because it is the only one of the three that is about this DEVICE rather than this pane,
  // and the remedy is on another screen.
  // `null` is "not asked yet", not "off": it disables the switch below with the ordinary hint rather
  // than claiming a refusal nothing has established.
  const pushOff = push !== null && (push.availability !== "ready" || !push.subscribed);

  return (
    <BottomSheet open={open} onClose={onClose} title={t("paneSettings.title")}>
      {!program && (
        <PaneSettingsView
          state={state}
          busy={busy}
          pushOff={pushOff}
          pushKnown={push !== null}
          onToggle={(next) => void toggle(next)}
          onRename={onRename}
          hooks={hooks}
          changeLogin={account === undefined || changeLogin === undefined ? undefined : { account, onOpen: () => changeLogin.onOpen(account.id) }}
          changeLoginPending={changeLoginPending}
        />
      )}
      {/* The last ten sends for this pane, from the bridge's receipts (M56 spec 09). Read when the sheet opens. */}
      {open && <SendReceipts paneId={paneId} {...(scope === undefined ? {} : { scope })} />}
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
  onRename,
  hooks,
  changeLogin,
  changeLoginPending = false,
}: {
  /** Null until the bridge answers. The switch is disabled and the hint is the ordinary one. */
  state: CacheWatchState | null;
  busy: boolean;
  /** Push is not usable on this device. The first of the three reasons, and the only device-level one. */
  pushOff: boolean;
  /** False while the browser has not been asked yet — disables without claiming a refusal. */
  pushKnown?: boolean;
  onToggle: (next: boolean) => void;
  /** The Rename row, above the switch. Absent hides it. */
  onRename?: () => void;
  /** The pane's hook source (M56 spec 11), or `holds` when it holds permissions (M56 spec 12). Absent hides the row. */
  hooks?: "live" | "holds" | "none" | undefined;
  /** The Change login row under Rename: the session's account, named in the row's hint. Absent hides it. */
  changeLogin?: { account: AccountRow; onOpen: () => void } | undefined;
  /** The row's profile read is in flight and this machine had profiles: its place is held, with nothing live in it. */
  changeLoginPending?: boolean;
}) {
  useLocale();
  const globalOn = state?.global === true;
  const unwatchable = state !== null && !state.watchable;
  const hint = hintFor({ pushOff, globalOn, unwatchable, warnSeconds: state?.warnSeconds });

  return (
    <div className="flex flex-col gap-3 pb-4">
      {onRename && (
        <div className="px-1">
          <ActionRow
            icon={<Icon name="edit" className="size-4 shrink-0 text-muted-foreground" />}
            label={t("paneActions.rename.label")}
            onClick={onRename}
          />
        </div>
      )}
      {/* Change login (M101): the account this session runs under, with who is signed in on it. The same
          page as the account's own Change login (routes/settings-change-login.tsx). */}
      <Collapse open={changeLogin !== undefined || changeLoginPending}>
        {changeLogin !== undefined ? (
          <div className="px-1" data-slot="pane-change-login">
            <ActionRow
              icon={<Icon name="sign-in" className="size-4 shrink-0 text-muted-foreground" />}
              label={t("accounts.changeLogin.action")}
              hint={[accountName(changeLogin.account), changeLogin.account.identity?.email].filter((x) => x !== undefined && x !== "").join(" · ")}
              onClick={changeLogin.onOpen}
            />
          </div>
        ) : changeLoginPending ? (
          // The row's own box (ActionRow: `min-h-11`, `px-3 py-2.5`, a 20px label line and a 12px hint line
          // at `leading-snug`), drawn as nothing: no words, no tap, hidden from a reader.
          <div className="px-1" data-slot="pane-change-login-reserved" aria-hidden>
            <div className="flex min-h-11 w-full items-center gap-3 px-3 py-2.5">
              <span className="size-4 shrink-0" />
              <span className="min-w-0">
                <span className="block text-sm">{"\u00a0"}</span>
                <span className="block text-xs leading-snug">{"\u00a0"}</span>
              </span>
            </div>
          </div>
        ) : null}
      </Collapse>
      <div className="flex items-center justify-between gap-4 px-4">
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
      {/* The hook edges (M56 spec 11): live when the agent's own hooks report from this pane, none
          when they do not. Holds (M56 spec 12) when those hooks also hold permissions for a tap here,
          so a permission on a pane without it stays a dialog on the screen. A fact, not a switch. */}
      {hooks !== undefined && (
        <div className="px-4">
          <div className="text-sm font-medium">{t(HOOKS_LABEL[hooks])}</div>
          <p className="text-xs leading-snug text-muted-foreground">{t(HOOKS_HINT[hooks])}</p>
        </div>
      )}
    </div>
  );
}

const HOOKS_LABEL = {
  live: "paneSettings.hooks.live",
  holds: "paneSettings.hooks.holds",
  none: "paneSettings.hooks.none",
} as const satisfies Record<"live" | "holds" | "none", MessageKey>;

const HOOKS_HINT = {
  live: "paneSettings.hooks.liveHint",
  holds: "paneSettings.hooks.holdsHint",
  none: "paneSettings.hooks.noneHint",
} as const satisfies Record<"live" | "holds" | "none", MessageKey>;

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
