import { createPortal } from "react-dom";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react";

import { StatusDot } from "@/components/status-badge";
import { UnseenMark } from "@/components/ui/unseen-mark";
import type { NavMapSpace } from "@/hooks/use-pane-nav-map";
import { useLocale } from "@/hooks/use-locale";
import { hostName, isMultiHost } from "@/lib/hosts";
import { t } from "@/lib/i18n";
import { paneName } from "@/lib/pane-name";
import { fitCenter, isArmed, type Direction, type GestureState, type Point } from "@/lib/pane-nav-gesture";
import { isUnseen, TRIAGE_STATUS, worstTriage } from "@/lib/triage";
import type { AgentView, ServerSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

// THE PANE NAVIGATION OVERLAY (M70 spec 03, ADR 0121): what an armed gesture shows, and nothing else.
// At the top, the pane the finger is moving to, named large in the app face with its status mark, and
// under it its space, its machine on a crew, and "pane i of n". Under that the map: every space a row,
// every pane a cell with its status mark, the target cell marked. Where the second finger first landed
// (the joystick: above the handle) a FIXED pad of four arrows, the last step's one filled; it does not
// follow the finger, and it carries no names and no status.
//
// A FLOATING LAYER (DESIGN.md §11 and §1, "the pane navigation overlay"): portalled to <body>, fixed,
// `z-40` over the band and under the sheets, `pointer-events-none` and `aria-hidden`, so it holds no
// space, takes no touch and moves nothing (§2). It exists only while the mode is armed. The gesture is
// an extra: the switcher, the sidebar and the space header stay the accessible way.

/** At most this many spaces show on the map, a window around the target's. */
const MAP_ROWS = 7;
/** From the pad's centre to an arrow's centre, px. */
const PAD_REACH = 38;
/** The pad's half size: the reach plus an arrow's half box and its pulse. */
const PAD_HALF = PAD_REACH + 26;
/** The joystick's pad stands this far above the finger, so the thumb does not cover it. */
const STICK_PAD_LIFT = 112;

/** One pane's status mark in a 12px box: the unseen square for an unopened reply, else its shape. */
function PaneMark({ pane, surface = "bg-card", big = false }: { pane: AgentView | undefined; surface?: string; big?: boolean }) {
  const box = big ? "size-4" : "size-3";
  if (pane === undefined) return <span aria-hidden className={cn(box, "shrink-0")} />;
  const unseen = isUnseen(pane);
  return (
    <span aria-hidden data-slot="pane-nav-mark" data-status={unseen ? "unseen" : pane.status} className={cn(box, "flex shrink-0 items-center justify-center")}>
      {unseen ? <UnseenMark className={big ? "size-4" : undefined} /> : <StatusDot status={pane.status} surface={surface} className={big ? "size-4" : undefined} />}
    </span>
  );
}

/** A space's worst mark: the one shape its chip advertises for everything in it. */
function SpaceMark({ panes }: { panes: readonly AgentView[] }) {
  const triage = worstTriage(panes.filter((p) => p.kind !== "shell"));
  if (triage === null) return <span aria-hidden className="size-3 shrink-0" />;
  return (
    <span aria-hidden data-slot="pane-nav-space-mark" className="flex size-3 shrink-0 items-center justify-center">
      {triage === "ready" ? <UnseenMark /> : <StatusDot status={TRIAGE_STATUS[triage]} surface="bg-card" />}
    </span>
  );
}

const PAD_ARROWS = [
  { dir: "up", Icon: ArrowUp, x: 0, y: -1 },
  { dir: "right", Icon: ArrowRight, x: 1, y: 0 },
  { dir: "down", Icon: ArrowDown, x: 0, y: 1 },
  { dir: "left", Icon: ArrowLeft, x: -1, y: 0 },
] as const satisfies readonly { dir: Direction; Icon: typeof ArrowUp; x: number; y: number }[];

/** Four arrows around a point, the `lit` one filled in the strong token, a pulse on each new `step`. */
function DirectionPad({ center, lit, step }: { center: Point; lit: Direction | null; step: number }) {
  const c = fitCenter(center, { w: window.innerWidth, h: window.innerHeight }, { x: PAD_HALF, y: PAD_HALF });
  return (
    <div data-slot="pane-nav-pad" data-lit={lit ?? "none"} className="absolute" style={{ left: c.x, top: c.y }}>
      {PAD_ARROWS.map(({ dir, Icon, x, y }) => {
        const on = lit === dir;
        return (
          <span
            key={dir}
            data-dir={dir}
            data-on={on || undefined}
            className="absolute flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
            style={{ left: x * PAD_REACH, top: y * PAD_REACH }}
          >
            {/* Keyed on the step count, so every step mounts it again and it rings once. */}
            {on && <span key={step} data-slot="pane-nav-pulse" className="pane-nav-pulse absolute size-9 rounded-md border-2 border-primary" />}
            {/* The border is reserved on every arrow and only recoloured, so lighting one moves nothing (§2). */}
            <span
              className={cn(
                "relative flex size-9 items-center justify-center rounded-md border-2 shadow-sm",
                on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-muted-foreground",
              )}
            >
              <Icon className="size-5" strokeWidth={on ? 3 : 2} />
            </span>
          </span>
        );
      })}
    </div>
  );
}

export interface PaneNavOverlayProps {
  state: GestureState;
  /** The map's spaces, index for index with the gesture's layout. */
  spaces: readonly NavMapSpace[];
  paneOf: (key: string) => AgentView | undefined;
  servers: readonly ServerSummary[] | undefined;
}

export function PaneNavOverlay({ state, spaces, paneOf, servers }: PaneNavOverlayProps) {
  useLocale();
  const target = state.target;
  if (!isArmed(state.phase) || target === null) return null;
  const view = target.spaces[target.space];
  const pane = view === undefined ? undefined : paneOf(view.panes[view.focus] ?? "");
  const space = spaces[target.space];
  const machine = pane !== undefined && isMultiHost(servers) ? hostName(servers, pane.host) : undefined;
  const where = [space?.label, machine, view === undefined ? undefined : t("paneNav.position", { index: view.focus + 1, total: view.panes.length })]
    .filter((part) => part !== undefined && part !== "")
    .join(" · ");

  // The map's window: up to MAP_ROWS spaces, the target's as near the middle as the ends allow.
  const from = Math.max(0, Math.min(target.space - Math.floor(MAP_ROWS / 2), target.spaces.length - MAP_ROWS));
  const rows = target.spaces.map((s, i) => ({ s, i })).slice(from, from + MAP_ROWS);

  const padAt =
    state.kind === "chord" ? state.padAt : state.start === null ? null : { x: state.start.x, y: state.start.y - STICK_PAD_LIFT };

  return createPortal(
    <div aria-hidden data-slot="pane-nav-overlay" data-kind={state.kind} className="pointer-events-none fixed inset-0 z-40 select-none">
      <div
        data-slot="pane-nav-card"
        className="absolute left-1/2 top-[calc(env(safe-area-inset-top)+4.5rem)] w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 rounded-md border border-rule bg-card p-3 text-card-foreground shadow-md"
      >
        <div data-slot="pane-nav-target" className="mb-3 border-b border-rule pb-2.5">
          <div className="flex items-center gap-2">
            <PaneMark pane={pane} big />
            <span data-slot="pane-nav-target-name" className="min-w-0 truncate font-sans text-lg font-medium leading-6 text-foreground">
              {pane === undefined ? "" : paneName(pane)}
            </span>
          </div>
          <p data-slot="pane-nav-target-where" className="mt-0.5 truncate pl-6 text-sm leading-5 text-muted-foreground">
            {where}
          </p>
        </div>
        <div data-slot="pane-nav-map" className="flex flex-col gap-1.5">
          {rows.map(({ s, i }) => {
            const row = spaces[i];
            const current = i === target.space;
            return (
              <div key={i} data-slot="pane-nav-row" data-current={current || undefined} className="flex items-center gap-2">
                <span className={cn("flex w-24 shrink-0 items-center gap-1 text-sm leading-4", current ? "text-foreground" : "text-muted-foreground")}>
                  <SpaceMark panes={row?.panes ?? []} />
                  <span className="min-w-0 truncate">{row?.label}</span>
                </span>
                <span className="flex min-w-0 flex-wrap gap-1.5">
                  {s.panes.map((key, k) => {
                    const here = current && k === s.focus;
                    return (
                      <span
                        key={key}
                        data-slot="pane-nav-cell"
                        data-here={here || undefined}
                        className={cn(
                          "flex h-6 w-9 items-center justify-center rounded-md border",
                          here ? "border-primary bg-accent" : current ? "border-foreground/40 bg-card" : "border-border bg-card",
                        )}
                      >
                        <PaneMark pane={paneOf(key)} surface={here ? "bg-accent" : "bg-card"} />
                      </span>
                    );
                  })}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {padAt !== null && <DirectionPad center={padAt} lit={state.lastDir} step={Math.abs(state.steps)} />}
    </div>,
    document.body,
  );
}

/**
 * THE JOYSTICK HANDLE: a 44px band just above the belt with a short bar in its middle, the thumb's
 * room both ways from the centre of the screen. Hold it 400ms and the same finger steers; a quick drag
 * up without the hold opens the switcher; a tap does nothing. Touch only, so it is `touch-none` and has
 * no click: it is not a button, and a screen reader is pointed at the switcher instead (`aria-hidden`).
 */
export function PaneNavHandle({ setNode }: { setNode: (node: HTMLDivElement | null) => void }) {
  return (
    <div data-slot="pane-nav-handle-band" className="flex h-11 items-center justify-center">
      <div
        ref={setNode}
        aria-hidden
        data-slot="pane-nav-handle"
        className="flex h-11 w-40 touch-none select-none items-center justify-center rounded-md [-webkit-touch-callout:none]"
      >
        <span className="h-1 w-10 rounded-md bg-muted-foreground/60" />
      </div>
    </div>
  );
}
