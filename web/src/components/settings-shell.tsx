import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router";

import { RouteHeader } from "@/components/app-header";
import { BuildStamp } from "@/components/build-stamp";
import { Icon } from "@/components/icons/icon";
import type { IconKey } from "@/components/icons/keys";
import { InstallRow } from "@/components/install-control";
import { StatusLive } from "@/components/status-area";
import { NAV_EDGE, RECESS_ACCENT } from "@/components/ui/nav-edge";
import { Button, FOCUS_RING, HOVER_FILL } from "@/components/ui/button";
import { useUpdatesStatus } from "@/components/updates-settings-card";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { SettingsSearch } from "@/components/settings-search";
import { STEADY_PAGES, useSettingsRows } from "@/hooks/use-settings-rows";
import { useWidthClass } from "@/hooks/use-width-class";
import { t } from "@/lib/i18n";
import { historyIdx, homePath, pathOnly, readFrom, settingsSectionPath, updatesPath } from "@/lib/nav";
import { markInAppBack } from "@/lib/nav-entry";
import { navTrail, type TrailEntries } from "@/lib/nav-trail";
import { useScope } from "@/lib/session";
import { cn } from "@/lib/utils";
import { oldIndexTarget } from "@/routes/settings-redirect";

// ── SETTINGS ON A LARGE SCREEN (ADR 0158, addendum 2026-11-21) ──────────────────────────────────────────────────
//
// The layout route around every `settings/*` address. On a phone, a tablet and with Large-screen layout Off it draws
// nothing but its `<Outlet/>`, so those trees are what they were. On the large screen (`expanded`) it draws Settings
// as one page: a header that spans the window on the navigation's recess, the section list at the window's left edge
// on the same recess, and the chosen section on the page plane beside it. The list is the pane view's sidebar in the
// same place and the same plane, so Settings reads as the same app.
//
// The section pages are not copied. Each one already draws through `SettingsPage` (and Updates now does too), and that
// one shell reads {@link useSettingsShell}: inside this layout it leaves the header to the layout, draws a plain title
// at the top of its column, and hands its path to the header's crumbs.
//
// The addresses stay: every one means what it meant. A row opens its section as a push, so the browser's Back returns
// to the section before; `/settings` itself becomes the first section that is not an action (Updates while a release
// waits, else Look and feel), replacing itself so Back does not land on a page that only forwards.

export interface SettingsShellApi {
  /** The header's host for the path inside the chosen section (a page one level down or more portals it here). */
  crumbs: HTMLElement | null;
  /** The chosen section's title, the first crumb. */
  section: string | null;
  /** True once after a row of the list opened a section: the section's title takes the focus. */
  takeFocus: () => boolean;
}

const SettingsShellContext = createContext<SettingsShellApi | null>(null);

/** The large-screen Settings around this page, or null on a phone, a tablet and with Large-screen layout Off. */
export function useSettingsShell(): SettingsShellApi | null {
  return useContext(SettingsShellContext);
}

/** The width of the section list, in px: the pane view's sidebar at its narrowest. */
export const SETTINGS_LIST_PX = 280;

/** The section's column: at most 720px of content, with the 24px gutter of the large screen on each side. */
export const SETTINGS_COLUMN = "w-full max-w-[calc(720px+3rem)] px-6";

/** Whether `href` is a Settings address: `/settings` or below it. */
function inSettings(href: string): boolean {
  const path = pathOnly(href);
  return path === "/settings" || path.startsWith("/settings/");
}

/**
 * How far back the entry is that Settings was opened from, and its address: the first entry behind `idx` that is not a
 * Settings address, when every entry between is one (the sections a person walked through). Null when the trail does
 * not reach it (a cold open, an entry the trail lost): the caller then goes up to the Dashboard instead.
 */
export function settingsExitSteps(entries: TrailEntries, idx: number): { steps: number; to: string } | null {
  for (let at = idx - 1; at >= 0; at--) {
    const href = entries.get(at);
    if (href === undefined) return null;
    if (!inSettings(href)) return { steps: idx - at, to: href };
  }
  return null;
}

/** The section a Settings address is in: the word after `/settings/`, or null on `/settings` itself. */
export function settingsSectionOf(pathname: string): string | null {
  return pathname.split("/").filter((part) => part !== "")[1] ?? null;
}

/**
 * The route element of `settings`: only the outlet, except on the large screen. Beside it on both widths the status
 * line for a screen reader (`StatusLive`), because no part of Settings draws the status line (ADR 0168).
 */
export function SettingsLayout() {
  const wide = useWidthClass() === "expanded";
  return (
    <>
      {wide ? <WideSettings /> : <Outlet />}
      <StatusLive />
    </>
  );
}

interface ListRow {
  id: string;
  to: string;
  icon: IconKey;
  title: string;
  /** The phone's second line; here the row's `title`, read on a pointer's rest. */
  caption: string;
  /** A release waits: the row keeps the index's 6px mark. */
  dot?: boolean;
}

/** One row of the list: icon and title, 44px, the selected one on the paper (the sidebar's own selected look). */
const ROW = "flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-sm font-medium transition-colors";

function WideSettings() {
  const { pathname, search, hash, state, key } = useLocation();
  const navigate = useNavigate();
  const nav = useNav();
  const scope = useScope();
  const updates = useUpdatesStatus();
  const { rows, hold } = useSettingsRows();
  useLocale();
  const [crumbs, setCrumbs] = useState<HTMLElement | null>(null);
  const focusNext = useRef(false);
  const takeFocus = useCallback(() => {
    const take = focusNext.current;
    focusNext.current = false;
    return take;
  }, []);

  const section = settingsSectionOf(pathname);
  const list: ListRow[] = [
    { id: "updates", to: updatesPath(scope), icon: "update-available", title: t("settings.page.updates.title"), caption: updates.line, dot: updates.available },
    ...rows,
  ];
  const chosen = list.find((row) => row.id === section) ?? null;
  const api = useMemo<SettingsShellApi>(() => ({ crumbs, section: chosen?.title ?? null, takeFocus }), [crumbs, chosen?.title, takeFocus]);

  // The roving tab stop: one stop for the whole list, on the chosen row until the arrows move it.
  const [stop, setStop] = useState<string | null>(section);
  useEffect(() => setStop(section), [section, key]);
  const listRef = useRef<HTMLElement | null>(null);

  if (section === null) {
    // `/settings` itself: the first section that is not an action, or the page an old fragment names
    // (`/settings#paired-devices`). A replace, carrying where Settings was opened from.
    const from = readFrom(state);
    const to = oldIndexTarget(search, hash) ?? (updates.available ? updatesPath(scope) : settingsSectionPath("look", scope));
    return <Navigate to={to} replace state={from === undefined ? undefined : { from }} />;
  }

  // Back leaves Settings for where it was opened from, as the index's arrow does on a phone: a step back past the
  // sections walked through when the trail holds them, else up to the Dashboard.
  const leave = () => {
    const idx = historyIdx();
    const exit = idx === undefined ? null : settingsExitSteps(navTrail.entries(), idx);
    if (exit === null) {
      nav.up(homePath(scope));
      return;
    }
    markInAppBack(pathOnly(exit.to));
    void navigate(-exit.steps);
  };

  const open = (row: ListRow) => {
    if (pathOnly(row.to) === pathname) return;
    focusNext.current = true;
    nav.down(row.to);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-settings-row]") ?? [])];
    const at = items.findIndex((item) => item === document.activeElement);
    const last = items.length - 1;
    const next =
      event.key === "ArrowDown" ? Math.min(at + 1, last) : event.key === "ArrowUp" ? Math.max(at - 1, 0) : event.key === "Home" ? 0 : event.key === "End" ? last : null;
    if (next === null || at === -1) return;
    event.preventDefault();
    items[next]?.focus();
  };

  const stopId = list.some((row) => row.id === stop) ? stop : (list[0]?.id ?? null);

  return (
    <SettingsShellContext.Provider value={api}>
      <RouteHeader
        width="full"
        span
        override={
          <>
            <Button variant="ghost" size="icon" className="size-11" onClick={leave} aria-label={t("settings.nav.close")} title={t("settings.nav.close")}>
              <Icon name="back" className="size-5" />
            </Button>
            <p data-slot="settings-title" className="shrink-0 text-base font-semibold tracking-tight">
              {t("settings.title")}
            </p>
            {/* The path inside the chosen section, portalled here by a page one level down or more (SettingsPage). */}
            <div ref={setCrumbs} data-slot="settings-crumbs" className="flex min-w-0 flex-1 items-center" />
          </>
        }
      />
      <div data-slot="settings-wide" className="flex min-h-0 flex-1">
        {/* The list, on the navigation's recess like the pane view's sidebar: boxes 8px in, ink 16px in, its own scroll.
            `--accent` is the paper there, so the chosen row and a hovered one stand on the lightest surface. */}
        <aside
          data-slot="settings-list"
          className={cn("flex shrink-0 flex-col overflow-y-auto border-r bg-surface-recess px-2 py-2", RECESS_ACCENT, NAV_EDGE)}
          style={{ width: SETTINGS_LIST_PX }}
        >
          <SettingsSearch compact>
          <>
          <InstallRow className={cn(ROW, "mb-1", HOVER_FILL, FOCUS_RING)} />
          <nav ref={listRef} aria-label={t("settings.title")} className="flex flex-col gap-0.5">
            {hold
              ? ["updates", ...STEADY_PAGES.map((page) => page.id)].map((id) => (
                  <div key={id} aria-hidden="true" data-slot="settings-list-hold" className="h-11" />
                ))
              : list.map((row) => {
                  const here = row.id === section;
                  return (
                    <button
                      key={row.id}
                      type="button"
                      data-settings-row={row.id}
                      tabIndex={row.id === stopId ? 0 : -1}
                      aria-current={here ? "page" : undefined}
                      title={row.caption}
                      onFocus={() => setStop(row.id)}
                      onKeyDown={onKeyDown}
                      onClick={() => open(row)}
                      className={cn(ROW, FOCUS_RING, here ? "bg-accent text-accent-foreground" : HOVER_FILL)}
                    >
                      <Icon name={row.icon} className="size-5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{row.title}</span>
                      {row.dot === true && <span aria-hidden="true" data-slot="update-dot" className="size-1.5 shrink-0 rounded-full bg-primary" />}
                    </button>
                  );
                })}
          </nav>
          </>
          </SettingsSearch>
          {/* "What am I running", as at the foot of the phone's index. */}
          <div className="mt-auto px-2 pt-4">
            <BuildStamp />
          </div>
        </aside>
        {/* The chosen section, on the page plane. Its page draws its own column and scroll (SettingsPage). */}
        <div data-slot="settings-section" className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          <Outlet />
        </div>
      </div>
    </SettingsShellContext.Provider>
  );
}
