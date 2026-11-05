// "Backdrop": three ground patterns for the default theme `collie`, side by side on one screen. Nothing
// here ships. Option 1 is Harbour's own `grain` word, read from the surface table; options 2 and 3 are
// built the same way (the page colour with 4 percent of the foreground, `color-mix(in oklab, ...)`)
// and live in this file only. Each pattern is laid on its own frame the way index.css lays
// `--ground-image` on `html`: the page colour under, the image over. Light and dark follow the page's
// own Theme switch in the top bar.
//
// DEV-ONLY, unreachable from the app entry. Every word and row on the phones is the app's own.

import { AgentList, type HeadingNewTab } from "@/components/agent-list";
import { AppHeaderHost, RouteHeader, SettingsGear } from "@/components/app-header";
import { ServerSwitcher } from "@/components/server-switcher";
import { SessionSwitcher } from "@/components/session-switcher";
import { sessionsOnHost } from "@/lib/hosts";
import type { HomeData } from "@/lib/loaders";
import type { ServerSummary } from "@/lib/types";
import { GROUND_GRAIN_LINE, SURFACE } from "@/lib/theme/surface";

import { herd, homeSolo, sessionsSolo, tabs, TS } from "../fixtures";
import { PackedRootRouter } from "../harness";
import { Section, type SectionDef } from "../layout";
import { Round, type RoundOption } from "../round";

export const DEF: SectionDef = { id: "backdrop", title: "Backdrop" };

/** The line and dot colour of all three options: the page with 4 percent of the foreground, spelled as `groundMix` spells it. */
const LINE = `color-mix(in oklab, var(--${GROUND_GRAIN_LINE.base}) ${100 - GROUND_GRAIN_LINE.percent}%, var(--${GROUND_GRAIN_LINE.mix}))`;

/** Option 1: Harbour's `grain` word, the two diagonal sets, taken from the surface table. */
const CROSSED_GRAIN = SURFACE.ground.grain[0][1];
/** Option 2: a 1px dot on a square grid, 6px pitch (the pitch is its `background-size`). */
const DOT_GRID = `radial-gradient(circle at 0.5px 0.5px, ${LINE} 0.5px, transparent 0.6px)`;
const DOT_PITCH = "6px 6px";
/** Option 3: a 1px horizontal line every 8px. */
const RULED_LINES = `repeating-linear-gradient(to bottom, ${LINE} 0 1px, transparent 1px 8px)`;

const ROSTER: ServerSummary[] = [
  { id: "bluefin", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: TS - 2_000 },
  { id: "minibuch", name: "minibuch", isLead: false, reachable: true, protocol: "ok", lastSeenAt: TS - 3_000 },
];

/** The playground's herd, trimmed to a few rows so open page shows between and below them. */
const DATA: HomeData = {
  ...homeSolo,
  agents: [herd[0]!, herd[2]!, herd[4]!],
  shellPanes: [],
  servers: ROSTER,
  sessions: sessionsSolo,
};

/** Wired to nothing, as in the Dashboard section. */
const HEADING_NEW_TAB: HeadingNewTab = { scope: {}, creating: new Set(), onNewTab: () => {} };

function Header() {
  const sessions = sessionsOnHost(DATA.sessions ?? [], DATA.scope, DATA.servers);
  return (
    <RouteHeader
      wordmark
      width="column"
      rightLead={
        <>
          <ServerSwitcher servers={ROSTER} scope={DATA.scope} agents={DATA.agents} />
          <SessionSwitcher sessions={sessions} scope={DATA.scope} viewAll={false} />
        </>
      }
      rightTrail={<SettingsGear scope={DATA.scope} />}
    />
  );
}

function Screen() {
  return (
    <AppHeaderHost bridge="connected" error={false}>
      <Header />
      <div data-pg-scroll className="min-h-0 flex-1">
        <AgentList
          agents={DATA.agents}
          shellPanes={DATA.shellPanes}
          bridge="connected"
          onOpen={() => {}}
          tabs={tabs}
          servers={ROSTER}
          newTab={HEADING_NEW_TAB}
          order="place"
          onOrderChange={() => {}}
          isolated={[]}
          hidden={[]}
          onIsolate={() => {}}
          onToggleHidden={() => {}}
          needsYouOnly={false}
          onNeedsYouOnlyChange={() => {}}
        />
      </div>
    </AppHeaderHost>
  );
}

/** The ground as index.css paints it on `html`: the page colour, then `--ground-image` over it. */
function Ground({ image, size }: { image: string; size?: string }) {
  return (
    <div
      data-pg-ground=""
      ref={(el) => el?.style.setProperty("--ground-image", image)}
      style={{ backgroundColor: "var(--background)", backgroundImage: "var(--ground-image)", backgroundSize: size }}
      className="flex min-h-full flex-1 flex-col"
    >
      <PackedRootRouter data={DATA}>
        <Screen />
      </PackedRootRouter>
    </div>
  );
}

const OPTIONS: readonly RoundOption[] = [
  { n: 1, title: "Crossed grain", render: () => <Ground image={CROSSED_GRAIN} /> },
  { n: 2, title: "Dot grid", render: () => <Ground image={DOT_GRID} size={DOT_PITCH} /> },
  { n: 3, title: "Ruled lines", render: () => <Ground image={RULED_LINES} /> },
];

export function BackdropSection() {
  return (
    <Section def={DEF}>
      <Round id="backdrop" cases={[]} options={OPTIONS} frame={{ kind: "phone", height: 720 }} />
    </Section>
  );
}
