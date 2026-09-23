// Dashboard nav, a design round (2026-09-23). Operator's ask: a footer nav on the dashboard that
// reaches the diffs, and that can carry the attention-only view issue 270 asks for. Four NUMBERED
// options, each drawn at phone size (375 x 812 CSS px, plus a simulated 34px home-indicator inset)
// and each fully tappable: switch views, open a workspace's Changes, go back.
//
// PICKED: option 1, the three-tab footer, with two corrections: the first tab is "Panes", not
// "All", and the Changes tab wears `GitCompare`, the one Changes icon the pane belt and Settings
// already use. It shipped as `TabBar` (components/ui/tab-bar.tsx) and `WorkspaceChangesList` in
// routes/home.tsx (ADR 0066); option 1's phones below mount those two real components. Options 2
// to 4 stay as they were drawn, for the record, apart from the Changes icon.
//
// The second tab shipped that day as "Attention" with `BellRing`, then renamed "Focus" with
// `CircleDot` the same day, once the `attention-icon` round found the bell read as a notification
// even in its quiet state (ADR 0068). Option 1's phones below carry that second rename too, since
// they mount the real `TabBar`; options 2 to 4 still say "Needs you", as they were drawn.
//
// HONESTY: this is a mock composed from the app's own parts, not a mount of `AgentList`. The rows
// (`AgentCard`), headings (`SectionHeader`), counts (`StatusCounts`, `StatusSummaryLine`), chips
// (`Chip`), list frames (`ListGroup`), the Changes list (`ChangesList`), `Switch` and `BottomSheet`
// are the real components with their real props. The layout around them (the header, the footer,
// the attention filter, the per-workspace Changes screen) is new and exists only here, because
// `AgentList` has no attention filter and no heading slot for a Changes entry yet.

import { BellRing, ChevronLeft, ChevronRight, CircleDot, GitCompare, Rows3, Settings } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { AgentCard } from "@/components/agent-card";
import { ChangesList } from "@/components/changes-view";
import { SectionHeader } from "@/components/section-header";
import { StatusCounts, StatusSummaryLine } from "@/components/status-counts";
import { Chip } from "@/components/ui/chip";
import { STRIP_SCROLLER } from "@/components/ui/labelled-strip";
import { ListGroup } from "@/components/ui/list-group";
import { BottomSheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { TabBar } from "@/components/ui/tab-bar";
import { WorkspaceChangesList, type WorkspaceChangesRow } from "@/components/workspace-changes-list";
import { paneRowKey } from "@/lib/hosts";
import { groupPanesByWorkspace, type WorkspaceGroup } from "@/lib/pane-groups";
import { bucketOf, worstTriage, type TriageKey } from "@/lib/triage";
import { summarizeChanges, type WorkspaceChangeCount } from "@/lib/workspace-changes";
import type { AgentView, ChangedRepo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Card, Group, Section, type SectionDef } from "../harness";
import { navAgents, navChanges, navShells } from "./dashboard-nav-fixtures";

export const DEF: SectionDef = {
  id: "dashboard-nav",
  title: "Dashboard nav",
  intent:
    "PICKED: option 1, with the first tab named Panes and GitCompare as the Changes icon (ADR 0066). " +
    "Design round: four numbered ways to put a nav on the dashboard that reaches each workspace's " +
    "Changes and carries issue 270's attention-only view (only panes that need you or are ready and " +
    "unseen, empty workspaces dropped, order unchanged, the summary still counts every pane, kept per " +
    "device as `attentionOnly`). Every phone is live: tap the nav, a workspace, Back.",
};

// ── Shared data ──────────────────────────────────────────────────────────────────────────────────

const ATTENTION: ReadonlySet<TriageKey> = new Set<TriageKey>(["needs", "ready"]);
const GROUPS: readonly WorkspaceGroup[] = groupPanesByWorkspace(navAgents, navShells, { order: "fixed" });
const ALL_PANES: readonly AgentView[] = [...navAgents, ...navShells];
const ATTENTION_COUNT = ALL_PANES.filter((p) => ATTENTION.has(bucketOf(p))).length;

function changesOf(ws: string): readonly ChangedRepo[] {
  return navChanges.get(ws) ?? [];
}

interface ChangeTotals {
  files: number;
  added: number;
  removed: number;
}

function changeTotals(ws: string): ChangeTotals {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const repo of changesOf(ws)) {
    for (const f of repo.files) {
      files++;
      added += f.added;
      removed += f.removed;
    }
  }
  return { files, added, removed };
}

const TOTAL_CHANGED_FILES = GROUPS.reduce((n, g) => n + changeTotals(g.label).files, 0);
const WORKSPACES_WITH_CHANGES = GROUPS.filter((g) => changeTotals(g.label).files > 0).length;

// ── The phone ────────────────────────────────────────────────────────────────────────────────────

/** 375 x 812 of viewport inside a 6px bezel. `--sim-sab` stands in for iOS's bottom safe area. */
function Phone({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <figure className="flex shrink-0 flex-col gap-2">
      <figcaption className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">{caption}</figcaption>
      <div
        className="relative isolate h-[824px] w-[387px] overflow-hidden rounded-[1.75rem] border-[6px] border-zinc-800 bg-background text-foreground shadow-xl dark:border-zinc-700 [--sim-sab:34px]"
        style={{ transform: "translate(0)" }}
      >
        <div className="flex h-full flex-col">{children}</div>
        {/* The home indicator, so the safe-area band the footer reserves is visible as such. */}
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-2 left-1/2 z-[60] h-[5px] w-32 -translate-x-1/2 rounded-full bg-foreground/50"
        />
      </div>
    </figure>
  );
}

/** The dashboard header, reduced: the wordmark and the 44px gear on a 60px row. */
function MockHeader() {
  return (
    <header className="flex min-h-15 shrink-0 items-center gap-2 border-b border-rule px-4 py-1">
      <span className="flex-1 text-lg font-semibold tracking-tight">collie</span>
      <span className="flex size-11 items-center justify-center text-muted-foreground" aria-hidden>
        <Settings className="size-5" />
      </span>
    </header>
  );
}

/** The bottom band: page colour, one rule above, and the safe area below its 56px row. */
const FOOTER_BAND = "shrink-0 border-t border-rule bg-background pb-[max(env(safe-area-inset-bottom),var(--sim-sab,0px))]";

interface TabItem<V extends string> {
  value: V;
  label: string;
  icon: ReactNode;
  badge?: number;
}

/**
 * A footer tab row. The active mark is a 2px top edge, reserved transparent on every tab, so a
 * switch repaints and never moves (DESIGN.md §2). The badge floats on the icon's corner, outside the
 * flow, so a count appearing or leaving moves no label.
 */
function FooterTabs<V extends string>({
  items,
  active,
  onSelect,
}: {
  items: readonly TabItem<V>[];
  active: V | null;
  onSelect: (v: V) => void;
}) {
  return (
    <nav aria-label="Dashboard views" className={FOOTER_BAND}>
      <div className="flex">
        {items.map((it) => {
          const on = it.value === active;
          return (
            <button
              key={it.value}
              type="button"
              aria-current={on ? "page" : undefined}
              onClick={() => onSelect(it.value)}
              className={cn(
                "-mt-px flex min-h-14 flex-1 flex-col items-center justify-center gap-1 border-t-2 border-transparent text-[11px] font-medium select-none",
                on ? "border-foreground text-foreground" : "text-muted-foreground",
              )}
            >
              <span className="relative">
                {it.icon}
                {it.badge !== undefined && it.badge > 0 && (
                  <span className="absolute -right-3 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-sm bg-status-blocked px-1 text-[10px] font-semibold leading-none text-white tabular-nums">
                    {it.badge}
                  </span>
                )}
              </span>
              {it.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

// ── The dashboard body ───────────────────────────────────────────────────────────────────────────

function Row({ pane }: { pane: AgentView }) {
  return (
    <AgentCard
      agent={pane}
      onClick={() => {}}
      scope="place"
      statusStyle="dot"
      density="row"
      unseen={bucketOf(pane) === "ready"}
      tint
    />
  );
}

/**
 * The grouped herd, with issue 270's filter as one predicate. `attentionOnly` removes rows and moves
 * nothing: the strip and the summary keep their place and keep counting every pane, and a heading
 * keeps its whole workspace's counts.
 */
function DashBody({
  attentionOnly,
  onOpenChanges,
  quietNote = true,
}: {
  attentionOnly: boolean;
  /** The mock's "N quiet panes hidden" line. The picked option shipped without it (ADR 0066). */
  quietNote?: boolean;
  /** Option 2 only: draws a Changes chip on each heading and opens that workspace's Changes. */
  onOpenChanges?: (ws: string) => void;
}) {
  const [isolated, setIsolated] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const byWs = isolated === null ? GROUPS : GROUPS.filter((g) => g.key === isolated);
  const shown = byWs
    .map((g) => ({ g, rows: attentionOnly ? g.panes.filter((p) => ATTENTION.has(bucketOf(p))) : g.panes }))
    .filter((x) => x.rows.length > 0);
  const hiddenCount = byWs.reduce((n, g) => n + g.panes.length, 0) - shown.reduce((n, x) => n + x.rows.length, 0);
  const firstUrgent = GROUPS.findIndex((g) => g.panes.some((p) => ATTENTION.has(bucketOf(p))));
  return (
    <div ref={root} className="flex flex-col gap-5 px-4 py-4">
      <nav aria-label="Workspaces" className="-mx-4">
        <div className={cn(STRIP_SCROLLER, "px-4")}>
          <Chip label="All" active={isolated === null} onClick={() => setIsolated(null)} />
          {GROUPS.map((g) => (
            <Chip
              key={g.key}
              label={g.label}
              active={isolated === g.key}
              status={worstTriage(g.panes)}
              onClick={() => setIsolated(isolated === g.key ? null : g.key)}
            />
          ))}
        </div>
      </nav>

      <StatusSummaryLine
        panes={navAgents}
        allClear={ATTENTION_COUNT === 0}
        onJump={() =>
          root.current?.querySelector(`[data-ws-idx="${firstUrgent}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" })
        }
      />

      {shown.map(({ g, rows }) => (
        <section key={g.key} data-ws-idx={GROUPS.indexOf(g)} className="flex scroll-mt-4 flex-col gap-2">
          <SectionHeader
            label={g.label}
            tone="strong"
            dot={g.panes.some((p) => bucketOf(p) === "needs") ? "bg-status-blocked" : undefined}
            trailing={
              <span className="flex shrink-0 items-center gap-3">
                <StatusCounts panes={g.panes} className="text-[11px] text-muted-foreground" />
                {onOpenChanges && <HeadingChangesChip ws={g.label} onOpen={onOpenChanges} />}
              </span>
            }
          />
          <ListGroup>
            {rows.map((p) => (
              <Row key={paneRowKey(p)} pane={p} />
            ))}
          </ListGroup>
        </section>
      ))}

      {quietNote && attentionOnly && hiddenCount > 0 && (
        <p className="text-center text-xs text-muted-foreground">
          {hiddenCount} quiet panes hidden by Needs you.
        </p>
      )}
    </div>
  );
}

// ── Changes: the per-workspace list and one workspace's screen ───────────────────────────────────

function Counts({ ws }: { ws: string }) {
  const { files, added, removed } = changeTotals(ws);
  if (files === 0) return <span className="text-xs text-muted-foreground">No changes</span>;
  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
      <span>
        {files} {files === 1 ? "file" : "files"}
      </span>
      <span className="font-mono text-[11px]">
        <span className="text-status-done">+{added}</span> <span className="text-status-blocked">−{removed}</span>
      </span>
    </span>
  );
}

/** Every workspace, in the dashboard's own order; a clean one stays listed, muted and inert. */
function WorkspaceChangesIndex({ onOpen }: { onOpen: (ws: string) => void }) {
  return (
    <ListGroup as="ul">
      {GROUPS.map((g) => {
        const clean = changeTotals(g.label).files === 0;
        return (
          <li key={g.key}>
            <button
              type="button"
              disabled={clean}
              onClick={() => onOpen(g.label)}
              className="flex min-h-13 w-full items-center gap-3 px-3 py-2 text-left disabled:opacity-60"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="truncate text-sm font-medium">{g.label}</span>
                <Counts ws={g.label} />
              </span>
              {!clean && <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
            </button>
          </li>
        );
      })}
    </ListGroup>
  );
}

function ChangesIndexScreen({ onOpen }: { onOpen: (ws: string) => void }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <p className="flex min-h-8 items-center text-xs font-medium">
        {TOTAL_CHANGED_FILES} changed files in {WORKSPACES_WITH_CHANGES} of {GROUPS.length} workspaces
      </p>
      <WorkspaceChangesIndex onOpen={onOpen} />
    </div>
  );
}

/** What `workspace/:workspaceId/changes` would show: a back row naming the folder, then the list. */
function WorkspaceChangesScreen({ ws, onBack }: { ws: string; onBack: () => void }) {
  return (
    <div className="flex flex-col">
      <div className="flex min-h-13 items-center gap-1 border-b border-rule pr-4">
        <button type="button" aria-label="Back" onClick={onBack} className="flex size-11 shrink-0 items-center justify-center">
          <ChevronLeft className="size-5" />
        </button>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-base font-semibold leading-tight">Changes</span>
          <span className="truncate text-xs text-muted-foreground">{ws}</span>
        </span>
        <Counts ws={ws} />
      </div>
      <div className="p-4">
        <ChangesList repos={changesOf(ws)} onOpen={() => {}} />
      </div>
    </div>
  );
}

/** The scrolling region between header and footer. */
function Scroll({ children }: { children: ReactNode }) {
  return <div className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">{children}</div>;
}

const ICON = "size-5";

// ── Option 1: three-tab footer (PICKED, shipped as TabBar + WorkspaceChangesList) ─────────────────

type View = "panes" | "focus" | "changes";

/** Option 1's Changes rows: the real list's rows, fed the fixture's answers instead of a fetch. */
const REAL_ROWS: readonly WorkspaceChangesRow[] = GROUPS.map((g) => ({
  key: g.key,
  label: g.label,
  workspaceId: g.panes[0]?.workspaceId ?? g.key,
  scope: {},
}));
const REAL_COUNTS: ReadonlyMap<string, WorkspaceChangeCount> = new Map(
  GROUPS.map((g) => [g.key, summarizeChanges({ available: true, root: "/", truncated: false, repos: [...changesOf(g.label)] })]),
);

function OptionThreeTabs({ initial, openWs = null }: { initial: View; openWs?: string | null }) {
  const [view, setView] = useState<View>(initial);
  const [ws, setWs] = useState<string | null>(openWs);
  const select = (v: View) => {
    setView(v);
    setWs(null);
  };
  return (
    <>
      <MockHeader />
      <Scroll>
        {view === "changes" && ws !== null ? (
          <WorkspaceChangesScreen ws={ws} onBack={() => setWs(null)} />
        ) : view === "changes" ? (
          <div className="flex flex-col gap-5 px-4 py-4">
            <WorkspaceChangesList rows={REAL_ROWS} counts={REAL_COUNTS} onOpen={(row) => setWs(row.label)} />
          </div>
        ) : (
          <DashBody attentionOnly={view === "focus"} quietNote={false} />
        )}
      </Scroll>
      <TabBar<View>
        label="Dashboard views"
        active={view}
        onSelect={select}
        className="pb-[max(env(safe-area-inset-bottom),var(--sim-sab,0px))]"
        items={[
          { value: "panes", label: "Panes", icon: <Rows3 className={ICON} /> },
          {
            value: "focus",
            label: "Focus",
            icon: <CircleDot className={ICON} />,
            badge: ATTENTION_COUNT,
            badgeLabel: `${ATTENTION_COUNT} need you`,
          },
          { value: "changes", label: "Changes", icon: <GitCompare className={ICON} /> },
        ]}
      />
    </>
  );
}

// ── Option 2: two-tab footer + a Changes chip on each workspace heading ─────────────────────────

/** A heading's Changes entry: 24px drawn, 44px hit, the file count in mono. None on a clean folder. */
function HeadingChangesChip({ ws, onOpen }: { ws: string; onOpen: (ws: string) => void }) {
  const { files } = changeTotals(ws);
  if (files === 0) return null;
  return (
    <button
      type="button"
      aria-label={`Changes in ${ws}, ${files} files`}
      onClick={() => onOpen(ws)}
      className="relative flex h-6 items-center gap-1 rounded-sm border border-rule px-1.5 font-mono text-[11px] text-foreground tabular-nums before:absolute before:-inset-x-1 before:-inset-y-2.5 before:content-['']"
    >
      <GitCompare className="size-3.5" aria-hidden />
      {files}
    </button>
  );
}

type Filter = "all" | "needs";

function OptionTwoTabsHeadingChip({ initial, openWs = null }: { initial: Filter; openWs?: string | null }) {
  const [filter, setFilter] = useState<Filter>(initial);
  const [ws, setWs] = useState<string | null>(openWs);
  return (
    <>
      <MockHeader />
      <Scroll>
        {ws === null ? (
          <DashBody
            attentionOnly={filter === "needs"}
            onOpenChanges={setWs}
          />
        ) : (
          <WorkspaceChangesScreen ws={ws} onBack={() => setWs(null)} />
        )}
      </Scroll>
      <FooterTabs<Filter>
        active={ws === null ? filter : null}
        onSelect={(v) => {
          setFilter(v);
          setWs(null);
        }}
        items={[
          { value: "all", label: "All", icon: <Rows3 className={ICON} /> },
          { value: "needs", label: "Needs you", icon: <BellRing className={ICON} />, badge: ATTENTION_COUNT },
        ]}
      />
    </>
  );
}

// ── Option 3: segmented control at the top, no footer ───────────────────────────────────────────

type SegView = "all" | "needs" | "changes";

function OptionTopSegmented({ initial, openWs = null }: { initial: SegView; openWs?: string | null }) {
  const [view, setView] = useState<SegView>(initial);
  const [ws, setWs] = useState<string | null>(openWs);
  const segs: { value: SegView; label: string }[] = [
    { value: "all", label: "All" },
    { value: "needs", label: `Needs you · ${ATTENTION_COUNT}` },
    { value: "changes", label: "Changes" },
  ];
  return (
    <>
      <MockHeader />
      <div className="shrink-0 border-b border-rule px-4 py-2">
        <div role="tablist" aria-label="Dashboard views" className="grid grid-cols-3 gap-0.5 rounded-sm border border-rule p-0.5">
          {segs.map((s) => {
            const on = s.value === view;
            return (
              <button
                key={s.value}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => {
                  setView(s.value);
                  setWs(null);
                }}
                className={cn(
                  "flex h-11 items-center justify-center rounded-sm border border-transparent text-xs font-medium tabular-nums",
                  on ? "border-rule bg-card text-foreground shadow-xs" : "text-muted-foreground",
                  s.value === "needs" && !on && "text-status-blocked",
                )}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </div>
      <Scroll>
        {view === "changes" ? (
          ws === null ? (
            <ChangesIndexScreen onOpen={setWs} />
          ) : (
            <WorkspaceChangesScreen ws={ws} onBack={() => setWs(null)} />
          )
        ) : (
          <DashBody attentionOnly={view === "needs"} />
        )}
        {/* The meta zone keeps the bottom of the scroll, as today. */}
        <p className="px-4 pb-[max(env(safe-area-inset-bottom),var(--sim-sab,0px))] pt-3 font-mono text-[11px] text-muted-foreground">
          collie 1.12.1 · build f2ac0ab1
        </p>
      </Scroll>
    </>
  );
}

// ── Option 4: a Needs-you toggle + a Changes button that opens a picker sheet ───────────────────

function OptionToggleAndSheet({
  initialOn,
  initialSheet = false,
  openWs = null,
}: {
  initialOn: boolean;
  initialSheet?: boolean;
  openWs?: string | null;
}) {
  const [on, setOn] = useState(initialOn);
  const [sheet, setSheet] = useState(initialSheet);
  const [ws, setWs] = useState<string | null>(openWs);
  return (
    <>
      <MockHeader />
      <Scroll>
        {ws === null ? (
          <DashBody attentionOnly={on} />
        ) : (
          <WorkspaceChangesScreen ws={ws} onBack={() => setWs(null)} />
        )}
      </Scroll>
      <div className={FOOTER_BAND}>
        <div className="flex divide-x divide-border">
          {/* The whole half is the label, so a tap anywhere on it flips the switch. */}
          <label
            className={cn(
              "flex min-h-14 flex-1 items-center justify-center gap-2.5 text-sm font-medium select-none",
              on ? "text-status-blocked" : "text-foreground",
            )}
          >
            <BellRing className={ICON} aria-hidden />
            <span className="tabular-nums">Needs you · {ATTENTION_COUNT}</span>
            <Switch
              checked={on}
              aria-label="Show only panes that need you"
              onCheckedChange={(v) => {
                setOn(v);
                setWs(null);
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => setSheet(true)}
            className="flex min-h-14 flex-1 items-center justify-center gap-2 text-sm font-medium"
          >
            <GitCompare className={ICON} aria-hidden />
            Changes
            <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{TOTAL_CHANGED_FILES}</span>
          </button>
        </div>
      </div>
      <BottomSheet open={sheet} onClose={() => setSheet(false)} title="Changes">
        <div className="pb-[max(env(safe-area-inset-bottom),var(--sim-sab,0px))]">
          <WorkspaceChangesIndex
            onOpen={(w) => {
              setWs(w);
              setSheet(false);
            }}
          />
        </div>
      </BottomSheet>
    </>
  );
}

// ── The cards ────────────────────────────────────────────────────────────────────────────────────

/** An option's head: the big number Altan picks by, its short name, and the trade-off lines. */
function OptionHead({ n, name, lines }: { n: number; name: string; lines: readonly string[] }) {
  return (
    <div className="mb-4 flex items-start gap-4 rounded-sm border border-rule bg-card p-4 shadow-sm">
      <span className="font-mono text-6xl font-bold leading-none tabular-nums">{n}</span>
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-lg font-semibold leading-tight">{name}</span>
        {lines.map((l) => (
          <p key={l} className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
            {l}
          </p>
        ))}
      </div>
    </div>
  );
}

function Phones({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-6 pb-3">{children}</div>;
}

const REACH =
  "not in the app yet. The dashboard at /, with issue 270's filter and a workspace-scoped Changes " +
  "route (workspace/:workspaceId/changes). Tap the nav inside each phone.";

export function DashboardNavSection() {
  return (
    <Section def={DEF}>
      <Group title="Options">
        <Card state="dash-nav-option-1" label="option 1 · three-tab footer" reach={REACH} span={2}>
          <OptionHead
            n={1}
            name="PICKED · Three-tab footer: Panes · Focus · Changes"
            lines={[
              "Picked 2026-09-23, with two corrections: the first tab is Panes (each tab names what its list holds, and the app counts panes everywhere), and Changes wears GitCompare, the icon the pane belt's Changes pill uses. Drawn as Needs you, renamed Attention the same day, then renamed Focus with CircleDot the same day again: the bell read as a notification even in its quiet state (ADR 0068). These phones mount the shipped TabBar and WorkspaceChangesList (ADR 0066).",
              "Thumb reach: every view is one tap from the bottom edge. The Changes tab lists every workspace with its file count, and a tap opens that workspace's Changes.",
              `What moves: nothing between Panes and Focus, the strip and summary hold their place. Changes swaps the whole body. Focus carries a badge (${ATTENTION_COUNT}) while it is above zero.`,
              "Cost: 56px of footer plus the safe area on the dashboard, always. Changes becomes a peer of the herd, so it reads as a main feature.",
            ]}
          />
          <Phones>
            <Phone caption="a · Focus selected">
              <OptionThreeTabs initial="focus" />
            </Phone>
            <Phone caption="b · Changes tab">
              <OptionThreeTabs initial="changes" />
            </Phone>
            <Phone caption="c · collie's Changes">
              <OptionThreeTabs initial="changes" openWs="collie" />
            </Phone>
          </Phones>
        </Card>

        <Card state="dash-nav-option-2" label="option 2 · two tabs + heading chip" reach={REACH} span={2}>
          <OptionHead
            n={2}
            name="Two-tab footer + a Changes chip on each workspace heading"
            lines={[
              "Thumb reach: the filter sits under the thumb. Changes sits on each heading, mid-screen, right where the workspace is named. One tap to a workspace's Changes.",
              "What moves: nothing. A clean workspace has no chip, and the chip sits at the right end, so no name moves.",
              "Cost: busier headings. With Needs you on, a quiet workspace with changes has no heading, so its Changes has no way in. There is no overview of all changes.",
            ]}
          />
          <Phones>
            <Phone caption="a · All, chips on headings">
              <OptionTwoTabsHeadingChip initial="all" />
            </Phone>
            <Phone caption="b · Needs you selected">
              <OptionTwoTabsHeadingChip initial="needs" />
            </Phone>
            <Phone caption="c · collie's Changes">
              <OptionTwoTabsHeadingChip initial="all" openWs="collie" />
            </Phone>
          </Phones>
        </Card>

        <Card state="dash-nav-option-3" label="option 3 · segmented control at the top" reach={REACH} span={2}>
          <OptionHead
            n={3}
            name="Segmented control at the top, no footer (the contrast)"
            lines={[
              "Thumb reach: the worst of the four. The control sits under the header, at the top of the screen.",
              "What moves: nothing below the control. The control itself costs 61px above the fold, on the screen that has the least room.",
              "Cost: the least new chrome, and the bottom stays the meta zone (crew line, update, build stamp). It reads like a filter, not like navigation.",
            ]}
          />
          <Phones>
            <Phone caption="a · Needs you selected">
              <OptionTopSegmented initial="needs" />
            </Phone>
            <Phone caption="b · Changes selected">
              <OptionTopSegmented initial="changes" />
            </Phone>
            <Phone caption="c · collie's Changes">
              <OptionTopSegmented initial="changes" openWs="collie" />
            </Phone>
          </Phones>
        </Card>

        <Card state="dash-nav-option-4" label="option 4 · Needs-you toggle + Changes sheet" reach={REACH} span={2}>
          <OptionHead
            n={4}
            name="Footer with a Needs-you switch and a Changes button that opens a picker sheet"
            lines={[
              `Thumb reach: both at the bottom. Needs you is a switch, a state of the one dashboard, not a second place. Changes shows the total file count (${TOTAL_CHANGED_FILES}).`,
              "What moves: nothing. The sheet floats over the list, and a tap in it opens that workspace's Changes.",
              "Cost: one more tap to a workspace's Changes (button, then pick). A switch reads less like navigation, and the footer has two different kinds of control.",
            ]}
          />
          <Phones>
            <Phone caption="a · Needs you on">
              <OptionToggleAndSheet initialOn />
            </Phone>
            <Phone caption="b · Changes sheet open">
              <OptionToggleAndSheet initialOn={false} initialSheet />
            </Phone>
            <Phone caption="c · collie's Changes">
              <OptionToggleAndSheet initialOn={false} openWs="collie" />
            </Phone>
          </Phones>
        </Card>
      </Group>
    </Section>
  );
}

