// Layout primitives, the page's routes and the shared connection clock: the LIGHT half of the
// playground's harness, split from ./harness.tsx (the routers, which import every app route) so the
// page chrome and a section that mounts no router load none of the app's routes. DEV-ONLY (see
// `playground.html`). Plain English copy, as harness.tsx explains.

import { Children, createContext, isValidElement, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { CONNECTION_LOST_MS, TROUBLE_MS } from "@/hooks/use-connection-lost";
import { __resetConnectionHealth, markLive } from "@/lib/connection-health";
import { cn } from "@/lib/utils";

// ── The shared connection clock ──────────────────────────────────────────────
//
// `lib/connection-health.ts` is ONE module-scoped clock on purpose: the banner, the header dog and
// the boot splash all derive from it so they can never disagree. That is also why this page cannot
// show "troubled" and "lost" side by side — there is a single anchor, and two different answers to
// "how long since the last live poll" cannot both be true at once. Forking the components to take
// the state as a prop would break the very property the clock exists to guarantee.
//
// So the playground drives the real store instead, with the real exported mutators, and every
// clock-fed state on the page moves together. Flipping the control in the top bar is exactly what a
// real outage does — which makes "do the bar and the dog agree?" the easy thing to check.
//
// THE CONTROL IS GLOBAL, NOT SECTION-LOCAL, and that follows from the same fact: there is one store,
// so a control parked inside "Boot & connection" would silently be repainting the header dog on the
// Dashboard tab too, even while that tab is not mounted. A top-bar control tells the truth about its
// own reach — and since only the selected tab mounts, "Boot & connection" and "Dashboard" are never
// both on screen to compare directly; the shared clock is what keeps them honest anyway.

export type ClockMode = "live" | "trouble" | "lost";

export const CLOCK_OPTIONS = [
  { value: "live", label: "Live" },
  { value: "trouble", label: "Trouble" },
  { value: "lost", label: "Lost" },
] as const satisfies readonly { value: ClockMode; label: string }[];

/**
 * Hold the shared health anchor at the chosen age. Re-stamped every second so "trouble" cannot drift
 * on into "lost" while you look at it, and so a real `/api/config` probe or a visibility change
 * cannot quietly recover the page underneath you.
 */
export function useConnectionClock(mode: ClockMode): void {
  useEffect(() => {
    // Every mode re-stamps, including "live". Nothing polls on this page, so a single markLive()
    // would age past 15s while you were reading and quietly escalate the whole page — the healthy
    // state has to be held open exactly as deliberately as the broken ones.
    const behind =
      mode === "live" ? 0 : mode === "trouble" ? TROUBLE_MS + 750 : CONNECTION_LOST_MS + 1_000;
    const stamp = () => (behind === 0 ? markLive() : __resetConnectionHealth(Date.now() - behind));
    stamp();
    const id = window.setInterval(stamp, 1_000);
    return () => window.clearInterval(id);
  }, [mode]);
}

// ── Layout ───────────────────────────────────────────────────────────────────

/** One top-level section of the page, as both the nav and the body know it. */
export interface SectionDef {
  readonly id: string;
  readonly title: string;
  /** One line: what this section is for. Printed under the heading. */
  readonly intent: string;
}

/** A group's title as it sits in the URL: `#dashboard:the-herd`. */
export function groupSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The sub-page the route names, and how to change it. Provided by `PlaygroundApp`; without it (a
 *  test or the website mounting a section on its own) every group shows and there is no bar. */
export interface SubPageRoute {
  readonly group: string | null;
  readonly selectGroup: (slug: string | null) => void;
}

export const SubPageContext = createContext<SubPageRoute | null>(null);

/**
 * One section of the page. Each `Group` that is a DIRECT child is also a sub-page: with two or more,
 * a bar under the intent offers All plus one link per group, and `#<section>:<group>` mounts only
 * that group's cards. All is the default, so a card handle (`#<section>/<card>`) always finds its
 * card. Read off the children rather than registered by an effect, so the bar is there in the first
 * paint and a group that is not shown is never mounted at all.
 */
export function Section({ def, children }: { def: SectionDef; children: ReactNode }) {
  const route = useContext(SubPageContext);
  const items = Children.toArray(children);
  const groups = items.flatMap((el) =>
    isValidElement<{ title: string }>(el) && el.type === Group ? [el.props.title] : [],
  );
  const asked = route?.group ?? null;
  const only = asked !== null && groups.some((g) => groupSlug(g) === asked) ? asked : null;
  const shown =
    only === null
      ? items
      : items.filter((el) => !(isValidElement<{ title: string }>(el) && el.type === Group) || groupSlug(el.props.title) === only);
  return (
    <section id={def.id} className="scroll-mt-4">
      <h2 className="text-base font-semibold tracking-tight">{def.title}</h2>
      <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{def.intent}</p>
      {route !== null && groups.length >= 2 && (
        <nav aria-label={`${def.title} pages`} className="mt-3 flex flex-wrap gap-1">
          {[null, ...groups].map((g) => {
            const slug = g === null ? null : groupSlug(g);
            const current = slug === only;
            return (
              <a
                key={slug ?? "all"}
                href={slug === null ? `#${def.id}` : `#${def.id}:${slug}`}
                aria-current={current ? "page" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  route.selectGroup(slug);
                }}
                className={cn(
                  "rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors",
                  current
                    ? "border-foreground bg-foreground text-background"
                    : "border-border text-muted-foreground hover:bg-muted",
                )}
              >
                {g ?? "All"}
              </a>
            );
          })}
        </nav>
      )}
      <div className="mt-4 space-y-8">{shown}</div>
    </section>
  );
}

/**
 * One named group of cards within a section, replacing the single page-wide grid a section used to
 * render on its own. A section's body is a `space-y-8` column of these, ordered from the everyday
 * state to the rare one, so a tab with a dozen cards can be skimmed by its group titles instead of
 * scrolled blind. `.pg-grid` still wraps exactly the cards inside one group, so every card stays a
 * direct child of a `.pg-grid` — the selector `app.test.tsx` and `handles.spec.ts` both scope their
 * handle collection to.
 */
export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="pg-grid mt-2">{children}</div>
    </div>
  );
}

/**
 * One labelled state. `reach` is the line that keeps this page honest — it says how an operator
 * arrives at this state on a real collie, so a card is never just a pretty picture of a component.
 */
export function Card({
  state,
  label,
  reach,
  note,
  span = 1,
  children,
}: {
  /**
   * The card's stable handle, rendered as `data-state`. Flat kebab-case, naming what the card
   * SHOWS and not where it sits: `update-band-in-flight`, `host-stale-unreachable`. It is required
   * so the compiler finds a card without one, and `app.test.tsx` refuses a repeat. A browser case
   * addresses `[data-state="…"]` and reads roles and text inside it — the label is prose that gets
   * reworded, so it is not a key (two of them are identical already).
   */
  state: string;
  label: string;
  /** How you reach this state for real. Rendered after "reach it for real:". */
  reach: string;
  /** An honesty note — what is approximated here, or which control drives it. */
  note?: string;
  /** Two columns for anything route-sized. Collapses to one under the phone-width toggle. */
  span?: 1 | 2;
  children: ReactNode;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  // Three rows of the group's grid, shared with every card beside it (`.pg-card` in playground.css):
  // the label block, the controls, then the component. Each row is as tall as the tallest card's in
  // that grid row, so a frame starts at the same height as its neighbours' whatever the length of the
  // text or the controls above it. Each part is placed on its row by hand, because an empty controls
  // row is `display: none` and would otherwise let the component slide up into it.
  return (
    <div data-state={state} className={cn("pg-card min-w-0", span === 2 && "pg-span-2")}>
      <div style={{ gridRow: 1 }}>
        <p className="font-mono text-[11px] uppercase tracking-wide text-foreground">{label}</p>
        <p className="mb-2 mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
          <span className="text-status-idle">reach it for real:</span> {reach}
        </p>
        {note !== undefined && (
          <p className="mb-2 text-[11px] leading-relaxed text-status-working">{note}</p>
        )}
      </div>
      <div ref={setSlot} className="flex min-w-0 flex-col gap-2 pb-2 empty:hidden" style={{ gridRow: 2 }} />
      <CardControlsSlot.Provider value={slot}>
        <div className="min-w-0" style={{ gridRow: 3 }}>
          {children}
        </div>
      </CardControlsSlot.Provider>
    </div>
  );
}

/**
 * Where a card's controls go: the card's own controls row, `null` until that row has mounted, and
 * `undefined` outside any card.
 */
const CardControlsSlot = createContext<HTMLElement | null | undefined>(undefined);

/**
 * The controls a card shows above its component: a Segmented, a replay button, toggles. Written
 * where the state lives (inside the card's body, or inside a wrapper like `SlowStage`) and drawn in
 * the card's controls row, so cards side by side keep their frames level whether or not they have
 * controls. Outside a card it draws in place.
 */
export function CardControls({ className, children }: { className?: string; children: ReactNode }) {
  const slot = useContext(CardControlsSlot);
  const strip = <div className={className}>{children}</div>;
  if (slot === undefined) return <div className={cn("mb-2", className)}>{children}</div>;
  return slot === null ? null : createPortal(strip, slot);
}

/**
 * The box a component paints inside. `transform` on it makes it the containing block for any
 * `position: fixed` descendant, so the idle cover renders at its true size in a card rather than
 * over the whole page; `dvh` pulls a `h-[100dvh]` root down to the box (see playground.css).
 */
export function Stage({
  height,
  dvh = false,
  children,
}: {
  height?: number;
  dvh?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-pg-frame=""
      className={cn(
        "relative isolate overflow-hidden rounded-xl border border-border bg-background",
        dvh && "pg-stage-dvh",
      )}
      style={{ height, transform: "translate(0)" }}
    >
      {children}
    </div>
  );
}

/**
 * A phone-shaped frame for a route-level mount: 390px of viewport (an iPhone 14's CSS width), a
 * fixed height, and its own internal scroll. Route components are written for a screen, not for a
 * card — given a card's width they read as a widget, and given the page's height they merge into the
 * page. The frame gives them back both, and its scrollbar is the component's own, not the page's.
 *
 * Same `transform` trick as `Stage`: a `position: fixed` header or sheet inside resolves against the
 * frame instead of escaping to the viewport.
 */
export function PhoneFrame({ height = 720, children }: { height?: number; children: ReactNode }) {
  return (
    <div
      data-pg-frame=""
      className="relative isolate w-[390px] max-w-full overflow-hidden rounded-[1.75rem] border-[6px] border-zinc-800 bg-background shadow-xl dark:border-zinc-700"
      style={{ height, transform: "translate(0)" }}
    >
      <div className="pg-phone-scroll flex h-full flex-col overflow-y-auto">{children}</div>
    </div>
  );
}

/**
 * A segmented control. Plain buttons — the playground borrows no app chrome it isn't showing.
 *
 * `name` is what a browser case asks for when a card shows two states through this control rather
 * than through two cards: it makes the group itself addressable by an accessible name
 * (`getByRole("group", { name })`), so a case can pick the option it wants without matching the
 * card's prose label. Only the controls that switch a card's state need one.
 */
export function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name?: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div
      role={name === undefined ? undefined : "group"}
      aria-label={name}
      className="inline-flex overflow-hidden rounded-lg border border-border"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={option.value === value}
          className={cn(
            "px-2 py-1 text-[11px] font-medium transition-colors",
            option.value === value
              ? "bg-foreground text-background"
              : "bg-transparent text-muted-foreground hover:bg-muted",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** What {@link useSelectedSection} returns. */
export interface SelectedSection {
  /** The id of the section currently on screen. */
  activeId: string;
  /** Select a section by id. Writes `localStorage` and pushes the URL hash, so Back returns to the
   *  page before, unless a `forced` id was given to the hook. */
  selectTab: (id: string) => void;
  /** The sub-page (a group's slug) the hash names after `:`, or `null` for all of the section. */
  group: string | null;
  /** Show one group of the active section, or all with `null`. Pushes `#<id>:<slug>`. */
  selectGroup: (slug: string | null) => void;
  /** The card handle carried on the hash at the moment it was last read (`#pane/<handle>`), or
   *  `null`. Consumed by the page to scroll that card into view after the section mounts. */
  cardHandle: string | null;
}

const TAB_STORAGE_KEY = "collie.playground.tab";

/** `#<section>`, `#<section>:<group>` or `#<section>/<card>`. A card handle and a group are never
 *  both named: the handle needs every group mounted to find its card. */
function parseHash(hash: string) {
  const raw = decodeURIComponent(hash.replace(/^#/, ""));
  const [head = "", card = null] = raw.split("/", 2);
  const [id = "", group = null] = head.split(":", 2);
  return { id, group: card ? null : group || null, card: card || null };
}

/**
 * Which tab is selected, and the one card the hash asked to be scrolled to.
 *
 * The selected tab lives in the URL hash: `#pane` selects the Pane tab, `#pane/<card-handle>`
 * selects it AND names a card to scroll into view once it mounts, and `#pane:<group>` shows one group
 * of it as a sub-page. Every section and sub-page is a page of its own (its code loads when it is
 * opened, see app.tsx), so a click pushes the hash and Back walks the pages; back/forward and
 * hand-edited hashes are honoured via `hashchange`. With no
 * hash, the last remembered tab (`localStorage["collie.playground.tab"]`) is used; with neither, or
 * an id naming no section, the first section is used.
 *
 * `forced` is {@link PlaygroundApp}'s `tab` prop: when given, the hash and `localStorage` are never
 * read or written, so a test can pin a section without touching global state another test relies on.
 *
 * The playground has no server render, so `window` is read directly rather than probed — it is
 * always present, in the browser and under jsdom alike.
 */
export function useSelectedSection(sections: readonly Pick<SectionDef, "id">[], forced?: string): SelectedSection {
  const idSet = new Set(sections.map((s) => s.id));
  const firstId = sections[0]?.id ?? "";
  const resolve = (id: string): string => (idSet.has(id) ? id : firstId);

  // Read on every render rather than captured once, so the closures below (the `hashchange`
  // listener, `selectTab`) always resolve against the CURRENT section list without needing it as an
  // effect dependency — which would reattach the listener on every render, since `sections` is a
  // fresh array each time (`PlaygroundApp` builds it from `SECTIONS.map(...)`).
  const liveRef = useRef({ idSet, firstId, resolve });
  liveRef.current = { idSet, firstId, resolve };

  const [state, setState] = useState<{ id: string; group: string | null; card: string | null }>(() => {
    if (forced !== undefined) return { id: resolve(forced), group: null, card: null };
    const fromHash = parseHash(window.location.hash);
    if (fromHash.id && idSet.has(fromHash.id)) return fromHash;
    const stored = window.localStorage.getItem(TAB_STORAGE_KEY);
    return { id: resolve(stored ?? firstId), group: null, card: null };
  });

  useEffect(() => {
    if (forced !== undefined) return;
    const onHashChange = () => {
      const live = liveRef.current;
      const fromHash = parseHash(window.location.hash);
      const resolved = live.resolve(fromHash.id || live.firstId);
      setState({ id: resolved, group: fromHash.group, card: fromHash.card });
      // A tab reached by editing the hash or by back/forward is a real visit to that tab, exactly
      // like a click — it should be the one `useSelectedSection` opens on next time too.
      window.localStorage.setItem(TAB_STORAGE_KEY, resolved);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [forced]);

  const selectTab = (id: string): void => {
    const resolved = resolve(id);
    setState({ id: resolved, group: null, card: null });
    if (forced === undefined) {
      window.localStorage.setItem(TAB_STORAGE_KEY, resolved);
      if (window.location.hash !== `#${resolved}`) window.history.pushState(null, "", `#${resolved}`);
    }
  };

  const selectGroup = (slug: string | null): void => {
    setState((prev) => ({ id: prev.id, group: slug, card: null }));
    if (forced === undefined) {
      const hash = slug === null ? `#${state.id}` : `#${state.id}:${slug}`;
      if (window.location.hash !== hash) window.history.pushState(null, "", hash);
    }
  };

  return { activeId: state.id, selectTab, cardHandle: state.card, group: state.group, selectGroup };
}
