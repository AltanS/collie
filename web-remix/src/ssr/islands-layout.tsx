// THE ISLANDS DOCUMENT'S LAYOUT (S3), drawn on the bridge. Server HTML except for the islands it names
// (islands/ids.ts): what may live outside an island is what the snapshot alone decides and a tap only
// navigates or names an act (lib/acts.ts). REMIX3.md, "Islands and soft navigation".
//
//   <div data-slot="app">                       the column, as the static shell's Shell draws it
//     [live]                                    the band, the toasts, the cover (islands/live.tsx)
//     <div data-slot="app-body">                `inert` under the idle cover
//       <header>                                server HTML: the mark, the identity, two slots
//         [header-actions]                      the right cluster
//       home:  [home-list frame]                the list, the chips, the tab bar; [home-tail] inside
//       pane:  <main> [screen] [composer] </main>, each keyed by pane
//   [sheets] [gestures]
//
// The header's mark is painted once by the `live` island into a span every document keeps
// (`data-rmx-preserve-dom`), so a soft navigation never restarts its 37 animations. The server draws the
// empty host only, as the S1 document does: the drawing is 36 KB of SVG and CSS. Every layout element keeps
// its place across documents, so the diff moves only what changed.
import { Frame, type Handle, type RemixNode } from "remix/component";
import { ListTree, Network, Rows3, Settings } from "lucide";

import { buildLabel } from "@web/lib/build";
import type { DashView } from "@web/lib/dash-view";
import { isMultiHost, paneScope } from "@web/lib/hosts";
import { t, tn } from "@web/lib/i18n";
import { homePath, panePath, settingsPath, spacePath } from "@web/lib/nav";
import { paneName, panePlaceParts } from "@web/lib/pane-name";
import { paneScopeKey } from "@web/lib/scope";
import { countBlocked, hasReady } from "@web/lib/triage";
import type { AgentView, BridgeConfig } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { act } from "../lib/acts";
import { address, config, snapshot, snapshotAt } from "../lib/data";
import { pins } from "../lib/pins";
import { dashPrefs, hiddenMachines } from "../lib/prefs";
import { href } from "../routes";
import { AgentList } from "../routes/home/agent-list";
import { CrewFooterLink } from "../routes/home/crew-footer-link";
import { paneTarget } from "../routes/home/open-pane";
import { paneDrawsIslands } from "./islands-eligible";
import { findPane } from "../routes/pane/data";
import { PaneIdentity } from "../routes/pane/identity";
import { ReadOnlyBanner } from "../shell/connection-banner";
import { MuxLine } from "../shell/header";
import { Icon } from "../ui/icon";
import { SectionLabel } from "../ui/section-label";
import { TabBar } from "../ui/tab-bar";
import { PaneComposerIsland } from "../islands/composer";
import { Gestures } from "../islands/gestures";
import { HeaderActions } from "../islands/header-actions";
import { HomeTail } from "../islands/home-tail";
import { Live } from "../islands/live";
import { PaneScreenIsland } from "../islands/screen";
import { Sheets } from "../islands/sheets";
import { HOME_LIST_FRAME, PANE_HEAD_FRAME } from "../islands/snapshot-wire";

const WIDTH = {
  column: "mx-auto w-full max-w-screen-sm",
  wide: "mx-auto w-full max-w-screen-md lg:max-w-screen-lg xl:max-w-screen-xl 2xl:max-w-[1400px]",
} as const;

const NO_PANES: AgentView[] = [];
const noop = (): void => {};

/** The page an islands document draws. */
export type IslandsPage = { kind: "home" } | { kind: "pane"; paneId: string };

/** The multiplexer's sentence for why it cannot tell agents apart (home.tsx `agentDetectionNote`). */
function agentDetectionNote(cfg: BridgeConfig | undefined): string {
  const mux = cfg?.mux;
  if (mux?.capabilities?.agentDetection !== false) return "";
  return mux.notes?.agentDetection ?? "";
}

// ── The header ─────────────────────────────────────────────────────────────────────────────────────

interface HeaderProps {
  page: IslandsPage;
  /** The frames' src: the page's own URL, mounted. */
  src: string;
}

/** The server header (shell/header.tsx `HeaderHost`, the same boxes and classes). */
function IslandsHeader(handle: Handle<HeaderProps>) {
  return () => islandsHeader(handle.props);
}

function islandsHeader(props: HeaderProps): RemixNode {
  const { page, src } = props;
  const { scope } = address.get();
  const home = page.kind === "home";
  // The server has no history: the link is the dashboard, which is also where a document load with no
  // JavaScript should go. With JavaScript the `up` act decides on the device (back onto a parent behind
  // us, else the dashboard; routes/pane/back.ts).
  const up = homePath(scope);
  const upLabel = home ? t("nav.home.aria.default") : up.startsWith("/space/") ? t("changes.backAria.workspace") : t("changes.backAria.dashboard");
  return (
    <header
      data-slot="app-header"
      translate="no"
      data-width={home ? "column" : "wide"}
      class={cn(
        "sticky top-0 z-20 flex shrink-0 flex-col border-b border-rule bg-background",
        "transition-[padding-top] duration-[240ms] ease-out motion-reduce:transition-none",
        // The band holds the notch inset while it is open (islands/live.tsx sets `band-open`).
        "[html:not(.band-open)_&]:[padding-top:env(safe-area-inset-top)] [html.zen_&]:hidden",
        home ? WIDTH.column : WIDTH.wide,
      )}
    >
      <div data-slot="header-row" class="relative flex min-h-15 items-center gap-2 py-1 pr-2 pl-4">
        <div data-slot="header-lead" class="flex min-w-0 items-center gap-2">
          <a
            href={href(up)}
            data-testid="header-home"
            aria-label={upLabel}
            data-rmx-reset-scroll="false"
            {...(home ? undefined : act("up"))}
            data-glide-key={home ? undefined : panePath(page.paneId, scope)}
            class="-mx-1 flex items-center rounded px-1 transition-opacity active:opacity-70"
          >
            {/* Painted by the `live` island and kept by every later document (`data-rmx-preserve-dom`). */}
            <span data-slot="collie-mark" data-rmx-preserve-dom="" class="grid size-11 shrink-0 place-items-center" />
          </a>
          <div data-slot="header-identity" class={cn("relative min-w-0", !home && "invisible absolute")}>
            <SectionLabel class="absolute bottom-full left-0 max-w-full truncate leading-none">Collie</SectionLabel>
            <MuxLine />
          </div>
        </div>
        <div data-slot="header-center" class="flex min-w-0 flex-1 items-center">
          {home ? null : <Frame name={PANE_HEAD_FRAME} src={src} />}
        </div>
        <div data-slot="header-right" class="flex items-center gap-1">
          {home ? (
            <>
              <HeaderActions page="home" />
              <a
                href={href(settingsPath(scope))}
                data-rmx-document=""
                data-testid="settings-gear"
                aria-label={t("nav.settings.aria")}
                class="grid size-11 place-items-center text-muted-foreground transition-colors hover:text-foreground"
              >
                <Icon icon={Settings} class="size-5" />
              </a>
            </>
          ) : (
            <HeaderActions page="pane" gone={findPane(snapshot.get().data, page.paneId) === undefined} />
          )}
        </div>
      </div>
    </header>
  );
}

// ── The snapshot frames' content ───────────────────────────────────────────────────────────────────

/**
 * The `home-list` frame: the scroller (the list, then the home tail island, then the footer) and the
 * tab bar under it (home.tsx draws the same, for the dashboard view). `heldRanks` is the order the
 * browser shows (islands/snapshot-wire.ts `X-Collie-Ranks`).
 */
export function homeListContent(heldRanks?: ReadonlyMap<string, number>): RemixNode {
  const loaded = snapshot.get();
  const body = loaded.data;
  const pending = body === undefined && loaded.status === undefined;
  const p = dashPrefs.get();
  const scope = address.get().scope;
  const servers = body?.servers;
  const multi = isMultiHost(servers);
  const view: DashView = p.dashView === "crew" && !multi ? "dashboard" : p.dashView;
  const needsYouOnly = view === "dashboard" && p.needsYouOnly;
  const agents = body?.agents ?? NO_PANES;
  const blocked = countBlocked(agents);
  const readyUnseen = blocked === 0 && hasReady(agents);
  return (
    <>
      <div class="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto" data-testid="home-scroller" data-scroll-memory="">
        <ReadOnlyBanner />
        <main class="flex-1 outline-none" tabIndex={-1} data-focus-landing="">
          <AgentList
            agents={agents}
            shellPanes={body?.shellPanes ?? NO_PANES}
            bridge={body?.bridge}
            error={loaded.error !== undefined}
            pending={pending}
            lastSeenAt={snapshotAt.get() === 0 ? undefined : snapshotAt.get()}
            tabs={body?.tabs ?? []}
            servers={servers}
            agentDetectionNote={agentDetectionNote(config.get().data)}
            isolated={p.isolatedSpace}
            hidden={p.hiddenSpaces}
            onIsolate={noop}
            onToggleHidden={noop}
            hiddenMachines={hiddenMachines.get()}
            addressedHost={scope.host}
            onShowMachine={noop}
            needsYouOnly={needsYouOnly}
            onNeedsYouOnlyChange={noop}
            pins={pins.get()}
            order={p.paneOrder}
            onOrderChange={noop}
            newTab={{ scope, sessions: body?.sessions, creating: new Set(), onNewTab: noop }}
            onOpen={noop}
            onPress={noop}
            glideKeyOf={paneTarget}
            documentLink={(pane) => !paneDrawsIslands(pane)}
            onHold={noop}
            reveal={null}
            heldRanks={heldRanks}
          />
          {pending ? null : <HomeTail />}
        </main>
        <CrewFooterLink class="px-4 pt-3" />
        <div class="px-4 pt-3 pb-2 text-center text-[11px] leading-relaxed text-muted-foreground" data-testid="build-stamp">
          <span class="font-mono">{buildLabel()}</span>
        </div>
      </div>
      <TabBar
        label={t("home.tabs.aria")}
        active={view}
        onSelect={noop}
        items={[
          ...(multi ? [{ value: "crew" as const, label: t("crew.title"), icon: <Icon icon={Network} class="size-5" />, acts: act("dash-view", { value: "crew" }) }] : []),
          {
            value: "dashboard" as const,
            label: t("home.tabs.dashboard"),
            icon: <Icon icon={Rows3} class="size-5" />,
            badge: blocked,
            dot: readyUnseen,
            badgeLabel: blocked > 0 ? tn("home.tabs.blocked", blocked) : t("home.tabs.unseen"),
            acts: act("dash-view", { value: "dashboard" }),
          },
          { value: "changes" as const, label: t("files.title"), icon: <Icon icon={ListTree} class="size-5" />, acts: act("dash-view", { value: "changes" }) },
        ]}
      />
    </>
  );
}

/** The `pane-head` frame: the pane's identity in the header (pane.tsx's header claim, its center). */
export function paneHeadContent(paneId: string): RemixNode {
  const data = snapshot.get().data;
  const { scope } = address.get();
  const pane = findPane(data, paneId);
  const shell = pane?.kind === "shell";
  return (
    <PaneIdentity
      name={pane ? paneName(pane) : paneId}
      workspace={pane ? panePlaceParts(pane, data?.tabs).space : ""}
      agent={shell ? undefined : (pane?.agent ?? "")}
      status={shell ? undefined : pane?.status}
      host={pane?.host}
      session={pane?.session}
      cache={pane?.cache}
      gone={pane === undefined}
      onName={noop}
      onWorkspace={noop}
      onCache={noop}
      workspaceHref={pane ? href(spacePath(pane.workspaceId, paneScope(scope, pane, data?.servers, data?.sessions))) : undefined}
    />
  );
}

// ── The document's body ────────────────────────────────────────────────────────────────────────────

export interface LayoutProps {
  page: IslandsPage;
  src: string;
}

export function IslandsLayout(handle: Handle<LayoutProps>) {
  return () => islandsLayout(handle.props);
}

function islandsLayout(props: LayoutProps): RemixNode {
  const { page, src } = props;
  const { scope } = address.get();
  return (
    <>
      <div data-slot="app" class="flex h-(--app-h) flex-col overflow-hidden">
        <Live page={page.kind} />
        <div data-slot="app-body" data-rmx-preserve-attrs="inert" class="flex min-h-0 flex-1 flex-col">
          <IslandsHeader page={page} src={src} />
          {page.kind === "home" ? (
            <div class="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col" data-testid="home">
              <Frame name={HOME_LIST_FRAME} src={src} />
            </div>
          ) : (
            <main
              class="flex min-h-0 flex-1 flex-col outline-none"
              data-testid="pane-view"
              data-tab="terminal"
              data-body="terminal"
              tabIndex={-1}
              data-focus-landing=""
            >
              <div class="contents" data-rmx-key={`screen-${paneScopeKey(scope, page.paneId)}`}>
                <PaneScreenIsland paneId={page.paneId} />
              </div>
              <div class="contents" data-rmx-key={`composer-${paneScopeKey(scope, page.paneId)}`}>
                <PaneComposerIsland paneId={page.paneId} />
              </div>
            </main>
          )}
        </div>
      </div>
      <Sheets />
      <Gestures />
    </>
  );
}
