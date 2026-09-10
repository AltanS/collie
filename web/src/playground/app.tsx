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
// THE PAGE IS TABBED, and this file owns only the chrome and the registry — one section at a time is
// mounted (see `useSelectedSection` in harness.tsx), and every section's cards live in its own file
// under `sections/`. A helper used by exactly one section lives beside it there; a helper two
// sections share lives in `sections/shared.tsx`.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { useTheme, type Theme } from "@/hooks/use-theme";
import { loadOperatorCommands } from "@/lib/operator-config";
import { cn } from "@/lib/utils";
import {
  CLOCK_OPTIONS,
  Segmented,
  useConnectionClock,
  useSelectedSection,
  type ClockMode,
  type SectionDef,
} from "./harness";
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
import * as brand from "./sections/brand";
import * as boot from "./sections/boot";
import * as idle from "./sections/idle";
import * as dashboard from "./sections/dashboard";
import * as pane from "./sections/pane";
import * as crew from "./sections/crew";
import * as settings from "./sections/settings";
import * as notices from "./sections/notices";
import * as motion from "./sections/motion";

/** What a section's `render` gets handed — the page-level knobs a section needs. Today only the
 *  shared connection clock (`BootSection`'s `clock` prop); a section that needs nothing reads
 *  nothing off it. */
export interface SectionRenderCtx {
  readonly clock: ClockMode;
}

/** One row of the section registry: the tab's own definition, and how to render its body. Only the
 *  SELECTED entry's `render` is ever called — see `PlaygroundApp` below. */
export interface SectionEntry {
  readonly def: SectionDef;
  readonly render: (ctx: SectionRenderCtx) => ReactNode;
}

/**
 * The page's tabs, in the order they are shown. Exported so `app.test.tsx` can iterate every
 * section rather than special-casing whatever the page happens to mount by default.
 *
 * Adding a section is a one-line addition here, plus its own file under `sections/`:
 * `{ def: motion.DEF, render: () => <motion.MotionSection /> }`, with
 * `import * as motion from "./sections/motion";` added to the imports above.
 */
export const SECTIONS: readonly SectionEntry[] = [
  { def: dashboard.DEF, render: () => <dashboard.DashboardSection /> },
  { def: pane.DEF, render: () => <pane.PaneSection /> },
  { def: crew.DEF, render: () => <crew.CrewSection /> },
  { def: settings.DEF, render: () => <settings.SettingsSection /> },
  { def: boot.DEF, render: (ctx) => <boot.BootSection clock={ctx.clock} /> },
  { def: idle.DEF, render: () => <idle.IdleSection /> },
  { def: brand.DEF, render: () => <brand.BrandSection /> },
  { def: notices.DEF, render: () => <notices.NoticesSection /> },
  { def: motion.DEF, render: () => <motion.MotionSection /> },
];

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
  const { activeId, selectTab, cardHandle } = useSelectedSection(sectionDefs, tab);
  const face = useFace();
  const accent = useAccent();
  useConnectionClock(clock);

  // Fill the one-shot `/api/config` store the same way the app does. It is what the header's
  // "on <mux>" caption and its logo read, and it costs one request. With no bridge behind the dev
  // proxy it simply never resolves, and every reader stays at its documented empty answer.
  useEffect(() => {
    void loadOperatorCommands();
  }, []);

  // `#pane/<card-handle>` names a card to scroll into view once its section has mounted. Runs after
  // every tab switch and after the hash changes; a re-run against a `cardHandle` the current section
  // does not carry (a stale hash left over from another tab) simply finds nothing and does nothing.
  useEffect(() => {
    if (cardHandle === null) return;
    // Not a template-built CSS selector: the e2e handle roll call (`web/e2e/handles.spec.ts`) and
    // app.test.tsx's own handle test both grep this tree for a card's `state` prop by pattern, and a
    // selector string assembled the same way would read back as one more handle no card actually has.
    const el = [...document.querySelectorAll("[data-state]")].find(
      (node) => node.getAttribute("data-state") === cardHandle,
    );
    el?.scrollIntoView();
  }, [activeId, cardHandle]);

  const active = SECTIONS.find((s) => s.def.id === activeId) ?? SECTIONS[0];

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
            {active.render({ clock })}
          </div>
        </main>
      </div>
    </div>
  );
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
  sections: readonly SectionDef[];
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
  sections: readonly SectionDef[];
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
