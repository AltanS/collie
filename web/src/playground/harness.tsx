// Layout primitives and the router harnesses the playground needs to mount REAL components in a
// state the page cannot otherwise reach. DEV-ONLY (see `playground.html`).
//
// Copy is plain English and does not go through `t()`. That is the one deliberate departure from the
// repo rule, and it is bounded: none of this text ships — the file is unreachable from the app entry
// and absent from `dist`. The components it mounts do their own translating, so switching the app's
// locale still repaints every state below.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { AgentChat } from "@/components/agent-chat";
import { AppHeaderHost } from "@/components/app-header";
import { ConnectionBanner } from "@/components/connection-banner";
import { PackProvider } from "@/components/pack-provider";
import { UpdateAvailableBanner } from "@/components/update-available-banner";
import { CONNECTION_LOST_MS, TROUBLE_MS } from "@/hooks/use-connection-lost";
import { __resetConnectionHealth, markLive } from "@/lib/connection-health";
import { saveDraft } from "@/lib/drafts";
import { ROOT_ROUTE_ID, type DevicesData, type HomeData, type PackData } from "@/lib/loaders";
import type { DeviceAuth } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PackRoute } from "@/routes/pack";
import { SettingsRoute } from "@/routes/settings";
import { UpdatesRoute } from "@/routes/updates";
import type { PaneFixture } from "./fixtures";

// ── The shared connection clock ──────────────────────────────────────────────
//
// `lib/connection-health.ts` is ONE module-scoped clock on purpose: the banner, the header dog and
// the boot splash all derive from it so they can never disagree. That is also why this page cannot
// show "troubled" and "lost" side by side — there is a single anchor, and two different answers to
// "how long since the last live poll" cannot both be true at once. Forking the components to take
// the state as a prop would break the very property the clock exists to guarantee.
//
// So the playground drives the real store instead, with the real exported mutators, and every
// clock-fed state on the page moves together. Flipping the control in the sidebar is exactly what a
// real outage does — which makes "do the bar and the dog agree?" the easy thing to check.
//
// THE CONTROL IS GLOBAL, NOT SECTION-LOCAL, and that follows from the same fact: there is one store,
// so a control parked inside "Boot & connection" would silently be repainting the header dog three
// sections further down as well. A sidebar control tells the truth about its own reach.

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

// ── Router harnesses ─────────────────────────────────────────────────────────

/**
 * A data router carrying the root snapshot under the real `ROOT_ROUTE_ID`, which is what
 * `useOptionalRootData()` reads — the update chip, the header's freshness stamp and the pack census
 * all need it. Built once (`useState`'s lazy initialiser) so the route element is stable; the
 * components inside subscribe to their own module stores and re-render without it.
 */
export function RootRouter({ data, children }: { data: HomeData; children: ReactNode }) {
  const [router] = useState(() =>
    createMemoryRouter(
      [{ id: ROOT_ROUTE_ID, path: "/", loader: () => data, element: <>{children}</> }],
      { initialEntries: ["/"] },
    ),
  );
  return <RouterProvider router={router} />;
}

/**
 * The same root, plus the `PackProvider` the host-aware surfaces read. Tier-2 health is derived
 * there, against the LEAD's clock (`home.ts`) — never the phone's — so anything mounted inside gets
 * the same host health the real app would have derived for the same snapshot.
 */
export function PackedRootRouter({ data, children }: { data: HomeData; children: ReactNode }) {
  const [router] = useState(() =>
    createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => data,
          element: (
            <PackProvider
              servers={data.servers}
              sessions={data.sessions}
              ts={data.ts}
              pollMs={3_000}
            >
              {children}
            </PackProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    ),
  );
  return <RouterProvider router={router} />;
}

/**
 * The pack census on its own router, assembled the way `routes/pack.test.tsx` assembles it: the root
 * route publishes the snapshot AND the `PackProvider`, and `/pack` carries the census. A `pack` of
 * `{ status: null }` is the solo/empty card — the real 404 answer, not a stub.
 */
export function PackRouter({ home, pack }: { home: HomeData; pack: PackData }) {
  const [router] = useState(() =>
    createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => home,
          element: (
            <PackProvider
              servers={home.servers}
              sessions={home.sessions}
              ts={home.ts}
              pollMs={3_000}
            >
              <AppHeaderHost bridge={home.bridge} error={false}>
                <Outlet />
              </AppHeaderHost>
            </PackProvider>
          ),
          children: [
            { index: true, element: <div className="p-4 text-sm text-muted-foreground">home</div> },
            { path: "pack", loader: () => pack, element: <PackRoute /> },
          ],
        },
      ],
      { initialEntries: ["/pack"] },
    ),
  );
  return <RouterProvider router={router} />;
}

/**
 * Settings on a memory router, with its OWN loader supplying the paired-device registry — the same
 * `DevicesData` shape `devicesLoader` returns, so the Paired devices card renders its real list
 * rather than its empty fallback.
 *
 * Two things on this page still reach the network, and both are meant to: `fetchConfig()` fills the
 * diagnostics panel's server build, and the push control asks the browser about its own
 * subscription. Both fail soft — the page renders whole either way, and against a dev proxy pointed
 * at a live bridge they answer for real.
 */
export function SettingsRouter({
  home,
  devices,
  start = "/settings",
}: {
  home: HomeData;
  devices: DevicesData;
  /** Which of the two routes to open on. `/settings/updates` is the Updates page, a child of
   *  Settings, so the same router serves both and "back" works between them. */
  start?: "/settings" | "/settings/updates";
}) {
  const [router] = useState(() =>
    createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => home,
          element: (
            <PackProvider
              servers={home.servers}
              sessions={home.sessions}
              ts={home.ts}
              pollMs={3_000}
            >
              <AppHeaderHost bridge={home.bridge} error={false}>
                <Outlet />
              </AppHeaderHost>
            </PackProvider>
          ),
          children: [
            { index: true, element: <div className="p-4 text-sm text-muted-foreground">home</div> },
            { path: "settings", loader: () => devices, element: <SettingsRoute /> },
            { path: "settings/updates", element: <UpdatesRoute /> },
          ],
        },
      ],
      { initialEntries: [start] },
    ),
  );
  return <RouterProvider router={router} />;
}

/**
 * The WHOLE pane view — header breadcrumb, StatusBadge, mirror and composer — on a memory router.
 *
 * It is mountable in full, and that is worth stating plainly because it is the one thing on this
 * page that looks like it should need a live bridge and does not: `AgentChat` takes the pane's text
 * as a PROP. The polling that keeps that prop fresh lives in the root layout, not here, so handing
 * it a captured screen out of `fixtures/panes/` gives the real component the real bytes with no
 * fetch anywhere. Nothing is stubbed and no half-component is mounted.
 *
 * What is NOT live: every WRITE. Tapping a dialog option, sending a reply or pressing a key posts to
 * `/api/pane/…`, which on this page is whatever the dev proxy answers — usually nothing. The screen
 * therefore never advances in response to a tap. Read it as a photograph you can inspect, not as a
 * terminal you can drive.
 */
export function PaneRouter({
  home,
  fixture,
  readOnly = false,
  draft,
}: {
  home: HomeData;
  fixture: PaneFixture;
  /** Mount with the write gate refusing, which is what locks the composer and raises its banner. */
  readOnly?: boolean;
  /**
   * Seed the pane's composer draft, so a card can be looked at with text already in the box.
   *
   * Written into the real draft store rather than pushed in as a prop, because the composer has no
   * such prop and must not grow one for this page: it restores its own draft on mount
   * (`lib/drafts.ts`), so writing the store IS how a draft arrives in the app. This runs in the
   * `useState` initialiser above the composer's own, which is the ordering that makes it land.
   */
  draft?: string;
}) {
  const [router] = useState(() => {
    // Undefined scope: this harness hands `AgentChat` no `scope`, so the composer below reads the
    // solo key, and that is the key this must write.
    if (draft !== undefined) saveDraft(undefined, fixture.pane.paneId, draft);
    const data: HomeData = readOnly
      ? { ...home, device: { enforced: true, device: "kitchen-phone", authorized: false } }
      : home;
    return createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => data,
          element: (
            <PackProvider
              servers={data.servers}
              sessions={data.sessions}
              ts={data.ts}
              pollMs={3_000}
            >
              <AppHeaderHost bridge={data.bridge} error={false}>
                <AgentChat
                  paneId={fixture.pane.paneId}
                  agent={fixture.pane}
                  agents={data.agents}
                  shellPanes={data.shellPanes}
                  tabs={data.tabs}
                  tabLabel={fixture.pane.tabLabel}
                  text={fixture.text}
                  requestedLines={400}
                  revision={fixture.revision}
                  device={data.device}
                  bridge={data.bridge}
                  error={false}
                  onBack={() => {}}
                  onSelect={() => {}}
                />
              </AppHeaderHost>
            </PackProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );
  });
  return <RouterProvider router={router} />;
}

/**
 * The stack card's device gate, carried past the router rather than through it.
 *
 * `createMemoryRouter` is built once inside `useState`, so its loader data — including `device` — is
 * frozen at first render, and a control that flips the prop afterwards changes nothing. That was
 * fine while every notice on this card was static. It is not fine now: the ReadOnlyBanner's whole
 * point after the `ui/notice.tsx` conversion is the TRANSITION, which cannot be looked at in a tree
 * that can only be built already-refused. Context reaches the route element the ordinary React way,
 * because `RouterProvider` renders it as a descendant.
 */
const StackDeviceContext = createContext<DeviceAuth | null>(null);

/**
 * {@link PaneRouter}'s pane, PLUS the two tier-1 banners RootLayout mounts as its in-flow siblings —
 * `<UpdateAvailableBanner/>` and `<ConnectionBanner/>` — so the worst-case stack (gap 4) can be judged
 * as one screen instead of summed from cards measured apart. Same real components, same nesting order
 * as `routes/root.tsx`: banners first, pane second.
 *
 * The red `ConnectionBanner` here is deliberately the AUTH-ERROR branch (`bridge=undefined,
 * authError`), not the trouble→lost escalation — that branch paints red off its props alone, with no
 * dependency on the shared connection-health clock. The escalation branch cannot be driven reliably
 * from a control on this page: `useConnectionClock`'s ticker mutates the shared store every second but
 * never calls the store's own `emit()` (a real gap in `lib/connection-health.ts` — see this file's
 * module comment above and the playground task notes), so a mounted card only repaints when a
 * consumer's OWN once-per-mount timer fires, ~4s/~15s after THAT card mounted, not after a control
 * flip. The auth-error branch sidesteps the bug entirely and is a genuine red `ConnectionBanner`
 * state in its own right (see the "refused (401/403)" card in Boot & connection).
 */
export function PaneStackRouter({
  home,
  fixture,
  device,
}: {
  home: HomeData;
  fixture: PaneFixture;
  /** The OTHER composer lock — the device gate, independent of the pack host gate the pane derives
   *  from `home.servers`. Both are driven at once so the stack shows every lock at the same time. */
  device: DeviceAuth;
}) {
  const [router] = useState(() => {
    const data: HomeData = { ...home, device };
    return createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => data,
          element: (
            <PackProvider
              servers={data.servers}
              sessions={data.sessions}
              ts={data.ts}
              pollMs={3_000}
            >
              <div className="flex h-full flex-col">
                <UpdateAvailableBanner />
                <ConnectionBanner bridge={undefined} error authError />
                <AppHeaderHost bridge={data.bridge} error={false}>
                  <StackPane data={data} fixture={fixture} />
                </AppHeaderHost>
              </div>
            </PackProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );
  });
  return (
    <StackDeviceContext.Provider value={device}>
      <RouterProvider router={router} />
    </StackDeviceContext.Provider>
  );
}

/** The stack card's pane, reading the live gate off the context above rather than frozen loader data. */
function StackPane({ data, fixture }: { data: HomeData; fixture: PaneFixture }) {
  const device = useContext(StackDeviceContext) ?? data.device;
  return (
    <AgentChat
      paneId={fixture.pane.paneId}
      agent={fixture.pane}
      agents={data.agents}
      shellPanes={data.shellPanes}
      tabs={data.tabs}
      tabLabel={fixture.pane.tabLabel}
      text={fixture.text}
      requestedLines={400}
      revision={fixture.revision}
      device={device}
      bridge={data.bridge}
      error={false}
      onBack={() => {}}
      onSelect={() => {}}
    />
  );
}

// ── Layout ───────────────────────────────────────────────────────────────────

/** One top-level section of the page, as both the nav and the body know it. */
export interface SectionDef {
  readonly id: string;
  readonly title: string;
  /** One line: what this section is for. Printed under the heading. */
  readonly intent: string;
}

export function Section({ def, children }: { def: SectionDef; children: ReactNode }) {
  return (
    <section id={def.id} className="scroll-mt-4 border-t border-rule pt-6">
      <h2 className="text-base font-semibold tracking-tight">{def.title}</h2>
      <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{def.intent}</p>
      <div className="pg-grid mt-4">{children}</div>
    </section>
  );
}

/**
 * One labelled state. `reach` is the line that keeps this page honest — it says how an operator
 * arrives at this state on a real collie, so a card is never just a pretty picture of a component.
 */
export function Card({
  label,
  reach,
  note,
  span = 1,
  children,
}: {
  label: string;
  /** How you reach this state for real. Rendered after "reach it for real:". */
  reach: string;
  /** An honesty note — what is approximated here, or which control drives it. */
  note?: string;
  /** Two columns for anything route-sized. Collapses to one under the phone-width toggle. */
  span?: 1 | 2;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0", span === 2 && "pg-span-2")}>
      <p className="font-mono text-[11px] uppercase tracking-wide text-foreground">{label}</p>
      <p className="mb-2 mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
        <span className="text-status-idle">reach it for real:</span> {reach}
      </p>
      {note !== undefined && (
        <p className="mb-2 text-[11px] leading-relaxed text-status-working">{note}</p>
      )}
      {children}
    </div>
  );
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
      className="relative isolate w-[390px] max-w-full overflow-hidden rounded-[1.75rem] border-[6px] border-zinc-800 bg-background shadow-xl dark:border-zinc-700"
      style={{ height, transform: "translate(0)" }}
    >
      <div className="pg-phone-scroll flex h-full flex-col overflow-y-auto">{children}</div>
    </div>
  );
}

/** A segmented control. Plain buttons — the playground borrows no app chrome it isn't showing. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-border">
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

/**
 * Which section is currently under the top of the viewport. Plain scroll arithmetic rather than an
 * IntersectionObserver: the sections are wildly different heights (a row of marks vs. three phone
 * frames), so "most visible" picks the tall one almost always, while "the last heading you scrolled
 * past" is what a reader means by where they are.
 */
export function useActiveSection(sections: readonly SectionDef[]): string {
  const [active, setActive] = useState(sections[0]?.id ?? "");
  useEffect(() => {
    const pick = () => {
      let current = sections[0]?.id ?? "";
      for (const s of sections) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= 96) current = s.id;
      }
      setActive(current);
    };
    pick();
    window.addEventListener("scroll", pick, { passive: true });
    window.addEventListener("resize", pick);
    return () => {
      window.removeEventListener("scroll", pick);
      window.removeEventListener("resize", pick);
    };
  }, [sections]);
  return active;
}

/** The desktop sidebar's section list. */
export function SideNav({
  sections,
  active,
}: {
  sections: readonly SectionDef[];
  active: string;
}) {
  return (
    <nav className="flex flex-col gap-0.5" aria-label="Sections">
      {sections.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          aria-current={s.id === active ? "true" : undefined}
          className={cn(
            "rounded-md px-2 py-1.5 text-xs transition-colors",
            s.id === active
              ? "bg-muted font-medium text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          )}
        >
          {s.title}
        </a>
      ))}
    </nav>
  );
}

/** The narrow-viewport equivalent: one scrolling row of chips. */
export function ChipNav({
  sections,
  active,
}: {
  sections: readonly SectionDef[];
  active: string;
}) {
  return (
    <nav className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1" aria-label="Sections">
      {sections.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          aria-current={s.id === active ? "true" : undefined}
          className={cn(
            "shrink-0 rounded-md border px-2.5 py-1 text-[11px] transition-colors",
            s.id === active
              ? "border-foreground bg-foreground text-background"
              : "border-border text-muted-foreground",
          )}
        >
          {s.title}
        </a>
      ))}
    </nav>
  );
}
