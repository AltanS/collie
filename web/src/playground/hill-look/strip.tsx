// Part A of the "Hill look" round: the Dashboard strip. The Hill as a mountain, then one item per
// trick, scrolling sideways with the house fade when it overflows (`OverflowEdges`, cue "none", as the
// Belt has it). A0 is today's row. A tap here only highlights. DEV-ONLY.

import { Mountain, MountainSnow } from "lucide-react";
import { useState, type ReactNode } from "react";

import { AgentList } from "@/components/agent-list";
import { AppHeaderHost, RouteHeader } from "@/components/app-header";
import { HillEntryRow } from "@/components/hill-view";
import { NeedsYouSwitch } from "@/components/needs-you-switch";
import { StatusCounts } from "@/components/status-counts";
import { Collapse } from "@/components/ui/collapse";
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

export type StripId = "A0" | "A1" | "A2" | "A3";

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

function A1Strip({ c }: { c: HillCase }) {
  const { picked, pick } = usePick();
  const { count, now } = hillFacts(c);
  return (
    <div data-slot="a1-strip" className="border-b border-border pb-2 pt-2">
      <Scroller className="gap-1.5">
        <Tile
          label="Hill"
          picked={picked === "hill"}
          onTap={() => pick("hill")}
          ring={now ? "border-status-working" : undefined}
          face={<Mountain aria-hidden className={cn("size-[22px]", count > 0 ? "text-foreground" : "text-muted-foreground")} strokeWidth={1.75} />}
          badge={count > 0 ? <CountBadge n={count} className={now ? "bg-status-working text-background" : "bg-foreground text-background"} /> : undefined}
        />
        <span aria-hidden className="mx-1 h-8 w-px shrink-0 self-center bg-border" />
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
      </AppHeaderHost>
    </RootRouter>
  );
}
