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

import { useEffect, useState, type ReactNode } from "react";

import { AgentList } from "@/components/agent-list";
import { AlphaBar } from "@/components/alpha-bar";
import { AppHeaderHost, RouteHeader, SettingsGear } from "@/components/app-header";
import { BuildStamp } from "@/components/build-stamp";
import { CollieHome } from "@/components/collie-home";
import { NewSpaceSheet } from "@/components/new-space-sheet";
import { SpaceOverview } from "@/components/space-overview";
import { CollieMark } from "@/components/collie-mark";
import { ConnectionBanner } from "@/components/connection-banner";
import { HostStaleBanner } from "@/components/host-stale-banner";
import { IdleLock } from "@/components/idle-lock";
import { NoEchoNotice } from "@/components/no-echo-notice";
import { PackFooterLink } from "@/components/pack-footer-link";
import { PaneStrip } from "@/components/pane-strip";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { ServerSwitcher } from "@/components/server-switcher";
import { SessionSwitcher } from "@/components/session-switcher";
import { SpaceStrip } from "@/components/space-strip";
import { TabStrip } from "@/components/tab-strip";
import { UpdateAvailableBanner } from "@/components/update-available-banner";
import { UpdateBanner } from "@/components/update-banner";
import { ListGroup } from "@/components/ui/list-group";
import { useTheme, type Theme } from "@/hooks/use-theme";
import { loadOperatorCommands } from "@/lib/operator-config";
import { clearNotPaired, markNotPaired } from "@/lib/pairing";
import { holdReload, releaseReload, __resetReloadGuard } from "@/lib/reload-guard";
import { __resetSelfUpdate, __setReloadImpl } from "@/lib/self-update";
import { observeServerBuild, __resetServerBuild } from "@/lib/server-build";
import { clearStatus, setStatus } from "@/lib/status";
import type { DeviceAuth } from "@/lib/types";
import { BootSplash } from "@/routes/root";
import {
  allPanes,
  censusConflicted,
  censusFive,
  censusNine,
  censusTrio,
  deviceRefused,
  deviceStack,
  devicesPaired,
  devicesUnpaired,
  herd,
  homeNine,
  homePack,
  homeSolo,
  homeTrio,
  hostIncompatible,
  hostNeverSeen,
  hostUnreachable,
  noEchoPrompt,
  paneBlocked,
  paneHostIncompatible,
  paneHostNeverSeen,
  paneHostUnreachable,
  paneShell,
  paneStack,
  paneWorking,
  rosterFive,
  spaces,
  spacesWithWorktrees,
  tabs,
  updateMajor,
  updateRelease,
  updateRestart,
} from "./fixtures";
import {
  Card,
  ChipNav,
  CLOCK_OPTIONS,
  PackedRootRouter,
  PackRouter,
  PaneRouter,
  PaneStackRouter,
  PhoneFrame,
  RootRouter,
  Section,
  Segmented,
  SettingsRouter,
  SideNav,
  Stage,
  useActiveSection,
  useConnectionClock,
  type ClockMode,
  type SectionDef,
} from "./harness";
import { TypefaceCard } from "./typeface-card";

const SECTIONS = [
  {
    id: "brand",
    title: "Brand",
    intent:
      "The app's own voice: the UI typeface under a live switcher, then the three marks it wears — the Collie mark in every weight and state, the multiplexer's own logo as the header prints it, and the installed-app icons at the sizes a launcher actually asks for.",
  },
  {
    id: "boot",
    title: "Boot & connection",
    intent:
      "Everything that answers “is this thing talking to my machine?” — the first paint before any data, the one connection banner, and the header dog that tracks the same two thresholds.",
  },
  {
    id: "idle",
    title: "Idle & resume",
    intent:
      "The pause that appears when Collie is left open, visible and untouched — and the refetch that returning to it fires. A pause, never a gate (ADR 0007).",
  },
  {
    id: "dashboard",
    title: "Dashboard",
    intent:
      "The home screen: the herd in triage order, the strips that say a write will be refused, the two update notices, and the footer's meta zone.",
  },
  {
    id: "pane",
    title: "Pane",
    intent:
      "One terminal, mirrored. The breadcrumb header and status chip, the ANSI mirror with whatever dialog the grammar lifted out of it, and the composer beneath.",
  },
  {
    id: "pack",
    title: "Pack",
    intent:
      "More than one machine. The formation drawing at four sizes, the cards for a pack that isn't one, the host switcher, and the tier-2 banners that name a machine — not a link — as the thing that broke.",
  },
  {
    id: "settings",
    title: "Settings",
    intent:
      "The whole settings route, mounted twice: once on a solo collie with nothing paired, once on a lead with three paired devices and a pack card to show for it.",
  },
] as const satisfies readonly SectionDef[];

const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const satisfies readonly { value: Theme; label: string }[];

type WriteGate = "device" | "pairing";
const GATE_OPTIONS = [
  { value: "device", label: "Device" },
  { value: "pairing", label: "Pairing" },
] as const satisfies readonly { value: WriteGate; label: string }[];

const ON_OFF = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
] as const satisfies readonly { value: "on" | "off"; label: string }[];

export function PlaygroundApp() {
  const [clock, setClock] = useState<ClockMode>("live");
  const [phoneWidth, setPhoneWidth] = useState(false);
  const active = useActiveSection(SECTIONS);
  useConnectionClock(clock);

  // Fill the one-shot `/api/config` store the same way the app does. It is what the header's
  // "on <mux>" caption and its logo read, and it costs one request. With no bridge behind the dev
  // proxy it simply never resolves, and every reader stays at its documented empty answer.
  useEffect(() => {
    void loadOperatorCommands();
  }, []);

  return (
    <div className={phoneWidth ? "pg-narrow" : undefined}>
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-[2000px] gap-6 bg-background px-4 text-foreground lg:px-6">
        <Sidebar
          active={active}
          clock={clock}
          onClock={setClock}
          phoneWidth={phoneWidth}
          onPhoneWidth={setPhoneWidth}
        />

        <main className="min-w-0 flex-1 space-y-10 pb-32 pt-4">
          <TopBar
            active={active}
            clock={clock}
            onClock={setClock}
            phoneWidth={phoneWidth}
            onPhoneWidth={setPhoneWidth}
          />

          <BrandSection />
          <BootSection clock={clock} />
          <IdleSection />
          <DashboardSection />
          <PaneSection />
          <PackSection />
          <SettingsSection />
        </main>
      </div>
    </div>
  );
}

// ── 1. Brand ─────────────────────────────────────────────────────────────────

function BrandSection() {
  return (
    <Section def={SECTIONS[0]}>
      <TypefaceCard />
      <Card
        label="the mark — header weight"
        reach="every screen. 40px in the header bar, 64px on the boot splash and the idle cover."
        note="`paper` is the ground the mark sits on: it is --background here, --muted in the header, --card on the idle cover."
      >
        <Stage>
          <div className="flex flex-wrap items-end gap-6 p-4">
            <MarkSample size={40} weight="header" loading={false} />
            <MarkSample size={40} weight="header" loading />
            <MarkSample size={64} weight="header" loading={false} />
            <MarkSample size={64} weight="header" loading />
          </div>
        </Stage>
      </Card>

      <Card
        label="the mark — full weight"
        reach="the drawing anywhere above about 80px. Below that the full weight's detail closes up and the header weight is used instead."
      >
        <Stage>
          <div className="flex flex-wrap items-end gap-6 p-4">
            <MarkSample size={96} weight="full" loading={false} />
            <MarkSample size={96} weight="full" loading />
            <MarkSample size={132} weight="full" loading />
          </div>
        </Stage>
      </Card>

      <Card
        label="the mark — muted rest"
        reach="let the connection stay lost for 15s. The splash and the header both drop the mark to this rest to say “not connected”."
      >
        <Stage>
          <div className="flex flex-wrap items-end gap-6 p-4">
            <MarkSample size={40} weight="header" loading={false} muted />
            <MarkSample size={64} weight="header" loading={false} muted />
            <MarkSample size={96} weight="full" loading={false} muted />
          </div>
        </Stage>
      </Card>

      <Card
        label="“Collie on <mux>” — the header wordmark"
        reach="open the dashboard or a space view. The caption rides WITH the wordmark and never appears inside a pane, where the breadcrumb owns the middle of the bar."
        note="Real <AppHeaderHost>+<RouteHeader wordmark/>. The name and the logo come from this bridge's own /api/config — so with no bridge behind the dev proxy the caption renders NOTHING, deliberately: “on unknown” would be a worse header than no line at all."
        span={2}
      >
        <Stage>
          <RootRouter data={homeSolo}>
            <AppHeaderHost bridge="connected" error={false}>
              <RouteHeader wordmark rightTrail={<SettingsGear />} />
            </AppHeaderHost>
          </RootRouter>
        </Stage>
      </Card>

      <Card
        label="the prerelease strip — AlphaBar"
        reach="run a v1 alpha build beside the stable install. It never appears at all on a stable
          build — `prereleaseLabel` reads THIS bundle's own baked-in version (lib/build.ts, a vite
          `define`) and returns nothing unless that version carries a SemVer prerelease tag."
        note="`version` is AlphaBar's own injectable prop (its test seam, alpha-bar.test.tsx uses the
          same one) — the honest way to stand in for the vite define without editing the component or
          faking the build. In the real app it is mounted once, inside the one <AppHeaderHost/> above
          the wordmark row — the header is hoisted out of the routes now, so there is exactly one of
          it for the app's lifetime; it is shown here on its own so its `version` seam can be driven."
        span={2}
      >
        <Stage>
          <div className="flex flex-col">
            <AlphaBar version="1.0.0-alpha.3" />
            <AlphaBar version="2.0.0-rc.1" />
          </div>
        </Stage>
      </Card>

      <Card
        label="favicon & installed-app tiles, at their real sizes"
        reach="install the PWA, or look at the browser tab. Each tile below is at its native pixel size — no upscaling — so the ones that get downsampled by a launcher can be judged as drawn."
        span={2}
      >
        <Stage>
          <div className="flex flex-wrap items-end gap-6 p-4">
            <IconSample src="/favicon.svg" size={16} label="favicon.svg @16" />
            <IconSample src="/favicon.svg" size={32} label="favicon.svg @32" />
            <IconSample src="/favicon.ico" size={16} label="favicon.ico 16×16" />
            <IconSample src="/favicon-96x96.png" size={96} label="favicon 96×96" />
            <IconSample src="/apple-touch-icon.png" size={180} label="apple-touch 180×180" />
            <IconSample src="/web-app-manifest-192x192.png" size={192} label="manifest 192×192" />
          </div>
        </Stage>
      </Card>

      <Card
        label="the 512 tile"
        reach="the manifest's largest icon — what a launcher downsamples from, and what a splash screen uses whole."
        span={2}
      >
        <Stage>
          <div className="p-4">
            <IconSample src="/web-app-manifest-512x512.png" size={512} label="manifest 512×512" />
          </div>
        </Stage>
      </Card>
    </Section>
  );
}

// ── 2. Boot & connection ─────────────────────────────────────────────────────

function BootSection({ clock }: { clock: ClockMode }) {
  return (
    <Section def={SECTIONS[1]}>
      <Card
        label={`boot splash — connecting → not connected (clock: ${clock})`}
        reach="the very first load, before the snapshot resolves. It escalates to “Not connected” once that first fetch has been stuck for 15s — e.g. reopening the PWA with the tailnet down."
        note="Real <BootSplash/> from routes/root.tsx, reading the shared clock. Move the sidebar's CONNECTION CLOCK to pick which half you see."
      >
        <Stage height={340} dvh>
          <RootRouter data={homeSolo}>
            <BootSplash />
          </RootRouter>
        </Stage>
      </Card>

      <Card
        label={`connection banner — trouble → lost (clock: ${clock})`}
        reach="pull the tailnet out from under a running Collie. Amber “reconnecting…” after 4s; red with a named cause plus Retry/Reload after 15s; a green flash on recovery."
        note="Red runs the genuine /api/config probe through the dev proxy, so the cause sentence names whatever the bridge on COLLIE_DEV_TARGET actually answers."
      >
        <Stage>
          <RootRouter data={homeSolo}>
            <ConnectionBanner
              bridge="disconnected"
              error
              authError={false}
              lastSeenAt={homeSolo.ts - 3_600_000}
            />
          </RootRouter>
        </Stage>
      </Card>

      <Card
        label="connection banner — refused (401/403)"
        reach="let the fronting proxy's identity session expire. A refusal is not an outage, and the banner says so rather than blaming the link."
      >
        <Stage>
          <RootRouter data={homeSolo}>
            <ConnectionBanner bridge={undefined} error authError />
          </RootRouter>
        </Stage>
      </Card>

      <Card
        label={`header dog — the full bar (clock: ${clock})`}
        reach="same two thresholds as the banner: the mark blooms on sustained trouble and rests muted once the outage is lost."
        note="Follows the shared clock, so this card and the banner above always agree — that is the property the single module-scoped clock exists to guarantee."
      >
        <Stage>
          <RootRouter data={homeSolo}>
            <AppHeaderHost bridge="disconnected" error>
              <RouteHeader wordmark rightTrail={<SettingsGear />} />
            </AppHeaderHost>
          </RootRouter>
        </Stage>
      </Card>

      <Card
        label="header dog — live · troubled · lost, side by side"
        reach="you cannot reach all three at once for real; there is one clock. <CollieHome/> takes them as ordinary props, which is the one way to line them up."
      >
        <Stage>
          <div className="flex flex-col gap-1 bg-muted p-2">
            <CollieHome trouble={false} wordmark />
            <CollieHome trouble wordmark />
            <CollieHome trouble lost wordmark />
          </div>
        </Stage>
      </Card>
    </Section>
  );
}

// ── 3. Idle & resume ─────────────────────────────────────────────────────────

function IdleSection() {
  return (
    <Section def={SECTIONS[2]}>
      <Card
        label="idle lock — paused"
        reach="leave Collie open, visible and untouched. A hidden page never locks; polling stops and the app stays mounted underneath, so an in-progress composer draft survives."
      >
        <Stage height={420}>
          <IdleLock onUnlock={() => {}} />
        </Stage>
      </Card>

      <Card
        label="idle lock — catching up"
        reach="touch the paused screen, or bring the tab back to the foreground. The cover stays up for exactly as long as the resume refetch is in flight."
        note="Both states sit on the page at once because `catchingUp` is a prop, not a clock."
      >
        <Stage height={420}>
          <IdleLock onUnlock={() => {}} catchingUp />
        </Stage>
      </Card>
    </Section>
  );
}

// ── 4. Dashboard ─────────────────────────────────────────────────────────────

function DashboardSection() {
  return (
    <Section def={SECTIONS[3]}>
      <Card
        label="agent list — a working herd, all four sections"
        reach="the dashboard on a busy day. The order is the one the whole app agrees on: Needs you → Ready · unseen → Working → Recent."
        note="Fourteen panes across four spaces and five harnesses. `gemini` has no bundled logo, so it lands on the neutral initials tile — the honest rendering, not a placeholder."
        span={2}
      >
        <PhoneFrameCard>
          <AgentList agents={herd} bridge="connected" onOpen={() => {}} />
        </PhoneFrameCard>
      </Card>

      <Card
        label="agent list — empty"
        reach="a Herdr session with no agent panes in it. Nothing is wrong; there is simply nothing running."
      >
        <Stage height={220}>
          <AgentList agents={[]} bridge="connected" onOpen={() => {}} />
        </Stage>
      </Card>

      <Card
        label="agent list — empty AND stale"
        reach="the bridge stops answering while the herd list is empty. “Nothing is running” and “we do not know what is running” are different sentences, and this is the second one."
      >
        <Stage height={220}>
          <AgentList
            agents={[]}
            bridge={undefined}
            onOpen={() => {}}
            error
            lastSeenAt={homeSolo.ts - 3_600_000}
          />
        </Stage>
      </Card>

      <WriteGateCard />

      <Card
        label="the three strips — spaces › tabs › panes"
        reach="open a space. The three navigation rows stack under the header, one level apart, and every one of them overflows on a phone. Scroll each row sideways: the name stays put, because it sits above the scroller rather than inside it."
        note="Real <SpaceStrip>, <TabStrip> and <PaneStrip> with the fixture herd, in a 390px frame — the width the row was measured at. The chips are live: tapping one moves the selection. Every pill is drawn 34px tall and answers a 46px touch: the extra 12px is a transparent hit area inside the row's own padding, so the tap floor costs no height. Try tapping just above or just below a pill."
        span={2}
      >
        <PhoneFrameCard height={240}>
          <StripsHarness />
        </PhoneFrameCard>
      </Card>

      <Card
        label="space strip — the drill-in (leads with Back)"
        reach="tap into a single space. The row leads with an explicit way back instead of the “All” chip."
        note="Same height as the card above, deliberately: the label is drawn in both states, so navigating in and out does not jump the page."
        span={2}
      >
        <PhoneFrameCard height={140}>
          <StripsHarness backOnly />
        </PhoneFrameCard>
      </Card>

      <Card
        label="update — the slim top row"
        reach="a fresh build is confirmed on the server but the app cannot auto-update right now: unsent work, an open sheet, an upload — or it already auto-updated once for this build."
        note="Driven through the actual controller: a reload hold is taken and a newer build id is observed twice, which is the hysteresis the real poll performs."
      >
        <Stage>
          <StaleBuildHarness />
        </Stage>
      </Card>

      <Card
        label="update — the footer chip, all three states"
        reach="read off the snapshot's `update` block. Precedence: a stale running PROCESS outranks an available release, which outranks a major that needs explicit consent (ADR 0020)."
        note="Three snapshots, three routers — the three cannot be true at once on one bridge."
      >
        <Stage>
          <ListGroup>
            <RootRouter data={{ ...homeSolo, update: updateRestart }}>
              <div className="p-3">
                <UpdateBanner />
              </div>
            </RootRouter>
            <RootRouter data={{ ...homeSolo, update: updateRelease }}>
              <div className="p-3">
                <UpdateBanner />
              </div>
            </RootRouter>
            <RootRouter data={{ ...homeSolo, update: updateMajor }}>
              <div className="p-3">
                <UpdateBanner />
              </div>
            </RootRouter>
          </ListGroup>
        </Stage>
      </Card>

      <Card
        label="footer — pack link + build stamp"
        reach="scroll to the bottom of the dashboard. The pack line renders only on a multi-machine roster; on a solo collie the footer is the build stamp alone."
        note="BuildStamp asks /api/config once for the bridge's own build, so the second line fills in only against a live bridge."
      >
        <Stage>
          <PackedRootRouter data={homePack}>
            <div className="pb-3">
              <PackFooterLink scope={{}} className="px-3 pt-3" />
              <BuildStamp className="px-3 pt-3" />
            </div>
          </PackedRootRouter>
        </Stage>
      </Card>

      <Card
        label="session switcher"
        reach="run more than one named Herdr session. The chip names the current one; the sheet lists the rest with their per-session counts, and an unreachable session is greyed out."
      >
        <Stage>
          <RootRouter data={homeSolo}>
            <div className="flex items-center gap-2 p-3">
              <SessionSwitcher sessions={homeSolo.sessions} scope={{}} viewAll={false} />
            </div>
          </RootRouter>
        </Stage>
      </Card>
    </Section>
  );
}

// ── 5. Pane ──────────────────────────────────────────────────────────────────

function PaneSection() {
  return (
    <Section def={SECTIONS[4]}>
      <Card
        label="pane — blocked on a permission prompt"
        reach="an agent asks to run something. Everything here is the real pane view — breadcrumb header, StatusBadge, mirror, composer — over a byte-faithful capture from web/src/fixtures/panes/."
        note="Reads are real; WRITES are not. Tapping an option posts to /api/pane/… and the screen never advances, because nothing on this page is a live terminal. Read it as a photograph."
        span={2}
      >
        <PhoneFrameCard height={760}>
          <PaneRouter home={homeSolo} fixture={paneBlocked} />
        </PhoneFrameCard>
      </Card>

      <Card
        label="pane — mid tool-run"
        reach="watch an agent while it works. This is what the ANSI mirror has to colour: a live screen, no dialog, the composer free."
        span={2}
      >
        <PhoneFrameCard height={760}>
          <PaneRouter home={homeSolo} fixture={paneWorking} />
        </PhoneFrameCard>
      </Card>

      <Card
        label="pane — a bare shell, composer locked read-only"
        reach="open a shell pane from a device the bridge will not let write. No agent means no grammar and a ShellBadge in place of the status chip; the write gate locks the composer and raises its banner above it."
        note="The shell screen is hand-written ANSI, not a capture — the fixture corpus is a corpus of AGENT screens, and a bare shell has no grammar to pin."
        span={2}
      >
        <PhoneFrameCard height={760}>
          <PaneRouter home={homeSolo} fixture={paneShell} readOnly />
        </PhoneFrameCard>
      </Card>

      <Card
        label="no-echo notice — the composer refused a password prompt"
        reach="tap Send at a pane sitting on `sudo`/`ssh`/`gpg`'s password prompt. Echo is off, so the
          reply guard's usual evidence can never arrive, and Send is refused every time — this notice
          is the one sentence that says why and points at the control that works (composer.tsx:1109)."
        note="Real <NoEchoNotice/>, state-driven rather than reached through a live send (playground
          writes go nowhere, and this path needs a real `res.noEcho`). `typed` picks which of the four
          sentences shows; the ✕ is wired to real state — this is the only notice in the app with a
          real dismiss, and tapping it here removes the card's content, not just a class."
      >
        <NoEchoNoticeHarness />
      </Card>

      <Card
        label="the worst case — every notice live at once"
        reach="never all six at once by accident, but never impossible either: a stale proxy session
          (401), a confirmed-but-held update, a status toast, a device this proxy doesn't allowlist,
          and a peer that has gone quiet — all independent facts that can coincide on one pane."
        note="GENUINE together: UpdateAvailableBanner + ConnectionBanner (RootLayout's own two in-flow
          rows) wrapping the real StatusArea/ReadOnlyBanner/HostStaleBanner/mirror inside the real
          AgentChat — the exact nesting routes/root.tsx uses. STAGED: the five causes are independently
          driven rather than provoked by one real outage, so they can be shown together on demand; nothing
          here is a state the app cannot produce, only a coincidence forced for review. The red
          ConnectionBanner is the auth-error branch (see PaneStackRouter's doc comment in harness.tsx)
          rather than the trouble→lost escalation, which this page cannot repaint on command — the
          clock's own `__resetConnectionHealth` never calls its store's `emit()`, so a control flip only
          takes effect once each consumer's own mount timer next fires. That gap sits in lib/, outside
          this pass's file allowlist — recommend fixing it there, not worked around by editing the
          store from here. StatusArea is behind its own toggle below rather than always on: `lib/
          status.ts` is ALSO a page-wide singleton, and every OTHER pane card on this page mounts a
          real AgentChat too — an always-on toast here would silently print on every one of them.
          Toggle it on only while measuring this card, then off again."
        span={2}
      >
        <PhoneFrameCard height={800}>
          <StackHarness />
        </PhoneFrameCard>
      </Card>
    </Section>
  );
}

// ── 6. Pack ──────────────────────────────────────────────────────────────────

function PackSection() {
  return (
    <Section def={SECTIONS[5]}>
      <Card
        label="formation — solo (lead + deputy + one)"
        reach="Settings → Pack on a collie that leads a small pack. Lead at the apex, deputy beneath it on the thick connector, everyone else fanned into a V."
        span={2}
      >
        <PhoneFrameCard height={640}>
          <PackRouter home={homeTrio} pack={{ status: censusTrio, error: false }} />
        </PhoneFrameCard>
      </Card>

      <Card
        label="formation — five machines, three problems"
        reach="a real pack that has been running a while: one peer gone quiet, one enrolled and never once reached, one speaking a protocol this lead cannot. Tap a machine for its paperwork."
        note="The incompatible member's reason is the peer's own words, printed verbatim — the fix follows from the wording, so it is never paraphrased."
        span={2}
      >
        <PhoneFrameCard height={640}>
          <PackRouter home={homePack} pack={{ status: censusFive, error: false }} />
        </PhoneFrameCard>
      </Card>

      <Card
        label="formation — nine machines (the V wraps)"
        reach="keep adding peers. Past about six the fan cannot stay on one row and the layout wraps it — this is the card that says whether it still reads as a formation."
        span={2}
      >
        <PhoneFrameCard height={640}>
          <PackRouter home={homeNine} pack={{ status: censusNine, error: false }} />
        </PhoneFrameCard>
      </Card>

      <Card
        label="formation — a conflicted member"
        reach="two collies both believe they lead this pack. Not a transient the next poll clears, so the page names it rather than folding it into “unreachable”."
        span={2}
      >
        <PhoneFrameCard height={640}>
          <PackRouter home={homeTrio} pack={{ status: censusConflicted, error: false }} />
        </PhoneFrameCard>
      </Card>

      <Card
        label="pack — solo (a 404 is an answer)"
        reach="open Settings → Pack on a collie that leads no pack. The bridge answers 404, which the loader turns into `null` — “there is no pack here” is an answer, not a failure."
      >
        <Stage height={300}>
          <PackRouter home={homeSolo} pack={{ status: null, error: false }} />
        </Stage>
      </Card>

      <Card
        label="pack — the census could not be fetched"
        reach="open the same page with the bridge down. This one IS a failure, and it says so differently from the solo card above."
      >
        <Stage height={300}>
          <PackRouter home={homeSolo} pack={{ status: null, error: true }} />
        </Stage>
      </Card>

      <Card
        label="host switcher"
        reach="be on a pack with more than one reachable machine. The chip names where you are; tap it for the sheet."
        note="The sheet's open/closed state is the component's OWN — there is no `open` prop to force, and inventing one would be a fork. Tap the chip; the sheet is portalled to <body>, so it takes the whole window."
      >
        <Stage height={120}>
          <PackedRootRouter data={homePack}>
            <div className="flex items-center gap-2 p-3">
              <ServerSwitcher servers={rosterFive} scope={{}} agents={homePack.agents} />
            </div>
          </PackedRootRouter>
        </Stage>
      </Card>

      <Card
        label="host-stale banner — unreachable"
        reach="on a pack: your link is fine but this pane's MACHINE is not. It appears inside the pane frame, over the last screen that machine did send."
        note="Hand-built HostHealth values — the banner's table is keyed on `state` and `writable` TOGETHER, so a row of it can only be shown by stating both."
      >
        <Stage>
          <HostStaleBanner health={hostUnreachable} />
        </Stage>
      </Card>

      <Card
        label="host-stale banner — never seen"
        reach="`collie pack add` a machine that has not come up yet. There is no cached screen behind this one, which is what makes it a different sentence."
      >
        <Stage>
          <HostStaleBanner health={hostNeverSeen} />
        </Stage>
      </Card>

      <Card
        label="host-stale banner — protocol incompatible"
        reach="run a peer on a Collie whose pack protocol this lead cannot speak. `collie pack update` levels it to the lead's own commit."
      >
        <Stage>
          <HostStaleBanner health={hostIncompatible} />
        </Stage>
      </Card>

      <Card
        label="host-stale banner — inside a real pane (unreachable)"
        reach="open a pane on a peer that has gone quiet. It sits above the tab strip and the mirror, inside the pane frame — never the standalone box the three cards above show it in."
        note="Real <PaneRouter/> on homePack (rosterFive), the pane re-hosted onto `attic` — the SAME
          real AgentChat mount the Pane section uses, run through the real hostHealth() derivation
          instead of a hand-built HostHealth. Every homeSolo pane fixture in the Pane section above
          uses rosterSolo (empty), which is why this banner could never appear there."
        span={2}
      >
        <PhoneFrameCard height={760}>
          <PaneRouter home={homePack} fixture={paneHostUnreachable} />
        </PhoneFrameCard>
      </Card>

      <Card
        label="host-stale banner — inside a real pane (never seen)"
        reach="`collie pack add` a machine, open a pane tagged to it before it has ever come up."
        span={2}
      >
        <PhoneFrameCard height={760}>
          <PaneRouter home={homePack} fixture={paneHostNeverSeen} />
        </PhoneFrameCard>
      </Card>

      <Card
        label="host-stale banner — inside a real pane (incompatible)"
        reach="open a pane on a peer running a pack protocol this lead cannot speak."
        span={2}
      >
        <PhoneFrameCard height={760}>
          <PaneRouter home={homePack} fixture={paneHostIncompatible} />
        </PhoneFrameCard>
      </Card>
    </Section>
  );
}

// ── 7. Settings ──────────────────────────────────────────────────────────────

function SettingsSection() {
  return (
    <Section def={SECTIONS[6]}>
      <Card
        label="settings — solo collie, nothing paired"
        reach="tap the gear from the dashboard. With no device paired, writes are ungated and the Paired devices card offers the pairing verb instead of a list."
        note="The whole real route. Two things on it still reach the network on purpose — /api/config for the diagnostics build, and the browser's own push subscription — and both fail soft, so the page renders whole with no bridge."
        span={2}
      >
        <PhoneFrameCard height={760}>
          <SettingsRouter home={homeSolo} devices={devicesUnpaired} />
        </PhoneFrameCard>
      </Card>

      <Card
        label="settings — lead of a pack, three devices paired"
        reach="pair a phone with `collie pair`, then open Settings on the lead. The Pack card appears only on a multi-machine roster; the device list names which row is the phone you are holding."
        span={2}
      >
        <PhoneFrameCard height={760}>
          <SettingsRouter home={homePack} devices={devicesPaired} />
        </PhoneFrameCard>
      </Card>
      <Card
        label="spaces — a repo and its worktrees"
        reach="open a worktree of a repo you already have open as a space. Herdr reports the repo on both, so the list nests the worktree under the checkout showing that repo — no extra call, and nothing to switch on."
        note="`blog` sits outside any repo and stays flat, which is the same row it always was. A worktree whose repo is NOT open would also stay flat: there would be nothing to indent under."
        span={2}
      >
        <PhoneFrameCard height={430}>
          <SpaceOverview
            workspaces={spacesWithWorktrees}
            // No agents: this card is about SHAPE. With a herd attached every row also carries its
            // triage tint, and a wall of "needs you" red says nothing about nesting.
            agents={[]}
            onOpen={() => {}}
            onNewSpace={() => {}}
            open
            onOpenChange={() => {}}
          />
        </PhoneFrameCard>
      </Card>

      <Card
        label="new space — the worktree tab"
        reach="tap + on the spaces list where at least one open space sits in a repo. With no repo open (or a multiplexer that cannot make one) the tab strip is not rendered at all and this is the plain new-space sheet."
        note="The repo picker is here because the sheet is opened from the LIST, where there is no current space to take a repo from. `Or open one that already exists` reads the worktrees of the chosen repo once — it is the only route to a checkout that is not a space."
        span={2}
      >
        <PhoneFrameCard height={560}>
          <NewSpaceSheet
            open
            onClose={() => {}}
            onCreate={() => {}}
            repos={[
              { workspaceId: "w1", repoRoot: "/src/collie", label: "collie" },
              { workspaceId: "w9", repoRoot: "/src/nixcfg", label: "nixcfg" },
            ]}
            onCreateWorktree={() => {}}
            onOpenWorktree={() => {}}
          />
        </PhoneFrameCard>
      </Card>

    </Section>
  );
}

// ── The page's own chrome ────────────────────────────────────────────────────

interface ControlProps {
  active: string;
  clock: ClockMode;
  onClock: (next: ClockMode) => void;
  phoneWidth: boolean;
  onPhoneWidth: (next: boolean) => void;
}

/** Desktop: a sticky rail. Hidden below `lg`, where {@link TopBar}'s chip row takes over. */
function Sidebar({ active, clock, onClock, phoneWidth, onPhoneWidth }: ControlProps) {
  return (
    <aside className="hidden w-[220px] shrink-0 lg:block">
      <div className="sticky top-0 max-h-[100dvh] overflow-y-auto py-4">
        <h1 className="text-sm font-semibold tracking-tight">Collie — states playground</h1>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Dev-only page. Not in the production bundle.
        </p>
        <div className="mt-4">
          <SideNav sections={SECTIONS} active={active} />
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
        <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
          The connection clock is GLOBAL because the thing it drives is: one module-scoped store
          feeds the banner, the header dog and the boot splash, so they can never disagree. A control
          parked inside one section would quietly be repainting three others.
        </p>
      </div>
    </aside>
  );
}

/** Narrow: the same nav as a scrolling chip row, with the controls above it. */
function TopBar({ active, clock, onClock, phoneWidth, onPhoneWidth }: ControlProps) {
  return (
    <header className="sticky top-0 z-30 -mx-4 border-b border-border bg-background/95 px-4 py-2 backdrop-blur lg:hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-2">
        <h1 className="text-sm font-semibold tracking-tight">Collie — states playground</h1>
        <Controls
          clock={clock}
          onClock={onClock}
          phoneWidth={phoneWidth}
          onPhoneWidth={onPhoneWidth}
        />
      </div>
      <ChipNav sections={SECTIONS} active={active} />
    </header>
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

/**
 * The three navigation strips, stacked as the space route stacks them (space › tab › pane) and
 * wired to real state so the selection actually moves. `backOnly` shows the drill-in branch, where
 * SpaceStrip leads with Back instead of the "All" chip.
 *
 * They need no provider: every capability they gate on reads as present when no bridge has said
 * otherwise (lib/mux-capability.ts), which is the same answer the real app gets on a fresh load.
 */
function StripsHarness({ backOnly = false }: { backOnly?: boolean }) {
  const [space, setSpace] = useState<string | null>("w1");
  const [tab, setTab] = useState<string | null>("w1:t1");
  const panes = allPanes.filter((p) => p.tabId === "w1:t1");
  const [pane, setPane] = useState(panes[0]?.paneId ?? "");
  return (
    <div className="flex flex-col">
      <SpaceStrip
        workspaces={spaces}
        agents={allPanes}
        selected={space}
        onSelect={setSpace}
        onNewSpace={() => {}}
        onBack={backOnly ? () => {} : undefined}
      />
      {!backOnly && (
        <>
          <TabStrip
            workspaceId={space ?? "w1"}
            tabs={tabs}
            agents={allPanes}
            selected={tab}
            onSelect={setTab}
            onNewTab={() => {}}
          />
          <PaneStrip panes={panes} currentPaneId={pane} onSelect={setPane} />
        </>
      )}
    </div>
  );
}

/**
 * A phone frame that centres itself in its (two-column) card. Route-level components are written for
 * a screen; given a card's width they read as a widget, so they get 390px and their own scrollbar.
 */
function PhoneFrameCard({ height, children }: { height?: number; children: ReactNode }) {
  return (
    <div className="flex justify-center">
      <PhoneFrame height={height}>{children}</PhoneFrame>
    </div>
  );
}

function MarkSample({
  size,
  weight,
  loading,
  muted = false,
}: {
  size: number;
  weight: "full" | "header";
  loading: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <CollieMark
        size={size}
        weight={weight}
        loading={loading}
        paper="var(--background)"
        className={muted ? "opacity-40 grayscale" : undefined}
      />
      <span className="font-mono text-[10px] text-muted-foreground">
        {size} {weight}
        {loading ? " loading" : ""}
        {muted ? " muted" : ""}
      </span>
    </div>
  );
}

function IconSample({ src, size, label }: { src: string; size: number; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <img src={src} width={size} height={size} alt={label} className="max-w-full" />
      <span className="font-mono text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}

// ── Two small store-driven harnesses ─────────────────────────────────────────

/**
 * The two write gates are independent on the bridge and compose by AND, and the pairing latch is
 * checked FIRST — so only one of the two strips can ever be on screen. The control picks which fact
 * is true rather than pretending both can be.
 */
function WriteGateCard() {
  const [gate, setGate] = useState<WriteGate>("device");

  useEffect(() => {
    if (gate === "pairing") markNotPaired();
    else clearNotPaired();
    return () => clearNotPaired();
  }, [gate]);

  return (
    <Card
      label={gate === "pairing" ? "read-only — not paired" : "read-only — device not allowlisted"}
      reach={
        gate === "pairing"
          ? "open Collie on a phone that holds no bearer token, or whose token was revoked. The remedy is on the phone: pair it."
          : "put a fronting proxy in front that names this device, and leave the name off the bridge's allowlist. Nothing on the phone can fix it."
      }
      note="The pairing latch is set through lib/pairing's own markNotPaired/clearNotPaired, and it OUTRANKS the device gate — the two can never both show, so pick one."
    >
      <div className="mb-2">
        <Segmented value={gate} options={GATE_OPTIONS} onChange={setGate} />
      </div>
      {/* 390px and the routes' own `mx-4 mt-3`: this box WRAPS in five of six locales, so its
          height is a function of the width it is read at, and a card-wide stage measures a box
          nobody has. The gutter rides the component the way home.tsx and space.tsx pass it. */}
      <div className="mx-auto w-[390px] max-w-full">
        <Stage>
          <ReadOnlyBanner device={deviceRefused} />
          <div className="h-3" />
        </Stage>
      </div>
    </Card>
  );
}

/**
 * Drive the self-updater to its "confirmed stale but held" state the way the real poll does: take a
 * reload hold (what an open composer draft or an in-flight upload does), then observe a server build
 * id that is not ours twice — the hysteresis needs two consecutive sightings before it acts.
 * `__setReloadImpl` is the module's own test seam, and it is what stops the page reloading itself.
 */
function StaleBuildHarness() {
  useEffect(() => {
    __resetSelfUpdate();
    __setReloadImpl(() => {});
    holdReload("collie-playground");
    observeServerBuild("collie-playground-newer-build");
    observeServerBuild("collie-playground-newer-build");
    return () => {
      releaseReload("collie-playground");
      __resetReloadGuard();
      __resetServerBuild();
      __resetSelfUpdate();
    };
  }, []);
  return <UpdateAvailableBanner />;
}

// ── Gap 2: NoEchoNotice ───────────────────────────────────────────────────────

type NoEchoTyped = "untyped" | "typed";
const NO_ECHO_OPTIONS = [
  { value: "untyped", label: "Not typed yet" },
  { value: "typed", label: "Already typed" },
] as const satisfies readonly { value: NoEchoTyped; label: string }[];

/**
 * `NoEchoNotice`, state-driven since a real refusal needs a live send this page cannot produce
 * (`res.noEcho`). `typed` picks which of the four sentences shows; the ✕ is wired to REAL local state
 * — this is the only notice in the app with a real dismiss, so tapping it here has to remove the
 * notice, not just prove a class toggled.
 */
function NoEchoNoticeHarness() {
  const [typed, setTyped] = useState<NoEchoTyped>("untyped");
  const [dismissed, setDismissed] = useState(false);
  return (
    <>
      <div className="mb-2">
        <Segmented value={typed} options={NO_ECHO_OPTIONS} onChange={setTyped} />
      </div>
      <Stage>
        <div className="p-3">
          {dismissed ? (
            <button
              type="button"
              className="text-[11px] text-muted-foreground underline underline-offset-4"
              onClick={() => setDismissed(false)}
            >
              dismissed — tap to show it again
            </button>
          ) : (
            <NoEchoNotice
              prompt={noEchoPrompt}
              typed={typed === "typed"}
              onUseType={() => {}}
              onDismiss={() => setDismissed(true)}
            />
          )}
        </div>
      </Stage>
    </>
  );
}

// ── Gap 4: the stack ─────────────────────────────────────────────────────────

/**
 * The header gate as a device the bridge DOES allowlist — the same fixture with one bit flipped, so
 * the read-only box can be made to leave as well as to arrive. Frozen at module scope: a fresh
 * object each render would re-run every `device`-keyed effect inside the real AgentChat below.
 */
const deviceStackAllowed: DeviceAuth = { ...deviceStack, authorized: true };

/**
 * Drives the self-updater's "confirmed stale but held" state (same recipe as
 * {@link StaleBuildHarness}, its own hold key so the two cards don't fight over one). `ConnectionBanner`'s
 * red and `ReadOnlyBanner`/`HostStaleBanner`'s locks are plain props on {@link PaneStackRouter} — see
 * its own doc comment in harness.tsx for why the red state is the auth-error branch, not the
 * escalation clock. `StatusArea` is NOT driven here — see {@link StackHarness}'s own toggle, and why.
 *
 * Cleanup releases only THIS component's own hold — never the shared
 * `__resetSelfUpdate()`/`__resetServerBuild()`/`__resetReloadGuard()` reset {@link StaleBuildHarness}
 * uses, because that reset is GLOBAL and this card and that one are both mounted on the page at once:
 * either one remounting (a Vite HMR update to just this file, say) must not blank the other's banner.
 */
function StackHarness() {
  const [showStatus, setShowStatus] = useState(false);
  // The ReadOnlyBanner is the one surface on this card that can be made to appear and disappear on
  // demand, and after its ui/notice.tsx conversion that transition is the thing worth looking at:
  // it opens and closes over 240ms instead of popping, and the mirror under it resizes with it
  // rather than teleporting. Flip this while watching the terminal tail.
  const [readOnly, setReadOnly] = useState(true);

  useEffect(() => {
    __setReloadImpl(() => {});
    holdReload("collie-playground-stack");
    observeServerBuild("collie-playground-newer-build");
    observeServerBuild("collie-playground-newer-build");
    return () => releaseReload("collie-playground-stack");
  }, []);

  // `lib/status.ts` is a page-wide singleton, same shape as `lib/connection-health.ts` — and unlike
  // the real app, this ONE page mounts several real `AgentChat`s (and therefore several real
  // `StatusArea`s) at once. Firing it unconditionally on mount would print this card's toast on
  // every other pane card too. So it is opt-in, and this card is the only reader that clears it again.
  useEffect(() => {
    if (!showStatus) return;
    setStatus("Reply sent · 3 lines", "success", null);
    return () => clearStatus();
  }, [showStatus]);

  return (
    <div className="flex h-full flex-col">
      <button
        type="button"
        onClick={() => setShowStatus((v) => !v)}
        className="shrink-0 border-b border-border bg-muted px-3 py-1 text-left text-[11px] font-medium text-muted-foreground"
      >
        {showStatus
          ? "StatusArea toast: ON — tap to clear (and stop it leaking into every other pane card)"
          : "StatusArea toast: off — tap to fire one (leaks into every other pane card while on)"}
      </button>
      <button
        type="button"
        onClick={() => setReadOnly((v) => !v)}
        className="shrink-0 border-b border-border bg-muted px-3 py-1 text-left text-[11px] font-medium text-muted-foreground"
      >
        {readOnly
          ? "read-only box: ON — tap to lift the gate and watch it collapse out"
          : "read-only box: off — tap to refuse this device and watch it collapse in"}
      </button>
      <div className="min-h-0 flex-1">
        <PaneStackRouter
          home={homePack}
          fixture={paneStack}
          device={readOnly ? deviceStack : deviceStackAllowed}
        />
      </div>
    </div>
  );
}
