// The design reference: every final state of Collie's UI, one entry per state, found by typing. Each
// state is mounted without having to provoke the condition that produces it. DEV-ONLY, see
// `web/design.html` (the old address `web/playground.html` opens the same page). The folder keeps its
// old name, `playground/`, because the website imports `@/playground/harness` and
// `@/playground/fixtures` by name.
//
// THE RULE THIS PAGE KEEPS: it mounts the REAL components with their REAL props, and where a state
// is derived from a module store instead of a prop it drives that store through the store's own
// exported mutators. Nothing here is a copy of a component, and no component was given a prop it
// does not already have. Where that was not possible the card says so in its own words.
//
// IT HOLDS ONLY FINAL STATES: what the product ships, or what the operator approved. A round where he
// picks between options is a one-pager of its own (`web/pick.html`, `src/pick/`), never an entry here.
// After the pick, the chosen state becomes an entry here and the one-pager is deleted.
//
// THE OTHER RULE: a card's label is a number and at most five words. Explanation goes in the report
// to Altan, not on the page. `reach` and `note` are optional and hidden by default (the Notes switch).
//
// THE PAGE IS SPLIT INTO PAGES, and this file owns only the chrome and the registry. Each entry is
// its own page with its own address (`#changes`), and its code is loaded only when it is opened.
// An entry's groups are sub-pages of it (`#changes:one-file`, the bar `Section` draws). See
// `useSelectedSection` in layout.tsx for the routes, and find.ts for the search (`?q=`). Every
// entry's cards live in its own file under `sections/`. A helper used by exactly one entry lives
// beside it there; a helper two entries share lives in `sections/shared.tsx`.

import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode } from "react";

import { Icon } from "@/components/icons/icon";
import { SearchField } from "@/components/ui/search-field";
import { useTheme, type Theme } from "@/hooks/use-theme";
import { loadOperatorCommands } from "@/lib/operator-config";
import { cn } from "@/lib/utils";
import { findEntries, readQuery, writeQuery, type Findable } from "./find";
import { CLOCK_OPTIONS, Segmented, SubPageContext, useConnectionClock, useSelectedSection, type ClockMode, type SectionDef } from "./layout";
import {
  ACCENT_IDS,
  ACCENTS,
  FACE_OPTIONS,
  prefStyle,
  setAccent,
  setFace,
  setNotes,
  useAccent,
  useFace,
  useNotes,
  type FaceId,
} from "./prefs";

/** What a section page gets handed — the page-level knobs a section needs. Today only the shared
 *  connection clock (`BootSection`'s `clock` prop); a section that needs nothing reads nothing off it. */
export interface SectionRenderCtx {
  readonly clock: ClockMode;
}

/** What the nav and the search know of an entry before its code is there. `id` and `title` are its
 *  file's own `DEF` (`app.test.tsx` holds the two equal); `keywords` are what a person types to find
 *  it: the component names it mounts and the feature words, never empty (`registry.test.ts`). */
export type EntryDef = Pick<SectionDef, "id" | "title"> & Findable;

/** One row of the entry registry. `load` fetches the entry's module when its page is opened. */
export interface SectionEntry {
  readonly def: EntryDef;
  readonly load: () => Promise<{ default: ComponentType<SectionRenderCtx> }>;
}

/**
 * The reference's entries, in the order they are shown. Exported so `app.test.tsx` can iterate every
 * entry rather than special-casing whatever the page happens to mount by default.
 *
 * Adding an entry is one row here plus its own file under `sections/`, whose `DEF` carries the same
 * id and title. The id is flat kebab-case and is the entry's address (`design.html#motion`).
 * `{ def: { id: "motion", title: "Motion", keywords: ["animation", "BottomSheet"] }, load: () => import("./sections/motion").then((m) => ({ default: m.MotionSection })) }`.
 * Keep the `import()` a literal path, so Vite can split it into its own chunk.
 */
export const SECTIONS: readonly SectionEntry[] = [
  {
    def: { id: "dashboard", title: "Dashboard", keywords: ["home", "herd", "AgentList", "tabs", "needs-you", "TabBar", "PaneStrip", "SpaceStrip", "TabStrip", "navigation", "update-band", "UpdateBanner", "UpdateRibbon", "footer", "build-stamp", "crew-link", "SessionSwitcher", "read-only", "write-gate", "worktree", "branch"] },
    load: () => import("./sections/dashboard").then((m) => ({ default: m.DashboardSection })),
  },
  {
    def: { id: "pane", title: "Pane", keywords: ["chat", "mirror", "terminal", "NavTray", "tool-run", "pane-actions", "header", "NoEchoNotice"] },
    load: () => import("./sections/pane").then((m) => ({ default: m.PaneSection })),
  },
  {
    def: { id: "composer-states", title: "Composer states", keywords: ["composer", "reply", "way-out", "held", "send", "queue", "draft", "steer", "hold"] },
    load: () => import("./sections/composer-states").then((m) => ({ default: m.ComposerStatesSection })),
  },
  {
    def: { id: "actions-row", title: "Actions row", keywords: ["belt", "ActionsRow", "keys", "harness", "HarnessBarControl", "HarnessPrefsControl", "keyboard"] },
    load: () => import("./sections/actions-row").then((m) => ({ default: m.ActionsRowSection })),
  },
  {
    def: { id: "programs", title: "Durable agents home", keywords: ["durable", "agent", "program", "conversation", "DurableHome", "ProgramSection", "AskCard", "ask", "SpaceOverview"] },
    load: () => import("./sections/programs").then((m) => ({ default: m.DurableSection })),
  },
  {
    def: { id: "crew", title: "Crew", keywords: ["machines", "host", "HostChip", "HostStaleBanner", "ServerSwitcher", "stale", "peer", "lead", "member"] },
    load: () => import("./sections/crew").then((m) => ({ default: m.CrewSection })),
  },
  {
    def: { id: "machines", title: "Machines", keywords: ["crew", "CrewTabView", "census", "detail", "history", "skeleton"] },
    load: () => import("./sections/machines").then((m) => ({ default: m.MachinesSection })),
  },
  {
    def: { id: "settings", title: "Settings", keywords: ["LauncherHowSheet", "launcher", "CommandPicker", "FolderBrowse", "NotifyPrefsCard", "notifications", "theme", "ThemePickerControl", "ThemeBrowseSheet", "ThemePasteSheet", "ThemePreviewSheet", "codex", "consent", "speech", "voice", "SpeechCards", "prompts"] },
    load: () => import("./sections/settings").then((m) => ({ default: m.SettingsSection })),
  },
  {
    def: { id: "boot", title: "Boot & connection", keywords: ["splash", "connection", "ConnectionBanner", "CollieHome", "header", "dog", "lost", "trouble", "offline", "clock"] },
    load: () => import("./sections/boot").then((m) => ({ default: (ctx: SectionRenderCtx) => <m.BootSection clock={ctx.clock} /> })),
  },
  {
    def: { id: "tour", title: "First run", keywords: ["tour", "onboarding", "TourSheet", "TourControl", "push", "permission", "welcome"] },
    load: () => import("./sections/tour").then((m) => ({ default: m.TourSection })),
  },
  {
    def: { id: "idle", title: "Idle & resume", keywords: ["IdleLock", "lock", "resume", "cover"] },
    load: () => import("./sections/idle").then((m) => ({ default: m.IdleSection })),
  },
  {
    def: { id: "brand", title: "Brand", keywords: ["mark", "CollieMark", "logo", "typeface", "font", "face", "header", "prerelease", "AlphaBar", "glyph", "icons", "app-icon"] },
    load: () => import("./sections/brand").then((m) => ({ default: m.BrandSection })),
  },
  {
    def: { id: "character-picker", title: "Character picker", keywords: ["character", "head", "mark", "collar", "CharacterPicker", "theme"] },
    load: () => import("./sections/character-picker").then((m) => ({ default: m.CharacterPickerSection })),
  },
  {
    def: { id: "notices", title: "Notices", keywords: ["Notice", "strip", "band", "StripHost", "toast", "ribbon", "UpdateRibbon", "HeaderStatus", "StatusArea", "recovery", "flash"] },
    load: () => import("./sections/notices").then((m) => ({ default: m.NoticesSection })),
  },
  {
    def: { id: "update-screen", title: "Update mode", keywords: ["update", "UpdateScreen", "UpdateRunStrip", "upgrade", "install", "restart"] },
    load: () => import("./sections/update-screen").then((m) => ({ default: m.UpdateScreenSection })),
  },
  {
    def: { id: "motion", title: "Motion", keywords: ["animation", "transition", "collapse", "swap", "OneOf", "BusyBar", "loading", "BottomSheet", "sheet", "AnchoredMenu", "menu", "pending", "pulse", "status-dot"] },
    load: () => import("./sections/motion").then((m) => ({ default: m.MotionSection })),
  },
  {
    def: { id: "cache", title: "Cache", keywords: ["prompt-cache", "CacheChip", "CacheSheet", "expiry", "timer"] },
    load: () => import("./sections/cache").then((m) => ({ default: m.CacheSection })),
  },
  {
    def: { id: "pane-settings", title: "Pane settings", keywords: ["PaneSettingsView", "sheet", "switch", "disabled"] },
    load: () => import("./sections/pane-settings").then((m) => ({ default: m.PaneSettingsSection })),
  },
  {
    def: { id: "walky", title: "WalkyTalky", keywords: ["walky", "walkytalky", "walky-talky", "message", "ItemView", "AnsiOutput", "WalkySheet", "WalkyConfirm", "PaneActionsSheet", "log"] },
    load: () => import("./sections/walky").then((m) => ({ default: m.WalkySection })),
  },
  {
    def: { id: "changes", title: "Changes", keywords: ["diff", "git", "files", "ChangesControl", "FileView", "breadcrumb", "filter", "worktree"] },
    load: () => import("./sections/changes").then((m) => ({ default: m.ChangesSection })),
  },
  {
    def: { id: "markdown-quotes", title: "Blockquotes", keywords: ["markdown", "blockquote", "quote", "MarkdownText", "table", "code", "list"] },
    load: () => import("./sections/markdown-quotes").then((m) => ({ default: m.MarkdownQuotesSection })),
  },
  {
    def: { id: "left-hand", title: "Left-hand layout", keywords: ["hand", "left", "right", "Composer", "belt", "layout"] },
    load: () => import("./sections/left-hand").then((m) => ({ default: m.LeftHandSection })),
  },
  {
    def: { id: "composer-box", title: "Composer box", keywords: ["composer", "box", "Composer", "layout", "expand", "fullscreen", "editor", "draft"] },
    load: () => import("./sections/composer-box").then((m) => ({ default: m.ComposerBoxSection })),
  },
  {
    def: { id: "dashboard-top", title: "Dashboard top", keywords: ["dashboard", "header", "AgentList", "HeadingNewTab", "ServerSwitcher", "SessionSwitcher", "control-bar", "workspace", "order"] },
    load: () => import("./sections/dashboard-top").then((m) => ({ default: m.DashboardTopSection })),
  },
  {
    def: { id: "usage-row", title: "Usage row", keywords: ["usage", "ModelTag", "model", "tag", "context", "limits", "percent", "dots", "statusline"] },
    load: () => import("./sections/usage-row").then((m) => ({ default: m.UsageRowSection })),
  },
  {
    def: { id: "grounds", title: "Grounds", keywords: ["ground", "pattern", "grain", "backdrop", "theme", "surface"] },
    load: () => import("./sections/grounds").then((m) => ({ default: m.GroundsSection })),
  },
  {
    def: { id: "pins", title: "Pinned messages", keywords: ["pins", "pin", "StreamBlock", "BlockActionsSheet", "PinsSheet", "SubagentSheet", "Composer", "belt"] },
    load: () => import("./sections/pins").then((m) => ({ default: m.PinsSection })),
  },
  {
    def: { id: "switcher", title: "Session switcher", keywords: ["switch", "pane", "sheet", "ThreadSidebar", "sessions", "filter", "crew"] },
    load: () => import("./sections/switcher").then((m) => ({ default: m.SwitcherSection })),
  },
  {
    def: { id: "filter", title: "Session filter", keywords: ["filter", "search", "match", "order", "ThreadSidebar", "AgentList"] },
    load: () => import("./sections/filter").then((m) => ({ default: m.FilterRoundSection })),
  },
  {
    def: { id: "new-tab", title: "New tab sheet", keywords: ["new", "tab", "plus", "NewTabSheet", "launcher", "start"] },
    load: () => import("./sections/new-tab").then((m) => ({ default: m.NewTabSection })),
  },
  {
    def: { id: "primitives", title: "Primitives", keywords: ["ui", "MatchText", "match", "find", "mark"] },
    load: () => import("./sections/primitives").then((m) => ({ default: m.PrimitivesSection })),
  },
  {
    def: { id: "report", title: "Report a problem", keywords: ["report", "issue", "ReportCard", "ReportSheetView", "failed", "sends"] },
    load: () => import("./sections/report").then((m) => ({ default: m.ReportSection })),
  },
  {
    def: { id: "pair-by-phone", title: "Pair by phone", keywords: ["pair", "device", "QR", "PairWithPhoneView", "approve", "phone"] },
    load: () => import("./sections/pair-by-phone").then((m) => ({ default: m.PairByPhoneSection })),
  },
  {
    def: { id: "trick-render", title: "Trick render", keywords: ["tricks", "tree-ui", "nodes", "renderer", "part", "frame", "trick-mark"] },
    load: () => import("./sections/trick-render").then((m) => ({ default: m.TrickRenderSection })),
  },
  {
    def: { id: "trick-places", title: "Trick places", keywords: ["tricks", "belt", "status-line", "DashboardTabBar", "TrickDashboardStrip", "tiles", "TrickSessionRow", "trick-session"] },
    load: () => import("./sections/trick-places").then((m) => ({ default: m.TrickPlacesSection })),
  },
  {
    def: { id: "trick-menu", title: "Trick menu", keywords: ["tricks", "menu", "PaneActionsSheet", "rows", "switches", "confirm", "belt-mark"] },
    load: () => import("./sections/trick-menu").then((m) => ({ default: m.TrickMenuSection })),
  },
  {
    def: { id: "trick-settings", title: "Trick settings", keywords: ["tricks", "TricksSettingsCard", "TrickAboutSheet", "about", "provenance", "official"] },
    load: () => import("./sections/trick-settings").then((m) => ({ default: m.TrickSettingsSection })),
  },
  {
    def: { id: "hill", title: "Hill", keywords: ["hill", "decision", "DecisionCard", "HillView", "HillHeader", "DashboardTabBar", "answer", "images"] },
    load: () => import("./sections/hill").then((m) => ({ default: m.HillSection })),
  },
  {
    def: { id: "token-label", title: "Uses agent tokens", keywords: ["tokens", "token-use", "label", "chip", "TokenUseLookProvider", "TricksSettingsCard"] },
    load: () => import("./sections/token-label").then((m) => ({ default: m.TokenLabelSection })),
  },
  {
    def: { id: "agent-view", title: "Agent view", keywords: ["agent-view", "AgentViewScreen", "morph", "tricks", "PaneActionsSheet", "send", "refusal"] },
    load: () => import("./sections/agent-view").then((m) => ({ default: m.AgentViewSection })),
  },
  {
    def: { id: "dashboard-places", title: "Dashboard places", keywords: ["dashboard", "hill", "bottom-bar", "DashboardTabBar", "TrickDashboardStrip", "tiles", "DecisionCard"] },
    load: () => import("./sections/dashboard-places").then((m) => ({ default: m.DashboardPlacesSection })),
  },
];

/** One `lazy` per section, made once: a fresh `lazy()` per render would suspend on every render. */
const PAGES = new Map(SECTIONS.map((s) => [s.def.id, lazy(s.load)]));

const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const satisfies readonly { value: Theme; label: string }[];

const ON_OFF = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
] as const satisfies readonly { value: "on" | "off"; label: string }[];

export function PlaygroundApp({ tab }: { tab?: string } = {}) {
  const [clock, setClock] = useState<ClockMode>("live");
  const [phoneWidth, setPhoneWidth] = useState(false);
  const sectionDefs = SECTIONS.map((s) => s.def);
  const { activeId, selectTab, cardHandle, group, selectGroup } = useSelectedSection(sectionDefs, tab);
  // The query is the address's `?q=` (find.ts). A test that pins `tab` leaves the address alone.
  const [query, setQueryState] = useState(() => (tab === undefined ? readQuery() : ""));
  const setQuery = (next: string): void => {
    setQueryState(next);
    if (tab === undefined) writeQuery(next);
  };
  const finder: FinderState = {
    query,
    onQuery: setQuery,
    found: findEntries(sectionDefs, query),
    total: sectionDefs.length,
    onOpen: selectTab,
  };
  const face = useFace();
  const accent = useAccent();
  useConnectionClock(clock);

  // Fill the one-shot `/api/config` store the same way the app does. It is what the header's
  // "on <mux>" caption and its logo read, and it costs one request. With no bridge behind the dev
  // proxy it simply never resolves, and every reader stays at its documented empty answer.
  useEffect(() => {
    void loadOperatorCommands();
  }, []);

  const active = SECTIONS.find((s) => s.def.id === activeId) ?? SECTIONS[0];
  const Page = PAGES.get(active.def.id);
  const subPage = useMemo(() => ({ group, selectGroup }), [group, selectGroup]);
  const controls = { clock, onClock: setClock, phoneWidth, onPhoneWidth: setPhoneWidth };

  return (
    // The prefs land HERE, on the root, not on any card: the typeface and accent overrides cascade
    // into every real component below, which is the only honest way to judge their impact. See
    // ./prefs.ts for what the style sets and what (font-mono surfaces) it deliberately leaves.
    <div className={phoneWidth ? "pg-narrow" : undefined} style={prefStyle(face, accent)}>
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-[2000px] gap-6 bg-background px-4 text-foreground lg:px-6">
        <Sidebar finder={finder} activeId={active.def.id} controls={controls} />

        <main className="min-w-0 flex-1 pb-32 pt-4">
          <TopBar finder={finder} activeId={active.def.id} />
          {/* The page knobs on a phone: under the sticky header, not in it, so the header stays short
              while the soft keyboard is up. */}
          <div className="pg-scroll-row items-center gap-x-4 pt-3 lg:hidden">
            <Controls {...controls} />
          </div>

          <div
            role="tabpanel"
            id={`pg-panel-${active.def.id}`}
            aria-labelledby={`pg-tab-h-${active.def.id} pg-tab-v-${active.def.id}`}
            className="pt-6 lg:pt-0"
          >
            <SubPageContext.Provider value={subPage}>
              <Suspense fallback={<p className="text-xs text-muted-foreground">Loading {active.def.title}…</p>}>
                {Page !== undefined && <Page clock={clock} />}
                <ScrollToCard handle={cardHandle} section={active.def.id} />
              </Suspense>
            </SubPageContext.Provider>
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * `#pane/<card-handle>` names a card to scroll into view. Rendered INSIDE the section's Suspense
 * boundary, beside the section, so its effect runs only once the section's code has loaded and its
 * cards are committed. A handle the current section does not carry (a stale hash left over from
 * another tab) simply finds nothing and does nothing.
 */
function ScrollToCard({ handle, section }: { handle: string | null; section: string }) {
  useEffect(() => {
    if (handle === null) return;
    // Not a template-built CSS selector: a card's handle is compared as a plain attribute value, so a
    // handle with an odd character cannot break the lookup.
    const el = [...document.querySelectorAll("[data-state]")].find(
      (node) => node.getAttribute("data-state") === handle,
    );
    el?.scrollIntoView();
  }, [handle, section]);
  return null;
}

// ── The page's own chrome ────────────────────────────────────────────────────
//
// Two shells, one `Finder` and one `TabBar` each. At `lg` and up, {@link Sidebar} is a sticky left
// rail: the title, the search field, the entry list running DOWN the rail, then the controls stacked
// under a rule. Below `lg`, {@link TopBar} takes over: a sticky header with the title, the search
// field and the entry list. The list runs ACROSS in one scrolling row while the field is empty, and
// wraps into as many rows as the matches need while it holds a query. Exactly one of the two shells
// is ever visible (Tailwind's `lg:` breakpoint hides the other), but BOTH are always mounted, so
// their elements carry their own ids (`idPrefix`) and the tabpanel is labelled by both.

/** The search, as both shells draw it. */
interface FinderState {
  query: string;
  onQuery: (next: string) => void;
  /** The entries the query finds, in their own order. */
  found: readonly EntryDef[];
  total: number;
  onOpen: (id: string) => void;
}

interface ControlsProps {
  clock: ClockMode;
  onClock: (next: ClockMode) => void;
  phoneWidth: boolean;
  onPhoneWidth: (next: boolean) => void;
  stacked?: boolean;
}

/** Wide screens: a sticky left rail carrying the search, the vertical entry list and the stacked
 *  controls. Hidden below `lg`, where {@link TopBar} takes over. */
function Sidebar({ finder, activeId, controls }: { finder: FinderState; activeId: string; controls: ControlsProps }) {
  return (
    <aside className="hidden w-[220px] shrink-0 lg:block">
      <div className="sticky top-0 max-h-[100dvh] overflow-y-auto py-4">
        <h1 className="text-sm font-semibold tracking-tight">Collie design reference</h1>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Final states only. Dev-only page, not in the production bundle.
        </p>
        <div className="mt-3">
          <Finder finder={finder} idPrefix="v" />
        </div>
        <div className="mt-3">
          {finder.found.length > 0 && (
            <TabBar orientation="vertical" sections={finder.found} activeId={activeId} onSelect={finder.onOpen} />
          )}
        </div>
        <div className="mt-5 space-y-3 border-t border-rule pt-4">
          <Controls {...controls} stacked />
        </div>
      </div>
    </aside>
  );
}

/** Narrow: a sticky top header carrying the search and the entry list. Hidden at `lg` and up, where
 *  {@link Sidebar} takes over. */
function TopBar({ finder, activeId }: { finder: FinderState; activeId: string }) {
  const header = useRef<HTMLElement>(null);
  // A sticky bar of an entry sits under this header, whose height changes as its list wraps.
  // `--pg-top` is that height.
  useEffect(() => {
    const el = header.current;
    if (el === null || !("ResizeObserver" in window)) return;
    const root = document.documentElement;
    const watch = new ResizeObserver(() => root.style.setProperty("--pg-top", `${el.offsetHeight}px`));
    watch.observe(el);
    return () => {
      watch.disconnect();
      root.style.removeProperty("--pg-top");
    };
  }, []);
  const searching = finder.query.trim() !== "";
  return (
    <header ref={header} className="sticky top-0 z-30 -mx-4 -mt-4 border-b border-border bg-background/95 px-4 pb-2 pt-2 backdrop-blur lg:hidden">
      <h1 className="pb-1.5 text-sm font-semibold tracking-tight">Collie design reference</h1>
      <Finder finder={finder} idPrefix="h" />
      {finder.found.length > 0 && (
        // With a query the matches wrap, so every one is in view without a sideways scroll; the box
        // stops at a share of the screen, so the keyboard never pushes the field out of it.
        <div className={cn("pt-2", searching ? "max-h-[40dvh] overflow-y-auto" : "pg-scroll-row")}>
          <TabBar orientation="horizontal" wrap={searching} sections={finder.found} activeId={activeId} onSelect={finder.onOpen} />
        </div>
      )}
    </header>
  );
}

/**
 * The search field over the entry list: the app's own `SearchField`, a clear button in its right
 * edge, the count of matches and, when nothing matches, a line that says so with a way back.
 * Enter opens the first match and lets the keyboard go; Escape clears.
 */
function Finder({ finder, idPrefix }: { finder: FinderState; idPrefix: "h" | "v" }) {
  const input = useRef<HTMLInputElement>(null);
  const { query, onQuery, found, total, onOpen } = finder;
  const searching = query.trim() !== "";
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      const first = found[0];
      if (first === undefined) return;
      event.preventDefault();
      onOpen(first.id);
      input.current?.blur();
    } else if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      onQuery("");
    }
  };
  return (
    <div data-slot={`finder-${idPrefix}`}>
      <SearchField
        ref={input}
        value={query}
        onChange={onQuery}
        placeholder="Find a state or component"
        label="Find an entry"
        enterKeyHint="go"
        onKeyDown={onKeyDown}
        trailing={
          <button
            type="button"
            aria-label="Clear the search"
            onClick={() => {
              onQuery("");
              input.current?.focus();
            }}
            className={cn(
              "absolute right-0 top-0 flex size-11 items-center justify-center rounded-md text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              !searching && "invisible",
            )}
          >
            <Icon name="clear" className="size-4" aria-hidden />
          </button>
        }
      />
      {searching && (
        <p role="status" className="pt-1 text-[11px] text-muted-foreground">
          {found.length === 0 ? (
            <>
              No entry matches. Try a component name or a feature word.{" "}
              <button type="button" onClick={() => onQuery("")} className="underline underline-offset-2">
                Show all {total}
              </button>
            </>
          ) : (
            `${found.length} of ${total}`
          )}
        </p>
      )}
    </div>
  );
}

/**
 * A real WAI-ARIA tab list: `role="tablist"` over `role="tab"` buttons, roving focus, and automatic
 * activation — moving focus with the keyboard selects the tab under it, the same as clicking it.
 * `orientation` picks which arrow pair moves focus (`ArrowDown`/`ArrowUp` when `"vertical"`,
 * `ArrowLeft`/`ArrowRight` when `"horizontal"`, per the ARIA authoring practice for a tab list);
 * `Home`/`End` jump to the ends either way. `PlaygroundApp` renders the matching `role="tabpanel"`.
 * `sections` is the list the search left, so the keys move over the matches only.
 *
 * `idPrefix` keeps the two mounted instances (the rail's and the header's — see the chrome comment
 * above) from handing out the same element id twice; the tabpanel's `aria-labelledby` names both.
 */
function TabBar({
  orientation,
  wrap = false,
  sections,
  activeId,
  onSelect,
}: {
  orientation: "horizontal" | "vertical";
  /** A horizontal list that wraps into rows instead of one scrolling row. */
  wrap?: boolean;
  sections: readonly EntryDef[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const idPrefix = orientation === "vertical" ? "pg-tab-v" : "pg-tab-h";
  const nextKey = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
  const prevKey = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";

  const moveTo = (index: number): void => {
    const count = sections.length;
    const wrapped = ((index % count) + count) % count;
    const target = sections[wrapped];
    if (target === undefined) return;
    onSelect(target.id);
    buttonRefs.current[wrapped]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === nextKey) {
      event.preventDefault();
      moveTo(index + 1);
    } else if (event.key === prevKey) {
      event.preventDefault();
      moveTo(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveTo(0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveTo(sections.length - 1);
    }
  };

  // With the active entry outside the matches, the first match takes the tab stop.
  const stop = sections.some((s) => s.id === activeId) ? activeId : sections[0]?.id;

  return (
    <div
      role="tablist"
      aria-label="Entries"
      aria-orientation={orientation}
      className={cn("flex gap-1", orientation === "vertical" ? "flex-col" : wrap ? "flex-wrap" : "flex-nowrap")}
    >
      {sections.map((s, index) => (
        <button
          key={s.id}
          ref={(el) => {
            buttonRefs.current[index] = el;
          }}
          type="button"
          role="tab"
          id={`${idPrefix}-${s.id}`}
          aria-selected={s.id === activeId}
          aria-controls={`pg-panel-${s.id}`}
          tabIndex={s.id === stop ? 0 : -1}
          onClick={() => onSelect(s.id)}
          onKeyDown={(event) => onKeyDown(event, index)}
          className={cn(
            "shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
            orientation === "vertical" && "text-left",
            wrap && "min-h-9",
            s.id === activeId
              ? "bg-foreground text-background"
              : "bg-transparent text-muted-foreground hover:bg-muted",
          )}
        >
          {s.title}
        </button>
      ))}
    </div>
  );
}

function Controls({ clock, onClock, phoneWidth, onPhoneWidth, stacked = false }: ControlsProps) {
  const { theme, setTheme } = useTheme();
  const face = useFace();
  const accent = useAccent();
  const [reduced, setReduced] = useState(false);
  const notes = useNotes();

  useEffect(() => {
    document.documentElement.classList.toggle("pg-reduce-motion", reduced);
  }, [reduced]);

  return (
    <>
      <Field label="Theme" stacked={stacked}>
        <Segmented value={theme} options={THEME_OPTIONS} onChange={setTheme} />
      </Field>
      <Field label="Connection clock" stacked={stacked}>
        <Segmented value={clock} options={CLOCK_OPTIONS} onChange={onClock} />
      </Field>
      <Field label="Phone width" stacked={stacked}>
        <Segmented
          value={phoneWidth ? "on" : "off"}
          options={ON_OFF}
          onChange={(next) => onPhoneWidth(next === "on")}
        />
      </Field>
      <Field label="Notes" stacked={stacked}>
        <Segmented
          name="Notes"
          value={notes ? "on" : "off"}
          options={ON_OFF}
          onChange={(next) => setNotes(next === "on")}
        />
      </Field>
      <Field label="Reduce motion" stacked={stacked}>
        <Segmented
          value={reduced ? "on" : "off"}
          options={ON_OFF}
          onChange={(next) => setReduced(next === "on")}
        />
      </Field>
      {/* Page-wide presentation prefs (./prefs.ts). A native select, not a Segmented: eight faces
          do not fit a 220px rail (or the top bar) as chips, and this control repeats what the
          typeface card offers with commentary — the chrome gets the compact form. */}
      <Field label="Typeface" stacked={stacked}>
        <select
          value={face}
          // SAFETY: the option list below is rendered from FACE_OPTIONS alone, so the value the
          // browser hands back is always one of its `value`s — a FaceId by construction.
          onChange={(e) => setFace(e.target.value as FaceId)}
          className="h-7 rounded-md border border-border bg-background px-1.5 text-[11px] text-foreground"
          aria-label="Typeface"
        >
          {FACE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Accent" stacked={stacked}>
        <div className="flex items-center gap-1.5">
          {ACCENT_IDS.map((id) => (
            <button
              key={id}
              type="button"
              title={ACCENTS[id].label}
              aria-label={`Accent: ${ACCENTS[id].label}`}
              aria-pressed={id === accent}
              onClick={() => setAccent(id)}
              className={cn(
                "size-5 rounded-full border",
                id === accent ? "border-foreground" : "border-border",
              )}
              // The default swatch shows the app's own token; the rest show what they would set.
              style={{ background: ACCENTS[id].primary ?? "var(--primary)" }}
            />
          ))}
        </div>
      </Field>
    </>
  );
}

function Field({
  label,
  stacked,
  children,
}: {
  label: string;
  stacked?: boolean;
  children: ReactNode;
}) {
  if (stacked) {
    return (
      <div className="space-y-1">
        <span className="block text-[11px] text-muted-foreground">{label}</span>
        {children}
      </div>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="whitespace-nowrap text-[11px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
