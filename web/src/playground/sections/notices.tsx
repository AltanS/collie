// The Notices tab of the states playground: everything that ANNOUNCES — the notice primitive, the
// strip band above the header, the connection-recovery flash, the update ribbon's states, and the
// status toast. See ../app.tsx's header for the page's own two rules (mount REAL components with
// REAL props; drive a module store through its own mutators). This file follows both, and every card
// still carries its own "reach it for real" line.
//
// DEV-ONLY, unreachable from the app entry: see ../app.tsx and web/playground.html.

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { AppHeaderHost, RouteHeader, SettingsGear } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Notice, NOTICE_ACTION, type NoticeTone, type NoticeVariant } from "@/components/ui/notice";
import { StripHost, StripSlot } from "@/components/ui/strip-host";
import { AUTH, OUTAGE, DEGRADED, UPDATE } from "@/lib/strip-priority";
import { ConnectionBanner, GREEN_MS } from "@/components/connection-banner";
import { __resetConnectionHealth, markLive } from "@/lib/connection-health";
import { TROUBLE_MS, CONNECTION_LOST_MS } from "@/hooks/use-connection-lost";
import { UpdateRibbon } from "@/components/update-ribbon";
import { HeaderStatus } from "@/components/header-status";
import { StatusArea } from "@/components/status-area";
import { setStatus, clearStatus, type StatusTone } from "@/lib/status";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { UpdateInfo } from "@/lib/types";

import { Card, Group, RootRouter, Section, Segmented, Stage, type SectionDef } from "../harness";
import {
  homeSolo,
  updateInFlight,
  updatePeersFollowing,
  updateRelease,
  updateRestart,
} from "../fixtures";
import { Replay, SlowStage } from "./motion-harness";
import "./motion.css";

export const DEF: SectionDef = {
  id: "notices",
  title: "Notices",
  intent:
    "How Collie tells you something changed: the notice primitive, the strip band above the header, and the status toast. Every state here is reachable for real; the controls only let you force one on demand.",
};

const ON_OFF = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
] as const satisfies readonly { value: "on" | "off"; label: string }[];

export function NoticesSection(): ReactNode {
  return (
    <Section def={DEF}>
      <Group title="The notice primitive">
        <NoticeMatrixCard />
      </Group>
      <Group title="The band">
        <StripBandCard />
        <ConnectionRecoveryCard />
        <UpdateRibbonSwapsCard />
      </Group>
      <Group title="Toasts">
        <StatusToastCard />
      </Group>
    </Section>
  );
}

// ── 1. Notice, every tone × both variants ──────────────────────────────────

const TONES: readonly NoticeTone[] = ["info", "caution", "danger", "success", "neutral"];
const VARIANTS: readonly NoticeVariant[] = ["strip", "box"];

const INTERACTIONS = [
  { value: "plain", label: "Plain" },
  { value: "activate", label: "Activate" },
  { value: "dismiss", label: "Dismiss" },
  { value: "action", label: "Action + dismiss" },
] as const;
type Interaction = (typeof INTERACTIONS)[number]["value"];

function NoticeSample({
  tone,
  variant,
  interaction,
}: {
  tone: NoticeTone;
  variant: NoticeVariant;
  interaction: Interaction;
}) {
  const text = `${tone} ${variant}`;
  if (interaction === "activate") {
    return (
      <Notice tone={tone} variant={variant} onActivate={() => {}}>
        {text}, tap anywhere on this row
      </Notice>
    );
  }
  if (interaction === "dismiss") {
    return (
      <Notice tone={tone} variant={variant} onDismiss={() => {}} dismissLabel="Dismiss">
        {text}
      </Notice>
    );
  }
  if (interaction === "action") {
    return (
      <Notice
        tone={tone}
        variant={variant}
        action={
          <Button size="sm" className={NOTICE_ACTION}>
            Retry
          </Button>
        }
        onDismiss={() => {}}
        dismissLabel="Dismiss"
      >
        {text}
      </Notice>
    );
  }
  return <Notice tone={tone} variant={variant}>{text}</Notice>;
}

function NoticeMatrixCard() {
  const [interaction, setInteraction] = useState<Interaction>("plain");
  return (
    <Card
      state="notice-matrix"
      label="notice, every tone and variant"
      reach="every standing condition in the app is meant to converge on this primitive (DESIGN.md
        §11). The band above the header and read-only-banner.tsx are built from it now. Four
        surfaces still hand-roll their own box instead (§10 gap 1): host-stale-banner.tsx,
        no-echo-notice.tsx, the two settings.tsx rows, and alpha-bar.tsx by design."
      note="onActivate and onDismiss are mutually exclusive at the type level (NoticeInteraction in
        ui/notice.tsx), so the Segmented above never offers a combination the component would
        refuse."
      span={2}
    >
      <div className="mb-2">
        <Segmented
          name="Interaction"
          value={interaction}
          options={INTERACTIONS}
          onChange={setInteraction}
        />
      </div>
      <Stage>
        <div className="flex flex-col gap-4 p-4">
          {VARIANTS.map((variant) => (
            <div key={variant} className="flex flex-col gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                {variant}
              </span>
              <div className="flex flex-col gap-1.5">
                {TONES.map((tone) => (
                  <NoticeSample key={tone} tone={tone} variant={variant} interaction={interaction} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </Stage>
    </Card>
  );
}

// ── 2. The strip band, StripHost arbitration ───────────────────────────────

function ToggleField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <Segmented
        name={`${label} strip`}
        value={value ? "on" : "off"}
        options={ON_OFF}
        onChange={(next) => onChange(next === "on")}
      />
    </div>
  );
}

/**
 * RootRouter freezes its `children` element inside a useState initialiser (harness.tsx's own
 * PaneStackRouter doc comment names this trap for `data`. It is the same trap for `children`, since
 * the router's route `element` embeds `<>{children}</>` at construction and never re-reads it). A
 * toggle that lives OUTSIDE the router and only causes the demo's own re-render therefore never
 * reaches the mounted content. Context is the fix harness.tsx's `StackDeviceContext` already uses
 * for the same reason: a Provider change re-renders every mounted consumer regardless of whether the
 * parent element identity changed.
 */
const StripToggleContext = createContext({ auth: true, outage: true, degraded: true, update: true });

/**
 * No `<StripHost>` of its own. `RootRouter` (harness.tsx) already wraps its `children` in the real
 * one now, the same way `routes/root.tsx` wraps `<Outlet/>`, so a second host here would only shadow
 * it and leave the outer one always empty. The header sits INSIDE that same host, exactly as
 * `RootLayout` nests it, so `useStripBandOpen()` sees the real band and hands the safe-area inset
 * back and forth on cue.
 */
function StripBandContent() {
  const { auth, outage, degraded, update } = useContext(StripToggleContext);
  return (
    <div className="flex flex-col">
      {auth && (
        <StripSlot priority={AUTH}>
          <Notice tone="danger" variant="strip" announce="alert">
            Auth refused
          </Notice>
        </StripSlot>
      )}
      {outage && (
        <StripSlot priority={OUTAGE}>
          <Notice tone="danger" variant="strip">
            Bridge unreachable
          </Notice>
        </StripSlot>
      )}
      {degraded && (
        <StripSlot priority={DEGRADED}>
          <Notice tone="caution" variant="strip">
            Connection trouble
          </Notice>
        </StripSlot>
      )}
      {update && (
        <StripSlot priority={UPDATE}>
          <Notice tone="info" variant="strip">
            Update available
          </Notice>
        </StripSlot>
      )}
      <AppHeaderHost bridge="connected" error={false}>
        <RouteHeader wordmark rightTrail={<SettingsGear />} />
      </AppHeaderHost>
    </div>
  );
}

function StripBandCard() {
  const [auth, setAuth] = useState(true);
  const [outage, setOutage] = useState(true);
  const [degraded, setDegraded] = useState(true);
  const [update, setUpdate] = useState(true);
  const toggles = useMemo(
    () => ({ auth, outage, degraded, update }),
    [auth, outage, degraded, update],
  );
  return (
    <Card
      state="strip-band-arbitration"
      label="strip band, arbitration at the app's own priorities"
      reach="reachable today. Let the tailnet drop while a release is on offer: the connection
        registers OUTAGE and the ribbon has already registered UPDATE, and the band shows only the
        connection strip. Any two of the four conditions below can be true on a real device at once.
        This card only lets you force a combination on demand instead of waiting for one."
      note="Only the loudest slot paints. Switch off the winner and the band ghosts the old strip
        while it collapses (240ms, ui/collapse.tsx's COLLAPSE_MS) and the header below takes the
        safe-area inset back through useStripBandOpen(), on the same 240ms curve. Notice's own strip
        floor never lets the band's height move, only its content."
      span={2}
    >
      <div className="mb-2 flex flex-wrap gap-3">
        <ToggleField label="Auth" value={auth} onChange={setAuth} />
        <ToggleField label="Outage" value={outage} onChange={setOutage} />
        <ToggleField label="Degraded" value={degraded} onChange={setDegraded} />
        <ToggleField label="Update" value={update} onChange={setUpdate} />
      </div>
      <SlowStage>
        <Stage>
          <StripToggleContext.Provider value={toggles}>
            <RootRouter data={homeSolo}>
              <StripBandContent />
            </RootRouter>
          </StripToggleContext.Provider>
        </Stage>
      </SlowStage>
    </Card>
  );
}

// ── 3. Connection recovery, trouble → lost → live ──────────────────────────

// Same RootRouter-freezes-its-children trap as StripToggleContext above: `connected` lives in this
// component and only re-renders ITS OWN tree, but RootRouter's mounted content was captured once at
// first render. Context is what lets the live value reach the ConnectionBanner mounted inside it.
const ConnectedContext = createContext(true);

// No `<StripHost>` here either, for the same reason StripBandContent above does without one:
// RootRouter mounts the real one now, and ConnectionBanner registers a StripSlot into it rather
// than drawing its own row, so wrapping it in a second host would shadow the one it is actually
// speaking to.
function ConnectionBannerLive({ lastSeenAt }: { lastSeenAt: number }) {
  const connected = useContext(ConnectedContext);
  return (
    <ConnectionBanner
      bridge={connected ? "connected" : "disconnected"}
      error={!connected}
      authError={false}
      lastSeenAt={lastSeenAt}
    />
  );
}

function ConnectionRecoveryStage() {
  const [playing, setPlaying] = useState(false);
  const [connected, setConnected] = useState(true);

  // Start clean and leave clean: lib/connection-health.ts is ONE module-scoped store shared with
  // every other ConnectionBanner on the page (and with the top bar's own Connection clock control),
  // so this card must not inherit a stale anchor on mount and must not leave one behind when the
  // operator switches tabs away from it.
  useEffect(() => {
    markLive();
    return () => {
      markLive();
    };
  }, []);

  useEffect(() => {
    if (!playing) return;
    setConnected(false);
    const troubleAt = window.setTimeout(
      () => __resetConnectionHealth(Date.now() - (TROUBLE_MS + 750)),
      300,
    );
    const lostAt = window.setTimeout(
      () => __resetConnectionHealth(Date.now() - (CONNECTION_LOST_MS + 1_000)),
      2_500,
    );
    const liveAt = window.setTimeout(() => {
      markLive();
      setConnected(true);
      setPlaying(false);
    }, 5_000);
    return () => {
      window.clearTimeout(troubleAt);
      window.clearTimeout(lostAt);
      window.clearTimeout(liveAt);
    };
  }, [playing]);

  return (
    <div>
      <div className="mb-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[11px]"
          onClick={() => setPlaying(true)}
          disabled={playing}
        >
          {playing ? "Playing…" : "Play"}
        </Button>
      </div>
      <Stage>
        <ConnectedContext.Provider value={connected}>
          <RootRouter data={homeSolo}>
            <ConnectionBannerLive lastSeenAt={homeSolo.ts - 3_600_000} />
          </RootRouter>
        </ConnectedContext.Provider>
      </Stage>
    </div>
  );
}

function ConnectionRecoveryCard() {
  return (
    <Card
      state="connection-recovery-flash"
      label="connection recovery, trouble to lost to live"
      reach="pull the tailnet out from under a running Collie, then let it return. Press Play to run
        the same three-step escalation on demand: amber at 4s of no live data, red at 15s, a green
        'Connected' flash on recovery."
      note={`GREEN_MS = ${GREEN_MS}ms is how long the recovery flash holds. Overrides the shared
        connection-health clock (lib/connection-health.ts) while playing and restores it (markLive())
        when the sequence ends and on unmount. This is the SAME store the top bar's Connection clock
        control writes every second, so set that control to Live before pressing Play, or the two
        will race. ConnectionBanner registers a StripSlot into the real band RootRouter mounts
        (AUTH/OUTAGE/DEGRADED, lib/strip-priority.ts), the same as it does in routes/root.tsx now, so
        the green flash you see here is the band swapping to the SAME priority a red or amber strip
        already held (DEGRADED for trouble and the flash, OUTAGE for lost), not a new row appearing
        beside it.`}
      span={2}
    >
      <Replay>
        <ConnectionRecoveryStage />
      </Replay>
    </Card>
  );
}

// ── 4. UpdateRibbon, stepping through its states ───────────────────────────

const RIBBON_OPTIONS = [
  { value: "release", label: "Release" },
  { value: "preflight", label: "Preflight" },
  { value: "staging", label: "Staging" },
  { value: "restarting", label: "Restarting" },
  { value: "peers", label: "Peers" },
  { value: "bundle", label: "Bundle" },
] as const;
type RibbonState = (typeof RIBBON_OPTIONS)[number]["value"];

function ribbonUpdateFor(state: RibbonState): UpdateInfo {
  switch (state) {
    case "release":
      return updateRelease;
    case "preflight":
      return updateInFlight("preflight");
    case "staging":
      return updateInFlight("staging");
    case "restarting":
      return updateInFlight("restarting");
    case "peers":
      return updatePeersFollowing;
    case "bundle":
      return updateRestart;
  }
}

/**
 * A router that can push new loader data into an ALREADY-MOUNTED UpdateRibbon, built locally
 * because harness.tsx's own `RootRouter` freezes both `data` and `children` inside a useState
 * initialiser (the same trap StripToggleContext's doc comment names above). UpdateRibbon reads its
 * update info through `useOptionalRootData()`, which is React Router's own `useRouteLoaderData` and
 * cannot be intercepted with a React Context the way StripBandContent and ConnectionBannerLive
 * intercept a plain prop above. The loader closes over a ref instead, and `router.revalidate()`, the
 * same imperative method `useRevalidator()` calls on a route change, re-reads it without remounting
 * anything.
 */
function useRevalidatingRibbonRouter(initial: HomeData) {
  const dataRef = useRef(initial);
  const [router] = useState(() =>
    createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => dataRef.current,
          element: (
            <StripHost>
              <UpdateRibbon />
            </StripHost>
          ),
        },
      ],
      { initialEntries: ["/"] },
    ),
  );
  return { router, dataRef };
}

function UpdateRibbonSwapsCard() {
  const [state, setState] = useState<RibbonState>("release");
  const { router, dataRef } = useRevalidatingRibbonRouter({
    ...homeSolo,
    update: ribbonUpdateFor("release"),
  });

  useEffect(() => {
    dataRef.current = { ...homeSolo, update: ribbonUpdateFor(state) };
    void router.revalidate();
  }, [state, router, dataRef]);

  return (
    <Card
      state="update-ribbon-swaps"
      label="update ribbon, stepping through its states"
      reach="confirm an update and leave the app on any screen. The band counts through the run
        without the Updates page open (see the Dashboard tab's 'update band' cards for each state at
        rest)."
      note="One UpdateRibbon, mounted once, driven by router.revalidate() rather than a remount per
        tap: RootRouter's own loader data is frozen at construction (see the trap named above), so a
        genuine picture of this control needs its own router with a re-readable loader instead. That
        turns out to be worth checking rather than assuming: even without a remount, stepping through
        these six states shows NO cross-fade, because UpdateRibbon registers ONE StripSlot for its
        whole mounted life (it unregisters only when `view.kind` is 'silent', which none of these six
        states are), so the band's OneOf never changes which layer is active, only that layer's
        content. The 120ms cross-fade lives between DIFFERENT slots winning, which the
        strip-band-arbitration card above shows directly. The fixed-height fact still holds: every
        strip, this one included, now sits on Notice's own min-h-[33px] floor rather than a number
        UpdateRibbon states itself."
      span={2}
    >
      <div className="mb-2">
        <Segmented name="ribbon state" value={state} options={RIBBON_OPTIONS} onChange={setState} />
      </div>
      <SlowStage>
        <Stage>
          <RouterProvider router={router} />
        </Stage>
      </SlowStage>
    </Card>
  );
}

// ── 5. Status toast, HeaderStatus & StatusArea ──────────────────────────────

const STATUS_TONES = [
  { value: "info", label: "Info" },
  { value: "success", label: "Success" },
  { value: "warn", label: "Warn" },
  { value: "error", label: "Error" },
] as const satisfies readonly { value: StatusTone; label: string }[];

const STATUS_TEXT = {
  info: "Tab ready",
  success: "Sent",
  warn: "Reconnecting…",
  error: "Send failed, check the connection",
} satisfies Record<StatusTone, string>;

function StatusToastCard() {
  // The page can switch tabs mid-toast; lib/status.ts is a module-scoped store shared with the whole
  // app (every mutation publishes to it), so this card must not leave a status standing behind it.
  useEffect(() => () => clearStatus(), []);
  return (
    <Card
      state="status-toast"
      label="status toast, HeaderStatus and StatusArea"
      reach="any lifecycle status the app publishes: a send confirmation, a kill, a reconnect note, a
        failed mutation (lib/status.ts's setStatus, called from lib/mutate.ts and its call sites)."
      note="Both real components read the SAME module store, so one tap drives both at once.
        HeaderStatus lives in the pane header's title slot (shown here with a placeholder title as its
        fallback); StatusArea is the floating pill every other screen uses. Clears the store on
        unmount, since switching tabs mid-toast must not leave the next section inheriting one."
      span={2}
    >
      <div className="mb-2 flex flex-wrap gap-1.5">
        {STATUS_TONES.map((tone) => (
          <Button
            key={tone.value}
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={() => setStatus(STATUS_TEXT[tone.value], tone.value)}
          >
            {tone.label}
          </Button>
        ))}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px]"
          onClick={() => clearStatus()}
        >
          Clear
        </Button>
      </div>
      <Stage>
        <div className="flex flex-col gap-3 p-4">
          <div>
            <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              HeaderStatus (pane title slot)
            </p>
            <HeaderStatus>
              <span className="truncate text-sm font-semibold">Pane title</span>
            </HeaderStatus>
          </div>
          <div>
            <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              StatusArea (floating pill)
            </p>
            <StatusArea />
          </div>
        </div>
      </Stage>
    </Card>
  );
}
