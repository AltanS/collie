// Part A of the "Hill look" round: the Dashboard strip. The Hill as a mountain, then one item per
// trick, scrolling sideways with the house fade when it overflows (`OverflowEdges`, cue "none", as the
// Belt has it). A0 is today's row. A tap here only highlights. DEV-ONLY.

import { LayoutGrid, Mountain, MountainSnow } from "lucide-react";
import { useState, type ReactNode } from "react";

import { AgentList } from "@/components/agent-list";
import { AppHeaderHost, RouteHeader } from "@/components/app-header";
import { HillEntryRow } from "@/components/hill-view";
import { NeedsYouSwitch } from "@/components/needs-you-switch";
import { StatusCounts } from "@/components/status-counts";
import { Collapse } from "@/components/ui/collapse";
import { Icon } from "@/components/icons/icon";
import { BottomSheet } from "@/components/ui/sheet";
import { TabBar, type TabBarItem } from "@/components/ui/tab-bar";
import { STRIP_TAP_TARGET } from "@/components/ui/labelled-strip";
import { OverflowEdges } from "@/components/ui/overflow-edges";
import type { PaneOrder } from "@/lib/pane-order";
import { trickIconOf } from "@/lib/tricks/icons";
import { inkOf } from "@/lib/tricks/tone";
import { cn } from "@/lib/utils";

import { herd, homeSolo, tabs } from "../fixtures";
import { RootRouter } from "../harness";
import type { HillCase, StripTrick } from "./fixtures";

const noop = () => {};

export type StripId = "A0" | "A1" | "A2" | "A3" | "A4" | "A5" | "A6";

/** The highlighted item: a tap marks it, a second tap clears it. */
function usePick() {
  const [picked, setPicked] = useState<string | null>(null);
  return { picked, pick: (id: string) => setPicked((was) => (was === id ? null : id)) };
}

function hillFacts(c: HillCase) {
  const count = c.open.length;
  const now = c.open.some((d) => d.priority === "now");
  const top = c.open[0];
  return { count, now, top };
}

/** A sideways scroller that runs to the screen edge and starts on the page gutter. */
function Scroller({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <OverflowEdges cue="none">
      {(ref) => (
        <div
          ref={ref}
          className={cn("flex min-w-0 flex-1 items-center overflow-x-auto overscroll-x-contain px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}
        >
          {children}
        </div>
      )}
    </OverflowEdges>
  );
}

// ── A1: tiles under the header, a round face with the name under it; the Hill shows its count ─────

function Tile({ label, picked, onTap, face, badge, ring }: { label: string; picked: boolean; onTap: () => void; face: ReactNode; badge?: ReactNode; ring?: string }) {
  return (
    <button
      type="button"
      onClick={onTap}
      aria-pressed={picked}
      className="group flex w-[60px] shrink-0 touch-manipulation flex-col items-center gap-1 rounded-sm py-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span
        className={cn(
          // Full round: the face is as wide as it is tall (DESIGN.md §3). The border is reserved, and a
          // tap recolours it.
          "relative flex size-12 items-center justify-center rounded-full border bg-card shadow-xs transition-colors group-active:scale-95",
          picked ? "border-primary bg-primary/10" : (ring ?? "border-border"),
        )}
      >
        {face}
        {badge}
      </span>
      <span className="w-full truncate text-center text-[11px] leading-4 text-foreground">{label}</span>
    </button>
  );
}

function CountBadge({ n, className }: { n: number | string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-sm px-1 text-[10px] font-semibold leading-none tabular-nums", className)}
    >
      {n}
    </span>
  );
}

function TrickGlyph({ trick, className }: { trick: StripTrick; className?: string }) {
  const Glyph = trickIconOf(trick.icon);
  return <Glyph aria-hidden className={cn("size-5", inkOf(trick.tone, false) || "text-foreground", className)} />;
}

function A1Strip({ c, withHill = true }: { c: HillCase; withHill?: boolean }) {
  const { picked, pick } = usePick();
  const { count, now } = hillFacts(c);
  return (
    <div data-slot="a1-strip" className="border-b border-border pb-2 pt-2">
      <Scroller className="gap-1.5">
        {withHill && (
          <>
        <Tile
          label="Hill"
          picked={picked === "hill"}
          onTap={() => pick("hill")}
          ring={now ? "border-status-working" : undefined}
          face={<Mountain aria-hidden className={cn("size-[22px]", count > 0 ? "text-foreground" : "text-muted-foreground")} strokeWidth={1.75} />}
          badge={count > 0 ? <CountBadge n={count} className={now ? "bg-status-working text-background" : "bg-foreground text-background"} /> : undefined}
        />
        <span aria-hidden className="mx-1 h-8 w-px shrink-0 self-center bg-border" />
          </>
        )}
        {c.tricks.map((trick) => (
          <Tile
            key={trick.id}
            label={trick.name}
            picked={picked === trick.id}
            onTap={() => pick(trick.id)}
            face={<TrickGlyph trick={trick} />}
            badge={trick.count !== undefined && trick.count.length <= 3 ? <CountBadge n={trick.count} className="border border-border bg-card text-foreground" /> : undefined}
          />
        ))}
      </Scroller>
    </div>
  );
}

// ── A2: one line with the counts, icons only; the Hill wears a dot while something is `now` ───────

function IconOnly({ label, picked, onTap, children, mark }: { label: string; picked: boolean; onTap: () => void; children: ReactNode; mark?: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={picked}
      onClick={onTap}
      className={cn(
        STRIP_TAP_TARGET,
        "relative flex size-9 shrink-0 touch-manipulation items-center justify-center rounded-full border transition-colors active:scale-95",
        picked ? "border-primary bg-primary/10" : "border-transparent hover:bg-muted/50",
      )}
    >
      {children}
      {mark}
    </button>
  );
}

function A2Line({ c, needsYou, onNeedsYou }: { c: HillCase; needsYou: boolean; onNeedsYou: (on: boolean) => void }) {
  const { picked, pick } = usePick();
  const { count, now } = hillFacts(c);
  const Peak = now ? MountainSnow : Mountain;
  return (
    <div data-slot="a2-line" className="flex min-h-11 items-center gap-1 pt-1">
      <div className="-ml-4 flex min-w-0 flex-1">
        <Scroller className="gap-0.5 pr-2">
          <IconOnly
            label={count > 0 ? `Hill, ${count} open` : "Hill"}
            picked={picked === "hill"}
            onTap={() => pick("hill")}
            mark={
              count > 0 ? (
                <span aria-hidden className="absolute right-0 top-0.5 flex">
                  <span className={cn("rounded-full border-2 border-background", now ? "size-3 bg-status-working" : "size-2.5 bg-muted-foreground")} />
                </span>
              ) : undefined
            }
          >
            <Peak aria-hidden className={cn("size-5", count > 0 ? "text-foreground" : "text-muted-foreground")} strokeWidth={1.75} />
          </IconOnly>
          {c.tricks.map((trick) => (
            <IconOnly
              key={trick.id}
              label={trick.name}
              picked={picked === trick.id}
              onTap={() => pick(trick.id)}
              mark={trick.tone !== undefined && trick.tone !== "plain" && trick.tone !== "muted" ? <span aria-hidden className={cn("absolute right-1 top-1 size-1.5 rounded-full bg-current", inkOf(trick.tone, false))} /> : undefined}
            >
              <TrickGlyph trick={trick} className="size-[18px]" />
            </IconOnly>
          ))}
        </Scroller>
      </div>
      <span aria-hidden className="h-5 w-px shrink-0 bg-border" />
      <StatusCounts panes={herd} className="shrink-0 pl-1.5" />
      <div className="-mr-2 shrink-0">
        <NeedsYouSwitch on={needsYou} onChange={onNeedsYou} />
      </div>
    </div>
  );
}

// ── A3: a sticky strip of pills, icon and word; the Hill pill peeks at the top title ─────────────

function Pill({ picked, onTap, children, className, label }: { picked: boolean; onTap: () => void; children: ReactNode; className?: string; label?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={picked}
      onClick={onTap}
      className={cn(
        STRIP_TAP_TARGET,
        // The house 2px corner: a pill is wider than tall, so it is no stadium (DESIGN.md §3).
        "flex h-9 shrink-0 touch-manipulation items-center gap-1.5 rounded-sm border px-2.5 text-[13px] transition-colors active:scale-[0.98]",
        picked ? "border-primary bg-primary/10" : "border-border bg-card",
        className,
      )}
    >
      {children}
    </button>
  );
}

function A3Strip({ c }: { c: HillCase }) {
  const { picked, pick } = usePick();
  const { count, now, top } = hillFacts(c);
  return (
    <div data-slot="a3-strip" className="sticky top-0 z-20 border-b border-rule bg-background py-1.5">
      <Scroller className="gap-1.5 py-1">
        <Pill picked={picked === "hill"} onTap={() => pick("hill")} label={count > 0 ? `Hill, ${count} open` : "Hill"} className={cn("max-w-[236px]", now && picked !== "hill" && "border-status-working/60")}>
          <Mountain aria-hidden className={cn("size-4 shrink-0", now ? "text-status-working" : "text-foreground")} strokeWidth={2} />
          {count > 0 ? (
            <>
              <span className="shrink-0 font-semibold tabular-nums">{count}</span>
              {top !== undefined && <span className="font-content min-w-0 truncate text-muted-foreground">{top.title}</span>}
            </>
          ) : (
            <span className="text-muted-foreground">Hill</span>
          )}
        </Pill>
        {c.tricks.map((trick) => (
          <Pill key={trick.id} picked={picked === trick.id} onTap={() => pick(trick.id)}>
            <TrickGlyph trick={trick} className="size-4" />
            <span>{trick.name}</span>
            {trick.count !== undefined && <span className={cn("tabular-nums", inkOf(trick.tone, false) || "text-muted-foreground")}>{trick.count}</span>}
          </Pill>
        ))}
      </Scroller>
    </div>
  );
}


// ── The bottom bar: today's tabs (the real TabBar), and A4 to A6 around them ───────────────────────

type DashTab = "crew" | "dashboard" | "changes" | "hill";

/** The needs-you count the Dashboard tab carries, as `routes/home.tsx` counts it. */
const BLOCKED = herd.filter((a) => a.status === "blocked").length;

/** Today's tabs on a crew with a screen: Crew, Dashboard, Files, as `routes/home.tsx` draws them. */
const TABS: readonly TabBarItem<DashTab>[] = [
  { value: "crew", label: "Crew", icon: <Icon name="crew" className="size-5" /> },
  { value: "dashboard", label: "Dashboard", icon: <Icon name="tab-dashboard" className="size-5" />, badge: BLOCKED, badgeLabel: `${BLOCKED} blocked` },
  { value: "changes", label: "Files", icon: <Icon name="files" className="size-5" /> },
];

/** The Hill as a tab item: the mountain, the red count in the bar's own badge, the snow cap in the caution ink while a Decision is `now`. */
function hillTab(c: HillCase): TabBarItem<DashTab> {
  const { count, now } = hillFacts(c);
  const Peak = now ? MountainSnow : Mountain;
  return {
    value: "hill",
    label: "Hill",
    icon: <Peak className={cn("size-5", now && "text-status-working")} strokeWidth={1.75} />,
    badge: count,
    badgeLabel: `${count} open`,
  };
}

/** Today's bar: the real TabBar, unchanged. */
function TodayBar() {
  const [tab, setTab] = useState<DashTab>("dashboard");
  return <TabBar label="Dashboard views" active={tab} onSelect={setTab} items={TABS} />;
}

/**
 * One item in the bar's own style, for the parts the TabBar cannot hold (it lays its tabs out
 * equal and never scrolls): the TabBar button's classes, the same reserved 2px top edge, the same
 * corner badge. A trick's count is not "waiting on you", so its badge is quiet, never red (ADR 0066).
 */
function BarItem({ label, icon, picked, onTap, badge, quiet = false, width = "w-[60px]" }: { label: string; icon: ReactNode; picked: boolean; onTap: () => void; badge?: number | string; quiet?: boolean; width?: string }) {
  return (
    <button
      type="button"
      aria-pressed={picked}
      onClick={onTap}
      className={cn(
        "relative flex min-h-14 shrink-0 flex-col items-center justify-center gap-1 border-t-2 border-transparent px-1 text-[11px] font-medium select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        width,
        picked ? "border-foreground text-foreground" : "text-muted-foreground",
      )}
    >
      <span className="relative flex size-5 items-center justify-center" aria-hidden>
        {icon}
        {badge !== undefined && badge !== 0 && (
          <span
            className={cn(
              "absolute -top-1.5 left-[calc(100%-0.25rem)] flex h-4 min-w-4 items-center justify-center rounded-sm px-1 text-[10px] font-semibold leading-none tabular-nums",
              quiet ? "border border-border bg-card text-foreground" : "bg-status-blocked text-background",
            )}
          >
            {badge}
          </span>
        )}
      </span>
      <span className="max-w-full truncate leading-tight">{label}</span>
    </button>
  );
}

/** The band every bar option stands on: the TabBar's own ground, rule and safe area. */
function Band({ children }: { children: ReactNode }) {
  return (
    <nav aria-label="Dashboard views" className="flex shrink-0 border-t border-band-rule bg-band-ground pb-[env(safe-area-inset-bottom)]">
      {children}
    </nav>
  );
}

/** The real TabBar, its tabs pinned at the bar's left at a fixed width, its own band dropped (the Band draws it). */
function PinnedTabs({ width }: { width: string }) {
  const [tab, setTab] = useState<DashTab>("dashboard");
  return <TabBar label="Dashboard tabs" active={tab} onSelect={setTab} items={TABS} className={cn("shrink-0 border-t-0 bg-transparent pb-0", width)} />;
}

function BarDivider() {
  return <span aria-hidden className="my-3 w-px shrink-0 self-stretch bg-border" />;
}

function trickBadge(trick: StripTrick): string | undefined {
  return trick.count !== undefined && trick.count.length <= 3 ? trick.count : undefined;
}

/** A4: the tabs pinned, a divider, the Hill pinned after it, then the tricks scrolling under the house fade. */
function A4Bar({ c }: { c: HillCase }) {
  const { picked, pick } = usePick();
  const hill = hillTab(c);
  return (
    <Band>
      <PinnedTabs width="w-[210px]" />
      <BarDivider />
      <div className="-mt-px flex shrink-0">
        <BarItem label="Hill" icon={hill.icon} badge={hill.badge} picked={picked === "hill"} onTap={() => pick("hill")} width="w-14" />
      </div>
      <div className="-mt-px flex min-w-0 flex-1">
        <OverflowEdges cue="none">
          {(ref) => (
            <div ref={ref} className="flex min-w-0 flex-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {c.tricks.map((trick) => (
                <BarItem key={trick.id} label={trick.name} icon={<TrickGlyph trick={trick} />} badge={trickBadge(trick)} quiet picked={picked === trick.id} onTap={() => pick(trick.id)} width="w-14" />
              ))}
            </div>
          )}
        </OverflowEdges>
      </div>
    </Band>
  );
}

/** A5: the Hill is a fourth tab at the bar's right end, under the thumb; the tricks go to the tiles at the top. */
function A5Bar({ c }: { c: HillCase }) {
  const [tab, setTab] = useState<DashTab>("dashboard");
  return <TabBar label="Dashboard views" active={tab} onSelect={setTab} items={[...TABS, hillTab(c)]} />;
}

/** A6: no scrolling: the tabs, a divider, the Hill, and one Tricks item that opens a sheet of tiles. */
function A6Bar({ c }: { c: HillCase }) {
  const { picked, pick } = usePick();
  const [sheet, setSheet] = useState(false);
  const hill = hillTab(c);
  const loud = c.tricks.filter((t) => t.tone === "warn" || t.tone === "danger").length;
  return (
    <>
      <Band>
        <PinnedTabs width="flex-[3]" />
        <BarDivider />
        <div className="-mt-px flex flex-[2]">
          <BarItem label="Hill" icon={hill.icon} badge={hill.badge} picked={picked === "hill"} onTap={() => pick("hill")} width="flex-1" />
          <BarItem
            label="Tricks"
            icon={<LayoutGrid className="size-5" strokeWidth={1.75} />}
            badge={loud > 0 ? loud : undefined}
            quiet
            picked={sheet}
            onTap={() => setSheet(true)}
            width="flex-1"
          />
        </div>
      </Band>
      <BottomSheet open={sheet} onClose={() => setSheet(false)} title="Tricks">
        <div className="grid grid-cols-4 justify-items-center gap-x-2 gap-y-3 px-4 pb-6 pt-1">
          {c.tricks.map((trick) => (
            <Tile
              key={trick.id}
              label={trick.name}
              picked={picked === trick.id}
              onTap={() => pick(trick.id)}
              face={<TrickGlyph trick={trick} />}
              badge={trickBadge(trick) !== undefined ? <CountBadge n={trickBadge(trick) ?? ""} className="border border-border bg-card text-foreground" /> : undefined}
            />
          ))}
        </div>
      </BottomSheet>
    </>
  );
}

function BottomBar({ option, c }: { option: StripId; c: HillCase }) {
  if (option === "A4") return <A4Bar c={c} />;
  if (option === "A5") return <A5Bar c={c} />;
  if (option === "A6") return <A6Bar c={c} />;
  return <TodayBar />;
}

// ── The Dashboard around the strip ─────────────────────────────────────────────────────────────────

/** The real Dashboard: header, the strip where the option puts it, and the pane list under it. */
export function StripDashboard({ option, c }: { option: StripId; c: HillCase }) {
  const [order, setOrder] = useState<PaneOrder>("place");
  const [needsYou, setNeedsYou] = useState(false);
  const { count, top } = hillFacts(c);
  return (
    <RootRouter data={homeSolo}>
      <AppHeaderHost bridge="connected" error={false}>
        <RouteHeader wordmark width="column" />
        <div data-pg-scroll className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          {option === "A0" && (
            <Collapse open={count > 0}>
              {top !== undefined ? (
                <div className="px-4 pt-3">
                  <HillEntryRow count={count} title={top.title} onOpen={noop} />
                </div>
              ) : null}
            </Collapse>
          )}
          {option === "A1" && <A1Strip c={c} />}
          {option === "A5" && <A1Strip c={c} withHill={false} />}
          {option === "A3" && <A3Strip c={c} />}
          {option === "A2" && (
            <div className="px-4">
              <A2Line c={c} needsYou={needsYou} onNeedsYou={setNeedsYou} />
            </div>
          )}
          {/* A2 takes the summary line's row: the list's own row is not drawn under it. */}
          <div className={cn(option === "A2" && "[&_div:has(>#dash-summary-line)]:hidden")}>
            <AgentList
              agents={herd}
              shellPanes={[]}
              bridge="connected"
              onOpen={noop}
              tabs={tabs}
              order={order}
              onOrderChange={setOrder}
              isolated={[]}
              hidden={[]}
              onIsolate={noop}
              onToggleHidden={noop}
              needsYouOnly={needsYou}
              onNeedsYouOnlyChange={setNeedsYou}
            />
          </div>
        </div>
        <BottomBar option={option} c={c} />
      </AppHeaderHost>
    </RootRouter>
  );
}
