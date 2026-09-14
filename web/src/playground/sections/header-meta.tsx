// Pane header meta ideas: FOUR numbered options for line 2 of the pane header — where the cache
// reading and the host name go. Nothing here ships until Altan picks one; this section exists so he
// can say "option N" and be understood, exactly as `header-corner.tsx` did for the corner before it.
//
// THE FAULT, ON A 390PX PHONE. Today's line 2 reads `workspace-sportsight › …   ⌂ bluefin · ⧗ 20m`:
// the meta (a pink server glyph, the muted host name, a dot, a green hourglass, the countdown) takes
// a THIRD of the line, so the tab crumb truncates to `…`. Two coloured glyphs beside a muted path
// read as clutter. And the host name is usually the OPERATOR'S OWN MACHINE — the one the phone is
// dialled into — which the app already names elsewhere (the dashboard header). Altan: "the cache and
// host inside a pane don't look nice, they need more work."
//
// A THIRD ROW WAS RULED OUT. An earlier pass tried the meta on its own line under the path — it read
// as an extra row growing the header, and Altan ruled it out: host and cache MUST stay on the SAME
// line as the workspace name. Every option below keeps them there; only what shares that line with
// the path — dropping the tab, hiding your own host, drawing the host as a dot, or going quiet — is
// what changes from option to option.
//
// WHAT IS REAL HERE AND WHAT IS NOT. `PaneMeta`, `HostChip`, `CacheChip`, `AgentIcon` and `StatusDot`
// are the app's own components, inside a real `CrewProvider`, so the hide rule, the identity tint and
// the countdown are the real ones. The header ROW ITSELF is DRAWN — `RouteHeader` portals into the
// one hoisted header shell and cannot be mounted in a card, the same reason `header-corner.tsx` draws
// it — copied class for class from `agent-chat.tsx`. Option 4's "no host tint" is reached by mounting
// the real `HostChip` on a machine id the roster does not carry (an honest edge of the real
// component, not a fake one): its Server glyph then inherits the row's own muted colour instead of a
// host tint, because `hostSlot` answers `null` for an id it cannot place.

import type { ReactNode } from "react";
import { EllipsisVertical } from "lucide-react";

import { AgentIcon } from "@/components/agent-icon";
import { CrewProvider } from "@/components/crew-provider";
import { PaneMeta } from "@/components/pane-meta";
import { StatusDot } from "@/components/status-badge";
import { hostSlot } from "@/lib/hosts";
import type { PaneCache, ServerSummary } from "@/lib/types";
import { statusLabel } from "@/lib/types";
import { cn } from "@/lib/utils";

import { cacheNow, paneCache, TS } from "../fixtures";
import { Card, Group, Section, type SectionDef } from "../harness";
import { PhoneMock } from "./shared";

export const DEF: SectionDef = {
  id: "header-meta",
  title: "Pane header meta ideas",
  intent:
    "Four numbered options for the pane header's second line, where the cache reading and the host " +
    "name live today. On a 390px phone the meta eats a third of the line and the tab crumb truncates " +
    "to '…'; two coloured glyphs beside a muted path also read as clutter, and the host is usually the " +
    "operator's own machine, already named elsewhere. A third row was ruled out — host and cache stay " +
    "on the path line in every option. Nothing ships from this page until Altan picks one — say the " +
    "number.",
};

// ── The fixture every card stands on ─────────────────────────────────────────

const TITLE = "daily fact checks and fixes";
const WORKSPACE = "workspace-sportsight";
const WORKSPACE_KAZ = "workspace-kaz";
const PATH_WITH_TAB = "workspace-sportsight › work";
const MIN = 60_000;

/** The one reading every card shows — the operator's own example, `⧗ 20m`. */
const CACHE: PaneCache = paneCache({ state: "warm", expiresAt: cacheNow + 20 * MIN + 30_000 });

const LEAD: ServerSummary = { id: "lodge", name: "lodge", isLead: true, reachable: true, protocol: "ok", lastSeenAt: TS - 2_000 };
const WORKSHOP: ServerSummary = { id: "workshop", name: "workshop", isLead: false, reachable: true, protocol: "ok", lastSeenAt: TS - 3_000 };
const MINIBUCH: ServerSummary = { id: "minibuch", name: "minibuch", isLead: false, reachable: true, protocol: "ok", lastSeenAt: TS - 4_000 };
const BLUEFIN: ServerSummary = { id: "bluefin", name: "bluefin", isLead: false, reachable: true, protocol: "ok", lastSeenAt: TS - 5_000 };

/** A crew that carries `bluefin`, for option 1's "meta as today" mock. */
const ROSTER_WITH_BLUEFIN: ServerSummary[] = [LEAD, BLUEFIN];

/** A crew that carries `minibuch`, so its tint and its chip both resolve. */
const ROSTER_WITH_MINIBUCH: ServerSummary[] = [LEAD, MINIBUCH];

/** A crew that does NOT carry `minibuch` — mounting `HostChip host="minibuch"` here is the honest way
 *  to draw a quiet, untinted host row from the real component: `hostSlot` answers `null` for an id it
 *  cannot place, so the Server glyph inherits the row's own muted colour instead of a host tint. */
const ROSTER_WITHOUT_MINIBUCH: ServerSummary[] = [LEAD, WORKSHOP];

/** A callback that does nothing — every card here is a photograph. */
const inert = () => {};

function Crew({ servers, children }: { servers: ServerSummary[]; children: ReactNode }) {
  return (
    <CrewProvider servers={servers} ts={TS} pollMs={3_000}>
      {children}
    </CrewProvider>
  );
}

// ── The header row, drawn here ───────────────────────────────────────────────

/** The ⋮, exactly as `agent-chat.tsx` draws it — copied class for class, the same copy
 *  `header-corner.tsx` keeps for the same reason: the real one lives inside a 2,000-line component. */
function Kebab() {
  return (
    <button
      type="button"
      onClick={inert}
      aria-label="Pane menu"
      className="grid w-11 min-h-11 shrink-0 place-items-center self-stretch rounded-md text-muted-foreground transition-colors active:bg-muted/60 active:text-foreground"
    >
      <EllipsisVertical className="size-5" />
    </button>
  );
}

/**
 * The pane header's own row: a 60px floor, the identity block (agent mark + status dot + name on
 * line 1, the path on line 2), then the trailing corner. Copied from `agent-chat.tsx`'s own class
 * strings — see `header-corner.tsx`'s `HeaderRow` for why this cannot simply import that component.
 *
 * `path` is line 2's own text — every option changes what shares that line, never the line itself.
 * `nameLeading` sits between the agent mark and the name (option 3's colour dot only). `pathTrailing`
 * sits at the end of line 2 (every option). There is no third line — Altan ruled that shape out.
 */
function HeaderMetaRow({
  path,
  nameLeading,
  pathTrailing,
}: {
  path: string;
  nameLeading?: ReactNode;
  pathTrailing?: ReactNode;
}) {
  return (
    <div className="flex min-h-15 items-stretch gap-2 border-b border-rule bg-background px-3 py-2">
      <div className="flex min-w-0 flex-1 items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2 leading-5">
            <div className="relative shrink-0">
              <AgentIcon agent="claude" className="size-4" />
              <StatusDot
                status="working"
                label={statusLabel("working")}
                live
                surface="bg-background"
                className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-background"
              />
            </div>
            {nameLeading}
            <span className="block truncate font-semibold leading-5">{TITLE}</span>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <span className="block truncate font-mono text-[11px] leading-3 text-muted-foreground">
              {path}
            </span>
            {pathTrailing !== undefined && <span className="ml-auto shrink-0">{pathTrailing}</span>}
          </div>
        </div>
      </div>
      <Kebab />
    </div>
  );
}

/** One card's mock: the header row inside a 390px phone frame, nothing else on the screen. */
function HeaderMock({ children }: { children: ReactNode }) {
  return <PhoneMock>{children}</PhoneMock>;
}

// ── The cards ────────────────────────────────────────────────────────────────

const IDEA = "idea, not shipped:";

export function HeaderMetaSection() {
  return (
    <Section def={DEF}>
      <Group title="Line 2 stays the path line — four ideas for what shares it">
        <Card
          state="header-meta-workspace-today"
          label="Option 1 · Workspace only, meta as today"
          reach={`${IDEA} the path line drops the tab crumb; the trailing meta mounts the real PaneMeta inline, unchanged, host="bluefin".`}
          note="The tab strip under the header already shows the tab. So the path line drops the tab and keeps only the workspace. Host and cache stay at the end of that line, as today. The line no longer truncates."
        >
          <Crew servers={ROSTER_WITH_BLUEFIN}>
            <HeaderMock>
              <HeaderMetaRow
                path={WORKSPACE}
                pathTrailing={<PaneMeta layout="inline" host="bluefin" cache={CACHE} onOpenCache={inert} />}
              />
            </HeaderMock>
          </Crew>
        </Card>

        <Card
          state="header-meta-host-other-machine"
          label="Option 2 · Workspace only, host only for another machine"
          reach={`${IDEA} both rows mount the real PaneMeta inline; the top passes host={undefined} (PaneMeta's own "this one" case), the bottom passes host="minibuch" on a roster that carries it.`}
          note="Same as option 1, and your own machine's name goes away. The host shows only when the pane is on another machine."
        >
          <Crew servers={ROSTER_WITH_MINIBUCH}>
            <div className="space-y-3">
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  this pane, on your own machine
                </p>
                <HeaderMock>
                  <HeaderMetaRow
                    path={WORKSPACE}
                    pathTrailing={
                      <PaneMeta layout="inline" host={undefined} cache={CACHE} onOpenCache={inert} />
                    }
                  />
                </HeaderMock>
              </div>
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  a crew pane on minibuch
                </p>
                <HeaderMock>
                  <HeaderMetaRow
                    path={WORKSPACE_KAZ}
                    pathTrailing={
                      <PaneMeta layout="inline" host="minibuch" cache={CACHE} onOpenCache={inert} />
                    }
                  />
                </HeaderMock>
              </div>
            </div>
          </Crew>
        </Card>

        <Card
          state="header-meta-host-dot"
          label="Option 3 · Workspace only, host as a colour dot"
          reach={`${IDEA} the dot is drawn here from lib/hosts.ts's own hostSlot()/HOST_TEXT_CLASSES, the same lookup HostChip uses for its glyph; the path line mounts the real PaneMeta with host={undefined} so only the cache reading shows there.`}
          note="Same as option 2, but the host is never a word. A small dot before the name takes the host's colour, the same colour as on the dashboard. The cache reading stands alone at the end of the path line."
        >
          <Crew servers={ROSTER_WITH_MINIBUCH}>
            <HeaderMock>
              <HeaderMetaRow
                path={WORKSPACE}
                nameLeading={<HostDot host="minibuch" servers={ROSTER_WITH_MINIBUCH} />}
                pathTrailing={
                  <PaneMeta layout="inline" host={undefined} cache={CACHE} onOpenCache={inert} />
                }
              />
            </HeaderMock>
          </Crew>
        </Card>

        <Card
          state="header-meta-quiet-tab"
          label="Option 4 · Keep the tab, shrink the meta"
          reach={`${IDEA} the tab crumb stays in the path text; the trailing meta mounts the real PaneMeta inline, on a roster that does not carry "minibuch", so HostChip's real hide-the-tint path (hostSlot() answering null for an id it cannot place) draws the glyph in the row's own muted colour instead of a fake one.`}
          note="The tab stays on the path line. The meta gets as small as it can: no host on your own machine, grey glyphs, colour only when the cache is expiring or cold."
        >
          <Crew servers={ROSTER_WITHOUT_MINIBUCH}>
            <HeaderMock>
              <HeaderMetaRow
                path={PATH_WITH_TAB}
                pathTrailing={
                  <PaneMeta layout="inline" host="minibuch" cache={CACHE} onOpenCache={inert} />
                }
              />
            </HeaderMock>
          </Crew>
        </Card>
      </Group>
    </Section>
  );
}

/** Option 3's colour dot: the same tint `HostChip` paints its glyph with, `lib/hosts.ts`'s own
 *  `hostSlot()` and `HOST_TEXT_CLASSES`, drawn as a small filled circle instead of an icon. `bg-*`
 *  written out rather than built from a template, for the reason `HOST_TEXT_CLASSES` itself is
 *  written out: Tailwind scans source text for class names it can see. */
const HOST_BG_CLASSES: readonly string[] = [
  "bg-host-0",
  "bg-host-1",
  "bg-host-2",
  "bg-host-3",
  "bg-host-4",
  "bg-host-5",
  "bg-host-6",
  "bg-host-7",
  "bg-host-8",
  "bg-host-9",
];

function HostDot({ host, servers }: { host: string; servers: ServerSummary[] }) {
  const slot = hostSlot(servers, host);
  return (
    <span
      aria-hidden
      className={cn("size-2 shrink-0 rounded-full bg-muted-foreground/60", slot !== null && HOST_BG_CLASSES[slot])}
    />
  );
}
