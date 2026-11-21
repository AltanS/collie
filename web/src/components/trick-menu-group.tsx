import { useEffect, useRef, useState, type ReactNode } from "react";

import { Icon } from "@/components/icons/icon";
import { ListGroup } from "@/components/ui/list-group";
import { OneOf } from "@/components/ui/one-of";
import { SectionLabel } from "@/components/ui/section-label";
import { Switch } from "@/components/ui/switch";
import { SwitchRow } from "@/components/ui/switch-row";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { SETTLE_MS, useSettled } from "@/hooks/use-settled";
import { useLocale } from "@/hooks/use-locale";
import { t, tn } from "@/lib/i18n";
import { useBridgeNow } from "@/lib/tricks/clock";
import { isPastWindow } from "@/lib/tricks/frame";
import { trickIconOf } from "@/lib/tricks/icons";
import { capGroups, isAgentPane, menuRowsOf, partsInSession, sessionKeyOf, type MenuPane } from "@/lib/tricks/menu";
import { menuMessageLine } from "@/lib/tricks/menu-message";
import { MENU_SHEET_ROWS_MAX, partKey, type MenuRow, type WireTrickInfo, type WireTrickPart } from "@/lib/tricks/schema";
import { placeOfAt, tapRefusalLine, tricksStore, useTricksState, type TapState, type TricksState, type TricksStore } from "@/lib/tricks/store";
import { trickTimeText } from "@/lib/tricks/time";
import { cn } from "@/lib/utils";

// A TRICK'S ROWS IN A SESSION'S SETTINGS (the `menu` place, contract 2), after Collie's own rows and
// Close in the session actions sheet (pane-actions-sheet.tsx). One group per trick, under Collie's words
// "From the trick <name>", in a frame of its own, so a trick's row never reads as one of Collie's. A trick
// that offers an agent view has its view switch in its group too: the switch is Collie's own row
// (`SwitchRow`), and it moved here out of Collie's rows so the trick's name is never a Collie row's label.
//
// THE ROW SET IS FROZEN WHEN THE SHEET OPENS: the groups, their order and each group's rows are read once
// at the open. A row a new document adds waits for the next open; a row it removes stays in place, inert.
// A row's words and state follow the last document, and any change to a row starts the settle window
// again (hooks/use-settled.ts, 500 ms, the agent view's own), so a label that changes under the finger
// takes no tap. Agent sessions only, never a shell pane.
//
// THE FREEZE IS FOR LABELS, ORDER AND PRESENCE, NOT FOR A SWITCH'S STATE. The view switch's words are the
// open's; its `on` is read from the live `views.rows` on every draw, so after the bridge answers the
// person's tap it shows what the bridge says. (It once drew the frozen row's `on`, so it fell back to the
// state at the open and the person tapped again.) A trick's own switch reads its row from the last document.
//
// A SWITCH NEVER FLIPS BEFORE THE PROGRAM ANSWERS (`TrickMenuRowView`, not `SwitchRow`): it draws the
// `on` of the last document; while a tap waits it stays where it was, inert, with Collie's spinner beside
// it; the receipt's parts redraw it. A `confirm` button arms on the first tap with Collie's own words and
// the whole label, and runs on the second. Each group reserves one footer line (a wait, no answer, a
// refusal, a part past its window, the trick switched off), so nothing in the sheet moves.
//
// THE CAP: at most MENU_SHEET_ROWS_MAX trick rows in one sheet. A group is shown whole or left out whole,
// in the order of the trick ids, and one line says how many tricks it left out.

/** An agent view switch of the session (the `agentViews` rows of pane-actions-sheet.tsx). */
export interface TrickMenuViewRow {
  readonly trick: string;
  readonly label: string;
  readonly on: boolean;
}

export interface TrickMenuGroupsProps {
  /** The sheet is open: the rows freeze when this turns true, and again for another pane. */
  open: boolean;
  pane: (MenuPane & { readonly paneId: string }) | null;
  /** This device may write: the trick rows are drawn. A read-only device and a saved copy draw none. */
  canWrite: boolean;
  /** The session's agent view switches, one per trick that offers a view. Drawn only with `onSwitch`. */
  views?: { readonly rows: readonly TrickMenuViewRow[]; readonly onSwitch?: (trick: string, on: boolean) => Promise<string | null> };
  store?: TricksStore;
  /** Pin the clock (epoch ms on the bridge's clock), for a test or the playground. */
  now?: number;
  /** The settle window in ms, for a test. Absent: {@link SETTLE_MS}. */
  settleMs?: number;
}

/** One trick's group as frozen at the open. */
interface FrozenGroup {
  readonly key: string;
  readonly host: string;
  readonly trick: string;
  /** The trick's name at the open, when the list no longer names it. */
  readonly name: string;
  /** The menu part the rows come from; undefined for a group that holds only a view switch. */
  readonly partKey?: string;
  readonly rows: readonly MenuRow[];
  readonly view?: TrickMenuViewRow;
  readonly keeps?: boolean;
  /** The trick's own rows it draws, its view switch not among them, for the cap. */
  readonly size: number;
}

interface Frozen {
  readonly at: string;
  readonly groups: readonly FrozenGroup[];
  readonly leftOut: number;
}

const ROW_ICON = "size-4 shrink-0 text-muted-foreground";
const NO_VIEWS: readonly TrickMenuViewRow[] = [];

function trickOf(state: TricksState, host: string, id: string): WireTrickInfo | undefined {
  return state.tricks.find((trick) => trick.host === host && trick.id === id);
}

/** The groups of a pane at the open: its menu parts as the session shows them, and its view switches. */
function freeze(state: TricksState, pane: TrickMenuGroupsProps["pane"], canWrite: boolean, views: TrickMenuGroupsProps["views"]): FrozenGroup[] {
  if (pane === null || !isAgentPane(pane)) return [];
  const groups = new Map<string, FrozenGroup>();
  if (canWrite) {
    const on = new Set(state.tricks.filter((trick) => trick.on).map((trick) => `${trick.host}/${trick.id}`));
    const menus = [...state.parts.values()].filter((part) => placeOfAt(part.value.at) === "menu" && on.has(`${part.host}/${part.trick}`));
    for (const part of partsInSession(menus, pane, { ownOnly: true })) {
      if (part.value.at !== "menu") continue;
      const rows = menuRowsOf(part.value);
      if (rows.length === 0) continue;
      const key = `${part.host}/${part.trick}`;
      groups.set(key, { key, host: part.host, trick: part.trick, name: trickOf(state, part.host, part.trick)?.name ?? part.trick, partKey: partKey(part), rows, size: rows.length });
    }
  }
  if (views?.onSwitch !== undefined) {
    for (const row of views.rows) {
      const found = [...groups.values()].find((group) => group.trick === row.trick);
      if (found !== undefined) {
        groups.set(found.key, { ...found, view: row, keeps: true });
        continue;
      }
      const info = state.tricks.find((trick) => trick.id === row.trick);
      const key = `${info?.host ?? ""}/${row.trick}`;
      groups.set(key, { key, host: info?.host ?? "", trick: row.trick, name: info?.name ?? row.label, rows: [], view: row, keeps: true, size: 0 });
    }
  }
  return [...groups.values()];
}

/** The groups the sheet shows, frozen at the open, and how many it leaves out. */
function useFrozen(props: TrickMenuGroupsProps, state: TricksState): Frozen {
  const at = props.open && props.pane !== null ? `${props.pane.host ?? ""}:${props.pane.paneId}:${props.pane.instance ?? ""}` : "";
  const [frozen, setFrozen] = useState<Frozen>({ at: "", groups: [], leftOut: 0 });
  if (frozen.at !== at) {
    const all = at === "" ? [] : freeze(state, props.pane, props.canWrite, props.views);
    const capped = capGroups(all, MENU_SHEET_ROWS_MAX);
    // A group over the cap with a view switch shows the switch alone: no rows, so no footer either.
    const shown = capped.shown.map((group): FrozenGroup => (capped.switchOnly.has(group.key) ? { key: group.key, host: group.host, trick: group.trick, name: group.name, rows: [], view: group.view, keeps: true, size: 0 } : group));
    const next: Frozen = { at, groups: shown, leftOut: capped.leftOut };
    setFrozen(next);
    return next;
  }
  return frozen;
}

/** The words of a group's footer line, or null for a line that stands empty. */
function footerWords(opts: { name: string; off: boolean; tap: TapState | undefined; part: WireTrickPart | undefined; now: number }): string | null {
  const { name, off, tap, part, now } = opts;
  if (off) return t("tricks.menu.off", { name });
  if (tap?.phase === "busy") return t("tricks.menu.waiting", { name });
  if (tap?.phase === "unknown") return t("tricks.menu.noAnswer", { name });
  if (tap?.phase === "failed") {
    const line = tap.refused !== undefined ? tapRefusalLine(tap.refused) : (menuMessageLine(tap.message) ?? t("tricks.frame.tapFailed"));
    return t("tricks.menu.message", { name, message: line });
  }
  if (part !== undefined && part.asOf !== undefined && (part.stale === true || isPastWindow(part, now))) {
    const ms = Date.parse(part.asOf);
    const age = trickTimeText(part.asOf, Number.isFinite(ms) && now - ms >= 86_400_000 ? "date" : "clock", now);
    if (age !== null) return t("tricks.menu.asOf", { age });
  }
  return null;
}

/**
 * One row of a trick's group: a button or a switch, drawn from the last document, never ahead of it.
 * `inert`: it takes no tap (the trick is off, the row is gone, a tap waits, the part is past its window
 * for a switch). `onTap` runs only once the row stood still for the settle window.
 */
function TrickMenuRowView({
  row,
  trickIcon,
  inert,
  busy,
  armed,
  settleMs,
  onTap,
}: {
  row: MenuRow;
  trickIcon: string | undefined;
  inert: boolean;
  busy: boolean;
  armed: boolean;
  settleMs: number;
  onTap: () => void;
}) {
  const settled = useSettled(JSON.stringify(row), settleMs);
  const Glyph = trickIconOf(row.icon ?? trickIcon);
  const disabled = inert || row.disabled === true;
  const tap = (): void => {
    if (disabled || !settled()) return;
    onTap();
  };
  const icon = busy ? <Icon name="busy" aria-hidden data-slot="trick-menu-busy" className={cn(ROW_ICON, "animate-spin")} /> : <Glyph aria-hidden className={ROW_ICON} />;
  if (row.kind === "switch") {
    return (
      <div data-slot="trick-menu-row" data-row={row.id} className="flex min-h-11 w-full items-center gap-3 px-3 py-2.5 text-sm font-medium">
        {icon}
        <span id={`trick-menu-${row.id}`} className="min-w-0 flex-1">
          {row.label}
        </span>
        {/* The document's state, never the asked one: `onCheckedChange` sends the tap and changes nothing here. */}
        <Switch checked={row.on === true} disabled={disabled} aria-labelledby={`trick-menu-${row.id}`} onCheckedChange={tap} />
      </div>
    );
  }
  return (
    <button
      type="button"
      data-slot="trick-menu-row"
      data-row={row.id}
      data-armed={armed ? "" : undefined}
      disabled={disabled}
      onClick={tap}
      className="flex min-h-11 w-full items-center gap-3 px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-accent active:bg-muted disabled:opacity-60 disabled:hover:bg-transparent"
    >
      {icon}
      {/* The armed words and the label share one box, so arming moves nothing (DESIGN.md section 2). */}
      <OneOf
        className="grid min-w-0 flex-1"
        active={armed ? "armed" : "label"}
        options={[
          { key: "label", node: <span className="block">{row.label}</span> },
          { key: "armed", node: <span className="block">{t("tricks.menu.armed", { label: row.label })}</span> },
        ]}
      />
    </button>
  );
}

function TrickMenuGroup({
  group,
  state,
  store,
  pane,
  now,
  settleMs,
  onSwitch,
  liveViews,
}: {
  group: FrozenGroup;
  state: TricksState;
  store: TricksStore;
  pane: NonNullable<TrickMenuGroupsProps["pane"]>;
  now: number;
  settleMs: number;
  onSwitch?: (trick: string, on: boolean) => Promise<string | null>;
  /** The session's agent view switches as they stand now: the state of the view switch comes from here. */
  liveViews: readonly TrickMenuViewRow[];
}) {
  const { pending, confirm, reset } = usePendingConfirm();
  // Review 12 N4: what the first tap of a confirm saw, so the second tap confirms that and nothing else.
  const armedAt = useRef<{ readonly id: string; readonly rev: number; readonly look: string } | null>(null);
  const part = group.partKey === undefined ? undefined : state.parts.get(group.partKey);
  const trick = trickOf(state, group.host, group.trick);
  const name = trick?.name ?? group.name;
  const tap = group.partKey === undefined ? undefined : state.taps.get(group.partKey);
  const menu = part !== undefined && part.value.at === "menu" ? menuRowsOf(part.value) : undefined;
  const off = group.partKey !== undefined && (trick === undefined || !trick.on);
  const busy = tap?.phase === "busy";
  const stale = part !== undefined && (part.stale === true || isPastWindow(part, now));
  const footer = group.partKey === undefined ? null : footerWords({ name, off, tap, part, now });
  // The armed row as drawn now; any change of it (its words, its intent, gone) disarms.
  const armedRow = pending === null ? undefined : menu?.find((row) => row.id === pending);
  const armedLook = armedRow === undefined ? null : JSON.stringify(armedRow);
  useEffect(() => {
    if (pending === null) {
      armedAt.current = null;
      return;
    }
    if (armedAt.current?.id === pending && armedAt.current.look !== armedLook) reset();
  }, [pending, armedLook, reset]);
  const send = (row: MenuRow): void => {
    if (part === undefined) return;
    let rev = part.rev;
    if (row.kind === "button" && row.confirm === true) {
      if (!confirm(row.id)) {
        armedAt.current = { id: row.id, rev: part.rev, look: JSON.stringify(row) };
        return;
      }
      // The second tap sends the rev the first one saw: the bridge refuses it when the part moved since.
      rev = armedAt.current?.id === row.id ? armedAt.current.rev : part.rev;
      armedAt.current = null;
    }
    const input = { host: part.host, trick: part.trick, part: part.part, intent: row.intent, control: row.id, rev };
    const value = row.kind === "switch" ? (row.on === true ? "off" : "on") : undefined;
    void store.tap(value === undefined ? input : { ...input, value }, { from: { session: sessionKeyOf(pane, part.host) } });
  };
  const rows: ReactNode[] = [];
  if (group.view !== undefined && onSwitch !== undefined) {
    const view = group.view;
    // The label is frozen at the open, the state is not: it settles to the bridge's answer while the sheet stays open.
    const checked = liveViews.find((row) => row.trick === view.trick)?.on ?? view.on;
    rows.push(<SwitchRow key="agent-view" icon={<Icon name="view-preview" className={ROW_ICON} />} label={view.label} hint={t("view.switch.hint")} checked={checked} onChange={(next) => onSwitch(view.trick, next)} />);
  }
  for (const frozen of group.rows) {
    const live = menu?.find((row) => row.id === frozen.id && row.kind === frozen.kind);
    const row = live ?? frozen;
    const inert = off || live === undefined || busy || (row.kind === "switch" && stale);
    rows.push(<TrickMenuRowView key={frozen.id} row={row} trickIcon={trick?.icon} inert={inert} busy={busy && tap.control === row.id} armed={pending === row.id && !inert} settleMs={settleMs} onTap={() => send(row)} />);
  }
  return (
    <section data-slot="trick-menu-group" data-trick={group.trick} aria-label={t("tricks.menu.heading", { name })} className="flex flex-col gap-1">
      <SectionLabel caps={false} className="px-3 text-xs text-muted-foreground">
        {t("tricks.menu.heading", { name })}
      </SectionLabel>
      <ListGroup>{rows}</ListGroup>
      {group.partKey !== undefined && (
        // One line, always there: a wait, no answer or a refusal repaints it and moves nothing.
        <p data-slot="trick-menu-footer" aria-live="polite" className="h-4 truncate px-3 text-xs leading-4 text-muted-foreground">
          {footer ?? ""}
        </p>
      )}
    </section>
  );
}

/** Every trick's group of one session's settings, frozen at the open, under the cap. */
export function TrickMenuGroups(props: TrickMenuGroupsProps) {
  useLocale();
  const store = props.store ?? tricksStore;
  const state = useTricksState(store);
  const now = useBridgeNow(props.now);
  const frozen = useFrozen(props, state);
  const pane = props.pane;
  if (pane === null || (frozen.groups.length === 0 && frozen.leftOut === 0)) return null;
  return (
    <div data-slot="trick-menu" className="mt-3 flex flex-col gap-3">
      {frozen.groups.map((group) => (
        <TrickMenuGroup key={group.key} group={group} state={state} store={store} pane={pane} now={now} settleMs={props.settleMs ?? SETTLE_MS} onSwitch={props.views?.onSwitch} liveViews={props.views?.rows ?? NO_VIEWS} />
      ))}
      {frozen.leftOut > 0 && (
        <p data-slot="trick-menu-more" className="px-3 text-xs text-muted-foreground">
          {tn("tricks.menu.moreSee", frozen.leftOut, { count: frozen.leftOut })}
        </p>
      )}
    </div>
  );
}
