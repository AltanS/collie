import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useLocation } from "react-router";

import { ActionRow, DestructiveActionRow } from "@/components/action-sheet-rows";
import { PaneRow } from "@/components/agent-sidebar";
import { useCrew } from "@/components/crew-provider";
import { Icon } from "@/components/icons/icon";
import { SectionHeader } from "@/components/section-header";
import { MatchText } from "@/components/ui/match-text";
import { SearchField } from "@/components/ui/search-field";
import { useAvailableShortcutActions, useShortcutHandler } from "@/hooks/use-shortcut-handler";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { availableCommands, isDestructive, suggestedCommands, type PaletteCommand } from "@/lib/actions-palette/commands";
import { hitKey, searchPalette, type CommandEntry, type Hit } from "@/lib/actions-palette/rank";
import { closeActionsPalette, openActionsPalette, useActionsPaletteOpen } from "@/lib/actions-palette/state";
import type { Range } from "@/lib/fuzzy";
import { paneRowKey, paneScope } from "@/lib/hosts";
import { t } from "@/lib/i18n";
import { useMuxHasSpaces } from "@/lib/mux-capability";
import { crewPath, panePath, spacePath } from "@/lib/nav";
import { recentLivePanes, useRecentPanes } from "@/lib/recent-panes";
import { useRootData } from "@/lib/route-data";
import type { Scope } from "@/lib/scope";
import { runShortcutAction } from "@/lib/shortcuts/registry";
import type { ActionId } from "@/lib/shortcuts/actions";
import type { AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";

// THE ACTIONS PALETTE (ADR 0165). One modal at the TOP of the screen, over a dimmed scrim, because the
// soft keyboard owns the bottom half: a search field, then one list. Before anything is typed the list
// is "Recent", the last panes this device opened (lib/recent-panes.ts), then "Suggested", four commands
// for this screen. Typed, it is one ranked list of commands, spaces and panes (lib/actions-palette/rank.ts).
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
  // The row Enter or Go runs; null until an arrow moves it, which means the list's first row.
  const [highlight, setHighlight] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typed = query.trim() !== "";

  // Focus on open, inside the tap that opened it, so the soft keyboard comes up; give the focus back on close.
  useLayoutEffect(() => {
    // SAFETY: `activeElement` is `Element | null`; only its optional `focus` is called on the way out.
    const before = document.activeElement as HTMLElement | null;
    inputRef.current?.focus({ preventScroll: true });
    return () => before?.focus?.({ preventScroll: true });
  }, []);

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
  // one matches, so this is the list with nothing but Close rows, where Enter waits for an arrow.
  const at = highlight === null ? (flat[0] !== undefined && !isDestructiveRow(flat[0]) ? 0 : -1) : Math.min(highlight, flat.length - 1);

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
    if (paneRowKey(row.pane) === hereKey) return;
    const to = panePath(row.pane.paneId, paneScope(data.scope, row.pane, data.servers, data.sessions));
    // Pane to pane is sideways, as the Switch pane sheet moves (ADR 0067); from any other screen, down.
    if (inPane) nav.side(to);
    else nav.down(to);
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
      if (flat.length === 0) return;
      const next = event.key === "ArrowDown" ? Math.min(at + 1, flat.length - 1) : Math.max(at - 1, 0);
      setHighlight(next);
      listRef.current?.querySelector(`[data-row-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const row = flat[at];
    if (row !== undefined) run(row);
  }

  function changeQuery(next: string): void {
    setQuery(next);
    setHighlight(null);
    listRef.current?.scrollTo({ top: 0 });
  }

  let index = 0;
  const rowAt = (row: Row): ReactNode => {
    const i = index;
    index += 1;
    return <PaletteRow key={row.key} row={row} index={i} highlighted={i === at} here={hereKey} onRun={run} />;
  };

  return (
    <div className="fixed inset-x-0 top-0 z-50 flex h-(--app-h) flex-col items-center px-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
      {/* The scrim: a tap that went down AND up on it closes, so the release of the tap that opened
          the palette never closes it again (ui/sheet.tsx, the backdrop's rule). */}
      <Scrim onClose={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("actions.title")}
        data-slot="actions-palette"
        // Rounded with the house radius, a uniform border and a soft shadow; no accent edge (DESIGN.md).
        className="relative z-10 flex w-full max-w-[560px] flex-col overflow-hidden rounded-md border border-border bg-card shadow-2xl duration-150 animate-in fade-in slide-in-from-top-2"
      >
        <div className="p-2">
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
          className="max-h-[min(26rem,calc(var(--app-h)*0.5))] overflow-y-auto overscroll-contain border-t border-rule pb-6 [mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)]"
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function isDestructiveRow(row: Row): boolean {
  return row.kind === "command" && isDestructive(row.command.id);
}

function Scrim({ onClose }: { onClose: () => void }) {
  const armed = useRef(false);
  return (
    <button
      type="button"
      aria-hidden="true"
      tabIndex={-1}
      data-slot="actions-palette-scrim"
      className="absolute inset-0 bg-black/50 duration-150 animate-in fade-in"
      onPointerDown={() => {
        armed.current = true;
      }}
      onClick={() => {
        if (!armed.current) return;
        armed.current = false;
        onClose();
      }}
    />
  );
}

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-0.5">
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

function PaletteRow({
  row,
  index,
  highlighted,
  here,
  onRun,
}: {
  row: Row;
  index: number;
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
    <div data-row-index={index} data-highlighted={highlighted ? "true" : undefined} className={cn("rounded-lg", highlighted && "bg-accent")}>
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
  return (
    <button
      type="button"
      onClick={openActionsPalette}
      aria-label={t("actions.open.aria")}
      aria-haspopup="dialog"
      data-slot="actions-button"
      // A real 44px box, as the Settings gear beside it (app-header.tsx `SettingsGear`).
      className={cn("grid size-11 shrink-0 place-items-center text-muted-foreground transition-colors hover:text-foreground", className)}
    >
      <Icon name="open-actions" className="size-5" />
    </button>
  );
}
