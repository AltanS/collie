import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";

import { sessionOfMark } from "@/components/belt-trick-mark";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { useFloatCover, usePageVisible, useReducedMotion } from "@/hooks/use-float-cover";
import { useFloatRegion } from "@/hooks/use-float-region";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { useAuthedUrl } from "@/lib/authed-url";
import { canAnimate } from "@/lib/env";
import { t } from "@/lib/i18n";
import { trickSessionPath } from "@/lib/nav";
import { TrickBoundary } from "@/lib/tricks/boundary";
import {
  FLOAT_IDLE_BOB_PX,
  FLOAT_SETTLE_MS,
  FLOAT_SIZE_PX,
  FLOAT_WANDER_EVERY_MS,
  FLOAT_WANDER_GLIDE_MS,
  OnceQueue,
  boxSide,
  capStay,
  floatScreenOf,
  floatsForScreen,
  pathOf,
  readFloat,
  restOf,
  rowFor,
  sheetRows,
  unit,
  type Box,
  type FloatSpec,
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

/** One sheet frame's size and row, drawn from the sheet at `url`. Transform only. */
function Sprite({ spec, url, reduced, paused, onLoaded }: { spec: FloatSpec; url: string | null; reduced: boolean; paused: boolean; onLoaded?: () => void }) {
  const px = FLOAT_SIZE_PX[spec.size];
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const rows = natural === null ? 1 : sheetRows(natural.w, natural.h, spec.frames);
  const row = rowFor(spec.mood, rows);
  const sheet = useRef<HTMLImageElement>(null);
  const animation = useRef<Animation | null>(null);
  useEffect(() => {
    const el = sheet.current;
    animation.current = null;
    if (el === null || natural === null || reduced || spec.frames < 2 || !canAnimate(el)) return;
    const y = -row * px;
    const run = el.animate(
      [{ transform: `translate3d(0, ${y}px, 0)` }, { transform: `translate3d(${-(spec.frames - 1) * px}px, ${y}px, 0)` }],
      { duration: (spec.frames / spec.fps) * 1000, iterations: Number.POSITIVE_INFINITY, easing: `steps(${spec.frames}, jump-none)` },
    );
    animation.current = run;
    return () => run.cancel();
  }, [natural, reduced, spec.frames, spec.fps, row, px]);
  useEffect(() => {
    if (paused) animation.current?.pause();
    else animation.current?.play();
  }, [paused, natural, reduced, spec.frames, spec.fps, row]);
  return (
    <span aria-hidden data-slot="float-sprite" className="relative block overflow-hidden" style={{ width: px, height: px }}>
      {url !== null && (
        <img
          ref={sheet}
          src={url}
          alt=""
          draggable={false}
          onLoad={(e) => {
            setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
            onLoaded?.();
          }}
          className={cn("absolute top-0 left-0 block max-w-none select-none", natural === null && "opacity-0")}
          style={{ width: px * spec.frames, height: "auto", transform: `translate3d(0, ${-row * px}px, 0)` }}
        />
      )}
    </span>
  );
}

/** A stay picture at rest in the free area: on its edge, in place, or wandering from spot to spot. */
function FloatPet({
  spec,
  region,
  reduced,
  paused,
  trickName,
  onOpen,
}: {
  spec: FloatSpec;
  region: Box;
  reduced: boolean;
  paused: boolean;
  trickName: string;
  onOpen: (() => void) | undefined;
}) {
  const { url } = useAuthedUrl(trickMediaPath(spec.host, spec.trickId, spec.src, spec.rev));
  const side = boxSide(spec);
  const [step, setStep] = useState(0);
  const [ready, setReady] = useState(false);
  const bob = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);
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
  const at = restOf(spec, region, reduced ? 0 : step);
  const glide = spec.motion === "wander" ? FLOAT_WANDER_GLIDE_MS : FLOAT_SETTLE_MS;
  const inset = (side - FLOAT_SIZE_PX[spec.size]) / 2;
  return (
    <div
      data-slot="float-pet"
      data-motion={spec.motion}
      data-mood={spec.mood}
      data-trick={spec.trickId}
      className="pointer-events-none absolute top-0 left-0 will-change-transform animate-in fade-in duration-300 motion-reduce:animate-none"
      style={{
        width: side,
        height: side,
        transform: `translate3d(${at.x}px, ${at.y}px, 0)`,
        transition: ready && !reduced ? `transform ${glide}ms ease-in-out` : undefined,
      }}
    >
      <span ref={bob} className="absolute block" style={{ left: inset, top: inset }}>
        <Sprite spec={spec} url={url} reduced={reduced} paused={paused} />
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

/** A once-shot: one motion along its path in the free area, then it is over. Never takes a pointer. */
function FloatShot({ spec, region: asked, paused, onDone }: { spec: FloatSpec; region: Box; paused: boolean; onDone: () => void }) {
  // The free area as it was when the shot began: a shot of at most three seconds is not laid out again.
  const [region] = useState(asked);
  const { url, failed } = useAuthedUrl(trickMediaPath(spec.host, spec.trickId, spec.src, spec.rev));
  const [loaded, setLoaded] = useState(false);
  const el = useRef<HTMLDivElement>(null);
  const run = useRef<Animation | null>(null);
  const side = FLOAT_SIZE_PX[spec.size];
  const done = useRef(onDone);
  done.current = onDone;
  const motion = FLOAT_ONCE_MOTIONS.find((word) => word === spec.motion);
  const path = useMemo(
    () => (motion === undefined ? null : pathOf({ motion, key: spec.key, rev: spec.rev, side, region })),
    [motion, spec.key, spec.rev, side, region],
  );
  // A picture that does not load is not played: the shot is over.
  useEffect(() => {
    if (failed || path === null) done.current();
  }, [failed, path]);
  useEffect(() => {
    const node = el.current;
    if (!loaded || node === null || path === null) return;
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
  }, [loaded, path]);
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
      className="pointer-events-none absolute top-0 left-0 will-change-transform"
      style={{ width: side, height: side, opacity: 0 }}
    >
      <Sprite spec={spec} url={url} reduced={false} paused={paused} onLoaded={() => setLoaded(true)} />
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
  const region = useFloatRegion(screen, wanted && !covered, probe);
  const drawing = wanted && !covered && region !== null;

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
              <FloatPet spec={spec} region={region} reduced={reduced} paused={!visible} trickName={trickName} onOpen={open} />
            </TrickBoundary>
          );
        })}
      {drawing && shot !== null && (
        <TrickBoundary fallback="none" resetKey={`${shot.key}@${shot.rev}`}>
          <FloatShot key={`${shot.key}@${shot.rev}`} spec={shot} region={region} paused={!visible} onDone={finishShot} />
        </TrickBoundary>
      )}
    </div>
  );
}
