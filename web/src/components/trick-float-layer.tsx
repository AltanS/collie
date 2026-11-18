import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";

import { sessionOfMark } from "@/components/belt-trick-mark";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { useFloatCover, usePageVisible, useReducedMotion } from "@/hooks/use-float-cover";
import { useFloatRegion, type FloatSpace } from "@/hooks/use-float-region";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { useAuthedUrl } from "@/lib/authed-url";
import { canAnimate } from "@/lib/env";
import { t } from "@/lib/i18n";
import { trickSessionPath } from "@/lib/nav";
import { TrickBoundary } from "@/lib/tricks/boundary";
import {
  FLOAT_IDLE_BOB_PX,
  FLOAT_POP_SCALE,
  FLOAT_SETTLE_MS,
  FLOAT_WANDER_EVERY_MS,
  FLOAT_WANDER_GLIDE_MS,
  OnceQueue,
  boxDims,
  capStay,
  drawnDims,
  fitsRegion,
  floatScreenOf,
  floatsForScreen,
  frameAspect,
  pathOf,
  readFloat,
  restOf,
  rowFor,
  spriteInBox,
  unit,
  type Box,
  type FloatSpec,
  type Point,
} from "@/lib/tricks/float";
import { FLOAT_ONCE_MOTIONS, parsePartKey, trickMediaPath, type WireTrickPart } from "@/lib/tricks/schema";
import { tricksStore, useTricksState, useTrickParts, type TricksStore } from "@/lib/tricks/store";
import type { AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";

// THE FLOAT PLACE (lib/tricks/float.ts holds the rules): small moving pictures that tricks draw over the
// app. One layer, mounted once at the root, above the page and under the toast, the sheets and the Fab. It
// takes no pointer: every picture is tap-through, except a parked stay picture whose part says
// `opens = "page"`, which takes a tap in a 44 px box and opens the trick's page, and nothing else.
//
// WHERE IT DRAWS: the Dashboard and a session's Chat or Terminal. The Dashboard shows the parts with no
// `sessions`, a session shows the ones bound to it (the same binding a belt mark has).
//
// WHEN IT STAYS OUT: the device's "Floating things" switch is off, a sheet or a card that asks is open, a
// field that types has focus, a hold is under way (hooks/use-float-cover.ts), no room is left in the free area,
// or the trick is off (the store leaves its parts out). Then nothing is drawn, and nothing waits to be drawn
// later: a once-shot that comes meanwhile is dropped. Reduced motion: a once-shot is not played and a stay
// picture is a still image (the mood swaps the frame row, nothing glides or wanders).
//
// WHAT MOVES: transform and opacity, on the compositor. A page that is hidden pauses every animation here.

interface TrickFloatLayerProps {
  /** The open session, for the pictures bound to it. */
  pane?: AgentView | undefined;
  /** The trick sessions (pages), where a tap on a parked picture goes. */
  trickSessions: readonly AgentView[];
  store?: TricksStore;
}

/** What a loaded sheet says of its size, in pixels. */
interface Natural {
  w: number;
  h: number;
}

/**
 * One frame of a sheet, `aspect` wide for each unit of height (its own shape: it need not be square), and the
 * mood's row. Transform only. The frame is as high as the part's size says, so a tall picture stands at full height.
 */
function Sprite({ spec, url, aspect, reduced, paused, onLoaded }: { spec: FloatSpec; url: string | null; aspect: number; reduced: boolean; paused: boolean; onLoaded?: (natural: Natural) => void }) {
  const drawn = drawnDims(spec, aspect);
  const [loaded, setLoaded] = useState(false);
  const row = rowFor(spec.mood, spec.rows);
  const sheet = useRef<HTMLImageElement>(null);
  const animation = useRef<Animation | null>(null);
  useEffect(() => {
    const el = sheet.current;
    animation.current = null;
    if (el === null || !loaded || reduced || spec.frames < 2 || !canAnimate(el)) return;
    const y = -row * drawn.h;
    const run = el.animate(
      [{ transform: `translate3d(0, ${y}px, 0)` }, { transform: `translate3d(${-(spec.frames - 1) * drawn.w}px, ${y}px, 0)` }],
      { duration: (spec.frames / spec.fps) * 1000, iterations: Number.POSITIVE_INFINITY, easing: `steps(${spec.frames}, jump-none)` },
    );
    animation.current = run;
    return () => run.cancel();
  }, [loaded, reduced, spec.frames, spec.fps, row, drawn.w, drawn.h]);
  useEffect(() => {
    if (paused) animation.current?.pause();
    else animation.current?.play();
  }, [paused, loaded, reduced, spec.frames, spec.fps, row]);
  return (
    <span aria-hidden data-slot="float-sprite" className="relative block overflow-hidden" style={{ width: drawn.w, height: drawn.h }}>
      {url !== null && (
        <img
          ref={sheet}
          src={url}
          alt=""
          draggable={false}
          onLoad={(e) => {
            setLoaded(true);
            onLoaded?.({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
          }}
          className={cn("absolute top-0 left-0 block max-w-none select-none", !loaded && "opacity-0")}
          style={{ width: drawn.w * spec.frames, height: drawn.h * spec.rows, transform: `translate3d(0, ${-row * drawn.h}px, 0)` }}
        />
      )}
    </span>
  );
}

/** A stay picture at rest in the free area: on its edge, in place, or wandering from spot to spot. */
function FloatPet({
  spec,
  space,
  reduced,
  paused,
  trickName,
  onOpen,
  onPlace,
}: {
  spec: FloatSpec;
  space: FloatSpace;
  reduced: boolean;
  paused: boolean;
  trickName: string;
  onOpen: (() => void) | undefined;
  /** Where the drawn picture is now (a box, or null once it is gone): a once part that says `from` starts there. */
  onPlace: (key: string, drawn: Box | null) => void;
}) {
  const { url } = useAuthedUrl(trickMediaPath(spec.host, spec.trickId, spec.src, spec.rev));
  const { region, reach } = space;
  const [natural, setNatural] = useState<Natural | null>(null);
  const aspect = frameAspect(natural, spec.frames, spec.rows);
  const box = boxDims(spec, aspect);
  const drawn = drawnDims(spec, aspect);
  const [step, setStep] = useState(0);
  const [ready, setReady] = useState(false);
  const bob = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (natural === null) return;
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, [natural]);
  const wanders = spec.motion === "wander" && !reduced && !paused;
  useEffect(() => {
    if (!wanders) return;
    // At most one move in FLOAT_WANDER_EVERY_MS, and a little more, a different little for each picture and step.
    const wait = FLOAT_WANDER_EVERY_MS + Math.round(4000 * unit(spec.key, 500 + step));
    const timer = setTimeout(() => setStep((n) => n + 1), wait);
    return () => clearTimeout(timer);
  }, [wanders, step, spec.key]);
  useEffect(() => {
    const el = bob.current;
    if (el === null || spec.motion !== "idle" || reduced || paused || !canAnimate(el)) return;
    const run = el.animate(
      [{ transform: `translate3d(0, ${-FLOAT_IDLE_BOB_PX}px, 0)` }, { transform: `translate3d(0, ${FLOAT_IDLE_BOB_PX}px, 0)` }],
      { duration: 2400, iterations: Number.POSITIVE_INFINITY, direction: "alternate", easing: "ease-in-out" },
    );
    return () => run.cancel();
  }, [spec.motion, reduced, paused]);
  // A picture whose box is wider or taller than the free area is not drawn: nothing may spill over a landmark.
  const fits = fitsRegion(box, region);
  const at = restOf(spec, region, reduced ? 0 : step, aspect, reach);
  const inside = spriteInBox(spec, drawn, box);
  const placed = natural !== null && fits;
  const left = at.x + inside.x;
  const top = at.y + inside.y;
  const { w, h } = drawn;
  useEffect(() => {
    if (!placed) return;
    onPlace(spec.key, { x: left, y: top, w, h });
    return () => onPlace(spec.key, null);
  }, [placed, left, top, w, h, spec.key, onPlace]);
  if (!fits) return null;
  const glide = spec.motion === "wander" ? FLOAT_WANDER_GLIDE_MS : FLOAT_SETTLE_MS;
  return (
    <div
      data-slot="float-pet"
      data-motion={spec.motion}
      data-mood={spec.mood}
      data-trick={spec.trickId}
      className="pointer-events-none absolute top-0 left-0 will-change-transform animate-in fade-in duration-300 motion-reduce:animate-none"
      style={{
        width: box.w,
        height: box.h,
        transform: `translate3d(${at.x}px, ${at.y}px, 0)`,
        transition: ready && !reduced ? `transform ${glide}ms ease-in-out` : undefined,
      }}
    >
      <span ref={bob} className="absolute block" style={{ left: inside.x, top: inside.y }}>
        <Sprite spec={spec} url={url} aspect={aspect} reduced={reduced} paused={paused} onLoaded={setNatural} />
      </span>
      {onOpen !== undefined && (
        <button
          type="button"
          data-slot="float-open"
          aria-label={t("tricks.mark.open", { trick: trickName })}
          onClick={onOpen}
          className="pointer-events-auto absolute inset-0 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
      )}
    </div>
  );
}

/**
 * A once-shot: one motion along its path in the free area, then it is over. Never takes a pointer. With
 * `origin` (the centre of the stay picture its part names, when that one is on screen) the motion starts there.
 */
function FloatShot({ spec, region: asked, origin: from, paused, onDone }: { spec: FloatSpec; region: Box; origin: Point | undefined; paused: boolean; onDone: () => void }) {
  // The free area and the start as they were when the shot began: a shot of at most three seconds is not laid out again.
  const [region] = useState(asked);
  const [origin] = useState(from);
  const { url, failed } = useAuthedUrl(trickMediaPath(spec.host, spec.trickId, spec.src, spec.rev));
  const [natural, setNatural] = useState<Natural | null>(null);
  const loaded = natural !== null;
  const aspect = frameAspect(natural, spec.frames, spec.rows);
  const dims = drawnDims(spec, aspect);
  const el = useRef<HTMLDivElement>(null);
  const run = useRef<Animation | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const motion = FLOAT_ONCE_MOTIONS.find((word) => word === spec.motion);
  // A picture too big for the free area (a pop grows by a fifth) is not played, as one that does not load is not.
  const fits = fitsRegion(dims, region, motion === "pop" ? FLOAT_POP_SCALE : 1);
  const size = spec.size;
  const path = useMemo(
    () => (motion === undefined || !loaded || !fits ? null : pathOf({ motion, key: spec.key, rev: spec.rev, dims: drawnDims({ size }, aspect), region, from: origin })),
    [motion, loaded, fits, spec.key, spec.rev, size, aspect, region, origin],
  );
  // A picture that does not load, or does not fit, is not played: the shot is over.
  useEffect(() => {
    if (failed || motion === undefined || (loaded && !fits)) done.current();
  }, [failed, motion, loaded, fits]);
  useEffect(() => {
    const node = el.current;
    if (node === null || path === null) return;
    if (!canAnimate(node)) {
      const timer = setTimeout(() => done.current(), path.durationMs);
      return () => clearTimeout(timer);
    }
    const animation = node.animate(
      path.steps.map((step) => ({ offset: step.offset, transform: `translate3d(${step.x}px, ${step.y}px, 0) scale(${step.scale})`, opacity: step.opacity })),
      { duration: path.durationMs, easing: "linear", fill: "forwards" },
    );
    run.current = animation;
    animation.finished.then(
      () => done.current(),
      () => undefined,
    );
    return () => {
      run.current = null;
      animation.cancel();
    };
  }, [path]);
  useEffect(() => {
    if (paused) run.current?.pause();
    else run.current?.play();
  }, [paused, loaded]);
  return (
    <div
      ref={el}
      data-slot="float-shot"
      data-motion={spec.motion}
      data-trick={spec.trickId}
      data-from={origin === undefined ? undefined : spec.from}
      className="pointer-events-none absolute top-0 left-0 will-change-transform"
      style={{ width: dims.w, height: dims.h, opacity: 0 }}
    >
      <Sprite spec={spec} url={url} aspect={aspect} reduced={false} paused={paused} onLoaded={setNatural} />
    </div>
  );
}

/** The signature of what a once part draws: a change of it, or the part arriving, plays it again. */
function onceSignature(part: WireTrickPart): string {
  return `${JSON.stringify(part.value)}|${JSON.stringify(part.bound ?? null)}`;
}

export function TrickFloatLayer({ pane, trickSessions, store = tricksStore }: TrickFloatLayerProps) {
  useLocale();
  const { pathname } = useLocation();
  const screen = floatScreenOf(pathname);
  const { prefs } = useDashPrefs();
  const nav = useNav();
  const state = useTricksState(store);
  const parts = useTrickParts("float", undefined, store);
  const covered = useFloatCover();
  const visible = usePageVisible();
  const reduced = useReducedMotion();
  const probe = useRef<HTMLDivElement>(null);
  const on = prefs.floatingThings;
  const wanted = on && screen !== null && parts.length > 0;
  const space = useFloatRegion(screen, wanted && !covered, probe);
  const region = space?.region ?? null;
  const drawing = wanted && !covered && space !== null;
  // Where each stay picture on screen draws now, by key: a once part with `from` starts at the one it names.
  const placed = useRef(new Map<string, Box>());
  const onPlace = useCallback((key: string, box: Box | null) => {
    if (box === null) placed.current.delete(key);
    else placed.current.set(key, box);
  }, []);
  const originOf = (spec: FloatSpec): Point | undefined => {
    if (spec.from === undefined) return undefined;
    const box = placed.current.get(`${spec.host}/${spec.trickId}/${spec.from}`);
    return box === undefined ? undefined : { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  };

  const here = useMemo(
    () => (screen === "dashboard" ? floatsForScreen(parts, { dashboard: true }) : screen === "session" ? floatsForScreen(parts, { pane }) : []),
    [parts, screen, pane],
  );
  const stay = useMemo(() => capStay(here), [here]);

  // ── The once-shots
  const queue = useRef<OnceQueue<FloatSpec>>(new OnceQueue<FloatSpec>());
  const [shot, setShot] = useState<FloatSpec | null>(null);
  const seen = useRef(new Map<string, string>());
  const primed = useRef(false);
  const latest = useRef({ here, drawing, reduced });
  latest.current = { here, drawing, reduced };
  const sync = state.rev;
  useEffect(() => {
    if (sync === null) return;
    const current = new Map<string, string>();
    const arrived: string[] = [];
    for (const part of parts) {
      const spec = readFloat(part);
      if (spec === null || spec.mode !== "once") continue;
      const sig = onceSignature(part);
      current.set(spec.key, sig);
      if (seen.current.get(spec.key) !== sig && !spec.stale) arrived.push(spec.key);
    }
    seen.current = current;
    const first = !primed.current;
    primed.current = true;
    // What was there when the phone first looked is old news: only a part that arrives or changes after that plays.
    if (first) return;
    const { here: shown, drawing: can, reduced: calm } = latest.current;
    if (!can || calm) return;
    for (const key of arrived) {
      const spec = shown.find((candidate) => candidate.key === key);
      if (spec === undefined) continue;
      if (queue.current.offer(spec) === "play") setShot(spec);
    }
  }, [parts, sync]);
  // Anything that takes the screen away ends the shot and drops the one that waits.
  useEffect(() => {
    if (drawing) return;
    queue.current.cancel();
    setShot(null);
  }, [drawing, screen, pane?.paneId]);
  const finishShot = () => setShot(queue.current.finish());

  if (!wanted) return null;
  return (
    <div data-slot="float-layer" className="pointer-events-none fixed inset-0 z-20 overflow-hidden">
      <div aria-hidden ref={probe} className="invisible absolute inset-0 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]" />
      {drawing &&
        stay.map((spec) => {
          const trickName = state.tricks.find((trick) => trick.host === spec.host && trick.id === spec.trickId)?.name ?? spec.trickId;
          const page = spec.opens === "page" && parsePartKey(spec.key) !== undefined ? sessionOfMark(spec.part, trickSessions) : undefined;
          const parked = spec.motion === "perch" || spec.motion === "idle";
          const open = page !== undefined && parked ? () => nav.down(trickSessionPath(page.paneId)) : undefined;
          return (
            <TrickBoundary key={`${spec.key}@${spec.rev}`} fallback="none" resetKey={`${spec.key}@${spec.rev}`}>
              <FloatPet spec={spec} space={space} reduced={reduced} paused={!visible} trickName={trickName} onOpen={open} onPlace={onPlace} />
            </TrickBoundary>
          );
        })}
      {drawing && region !== null && shot !== null && (
        <TrickBoundary fallback="none" resetKey={`${shot.key}@${shot.rev}`}>
          <FloatShot key={`${shot.key}@${shot.rev}`} spec={shot} region={region} origin={originOf(shot)} paused={!visible} onDone={finishShot} />
        </TrickBoundary>
      )}
    </div>
  );
}
