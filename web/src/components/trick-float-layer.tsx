import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  FLOAT_AWAY_CAP_MS,
  FLOAT_ENTER_MS,
  FLOAT_FROM_WAIT_MS,
  FLOAT_IDLE_BOB_PX,
  FLOAT_PENDING_MS,
  FLOAT_POP_SCALE,
  FLOAT_SETTLE_MS,
  FLOAT_THROW_WAIT_MS,
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
  lastFrameAtMs,
  partSignature,
  pathOf,
  playMs,
  readFloat,
  restOf,
  sameBox,
  rowFor,
  spriteInBox,
  afterRestOf,
  afterSpecOf,
  unit,
  type Box,
  type FloatSpec,
} from "@/lib/tricks/float";
import { floatClock } from "@/lib/tricks/float-clock";
import { FLOAT_ONCE_MOTIONS, mediaVersionOf, parsePartKey, trickMediaPath, type WireTrickInfo } from "@/lib/tricks/schema";
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
//
// A STAY PICTURE APPEARS IN PLACE: it is drawn at its rest spot from its first frame, invisible, and fades in
// over FLOAT_ENTER_MS. It never travels to its spot. (Not a keyframe animation of the wrapper: the `animate-in`
// keyframes of tailwind-animate name `translate3d(0, 0, 0)` as their first frame, which replaces the element's
// own transform for their duration and flew the picture in from the layer's top left corner.) Only a later change
// of the free area or the size glides, and a wander moves.
//
// A SPRITE PLAYS ONCE WHEN ITS PART SAYS `loop = false`: frames 0 to N - 1 at `fps`, the last one held. A new play
// starts when the part is printed with a changed value (`partSignature`, the one a once part plays again on), never
// on a new `asOf` or rev alone. The picture is mounted per part, not per rev, so a re-print does not make it appear again.
//
// A SPRITE MAY HAVE A SECOND ONE (`sprite.after`, only after `loop = false`): when the first reaches its last frame the second starts from
// its first, at once. Its frames are as high as the first's and as wide as its own sheet, so the box takes the new width in one step (no
// glide), kept on the part's anchor (`afterRestOf`). The second sheet is fetched and decoded while the first plays, so the switch has no blank
// frame. A changed part value plays both again from the first sprite's first frame. The place a once part with `from` starts at, and the
// wait for the throw, are those of the FIRST sprite. The play has a clock of its own per part (lib/tricks/float-clock.ts): it stops while the
// picture is away (a Page open, another screen, a sheet, a hidden page) and runs on when the picture is drawn again, so a tap that opens the
// Page, and Back, take up the throw where it stopped. A shot that waited for the throw, or flew, comes back with it and starts from the hand once
// the throw is over. Away longer than FLOAT_AWAY_CAP_MS: the end state shows and the shot is dropped as stale. Reduced motion, or no animation: the second sprite's last frame, still.

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
 * The frames loop, or with `loop = false` play once and hold the last one (still, too, under reduced motion and
 * where nothing can animate). `playKey` names the print being played: a new one plays the frames again from the first.
 * `onHeld` hears whether the frames are at their last one: false when a play starts, true when it reaches the last frame.
 */
function Sprite({
  spec,
  url,
  aspect,
  reduced,
  paused,
  playKey,
  clock,
  active = true,
  stillLast = !spec.loop,
  onLoaded,
  onHeld,
}: {
  spec: FloatSpec;
  url: string | null;
  aspect: number;
  reduced: boolean;
  paused: boolean;
  playKey: string;
  /** The part's play clock (lib/tricks/float-clock.ts): where this sprite's play stands, `offsetMs` after the start of the sequence. None: it starts at its first frame. */
  clock?: { key: string; offsetMs: number } | undefined;
  /** False: the sheet is loaded and ready but does not play (a second sprite before its turn). */
  active?: boolean;
  /** Where nothing animates (reduced motion): the last frame, not the first. */
  stillLast?: boolean;
  onLoaded?: (natural: Natural) => void;
  onHeld?: (held: boolean) => void;
}) {
  const drawn = drawnDims(spec, aspect);
  const [loaded, setLoaded] = useState(false);
  const row = rowFor(spec.mood, spec.rows);
  const sheet = useRef<HTMLImageElement>(null);
  const animation = useRef<Animation | null>(null);
  const held = useRef(onHeld);
  held.current = onHeld;
  const clockKey = clock?.key;
  const clockOffset = clock?.offsetMs ?? 0;
  /** Where the play stands in this sprite's own pass: the part's clock, less the start of this sprite. Infinite once the sequence is over. */
  const positionNow = useCallback(
    (): number => (clockKey === undefined ? 0 : Math.max(0, floatClock.positionOf(clockKey, playKey) - clockOffset)),
    [clockKey, playKey, clockOffset],
  );
  const still = stillLast && spec.frames > 1 && (reduced || !canAnimate(HTMLImageElement.prototype));
  useEffect(() => {
    const el = sheet.current;
    animation.current = null;
    if (el === null || !loaded || !active) return;
    if (reduced || spec.frames < 2 || !canAnimate(el)) {
      held.current?.(true);
      return;
    }
    const y = -row * drawn.h;
    const pass = playMs(spec.frames, spec.fps);
    const at = positionNow();
    // Where the part's clock says the play is: a remount, a region change or a changed size takes up there, never at the first frame.
    const start = spec.loop ? (Number.isFinite(at) ? at % pass : 0) : Math.min(at, pass);
    const run = el.animate(
      [{ transform: `translate3d(0, ${y}px, 0)` }, { transform: `translate3d(${-(spec.frames - 1) * drawn.w}px, ${y}px, 0)` }],
      {
        duration: pass,
        iterations: spec.loop ? Number.POSITIVE_INFINITY : 1,
        fill: spec.loop ? "none" : "forwards",
        easing: `steps(${spec.frames}, jump-none)`,
      },
    );
    if (start > 0) run.currentTime = start;
    animation.current = run;
    let frame = 0;
    const lastAt = lastFrameAtMs(spec.frames, spec.fps);
    if (!spec.loop && start >= lastAt) held.current?.(true);
    else if (!spec.loop) {
      // The last frame shows once the pass is lastFrameAtMs in. Polled on the animation's own clock, so a pause waits.
      held.current?.(false);
      const watch = (): void => {
        if (run.playState === "finished" || Number(run.currentTime ?? 0) >= lastAt) {
          held.current?.(true);
          return;
        }
        frame = requestAnimationFrame(watch);
      };
      frame = requestAnimationFrame(watch);
    }
    return () => {
      cancelAnimationFrame(frame);
      run.cancel();
    };
  }, [loaded, active, reduced, spec.frames, spec.fps, spec.loop, row, drawn.w, drawn.h, playKey, positionNow]);
  useEffect(() => {
    const run = animation.current;
    if (run === null) return;
    // A play that is over is left alone: play() on a finished animation would rewind it.
    if (paused && run.playState === "running") run.pause();
    else if (!paused && run.playState === "paused") {
      // The part's clock may have run out while the page was hidden (the cap): the end state shows, as it does on a remount.
      const pass = playMs(spec.frames, spec.fps);
      const at = positionNow();
      if (!spec.loop && at - Number(run.currentTime ?? 0) > 100) run.currentTime = Math.min(at, pass);
      run.play();
    }
  }, [paused, loaded, active, reduced, spec.frames, spec.fps, spec.loop, row, drawn.w, drawn.h, playKey, positionNow]);
  const x = still ? -(spec.frames - 1) * drawn.w : 0;
  return (
    <span aria-hidden data-slot="float-sprite" className="relative block overflow-hidden" style={{ width: drawn.w, height: drawn.h }}>
      {url !== null && (
        <img
          ref={sheet}
          src={url}
          alt=""
          draggable={false}
          onLoad={(e) => {
            // Decoded ahead, so the first frame of a sprite that waits for its turn is not blank when the turn comes.
            if (!active && "decode" in e.currentTarget) void e.currentTarget.decode().catch(() => undefined);
            setLoaded(true);
            onLoaded?.({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
          }}
          className={cn("absolute top-0 left-0 block max-w-none select-none", !loaded && "opacity-0")}
          style={{ width: drawn.w * spec.frames, height: drawn.h * spec.rows, transform: `translate3d(${x}px, ${-row * drawn.h}px, 0)` }}
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
  versions,
  onOpen,
  onPlace,
  onHold,
}: {
  spec: FloatSpec;
  space: FloatSpace;
  reduced: boolean;
  paused: boolean;
  trickName: string;
  /** The trick row's picture versions (`WireTrickInfo.media`): a picture replaced under the same name asks again. */
  versions: WireTrickInfo["media"];
  onOpen: (() => void) | undefined;
  /** Where the drawn picture is now (a box, or null once it is gone): a once part that says `from` starts there. */
  onPlace: (key: string, drawn: Box | null) => void;
  /** Whether the picture's frames are at their last one (`sprite.loop = false`): a once part with `from` waits for it. */
  onHold: (key: string, held: boolean) => void;
}) {
  const media = useAuthedUrl(trickMediaPath(spec.host, spec.trickId, spec.src, spec.rev, mediaVersionOf({ media: versions }, spec.src)));
  // A re-print moves the rev and so the sheet's address; the sheet on screen stays until the new one is there.
  const lastUrl = useRef<string | null>(null);
  if (media.url !== null) lastUrl.current = media.url;
  const url = media.url ?? lastUrl.current;
  // The second sprite (`sprite.after`), fetched with the first so it is there when its turn comes.
  const after = afterSpecOf(spec);
  const afterMedia = useAuthedUrl(after === undefined ? null : trickMediaPath(spec.host, spec.trickId, after.src, spec.rev, mediaVersionOf({ media: versions }, after.src)));
  const lastAfterUrl = useRef<string | null>(null);
  if (afterMedia.url !== null) lastAfterUrl.current = afterMedia.url;
  const afterUrl = after === undefined ? null : (afterMedia.url ?? lastAfterUrl.current);
  const playKey = partSignature(spec.part);
  // Whether the first sprite has reached its last frame in this play: the second one starts then. A changed value starts over at once.
  // A picture that is drawn again after its first sprite played out starts with the second one showing.
  const [heldFirst, setHeldFirst] = useState(() => !spec.loop && floatClock.positionOf(spec.key, playKey) >= lastFrameAtMs(spec.frames, spec.fps));
  const [seenKey, setSeenKey] = useState(playKey);
  if (seenKey !== playKey) {
    setSeenKey(playKey);
    setHeldFirst(false);
  }
  const hold = useCallback(
    (now: boolean) => {
      setHeldFirst(now);
      onHold(spec.key, now);
    },
    [onHold, spec.key],
  );
  useEffect(() => () => onHold(spec.key, false), [onHold, spec.key]);
  const { region, reach } = space;
  const [natural, setNatural] = useState<Natural | null>(null);
  const [naturalAfter, setNaturalAfter] = useState<Natural | null>(null);
  const aspect = frameAspect(natural, spec.frames, spec.rows);
  const aspectAfter = after === undefined ? aspect : frameAspect(naturalAfter, after.frames);
  // The box of the first sprite is the one a shot with `from` is laid out from, whichever sprite shows.
  const firstBox = boxDims(spec, aspect);
  const firstDrawn = drawnDims(spec, aspect);
  // The second sprite shows once the first has played out (at once under reduced motion, where there is nothing to play) and its sheet is
  // there and fits the free area. Otherwise the first one stays, on its last frame.
  const calm = reduced || !canAnimate(HTMLImageElement.prototype);
  const afterBox = boxDims(spec, aspectAfter);
  const afterReady = after !== undefined && naturalAfter !== null && fitsRegion(afterBox, region);
  const showAfter = afterReady && (heldFirst || calm);
  const drawn = showAfter ? drawnDims(spec, aspectAfter) : firstDrawn;
  const box = showAfter ? afterBox : firstBox;
  const [step, setStep] = useState(0);
  const [ready, setReady] = useState(false);
  // A change of box (the second sprite's turn, or a replay) takes its place at once: no glide for that one render.
  const [snap, setSnap] = useState(false);
  const [wasAfter, setWasAfter] = useState(showAfter);
  if (wasAfter !== showAfter) {
    setWasAfter(showAfter);
    setSnap(true);
  }
  useEffect(() => {
    if (!snap) return;
    const frame = requestAnimationFrame(() => setSnap(false));
    return () => cancelAnimationFrame(frame);
  }, [snap]);
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
  const fits = fitsRegion(firstBox, region);
  const stepNow = reduced ? 0 : step;
  const firstAt = restOf(spec, region, stepNow, aspect, reach);
  const firstInside = spriteInBox(spec, firstDrawn, firstBox);
  const at = showAfter ? afterRestOf(spec, region, stepNow, { first: aspect, after: aspectAfter }, reach) : firstAt;
  const inside = showAfter ? spriteInBox(spec, drawn, box) : firstInside;
  const placed = natural !== null && fits;
  const left = firstAt.x + firstInside.x;
  const top = firstAt.y + firstInside.y;
  const { w, h } = firstDrawn;
  useEffect(() => {
    if (!placed) return;
    onPlace(spec.key, { x: left, y: top, w, h });
    return () => onPlace(spec.key, null);
  }, [placed, left, top, w, h, spec.key, onPlace]);
  // The play clock runs while the picture is drawn and the page is visible, and stands otherwise. Layout effect: the sprites read it in their own effects.
  const running = fits && !paused;
  useLayoutEffect(() => {
    if (!running) return;
    floatClock.resume(spec.key, playKey);
    return () => floatClock.pause(spec.key, playKey);
  }, [running, spec.key, playKey]);
  if (!fits) return null;
  const glide = spec.motion === "wander" ? FLOAT_WANDER_GLIDE_MS : FLOAT_SETTLE_MS;
  return (
    <div
      data-slot="float-pet"
      data-motion={spec.motion}
      data-mood={spec.mood}
      data-trick={spec.trickId}
      className="pointer-events-none absolute top-0 left-0 will-change-transform"
      style={{
        width: box.w,
        height: box.h,
        // In place from the first frame: invisible until its sheet is there and placed, then it fades in. No travel.
        opacity: ready ? 1 : 0,
        transform: `translate3d(${at.x}px, ${at.y}px, 0)`,
        transition: ready && !reduced && !snap ? `transform ${glide}ms ease-in-out, opacity ${FLOAT_ENTER_MS}ms ease-out` : undefined,
      }}
    >
      <span ref={bob} className="absolute block" style={{ left: inside.x, top: inside.y }}>
        <span data-slot="float-first" className="absolute top-0 left-0 block" style={{ visibility: showAfter ? "hidden" : "visible" }}>
          <Sprite spec={spec} url={url} aspect={aspect} reduced={reduced} paused={paused} playKey={playKey} clock={{ key: spec.key, offsetMs: 0 }} onLoaded={setNatural} onHeld={hold} />
        </span>
        {after !== undefined && (
          <span data-slot="float-after" className="absolute top-0 left-0 block" style={{ visibility: showAfter ? "visible" : "hidden" }}>
            <Sprite
              spec={after}
              url={afterUrl}
              aspect={aspectAfter}
              reduced={reduced}
              paused={paused}
              playKey={playKey}
              clock={{ key: spec.key, offsetMs: lastFrameAtMs(spec.frames, spec.fps) }}
              active={showAfter}
              stillLast
              onLoaded={setNaturalAfter}
            />
          </span>
        )}
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

/** What a shot is laid out from once it begins: the free area, and the drawn box of its pet (none: it starts as usual). */
interface Begun {
  region: Box;
  origin: Box | undefined;
}

/**
 * A once-shot: one motion along its path in the free area, then it is over. Never takes a pointer. With
 * `pet` (the drawn box of the stay picture its part names, in the layer's own coordinates, the ones the free area
 * is in) the motion starts at that picture's hand. A shot whose part says `from` and whose pet is on the way
 * (`waits`) holds still, loading its sheet, until the pet reports its box, for at most FLOAT_FROM_WAIT_MS; only
 * then does it begin (`onBegin`, so the queue's rate counts from here), and with no pet by then it starts as usual.
 * A pet whose sprite plays once (`loop = false`) that has not reached its last frame (`holding`) is waited for too,
 * for at most FLOAT_THROW_WAIT_MS from the shot's arrival; then the shot starts from the pet's hand anyway.
 */
function FloatShot({
  spec,
  region: asked,
  pet,
  waits,
  holding,
  paused,
  versions,
  onBegin,
  onDone,
}: {
  spec: FloatSpec;
  region: Box;
  pet: Box | undefined;
  waits: boolean;
  holding: boolean;
  paused: boolean;
  /** The trick row's picture versions (`WireTrickInfo.media`). */
  versions: WireTrickInfo["media"];
  onBegin: () => void;
  onDone: () => void;
}) {
  // The free area and the start as they were when the shot began: a shot of at most five seconds is not laid out again.
  const [begun, setBegun] = useState<Begun | null>(() => (!waits || (pet !== undefined && !holding) ? { region: asked, origin: pet } : null));
  const latest = useRef({ asked, pet });
  latest.current = { asked, pet };
  // How long the shot has waited, as the page ran: a hidden page stops the count, as it stops the pet's play.
  const waitClock = useRef<{ spent: number; since: number | null }>({ spent: 0, since: paused ? null : Date.now() });
  useEffect(() => {
    const clock = waitClock.current;
    if (paused && clock.since !== null) {
      clock.spent += Date.now() - clock.since;
      clock.since = null;
      return;
    }
    if (!paused && clock.since === null) clock.since = Date.now();
  }, [paused]);
  useEffect(() => {
    if (begun !== null) return;
    if (pet !== undefined && !holding) {
      setBegun({ region: latest.current.asked, origin: pet });
      return;
    }
    const start = (): void => setBegun({ region: latest.current.asked, origin: latest.current.pet });
    // No pet box by FLOAT_FROM_WAIT_MS: start as usual. A pet that has not finished its play by FLOAT_THROW_WAIT_MS: start from it anyway.
    // Both counted from the shot's arrival, not from this effect: a pet that reports late does not move them.
    if (paused) return;
    const { spent, since } = waitClock.current;
    const gone = spent + (since === null ? 0 : Date.now() - since);
    const timer = setTimeout(() => (latest.current.pet === undefined ? start() : undefined), Math.max(0, FLOAT_FROM_WAIT_MS - gone));
    const cap = setTimeout(start, Math.max(0, FLOAT_THROW_WAIT_MS - gone));
    return () => {
      clearTimeout(timer);
      clearTimeout(cap);
    };
  }, [begun, pet, holding, paused]);
  const begin = useRef(onBegin);
  begin.current = onBegin;
  useEffect(() => {
    if (begun !== null) begin.current();
  }, [begun]);
  const region = begun?.region ?? asked;
  const origin = begun?.origin;
  const { url, failed } = useAuthedUrl(trickMediaPath(spec.host, spec.trickId, spec.src, spec.rev, mediaVersionOf({ media: versions }, spec.src)));
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
    () => (motion === undefined || !loaded || !fits || begun === null ? null : pathOf({ motion, key: spec.key, rev: spec.rev, dims: drawnDims({ size }, aspect), region, from: origin })),
    [motion, loaded, fits, begun, spec.key, spec.rev, size, aspect, region, origin],
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
      <Sprite spec={spec} url={url} aspect={aspect} reduced={false} paused={paused} playKey={String(spec.rev)} onLoaded={setNatural} />
    </div>
  );
}

/** The key of the stay part a once part names with `from`. */
function petKeyOf(spec: FloatSpec): string {
  return `${spec.host}/${spec.trickId}/${spec.from ?? ""}`;
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
  // Where each stay picture on screen draws now, by key: a once part with `from` starts at the one it names. State, not
  // a ref: a shot that waits for its pet starts the moment the pet reports.
  const [placed, setPlaced] = useState<ReadonlyMap<string, Box>>(() => new Map());
  const onPlace = useCallback((key: string, box: Box | null) => {
    setPlaced((had) => {
      const known = had.get(key);
      if (box === null ? known === undefined : known !== undefined && sameBox(known, box)) return had;
      const next = new Map(had);
      if (box === null) next.delete(key);
      else next.set(key, box);
      return next;
    });
  }, []);
  // Which stay pictures have played their frames to the last one (`sprite.loop = false`), by key: a once part with `from` waits for it.
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
  const onHold = useCallback((key: string, now: boolean) => {
    setHeld((had) => {
      if (had.has(key) === now) return had;
      const next = new Set(had);
      if (now) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

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
  // A part that arrives while the layer has not measured its free area yet (the trick's first float part makes the
  // layer want to draw, and the area is read a frame later) is held, by key, until the area is there. It is not
  // held for a screen that is covered, a device that has floating things off, or reduced motion: those drop it.
  const pending = useRef(new Map<string, number>());
  const holdable = wanted && !covered && !reduced;
  // A shot that is on screen when the layer goes away (a Page opens, a sheet covers the screen) is kept, not dropped: it comes back with its pet.
  const parked = useRef<{ spec: FloatSpec; sig: string; at: number } | null>(null);
  const keepsShots = on && parts.length > 0 && !reduced;
  const latest = useRef({ here, drawing, reduced, holdable, keepsShots });
  latest.current = { here, drawing, reduced, holdable, keepsShots };
  // A part that has left takes its play clock with it.
  useEffect(() => {
    const keys = new Set<string>();
    for (const part of parts) {
      const spec = readFloat(part);
      if (spec !== null) keys.add(spec.key);
    }
    floatClock.retain(keys);
  }, [parts]);
  const sync = state.rev;
  useEffect(() => {
    if (sync === null) return;
    const current = new Map<string, string>();
    const arrived: string[] = [];
    for (const part of parts) {
      const spec = readFloat(part);
      if (spec === null || spec.mode !== "once") continue;
      const sig = partSignature(part);
      current.set(spec.key, sig);
      if (seen.current.get(spec.key) !== sig && !spec.stale) arrived.push(spec.key);
    }
    seen.current = current;
    const first = !primed.current;
    primed.current = true;
    // What was there when the phone first looked is old news: only a part that arrives or changes after that plays.
    if (first) return;
    const { here: shown, drawing: can, reduced: calm, holdable: later } = latest.current;
    if (!can && later) {
      for (const key of arrived) pending.current.set(key, Date.now());
      return;
    }
    if (!can || calm) return;
    for (const key of arrived) {
      const spec = shown.find((candidate) => candidate.key === key);
      if (spec === undefined) continue;
      if (queue.current.offer(spec) === "play") setShot(spec);
    }
  }, [parts, sync]);
  // The free area is there: what arrived before it, and not long ago, plays now.
  useEffect(() => {
    if (!drawing) return;
    const { here: shown } = latest.current;
    const now = Date.now();
    // The shot the layer left comes back, unless it was away too long or its part has changed or gone meanwhile: that one is dropped.
    const kept = parked.current;
    parked.current = null;
    const again = kept === null ? undefined : shown.find((candidate) => candidate.key === kept.spec.key && partSignature(candidate.part) === kept.sig);
    if (kept !== null && again !== undefined && now - kept.at <= FLOAT_AWAY_CAP_MS && queue.current.resume(again)) setShot(again);
    for (const [key, at] of pending.current) {
      pending.current.delete(key);
      const spec = shown.find((candidate) => candidate.key === key);
      if (spec === undefined || now - at > FLOAT_PENDING_MS) continue;
      if (queue.current.offer(spec) === "play") setShot(spec);
    }
  }, [drawing]);
  // Anything that takes the screen away ends the shot and drops the one that waits.
  useEffect(() => {
    if (drawing) return;
    const playing = queue.current.playing;
    // Only a shot that is on screen is parked; a second run of this effect (the screen changed again while away) leaves the kept one alone.
    if (playing !== null && latest.current.keepsShots) parked.current = { spec: playing, sig: partSignature(playing.part), at: Date.now() };
    else if (!latest.current.keepsShots) parked.current = null;
    queue.current.cancel();
    setShot(null);
    if (!latest.current.holdable) pending.current.clear();
  }, [drawing, screen, pane?.paneId]);
  const finishShot = () => setShot(queue.current.finish());

  if (!wanted) return null;
  return (
    <div data-slot="float-layer" className="pointer-events-none fixed inset-0 z-20 overflow-hidden">
      <div aria-hidden ref={probe} className="invisible absolute inset-0 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]" />
      {drawing &&
        stay.map((spec) => {
          const row = state.tricks.find((trick) => trick.host === spec.host && trick.id === spec.trickId);
          const trickName = row?.name ?? spec.trickId;
          const page = spec.opens === "page" && parsePartKey(spec.key) !== undefined ? sessionOfMark(spec.part, trickSessions) : undefined;
          const resting = spec.motion === "perch" || spec.motion === "idle";
          const open = page !== undefined && resting ? () => nav.down(trickSessionPath(page.paneId)) : undefined;
          return (
            <TrickBoundary key={spec.key} fallback="none" resetKey={`${spec.key}@${spec.rev}`}>
              <FloatPet spec={spec} space={space} reduced={reduced} paused={!visible} trickName={trickName} versions={row?.media} onOpen={open} onPlace={onPlace} onHold={onHold} />
            </TrickBoundary>
          );
        })}
      {drawing && region !== null && shot !== null && (
        // The shot is clipped to the free area's width: a fly-across travels on until it is wholly past the far edge and the clip hides it
        // there, so nothing paints over a side landmark or past the screen. The inner box is at the layer's origin, so the shot's own
        // coordinates (the layer's) are unchanged.
        <div data-slot="float-clip" className="pointer-events-none absolute top-0 bottom-0 overflow-hidden" style={{ left: region.x, width: region.w }}>
          <div className="pointer-events-none absolute top-0" style={{ left: -region.x }}>
            <TrickBoundary fallback="none" resetKey={`${shot.key}@${shot.rev}`}>
              <FloatShot
                key={`${shot.key}@${shot.rev}`}
                spec={shot}
                region={region}
                pet={shot.from === undefined ? undefined : placed.get(petKeyOf(shot))}
                waits={shot.from !== undefined && stay.some((candidate) => candidate.key === petKeyOf(shot))}
                holding={stay.some((candidate) => candidate.key === petKeyOf(shot) && !candidate.loop && !held.has(candidate.key))}
                paused={!visible}
                versions={state.tricks.find((trick) => trick.host === shot.host && trick.id === shot.trickId)?.media}
                onBegin={() => queue.current.began(shot.trick)}
                onDone={finishShot}
              />
            </TrickBoundary>
          </div>
        </div>
      )}
    </div>
  );
}
