// The states playground: every UI state Collie can reach, on one page, without having to provoke the
// condition that produces it. DEV-ONLY — see `web/playground.html`.
//
// THE RULE THIS PAGE KEEPS: it mounts the REAL components with their REAL props, and where a state
// is derived from a module store instead of a prop it drives that store through the store's own
// exported mutators. Nothing here is a copy of a component, and no component was given a prop it
// does not already have. Where that was not possible the card says so in its own words.
//
// THE OTHER RULE: every card carries a "reach it for real" line. A picture of a state is only useful
// if you can also get to it, and writing that sentence is what keeps a card from drifting into a
// state the app can no longer produce.
//
// THE PAGE IS SPLIT INTO PAGES, and this file owns only the chrome and the registry. Each section is
// its own page with its own address (`#changes`), and its code is loaded only when it is opened: the
// page used to import all of them up front, so even a three-card tab paid for every section's module
// graph. A section's groups are sub-pages of it (`#changes:one-file`, the bar `Section` draws). See
// `useSelectedSection` in harness.tsx for the routes. Every section's cards live in its own file
// under `sections/`. A helper used by exactly one section lives beside it there; a helper two
// sections share lives in `sections/shared.tsx`.

import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode } from "react";

import { useTheme, type Theme } from "@/hooks/use-theme";
import { loadOperatorCommands } from "@/lib/operator-config";
import { cn } from "@/lib/utils";
import { CLOCK_OPTIONS, Segmented, SubPageContext, useConnectionClock, useSelectedSection, type ClockMode, type SectionDef } from "./layout";
import {
  ACCENT_IDS,
  ACCENTS,
  FACE_OPTIONS,
  prefStyle,
  setAccent,
  setFace,
  useAccent,
  useFace,
  type FaceId,
} from "./prefs";

/** What a section page gets handed — the page-level knobs a section needs. Today only the shared
 *  connection clock (`BootSection`'s `clock` prop); a section that needs nothing reads nothing off it. */
export interface SectionRenderCtx {
  readonly clock: ClockMode;
}

/** One row of the section registry. `def` is what the nav needs before the section's code is
 *  there (its file's own `DEF` carries the same id and title, and `app.test.tsx` holds the two
 *  equal); `load` fetches the section's module when its page is opened. */
export interface SectionEntry {
  readonly def: Pick<SectionDef, "id" | "title">;
  readonly load: () => Promise<{ default: ComponentType<SectionRenderCtx> }>;
}

/**
 * The page's sections, in the order they are shown. Exported so `app.test.tsx` can iterate every
 * section rather than special-casing whatever the page happens to mount by default.
 *
 * Adding a section is one entry here plus its own file under `sections/`:
 * `{ def: { id: "motion", title: "Motion" }, load: () => import("./sections/motion").then((m) => ({ default: m.MotionSection })) }`.
 * Keep the `import()` a literal path, so Vite can split it into its own chunk.
 */
export const SECTIONS: readonly SectionEntry[] = [
  { def: { id: "dashboard", title: "Dashboard" }, load: () => import("./sections/dashboard").then((m) => ({ default: m.DashboardSection })) },
  { def: { id: "pane", title: "Pane" }, load: () => import("./sections/pane").then((m) => ({ default: m.PaneSection })) },
  { def: { id: "actions-row", title: "Actions row" }, load: () => import("./sections/actions-row").then((m) => ({ default: m.ActionsRowSection })) },
  { def: { id: "crew", title: "Crew" }, load: () => import("./sections/crew").then((m) => ({ default: m.CrewSection })) },
  { def: { id: "machines", title: "Machines" }, load: () => import("./sections/machines").then((m) => ({ default: m.MachinesSection })) },
  { def: { id: "settings", title: "Settings" }, load: () => import("./sections/settings").then((m) => ({ default: m.SettingsSection })) },
  {
    def: { id: "boot", title: "Boot & connection" },
    load: () => import("./sections/boot").then((m) => ({ default: (ctx: SectionRenderCtx) => <m.BootSection clock={ctx.clock} /> })),
  },
  { def: { id: "tour", title: "First run" }, load: () => import("./sections/tour").then((m) => ({ default: m.TourSection })) },
  { def: { id: "idle", title: "Idle & resume" }, load: () => import("./sections/idle").then((m) => ({ default: m.IdleSection })) },
  { def: { id: "brand", title: "Brand" }, load: () => import("./sections/brand").then((m) => ({ default: m.BrandSection })) },
  { def: { id: "notices", title: "Notices" }, load: () => import("./sections/notices").then((m) => ({ default: m.NoticesSection })) },
  { def: { id: "update-screen", title: "Update mode" }, load: () => import("./sections/update-screen").then((m) => ({ default: m.UpdateScreenSection })) },
  { def: { id: "motion", title: "Motion" }, load: () => import("./sections/motion").then((m) => ({ default: m.MotionSection })) },
  { def: { id: "cache", title: "Cache" }, load: () => import("./sections/cache").then((m) => ({ default: m.CacheSection })) },
  { def: { id: "pane-settings", title: "Pane settings" }, load: () => import("./sections/pane-settings").then((m) => ({ default: m.PaneSettingsSection })) },
  { def: { id: "changes", title: "Changes" }, load: () => import("./sections/changes").then((m) => ({ default: m.ChangesSection })) },
  { def: { id: "dashboard-nav", title: "Dashboard nav" }, load: () => import("./sections/dashboard-nav").then((m) => ({ default: m.DashboardNavSection })) },
  { def: { id: "attention-icon", title: "Attention icon" }, load: () => import("./sections/attention-icon").then((m) => ({ default: m.AttentionIconSection })) },
  { def: { id: "left-hand", title: "Left-hand layout" }, load: () => import("./sections/left-hand").then((m) => ({ default: m.LeftHandSection })) },
  { def: { id: "dashboard-top", title: "Dashboard top" }, load: () => import("./sections/dashboard-top").then((m) => ({ default: m.DashboardTopSection })) },
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

  return (
    // The prefs land HERE, on the root, not on any card: the typeface and accent overrides cascade
    // into every real component below, which is the only honest way to judge their impact. See
    // ./prefs.ts for what the style sets and what (font-mono surfaces) it deliberately leaves.
    <div className={phoneWidth ? "pg-narrow" : undefined} style={prefStyle(face, accent)}>
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-[2000px] gap-6 bg-background px-4 text-foreground lg:px-6">
        <Sidebar
          sections={sectionDefs}
          activeId={active.def.id}
          onSelect={selectTab}
          clock={clock}
          onClock={setClock}
          phoneWidth={phoneWidth}
          onPhoneWidth={setPhoneWidth}
        />

        <main className="min-w-0 flex-1 pb-32 pt-4">
          <TopBar
            sections={sectionDefs}
            activeId={active.def.id}
            onSelect={selectTab}
            clock={clock}
            onClock={setClock}
            phoneWidth={phoneWidth}
            onPhoneWidth={setPhoneWidth}
          />

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
    // Not a template-built CSS selector: the e2e handle roll call (`web/e2e/handles.spec.ts`) and
    // app.test.tsx's own handle test both grep this tree for a card's `state` prop by pattern, and a
    // selector string assembled the same way would read back as one more handle no card actually has.
    const el = [...document.querySelectorAll("[data-state]")].find(
      (node) => node.getAttribute("data-state") === handle,
    );
    el?.scrollIntoView();
  }, [handle, section]);
  return null;
}

// ── The page's own chrome ────────────────────────────────────────────────────
//
// Two shells, one `TabBar`. At `lg` and up, {@link Sidebar} is a sticky left rail: the title, the
// tab list running DOWN the rail, then the controls stacked under a rule. Below `lg`, {@link TopBar}
// takes over: the same title and tab list, but the list runs ACROSS as a sticky header row, with the
// controls in a second row beneath it. Exactly one of the two is ever visible — Tailwind's `lg:`
// breakpoint hides the other — but BOTH are always mounted, so `TabBar`'s two instances need their
// own element ids (`idPrefix`) and the tabpanel below is labelled by both.

interface ChromeProps {
  sections: readonly SectionEntry["def"][];
  activeId: string;
  onSelect: (id: string) => void;
  clock: ClockMode;
  onClock: (next: ClockMode) => void;
  phoneWidth: boolean;
  onPhoneWidth: (next: boolean) => void;
}

/** Wide screens: a sticky left rail carrying the vertical tab list and the stacked controls. Hidden
 *  below `lg`, where {@link TopBar} takes over. */
function Sidebar({ sections, activeId, onSelect, clock, onClock, phoneWidth, onPhoneWidth }: ChromeProps) {
  return (
    <aside className="hidden w-[220px] shrink-0 lg:block">
      <div className="sticky top-0 max-h-[100dvh] overflow-y-auto py-4">
        <h1 className="text-sm font-semibold tracking-tight">Collie — states playground</h1>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Dev-only page. Not in the production bundle.
        </p>
        <div className="mt-4">
          <TabBar orientation="vertical" sections={sections} activeId={activeId} onSelect={onSelect} />
        </div>
        <div className="mt-5 space-y-3 border-t border-rule pt-4">
          <Controls
            clock={clock}
            onClock={onClock}
            phoneWidth={phoneWidth}
            onPhoneWidth={onPhoneWidth}
            stacked
          />
        </div>
      </div>
    </aside>
  );
}

/** Narrow: a sticky top header carrying the horizontal tab list, with the controls in a second row
 *  beneath it. Hidden at `lg` and up, where {@link Sidebar} takes over. */
function TopBar({ sections, activeId, onSelect, clock, onClock, phoneWidth, onPhoneWidth }: ChromeProps) {
  return (
    <header className="sticky top-0 z-30 -mx-4 -mt-4 border-b border-border bg-background/95 px-4 py-2 backdrop-blur lg:hidden">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 pb-2">
        <div>
          <h1 className="text-sm font-semibold tracking-tight">Collie — states playground</h1>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Dev-only page. Not in the production bundle.
          </p>
        </div>
        <TabBar orientation="horizontal" sections={sections} activeId={activeId} onSelect={onSelect} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-2">
        <Controls clock={clock} onClock={onClock} phoneWidth={phoneWidth} onPhoneWidth={onPhoneWidth} />
      </div>
    </header>
  );
}

/**
 * A real WAI-ARIA tab list: `role="tablist"` over `role="tab"` buttons, roving focus, and automatic
 * activation — moving focus with the keyboard selects the tab under it, the same as clicking it.
 * `orientation` picks which arrow pair moves focus (`ArrowDown`/`ArrowUp` when `"vertical"`,
 * `ArrowLeft`/`ArrowRight` when `"horizontal"`, per the ARIA authoring practice for a tab list);
 * `Home`/`End` jump to the ends either way. `PlaygroundApp` renders the matching `role="tabpanel"`.
 *
 * `idPrefix` keeps the two mounted instances (the rail's and the header's — see the chrome comment
 * above) from handing out the same element id twice; the tabpanel's `aria-labelledby` names both.
 */
function TabBar({
  orientation,
  sections,
  activeId,
  onSelect,
}: {
  orientation: "horizontal" | "vertical";
  sections: readonly SectionEntry["def"][];
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

  return (
    <div
      role="tablist"
      aria-label="Sections"
      aria-orientation={orientation}
      className={cn("flex gap-1", orientation === "vertical" ? "flex-col" : "flex-wrap")}
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
          tabIndex={s.id === activeId ? 0 : -1}
          onClick={() => onSelect(s.id)}
          onKeyDown={(event) => onKeyDown(event, index)}
          className={cn(
            "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
            orientation === "vertical" && "text-left",
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

function Controls({
  clock,
  onClock,
  phoneWidth,
  onPhoneWidth,
  stacked = false,
}: {
  clock: ClockMode;
  onClock: (next: ClockMode) => void;
  phoneWidth: boolean;
  onPhoneWidth: (next: boolean) => void;
  stacked?: boolean;
}) {
  const { theme, setTheme } = useTheme();
  const face = useFace();
  const accent = useAccent();
  const [reduced, setReduced] = useState(false);

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
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
