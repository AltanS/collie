// "The mark of the pane you are in", a pick round: five ways to mark the focused column of a large
// screen's pane row (ADR 0120). Today the focused column stands on the paper plane inside a 2px frame of
// the theme's `--pane-active` mixed 65% into the page (`strip-column.tsx`, `columnFrame`). In Collie that
// colour is the ink, so the frame is a light grey 2px ring, a near twin of the keyboard focus ring
// (`FOCUS_RING`, `--ring`, also a 2px grey): it reads as a focus mark a click left behind. A pick round is
// a proposal in the workspace's design app (`design propose <worktree> pane-frame`), never a design
// reference entry.
//
// THE FRAME. `frame: "wide"`: one option per row, in a box as wide as the page. Each option draws the
// same window: the rail, the space header with its tab row, and the strip of columns on the recess, the
// columns at their real widths (half the strip each, never under 440px, so a narrow box scrolls).
//
// THE CASES. One switch for every option: two panes in Chat (the default), three panes with the middle
// one focused, the Terminal view (the mirror stays dark, so the paper cannot carry the focus there),
// Collie light, the three other bundled themes each in the half where today's frame is weakest
// (measured, experiments/pane-frame/NUMBERS.md), and the keyboard focus inside the pane: the focused
// pane's actions button wears the real focus ring, drawn on, so the two marks stand side by side. A case
// with a theme puts that theme on the page (`setActiveTheme`, the light or dark pin): themes are scoped
// to the root, so the round's own page wears it too.
//
// WHAT IS REAL. The planes and the looks are the app's class strings (`PAPER_PLANE`, `PAGE_PLANE`,
// `columnFrame` for option 1); the tab row is the real `TabStrip`, the header of a column without focus
// is the real `ColumnHeader`, Chat is the real `SessionStream` on a fixture feed, the Terminal view the
// real `RawMirror` on a recorded screen, the focused pane's bottom block the real `Composer` with its
// belt, and the other columns' belt the real `ActionsRow`. The focused pane's header is a stand-in from
// the real parts (`PaneGlyph`, `BranchLabel`, `HostChip`, `ColumnControls`): the app's header is the one
// header shell docked into the column, which mounts once per page, and this page draws five. Nothing here
// sends anything.
//
// After the pick: the chosen look replaces `FOCUS_FRAME`/`columnFrame` in `strip-column.tsx`, the frame
// rules in `e2e/wide-planes.spec.ts` and DESIGN.md §4 follow it; delete this file, its test and its line in
// ../rounds.ts.

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { ActionsRow, type GeneralAction } from "@/components/actions-row";
import { Composer } from "@/components/composer";
import { HostChip } from "@/components/host-chip";
import { Icon } from "@/components/icons/icon";
import { RawMirror } from "@/components/raw-mirror";
import { SessionStream } from "@/components/session-stream";
import { ColumnControls, ColumnHeader, columnFrame, PAGE_PLANE, PAPER_PLANE } from "@/components/strip-column";
import { TabStrip } from "@/components/tab-strip";
import { BranchLabel } from "@/components/ui/branch-label";
import { Button } from "@/components/ui/button";
import { ChatMessageList, type ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import { NAV_EDGE } from "@/components/ui/nav-edge";
import { PaneGlyph } from "@/components/ui/pane-glyph";
import { SpaceTitle } from "@/components/wide-layout";
import { useElementWidth } from "@/hooks/use-element-width";
import type { ChatFeed } from "@/hooks/use-chat-window";
import { useTheme } from "@/hooks/use-theme";
import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { EMPTY_CHAT_WINDOW } from "@/lib/chat-window";
import { paneGitHead } from "@/lib/git-head";
import type { HomeData } from "@/lib/loaders";
import { paneName } from "@/lib/pane-name";
import { setActiveTheme } from "@/lib/theme/store";
import type { AgentView, TabView, TranscriptPart, WorkspaceView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { MIN_PANE_WIDTH, RAIL_WIDTH } from "@/lib/wide-layout";
import { homeSolo, paneShell, paneWorking, TS } from "@/playground/fixtures";
import { PackedRootRouter } from "@/playground/harness";

import type { PickCase, PickOption, PickRoundDef } from "../types";

// ── The five looks ───────────────────────────────────────────────────────────────────────────────

/**
 * The tints both planes give the Belt, the reply box and the reading area's top rule. A copy of
 * `strip-column.tsx`'s private `IN_EITHER_PLANE`; the round's test holds the two equal through
 * `columnFrame`.
 */
export const IN_EITHER_PLANE =
  "[&_[data-slot=composer-actions]]:bg-muted/20 [&_[data-slot=belt-track]]:bg-transparent [&_[data-slot=pane-reading]]:border-t-transparent";

/**
 * THE ACCENT of options 3 and 4: `--control-on-foreground`, the ink of the app's "on" pair (the open dock,
 * an armed mode, `TRIGGER_OPEN`). `--pane-active` is the ink in Collie, Daylight and Harbour, so it adds no
 * colour; `--control-on` is a fill, too close to a dark page to draw a line (about 1.6:1 on Collie dark).
 * The "on" ink is the same hue as that fill at line strength in every theme: sky in Collie and Daylight,
 * sea blue in Harbour, the theme's amber in Nightwatch. Mixed in OKLab, so the hue does not drift toward
 * the page's own on the way (an OKLCH mix turns Collie's sky green: the page carries a hue of 80).
 */
export const ACCENT = "var(--control-on-foreground)";

/**
 * Option 2, the same frame 1px wide, mixed 55% where today mixes 65%: the lowest round step that holds
 * 3:1 against the page and the recess beside it in the weakest half, Nightwatch dark (53% is the edge).
 * The light half keeps today's clamp at L 0.55.
 */
export const QUIET_FRAME =
  "border-[oklch(from_color-mix(in_oklch,var(--pane-active)_55%,var(--background))_min(l,0.55)_c_h)] dark:border-[color-mix(in_oklch,var(--pane-active)_55%,var(--background))]";

/** Option 3, a 2px line in the accent along the column's top edge only, square at both ends. */
export const TOP_LINE = "border-t-[var(--control-on-foreground)]";

/**
 * Option 4, a 1px hairline in the accent mixed into the page: 70% in light, 60% in dark, the lowest round
 * steps that hold 3:1 against the page and the recess in every half (Nightwatch light needs 67%,
 * Nightwatch dark 59%).
 */
export const TINT_FRAME =
  "border-[color-mix(in_oklab,var(--control-on-foreground)_70%,var(--background))] dark:border-[color-mix(in_oklab,var(--control-on-foreground)_60%,var(--background))]";

/**
 * Option 5, the columns without focus step back, in one place: their body ink is re-pointed to the muted
 * ink, which every theme holds at 4.5:1 or more on its page. The header of such a column is muted today
 * already. Status marks keep their colour, so a pane that needs you still says so from the back.
 */
export const STEP_BACK = "text-foreground [--foreground:var(--muted-foreground)] [--card-foreground:var(--muted-foreground)]";

export type LookId = "today" | "quiet-frame" | "top-line" | "tint-frame" | "dim-others";

/** The class of a column's frame under each look: the plane, and the mark reserved on every column. */
export const LOOKS = {
  today: columnFrame,
  "quiet-frame": (focused) => cn("border", IN_EITHER_PLANE, focused ? cn(PAPER_PLANE, QUIET_FRAME) : cn(PAGE_PLANE, "border-transparent")),
  "top-line": (focused) => cn("border-t-2", IN_EITHER_PLANE, focused ? cn(PAPER_PLANE, TOP_LINE) : cn(PAGE_PLANE, "border-t-transparent")),
  "tint-frame": (focused) => cn("border", IN_EITHER_PLANE, focused ? cn(PAPER_PLANE, TINT_FRAME) : cn(PAGE_PLANE, "border-transparent")),
  "dim-others": (focused) => cn(IN_EITHER_PLANE, focused ? PAPER_PLANE : cn(PAGE_PLANE, STEP_BACK)),
} satisfies Record<LookId, (focused: boolean) => string>;

/** What still says "this is the pane you are in" in the Terminal view, where the mirror is dark in every column. */
const TERMINAL_CUE = {
  today: "Terminal view: the 2px frame.",
  "quiet-frame": "Terminal view: the 1px frame.",
  "top-line": "Terminal view: the accent line on top; the sides have no mark.",
  "tint-frame": "Terminal view: the coloured hairline.",
  "dim-others": "Terminal view: only the header (paper, full ink); the mirrors do not step back.",
} satisfies Record<LookId, string>;

/**
 * The real focus ring, drawn on: `FOCUS_RING` (ui/button.tsx) without its `focus-visible:` prefix, so the
 * page shows it without a key press. The round's test holds the two equal.
 */
export const RING_SHOWN = "outline-2 outline-offset-2 outline-ring";

// ── The fixtures: one Space, three panes, made-up names ──────────────────────────────────────────

const MIN = 60_000;
const WS = "w1";
const SPACE_LABEL = "example-app";

const SPACE: WorkspaceView = { workspaceId: WS, number: 1, label: SPACE_LABEL, focused: true, activeTabId: `${WS}:t1`, tabCount: 3, paneCount: 3 };

const TABS: TabView[] = [
  { tabId: `${WS}:t1`, workspaceId: WS, number: 1, label: "release-notes", focused: true, paneCount: 3 },
  { tabId: `${WS}:t2`, workspaceId: WS, number: 2, label: "parser", focused: false, paneCount: 1 },
  { tabId: `${WS}:t3`, workspaceId: WS, number: 3, label: "docs", focused: false, paneCount: 1 },
];

function seat(n: number, agent: string, title: string, status: AgentView["status"], branch: string): AgentView {
  return {
    paneId: `${WS}:p${String(n)}`,
    workspaceId: WS,
    workspaceLabel: SPACE_LABEL,
    workspaceNumber: 1,
    tabId: `${WS}:t1`,
    tabLabel: "release-notes",
    agent,
    status,
    cwd: "/home/you/src/example-app",
    focused: false,
    hasSession: true,
    terminalTitle: title,
    gitHead: { kind: "branch", name: branch },
    lastActiveAt: TS - n * 3 * MIN,
    lastSeenAt: TS - n * 3 * MIN,
  };
}

const PANES: readonly AgentView[] = [
  seat(1, "claude", "release notes date", "idle", "fix/release-date"),
  seat(2, "codex", "parser tests", "working", "perf/parser"),
  seat(3, "pi", "docs pass", "idle", "docs/install"),
];

const HOME: HomeData = { ...homeSolo, agents: [...PANES], shellPanes: [], workspaces: [SPACE], tabs: TABS };

function feedOf(id: string, turns: readonly { role: "user" | "assistant"; parts: TranscriptPart[] }[]): ChatFeed {
  const at = new Date(TS - 10 * MIN).toISOString();
  return {
    window: {
      ...EMPTY_CHAT_WINDOW,
      status: { kind: "live" },
      entries: turns.map((turn, i) => ({ uuid: `${id}-${String(i)}`, seq: i + 1, ts: at, role: turn.role, parts: turn.parts })),
    },
    loadOlder: () => undefined,
    loadingOlder: false,
    asked: 1,
    answered: 1,
    tried: true,
  };
}

const FEEDS: ReadonlyMap<string, ChatFeed> = new Map([
  [`${WS}:p1`, feedOf("pf-1", [
    { role: "user", parts: [{ kind: "text", text: "The release notes page shows the old date. Find where it comes from and fix it." }] },
    {
      role: "assistant",
      parts: [
        { kind: "text", text: "I look at the page and the build step first." },
        { kind: "tool", name: "Read", summary: "docs/release-notes.md", call: { kind: "read", path: "docs/release-notes.md" }, result: { text: "ok" } },
        { kind: "tool", name: "Grep", summary: "buildDate", call: { kind: "search", query: "buildDate", where: "src", hits: 4 }, result: { text: "4 hits" } },
        {
          kind: "text",
          text:
            "The date comes from `scripts/stamp.ts`. It reads the date of the newest tag, not the date of the build.\n\n" +
            "1. The stamp runs before the tag exists.\n2. The page never refreshes the stamp.\n\n" +
            "The fix is one line:\n\n```ts\nexport const buildDate = new Date(Number(process.env.SOURCE_DATE_EPOCH ?? Date.now() / 1000) * 1000);\n```",
        },
      ],
    },
    { role: "user", parts: [{ kind: "text", text: "Good. Run the stamp tests." }] },
    {
      role: "assistant",
      parts: [
        {
          kind: "tool",
          name: "Bash",
          summary: "bun test scripts/stamp.test.ts",
          call: { kind: "execute", command: "bun test scripts/stamp.test.ts", description: "Run the stamp tests", exitCode: 0 },
          result: { text: "6 pass" },
        },
        { kind: "text", text: "Six tests pass. The page now shows the date of the build." },
      ],
    },
  ])],
  [`${WS}:p2`, feedOf("pf-2", [
    { role: "user", parts: [{ kind: "text", text: "The parser tests take four seconds. Make them faster." }] },
    {
      role: "assistant",
      parts: [
        { kind: "text", text: "Most of the time goes into one fixture that is parsed again for every case." },
        { kind: "tool", name: "Edit", summary: "test/parser.test.ts", call: { kind: "edit", path: "test/parser.test.ts", added: 4, removed: 9 }, result: { text: "ok" } },
        { kind: "text", text: "I parse it once in `beforeAll` now. There are no warnings left, and the run takes 0.6 seconds." },
      ],
    },
  ])],
  [`${WS}:p3`, feedOf("pf-3", [
    { role: "user", parts: [{ kind: "text", text: "Read the install page and list what is out of date." }] },
    {
      role: "assistant",
      parts: [
        { kind: "text", text: "Three things are out of date:\n\n1. The Node version.\n2. The name of the config file.\n3. The port in the last example." },
      ],
    },
  ])],
]);

const SCREENS: ReadonlyMap<string, string> = new Map([
  [`${WS}:p1`, paneWorking.text],
  [`${WS}:p2`, paneShell.text],
  [`${WS}:p3`, paneWorking.text],
]);

// ── The cases ────────────────────────────────────────────────────────────────────────────────────

interface Scene {
  /** How many columns, and which one has the focus (index). */
  readonly panes: 2 | 3;
  readonly focus: number;
  readonly view: "chat" | "terminal";
  readonly theme: "collie" | "daylight" | "harbour" | "nightwatch";
  readonly scheme: "dark" | "light";
  /** The focused pane's actions button wears the real focus ring. */
  readonly ring: boolean;
}

const BASE: Scene = { panes: 2, focus: 0, view: "chat", theme: "collie", scheme: "dark", ring: false };

const SCENES = new Map<string, Scene>([
  ["two", BASE],
  ["three", { ...BASE, panes: 3, focus: 1 }],
  ["terminal", { ...BASE, view: "terminal" }],
  ["light", { ...BASE, scheme: "light" }],
  ["daylight", { ...BASE, theme: "daylight", scheme: "light" }],
  ["harbour", { ...BASE, theme: "harbour", scheme: "dark" }],
  ["nightwatch", { ...BASE, theme: "nightwatch", scheme: "light" }],
  ["ring", { ...BASE, ring: true }],
]);

const CASES: readonly PickCase[] = [
  { id: "two", label: "Two panes, Chat" },
  { id: "three", label: "Three panes, middle focused" },
  { id: "terminal", label: "Terminal view" },
  { id: "light", label: "Collie light" },
  { id: "daylight", label: "Daylight light" },
  { id: "harbour", label: "Harbour dark" },
  { id: "nightwatch", label: "Nightwatch light" },
  { id: "ring", label: "Keyboard focus inside" },
];

export function sceneOf(caseId: string): Scene {
  const scene = SCENES.get(caseId);
  if (scene === undefined) throw new Error(`pane-frame: no case ${caseId}`);
  return scene;
}

/** Puts the case's theme and half on the page. Every option draws the same case, so they agree. */
function useSceneTheme(scene: Scene): void {
  const { setTheme } = useTheme();
  useLayoutEffect(() => {
    setActiveTheme(scene.theme);
    setTheme(scene.scheme);
  }, [scene.theme, scene.scheme, setTheme]);
}

// ── The columns ──────────────────────────────────────────────────────────────────────────────────

const PREFS = {
  wrap: true,
  fontSize: 11,
  draftFontSize: 14,
  chatFontSize: 14,
  fontFamily: "system",
  rawTerminal: false,
  tapToFocus: true,
  expandClippedReply: true,
  stretchText: false,
} as const;

const nothing = () => undefined;

/** The focused pane's header, from the real parts: the agent's tile, the name in full ink, its branch and machine, the menu, the column's own controls. */
function FocusedHead({ pane, ring }: { pane: AgentView; ring: boolean }) {
  const head = paneGitHead(pane);
  return (
    <div data-slot="column-head" className="flex min-h-15 shrink-0 items-center gap-1 border-b border-band-rule bg-band-ground py-1 pl-4 pr-2">
      <PaneGlyph pane={pane} className="size-8" markOn="bg-band-ground" named />
      <div className="min-w-0 flex-1 pl-2">
        <div data-slot="focused-name" className="truncate text-base font-semibold text-foreground">
          {paneName(pane)}
        </div>
        <div className="flex min-w-0 items-baseline gap-2 text-[11px] leading-4 text-muted-foreground">
          {head !== null && <BranchLabel head={head} className="min-w-0 shrink truncate" />}
          <HostChip host={pane.host} variant="glyph" className="ml-auto self-center" />
        </div>
      </div>
      <Button variant="ghost" size="lg" data-slot="focused-menu" className={cn("w-11 shrink-0 px-0", ring && RING_SHOWN)} aria-label="Pane actions">
        <Icon name="pane-menu" className="size-5" />
      </Button>
      <ColumnControls preset="half" onCycle={nothing} onRemove={nothing} removable />
    </div>
  );
}

/** A column's reading area: Chat on its fixture feed, or the Terminal view on a recorded screen. */
function Reading({ pane, view }: { pane: AgentView; view: Scene["view"] }) {
  const listRef = useRef<ChatMessageListHandle>(null);
  const feed = FEEDS.get(pane.paneId);
  if (view === "chat" && feed !== undefined) {
    return (
      <div data-slot="column-body" className="relative min-h-0 min-w-0 flex-1">
        <SessionStream feed={feed} address={`pane-frame:${pane.paneId}`} working={false} agent={pane.agent} showToolCalls showCompactions={false} fontSize={14} listRef={listRef} />
      </div>
    );
  }
  const lines = splitLines(parseAnsi(SCREENS.get(pane.paneId) ?? ""));
  return (
    <div data-slot="column-body" className="relative min-h-0 min-w-0 flex-1">
      <ChatMessageList ref={listRef} clearBand={0} dep={pane.paneId} className="h-full px-0 pt-0">
        <RawMirror lines={lines} wrap className="min-h-full rounded-none px-3" />
      </ChatMessageList>
    </div>
  );
}

const BELT: readonly GeneralAction[] = [
  { id: "keys", icon: "keys-drawer", label: "Keys", onSelect: nothing },
  { id: "screen", icon: "screen", label: "Screen", onSelect: nothing },
  { id: "type", icon: "type-into-terminal", label: "Type into terminal", word: "Type", onSelect: nothing },
  { id: "quick", icon: "quick-actions", label: "Quick actions", onSelect: nothing },
  { id: "display", icon: "display-settings", label: "Display settings", word: "Display", onSelect: nothing },
];

function FocusedColumn({ pane, scene }: { pane: AgentView; scene: Scene }) {
  return (
    <>
      <FocusedHead pane={pane} ring={scene.ring} />
      <Reading pane={pane} view={scene.view} />
      <div data-slot="chrome-block" className="relative shrink-0 bg-chrome">
        <Composer
          paneId={`pane-frame:${pane.paneId}`}
          agent={pane.agent}
          isShell={false}
          gone={false}
          readOnly={false}
          surface={{ revision: 1, turn: "idle", modal: "none", composer: "empty" }}
          text=""
          terminalDraft={null}
          rawTerminalDraft={null}
          prefs={PREFS}
          display={{ open: false, onToggle: nothing }}
          onSent={nothing}
          layout="box"
          screen={{ on: scene.view === "terminal", onToggle: nothing }}
        />
      </div>
    </>
  );
}

function OtherColumn({ pane, scene }: { pane: AgentView; scene: Scene }) {
  return (
    <>
      <ColumnHeader pane={pane} controls={<ColumnControls preset="half" onCycle={nothing} onRemove={nothing} removable />} onFocus={nothing} />
      <Reading pane={pane} view={scene.view} />
      <div data-slot="chrome-block" className="relative shrink-0 border-t border-rule bg-chrome px-3">
        <ActionsRow general={BELT} agent={pane.agent} onRun={() => Promise.resolve(false)} />
      </div>
    </>
  );
}

// ── The window ───────────────────────────────────────────────────────────────────────────────────

function Window({ look, scene }: { look: LookId; scene: Scene }) {
  useSceneTheme(scene);
  const [measure, width] = useElementWidth<HTMLDivElement>(1280);
  const panes = PANES.slice(0, scene.panes);
  const focused = panes[scene.focus];
  // Two columns share the strip; three take a third each. Never under the app's 440px floor.
  const share = scene.panes === 2 ? 0.5 : 1 / 3;
  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background text-foreground">
      <div data-slot="pane-frame-caption" className="flex h-8 shrink-0 items-center gap-3 bg-background px-3 text-xs tabular-nums text-muted-foreground">
        <span>{width} px wide</span>
        {scene.view === "terminal" && <span>{TERMINAL_CUE[look]}</span>}
      </div>
      <div ref={measure} data-state={`pane-frame-${look}`} className="relative isolate flex min-h-0 flex-1 overflow-hidden" style={{ transform: "translate(0)" }}>
        <aside data-slot="wide-sidebar" className={cn(NAV_EDGE, "shrink-0 border-r bg-surface-recess")} style={{ width: RAIL_WIDTH }} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            data-slot="space-header"
            className={cn(NAV_EDGE, "flex h-12 shrink-0 items-center gap-1 border-b bg-surface-recess pl-4 pr-1 [--band-ground:var(--surface-recess)] [--chrome:var(--surface-recess)]")}
          >
            <div className="flex min-w-0 flex-1 items-center">
              <SpaceTitle label={SPACE_LABEL} machine={undefined} widthClass="expanded" besideTabs />
              <TabStrip
                workspaceId={WS}
                tabs={TABS}
                agents={[...PANES]}
                selected={`${WS}:t1`}
                onSelect={nothing}
                onNewTab={nothing}
                allowAll={false}
                className="min-w-0 flex-1 self-end -mb-px bg-transparent"
              />
            </div>
          </div>
          <div data-slot="strip" className="relative flex min-h-0 flex-1 overflow-x-auto overflow-y-hidden bg-surface-recess">
            {panes.map((pane, i) => {
              const isFocus = pane === focused;
              return (
                <section
                  key={pane.paneId}
                  data-col-key={pane.paneId}
                  data-focused={isFocus ? "" : undefined}
                  aria-label={paneName(pane)}
                  className="flex h-full min-w-0 shrink-0 border-r border-border"
                  style={{ flex: `0 0 ${String(share * 100)}%`, minWidth: MIN_PANE_WIDTH }}
                >
                  <div data-slot="column-frame" data-col-index={i} className={cn("relative flex min-w-0 flex-1 flex-col overflow-hidden", LOOKS[look](isFocus))}>
                    {isFocus ? <FocusedColumn pane={pane} scene={scene} /> : <OtherColumn pane={pane} scene={scene} />}
                  </div>
                </section>
              );
            })}
            <div data-slot="add-column" className="flex h-full shrink-0 p-3" style={{ flex: "0 0 160px" }}>
              <div className="flex min-w-0 flex-1 items-center justify-center rounded-md border border-dashed border-rule" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stage({ look, caseId }: { look: LookId; caseId: string }): ReactNode {
  const scene = sceneOf(caseId);
  // The router is built once per mount; the design app remounts the option on every case switch.
  const [data] = useState(() => HOME);
  return (
    <PackedRootRouter data={data}>
      <Window look={look} scene={scene} />
    </PackedRootRouter>
  );
}

function option(n: number, label: string, look: LookId): PickOption {
  return { n, label, state: `pane-frame-${look}`, render: (caseId) => <Stage look={look} caseId={caseId} /> };
}

const OPTIONS: readonly PickOption[] = [
  option(1, "Today", "today"),
  option(2, "Quieter frame", "quiet-frame"),
  option(3, "Accent line on top", "top-line"),
  option(4, "Colour frame", "tint-frame"),
  option(5, "No frame, others step back", "dim-others"),
];

const ROUND: PickRoundDef = { title: "The mark of the pane you are in", options: OPTIONS, cases: CASES, frameHeight: 640, frame: "wide" };

export default ROUND;
