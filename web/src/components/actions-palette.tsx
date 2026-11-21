import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useLocation } from "react-router";

import { ActionRow, DestructiveActionRow } from "@/components/action-sheet-rows";
import { PALETTE_HIGHLIGHT, PaneRow, ThreadSidebar } from "@/components/agent-sidebar";
import { useCrew } from "@/components/crew-provider";
import { Icon } from "@/components/icons/icon";
import { SectionHeader } from "@/components/section-header";
import { MatchText } from "@/components/ui/match-text";
import { Modal } from "@/components/ui/modal";
import { SearchField } from "@/components/ui/search-field";
import { useAvailableShortcutActions, useShortcutHandler } from "@/hooks/use-shortcut-handler";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { openForCount, useDashPrefs } from "@/hooks/use-dash-prefs";
import { availableCommands, isDestructive, suggestedCommands, type PaletteCommand } from "@/lib/actions-palette/commands";
import { hitKey, searchPalette, type CommandEntry, type Hit } from "@/lib/actions-palette/rank";
import { closeActionsPalette, openActionsPalette, useActionsPaletteOpen } from "@/lib/actions-palette/state";
import { shortcutTarget } from "@/lib/shortcuts/target";
import type { Range } from "@/lib/fuzzy";
import { paneRowKey, paneScope } from "@/lib/hosts";
import { t } from "@/lib/i18n";
import { useMuxHasSpaces } from "@/lib/mux-capability";
import { crewPath, panePath, spacePath, trickSessionPath } from "@/lib/nav";
import { usePins } from "@/lib/pins";
import { recentLivePanes, useRecentPanes } from "@/lib/recent-panes";
import { useRootData } from "@/lib/route-data";
import type { Scope } from "@/lib/scope";
import { runShortcutAction } from "@/lib/shortcuts/registry";
import type { ActionId } from "@/lib/shortcuts/actions";
import type { AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FOCUS_RING, TRIGGER_OPEN } from "@/components/ui/button";

// THE ACTIONS PALETTE (ADR 0165). One modal at the TOP of the screen, over a dimmed scrim, because the
// soft keyboard owns the bottom half: a search field, then one list. Before anything is typed the list
// is "Recent", the last panes this device opened (lib/recent-panes.ts), then "Suggested", four commands
// for this screen, then "All panes", the Switch pane sheet's own list, so scrolling down lands in the
// switcher. Typed, it is one ranked list of commands, spaces and panes (lib/actions-palette/rank.ts).
//
// A COMMAND IS LISTED ONLY WHERE IT WORKS. The registry answers that (`useAvailableShortcutActions`, the
// same query the mode bar reads), never a list of screens kept here: a command's handler registers where
// its control lives, so it answers exactly while that control is on screen.
//
// RUNNING A ROW closes the palette first, then runs what the row names: a command runs its action's
// handler, the same function its menu row calls; a pane opens the way the Switch pane sheet opens one; a
// space opens its page. A destructive command (Close pane, Close tab) is never the highlighted first row,
// and its handler only opens the menu with its confirm armed, so Enter on it, like a tap, asks first.
//
// Mounted once, at the root (`ActionsPaletteDoor`), so every screen shares it; the doors are the Belt's
// Actions button, the dashboard's and the large screen's header button, and `prefix+g`.

/** Recent shows this many panes. */
const RECENT_COUNT = 4;

/** The key of a row of the All panes list: this prefix and the pane's `paneRowKey`. */
const ALL_PANES_KEY = "a:";
/** The rows of the All panes list, the Switch pane sheet's own `PaneRow`s. */
const ALL_PANE_ROWS = '[data-slot="actions-all-panes"] [data-slot="pane-row"]';
/** Every row the arrows walk, in document order. */
const WALKED = `[data-palette-row], ${ALL_PANE_ROWS}`;

type Row =
  | { readonly key: string; readonly kind: "command"; readonly command: PaletteCommand; readonly marks?: readonly Range[] }
  | { readonly key: string; readonly kind: "space"; readonly workspaceId: string; readonly label: string; readonly marks: readonly Range[] }
  | { readonly key: string; readonly kind: "pane"; readonly pane: AgentView; readonly hit?: Extract<Hit, { kind: "pane" }> };

/** The list before typing (Recent, Suggested) and the ranked list of a typed field. */
interface PaletteLists {
  readonly recent: readonly Row[];
  readonly suggested: readonly Row[];
  readonly typed: readonly Row[];
}

interface ActionsPaletteProps {
  /** The open pane as a row, when a pane is on screen: Recent leaves it out, and its screen suggests the pane commands. */
  openPane: AgentView | undefined;
  onClose: () => void;
}

/** The registry's set, as the predicate the command list takes. */
function useAvailable(): (id: ActionId) => boolean {
  const set = useAvailableShortcutActions();
  return useMemo(() => (id: ActionId) => set.has(id), [set]);
}

export function ActionsPalette({ openPane, onClose }: ActionsPaletteProps) {
  useLocale();
  const data = useRootData();
  const nav = useNav();
  const { pathname } = useLocation();
  const inPane = pathname.startsWith("/pane/");
  const available = useAvailable();
  const recentStore = useRecentPanes();
  const hasSpaces = useMuxHasSpaces();
  const [query, setQuery] = useState("");
  // The row Enter or Go runs, by its key; null until an arrow moves it, which means the list's first row.
  const [highlight, setHighlight] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typed = query.trim() !== "";

  const herd = useMemo(() => [...data.agents, ...data.shellPanes], [data.agents, data.shellPanes]);
  const hereKey = openPane === undefined ? null : paneRowKey(openPane);

  const rows = useMemo((): PaletteLists => {
    const recent = recentLivePanes({ recent: recentStore, panes: herd, hereKey, limit: RECENT_COUNT }).map(
      (pane): Row => ({ key: `p:${paneRowKey(pane)}`, kind: "pane", pane }),
    );
    const suggested = suggestedCommands(inPane ? "pane" : "dashboard", available).map(
      (command): Row => ({ key: `c:${command.id}`, kind: "command", command }),
    );
    if (!typed) return { recent, suggested, typed: [] };
    const commands = availableCommands(available);
    const byId = new Map(commands.map((command) => [command.id, command]));
    const entries: CommandEntry[] = commands.map((command) => ({ id: command.id, label: t(command.labelKey), destructive: isDestructive(command.id) }));
    const spaces = hasSpaces ? data.workspaces.map((space) => ({ key: space.workspaceId, label: space.label })) : [];
    const hits = searchPalette({ query, commands: entries, spaces, panes: herd, servers: data.servers });
    const typedRows = hits.map((hit): Row => {
      if (hit.kind === "command") {
        const command = byId.get(hit.command.id);
        if (command === undefined) throw new Error(`No palette command ${hit.command.id}`);
        return { key: hitKey(hit), kind: "command", command, marks: hit.marks };
      }
      if (hit.kind === "space") return { key: hitKey(hit), kind: "space", workspaceId: hit.space.key, label: hit.space.label, marks: hit.marks };
      return { key: hitKey(hit), kind: "pane", pane: hit.pane, hit };
    });
    return { recent, suggested, typed: typedRows };
  }, [recentStore, herd, hereKey, inPane, available, typed, query, hasSpaces, data.workspaces, data.servers]);

  const flat = typed ? rows.typed : [...rows.recent, ...rows.suggested];
  // The first row is highlighted unless it closes something: ranking puts a safe row first wherever
  // one matches, so this is the list with nothing but Close rows, where Enter waits for an arrow. With
  // no Recent and no Suggested row, the first highlight is the arrow's to give.
  const first = flat[0];
  const current = highlight ?? (first !== undefined && !isDestructiveRow(first) ? first.key : null);
  const paneByKey = useMemo(() => new Map(herd.map((pane) => [paneRowKey(pane), pane])), [herd]);
  const pins = usePins();
  const dash = useDashPrefs();

  function openPaneRow(pane: AgentView): void {
    onClose();
    if (paneRowKey(pane) === hereKey) return;
    const to = panePath(pane.paneId, paneScope(data.scope, pane, data.servers, data.sessions));
    // Pane to pane is sideways, as the Switch pane sheet moves (ADR 0067); from any other screen, down.
    if (inPane) nav.side(to);
    else nav.down(to);
  }

  function openTrick(pane: AgentView): void {
    onClose();
    nav.down(trickSessionPath(pane.paneId), inPane ? { forSession: true } : undefined);
  }

  function run(row: Row): void {
    onClose();
    if (row.kind === "command") {
      runShortcutAction(row.command.id);
      return;
    }
    if (row.kind === "space") {
      const to = spacePath(row.workspaceId, data.scope);
      // From a pane a space is a level up (agent-chat.tsx `openSpace`); from anywhere else a level down.
      if (inPane) nav.upTo(to);
      else nav.down(to);
      return;
    }
    openPaneRow(row.pane);
  }

  /**
   * The rows the arrows walk, in the order they are drawn: Recent and Suggested (or the ranked list),
   * then the All panes list's rows. Read from the list itself at the key press, so the sheet's own list
   * needs no second copy of its order and nothing is measured on open.
   */
  function walkKeys(): string[] {
    const list = listRef.current;
    if (list === null) return [];
    return [...list.querySelectorAll(WALKED)].flatMap((el) => {
      const own = el.getAttribute("data-palette-row");
      if (own !== null) return [own];
      const pane = el.getAttribute("data-pane-key");
      return pane === null ? [] : [`${ALL_PANES_KEY}${pane}`];
    });
  }

  function rowElement(key: string): Element | null {
    const list = listRef.current;
    if (list === null) return null;
    if (key.startsWith(ALL_PANES_KEY)) {
      const paneKey = key.slice(ALL_PANES_KEY.length);
      return [...list.querySelectorAll(ALL_PANE_ROWS)].find((el) => el.getAttribute("data-pane-key") === paneKey) ?? null;
    }
    return [...list.querySelectorAll("[data-palette-row]")].find((el) => el.getAttribute("data-palette-row") === key) ?? null;
  }

  function runKey(key: string): void {
    if (key.startsWith(ALL_PANES_KEY)) {
      const pane = paneByKey.get(key.slice(ALL_PANES_KEY.length));
      if (pane !== undefined) openPaneRow(pane);
      return;
    }
    const row = flat.find((r) => r.key === key);
    if (row !== undefined) run(row);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const keys = walkKeys();
      if (keys.length === 0) return;
      const at = current === null ? -1 : keys.indexOf(current);
      const nextAt = at < 0 ? 0 : event.key === "ArrowDown" ? Math.min(at + 1, keys.length - 1) : Math.max(at - 1, 0);
      const next = keys[nextAt];
      if (next === undefined) return;
      setHighlight(next);
      rowElement(next)?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (current !== null) runKey(current);
  }

  function changeQuery(next: string): void {
    setQuery(next);
    setHighlight(null);
    listRef.current?.scrollTo({ top: 0 });
  }

  const rowAt = (row: Row): ReactNode => (
    <PaletteRow key={row.key} row={row} highlighted={row.key === current} here={hereKey} onRun={run} />
  );
  const highlightedPane = current?.startsWith(ALL_PANES_KEY) ? current.slice(ALL_PANES_KEY.length) : null;
  // The shell (scrim, panel, focus, Escape, the room above the keyboard) is the shared modal's, at the top
  // (ui/modal.tsx, ADR 0167). The panel's room: from its top down to a small margin, above the keyboard.
  // On a large screen at most 70% of the window. The field takes the focus on open, inside the tap that
  // opened it, so the soft keyboard comes up.
  return (
    <Modal
      placement="top"
      onClose={onClose}
      label={t("actions.title")}
      initialFocus={inputRef}
      slot="actions-palette"
      scrimSlot="actions-palette-scrim"
      className="max-h-[calc(min(var(--app-h),var(--modal-room))-1.5rem-env(safe-area-inset-top))] w-full max-w-[560px] lg:max-h-[min(70dvh,calc(var(--modal-room)-1.5rem-env(safe-area-inset-top)))]"
    >
      <div className="shrink-0 p-2">
        <SearchField
          ref={inputRef}
          value={query}
          onChange={changeQuery}
          placeholder={t("actions.search.placeholder")}
          label={t("actions.search.placeholder")}
          enterKeyHint="go"
          onKeyDown={onKeyDown}
          trailing={
            <button
              type="button"
              aria-label={typed ? t("actions.search.clear") : t("common.closeAria")}
              onClick={() => {
                if (!typed) return onClose();
                changeQuery("");
                inputRef.current?.focus({ preventScroll: true });
              }}
              className="absolute right-0 top-0 flex size-11 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            >
              <Icon name="clear" className="size-4" aria-hidden />
            </button>
          }
        />
      </div>
      <div
        ref={listRef}
        data-slot="actions-palette-list"
        // The list scrolls inside itself. Its lower edge fades over the bottom padding, so a row cut by
        // the edge reads as "more below", and the last row scrolls clear of the fade.
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-rule pb-6 [mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)]"
      >
        {typed ? (
          rows.typed.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t("actions.empty", { query: query.trim() })}</p>
          ) : (
            <div className="flex flex-col gap-0.5 p-1">{rows.typed.map(rowAt)}</div>
          )
        ) : (
          <div className="flex flex-col gap-2 p-1">
            {rows.recent.length > 0 && <Block label={t("actions.recent")}>{rows.recent.map(rowAt)}</Block>}
            {rows.suggested.length > 0 && <Block label={t("actions.suggested")}>{rows.suggested.map(rowAt)}</Block>}
            {/* ALL PANES: the Switch pane sheet's own list (agent-sidebar.tsx), with the props that sheet
                gives it, so scrolling down lands in the switcher a person knows. Its own filter field
                is off: the palette's field is the search. No order toggle and no Launch rows. */}
            <Block label={t("actions.allPanes")} slot="actions-all-panes">
              <ThreadSidebar
                agents={data.agents}
                shellPanes={data.shellPanes}
                currentPaneKey={hereKey ?? ""}
                onSelect={openPaneRow}
                trickSessions={data.trickSessions}
                onSelectTrick={openTrick}
                tabs={data.tabs}
                servers={data.servers}
                workspaces={data.workspaces}
                scope={data.scope}
                sessions={data.sessions}
                pins={pins}
                shellsOpen={openForCount(dash.prefs.shellsOpen, data.shellPanes.length)}
                onShellsOpenChange={dash.setShellsOpen}
                order={dash.prefs.paneOrder}
                className="px-0 py-1"
                filter={false}
                highlightedKey={highlightedPane}
              />
            </Block>
          </div>
        )}
      </div>
    </Modal>
  );
}

function isDestructiveRow(row: Row): boolean {
  return row.kind === "command" && isDestructive(row.command.id);
}

function Block({ label, slot, children }: { label: string; slot?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-0.5" data-slot={slot}>
      <SectionHeader level={3} label={label} className="px-2" />
      {children}
    </section>
  );
}

/** A label with its matched letters marked, and the muted kind on the right. */
function RowLabel({ text, marks, kind, destructive = false }: { text: string; marks?: readonly Range[] | undefined; kind?: string; destructive?: boolean }) {
  return (
    <>
      <span className="min-w-0 flex-1 truncate">
        <MatchText text={text} ranges={marks} />
      </span>
      {kind !== undefined && (
        <span className={cn("shrink-0 text-xs font-normal", destructive ? "text-destructive/70" : "text-muted-foreground")}>{kind}</span>
      )}
    </>
  );
}

const ROW_ICON = "size-4 shrink-0";
/**
 * The house ring on the row a wrapper holds (an ActionRow, which the pane menu's sheet draws with the browser's own
 * ring). Outside the row, so it clears the keyboard highlight's inset ring (PALETTE_HIGHLIGHT): drawn on the same
 * pixels the two marks read as one, 1:1 (themes R5, 2026-11-21). The list's 4px inset holds it inside the scroller.
 */
const PALETTE_ROW_RING = "*:focus-visible:outline-2 *:focus-visible:outline-offset-2 *:focus-visible:outline-ring";

function PaletteRow({
  row,
  highlighted,
  here,
  onRun,
}: {
  row: Row;
  highlighted: boolean;
  here: string | null;
  onRun: (row: Row) => void;
}) {
  let body: ReactNode;
  if (row.kind === "pane") {
    body = <PaneRow pane={row.pane} active={paneRowKey(row.pane) === here} onSelect={() => onRun(row)} roomy={false} match={row.hit?.match} />;
  } else if (row.kind === "space") {
    body = (
      <ActionRow
        icon={<Icon name="new-space" className={cn(ROW_ICON, "text-muted-foreground")} aria-hidden />}
        label={<RowLabel text={row.label} marks={row.marks} kind={t("actions.kind.space")} />}
        onClick={() => onRun(row)}
      />
    );
  } else if (isDestructive(row.command.id)) {
    // Drawn as the menu draws a close, red from the first render; the tap runs the action, whose
    // handler opens that menu with its confirm armed. The palette never arms a row of its own.
    body = (
      <DestructiveActionRow
        icon={<Icon name={row.command.icon} className={ROW_ICON} aria-hidden />}
        label={<RowLabel text={t(row.command.labelKey)} marks={row.marks} kind={t("actions.kind.command")} destructive />}
        confirmLabel=""
        closingLabel=""
        armed={false}
        closing={false}
        onClick={() => onRun(row)}
      />
    );
  } else {
    body = (
      <ActionRow
        icon={<Icon name={row.command.icon} className={cn(ROW_ICON, "text-muted-foreground")} aria-hidden />}
        label={<RowLabel text={t(row.command.labelKey)} marks={row.marks} kind={t("actions.kind.command")} />}
        onClick={() => onRun(row)}
      />
    );
  }
  return (
    // The row Enter or Go runs: a filled ground, no accent edge.
    <div data-palette-row={row.key} data-highlighted={highlighted ? "true" : undefined} className={cn("rounded-lg", PALETTE_ROW_RING, highlighted && PALETTE_HIGHLIGHT)}>
      {body}
    </div>
  );
}

/**
 * The palette's one mount, at the root, and the two actions that need nothing but the root: opening it
 * (`open_actions`, on every screen) and Crew (`open_crew`, while a crew is configured, as its door in
 * Settings and on the dashboard is).
 */
export function ActionsPaletteDoor({ scope, openPane }: { scope: Scope; openPane: AgentView | undefined }) {
  const open = useActionsPaletteOpen();
  const nav = useNav();
  const { pathname } = useLocation();
  const { multi } = useCrew();
  useShortcutHandler("open_actions", openActionsPalette);
  useShortcutHandler("open_crew", multi && !pathname.startsWith("/crew") ? () => nav.down(crewPath(scope)) : undefined);
  // A route change closes it: a person who moved by the back gesture is not still choosing.
  const shownAt = useRef(pathname);
  useLayoutEffect(() => {
    if (shownAt.current === pathname) return;
    shownAt.current = pathname;
    closeActionsPalette();
  }, [pathname]);
  if (!open) return null;
  return <ActionsPalette openPane={openPane} onClose={closeActionsPalette} />;
}

/** The header's Actions button: the dashboard's right cluster and the large screen's space header. */
export function ActionsButton({ className }: { className?: string }) {
  useLocale();
  const open = useActionsPaletteOpen();
  return (
    <button
      type="button"
      onClick={openActionsPalette}
      aria-label={t("actions.open.aria")}
      aria-haspopup="dialog"
      // While the palette is open the button wears the shared open look (ui/button.tsx `TRIGGER_OPEN`).
      aria-expanded={open}
      data-slot="actions-button"
      {...shortcutTarget("open_actions")}
      // A real 44px box, as the Settings gear beside it (app-header.tsx `SettingsGear`). `rounded-md` gives the open fill the house corner.
      className={cn("grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground", FOCUS_RING, TRIGGER_OPEN, className)}
    >
      <Icon name="open-actions" className="size-5" />
    </button>
  );
}
