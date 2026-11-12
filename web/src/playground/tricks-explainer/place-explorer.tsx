// Where a trick can show, on the app's own screens (place-scenes.tsx), the trick's part lit and the rest
// dimmed; every place said the same way (place-data.ts). The owner picked this one of round 3's variants.
//   - `PlacesExplorer`: one phone and a chip per place, grouped; a tap switches the phone and the text
//     box beside it, which is as tall as the longest entry, so nothing moves. Under reduced motion the
//     chips go, the first place shows, and the rest are a plain list. The places chapter, and the live
//     component the website may mount (explainer-figures.tsx says how).
//   - `PlacesTour`: the figure `where-a-trick-can-show`. While playing it steps through the places, one
//     caption line naming the lit one; still, and under reduced motion, it shows the first place.
//   - `GatesWalk`: one trick, Release Gates, through four steps. It ends the places chapter.
// No code and no playground fixture.
// DEV-ONLY, like the rest of `src/playground/`.

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import { HUE_BORDER, HUE_TEXT, wash } from "./hues";
import { useStill } from "./motion";
import { GROUP_NAMES, GROUPS, IN_ORDER, PLACE_ENTRIES, placesOf, type PlaceId } from "./place-data";
import { byText, CAPTION_H, Lit, PhoneScreen, Scene, useSceneTricks, type SceneId, type Target } from "./place-scenes";

// ── Shared pieces ────────────────────────────────────────────────────────────────────────────────

function Badge({ n, className }: { n: number; className?: string }) {
  return (
    <span aria-hidden className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-full border-2 font-mono text-[12px] font-bold", HUE_BORDER.trick, HUE_TEXT.trick, className)}>
      {n}
    </span>
  );
}

/** What is said about a place: its name, what it is good for, a tap, and a real trick. */
function PlaceText({ id }: { id: PlaceId }) {
  const e = PLACE_ENTRIES[id];
  return (
    <div data-place={id} className="min-w-0 space-y-1.5 text-[15px] leading-relaxed">
      <p className="flex items-center gap-2 text-lg font-semibold">
        <Badge n={e.n} />
        {e.name}
      </p>
      <p>{e.good}</p>
      <p>
        <span className="font-semibold">A tap: </span>
        {e.tap}
      </p>
      <p className="text-muted-foreground">
        <span className="font-semibold text-foreground">Used by </span>
        {e.trick}
      </p>
    </div>
  );
}

function target(id: PlaceId): Target {
  return { find: PLACE_ENTRIES[id].find };
}

/** The whole screen: on a trick's Page, all of it is the trick's. */
const WHOLE: Target["find"] = (root) => root;

/** The screen a place is shown on. The Page's own screen, not the row that leads to it: a tap leads there. */
function sceneOf(id: PlaceId): SceneId {
  return id === "session" ? "page" : PLACE_ENTRIES[id].scene;
}

/** What is lit: the place's part, or nothing on the Page, which is all the trick's. */
function litOf(id: PlaceId): readonly Target[] {
  return id === "session" ? [] : [target(id)];
}

const SCENE_LABEL = {
  dashboard: "The Dashboard",
  page: "A trick's Page",
  session: "An agent session",
  "agent-view": "An agent view",
  hill: "The Hill",
} as const satisfies Record<SceneId, string>;

const NONE: readonly Target[] = [];

/** The phone's screens, each kept mounted once seen, so a second visit does not wait for it again. */
function Screens({ picked }: { picked: PlaceId }) {
  const scene = sceneOf(picked);
  const [seen, setSeen] = useState<ReadonlySet<SceneId>>(() => new Set([scene]));
  useEffect(() => {
    setSeen((s) => (s.has(scene) ? s : new Set([...s, scene])));
  }, [scene]);
  const lit = useMemo(() => litOf(picked), [picked]);
  return (
    <>
      {[...seen].map((s) => (
        <div key={s} hidden={s !== scene} className="h-full">
          <Lit targets={s === scene ? lit : NONE}>
            <Scene id={s} />
          </Lit>
        </div>
      ))}
    </>
  );
}

const FIRST: PlaceId = IN_ORDER[0] ?? "dashboard";

// ── The live one: a chip per place ─────────────────────────────────────────────────────────────────

/**
 * One phone and a chip per place. Mount it live, not inert: the chips are its point. It fills its
 * container's width and sets its own height (one column under 672 px, two from there).
 */
export function PlacesExplorer() {
  useSceneTricks();
  const [picked, setPicked] = useState<PlaceId>(FIRST);
  return (
    <div data-slot="places-explorer" className="@container space-y-4">
      <div className="grid grid-cols-1 gap-5 @2xl:grid-cols-[minmax(0,390px)_minmax(0,1fr)] @2xl:gap-8">
        <div className="space-y-4 @2xl:order-2">
          <div className="space-y-3 motion-reduce:hidden" role="group" aria-label="Places">
            {GROUPS.map((group) => (
              <div key={group} className="space-y-1.5">
                <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{GROUP_NAMES[group]}</p>
                <div className="flex flex-wrap gap-2">
                  {placesOf(group).map((id) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={picked === id}
                      onClick={() => setPicked(id)}
                      className={cn(
                        "inline-flex min-h-11 items-center gap-2 rounded-sm border px-3 text-[14px] font-medium",
                        picked === id ? cn(HUE_BORDER.trick, "text-foreground") : "border-border text-muted-foreground",
                      )}
                      style={picked === id ? { background: wash("trick", 14) } : undefined}
                    >
                      <Badge n={PLACE_ENTRIES[id].n} className="size-5 border text-[11px]" />
                      {PLACE_ENTRIES[id].name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {/* The reserved box: as tall as the longest entry at every width, so a tap moves nothing. */}
          <div aria-live="polite" className="grid rounded-sm border border-border p-4">
            {IN_ORDER.map((id) => (
              <div key={id} className={cn("col-start-1 row-start-1", id === picked ? "visible" : "invisible")} aria-hidden={id !== picked}>
                <PlaceText id={id} />
              </div>
            ))}
          </div>
        </div>
        <div className="@2xl:order-1">
          <PhoneScreen label={`${SCENE_LABEL[sceneOf(picked)]}, with ${PLACE_ENTRIES[picked].name} lit`}>
            <Screens picked={picked} />
          </PhoneScreen>
        </div>
      </div>
      {/* Reduced motion: the first place above, and the rest as a plain list. */}
      <ul className="hidden space-y-4 border-t border-border pt-4 motion-reduce:block">
        {IN_ORDER.slice(1).map((id) => (
          <li key={id}>
            <PlaceText id={id} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── The figure: the places in turn ─────────────────────────────────────────────────────────────────

/** The figure's screen height, at 390 px wide, under its caption line. */
export const TOUR_SCREEN_H = 600;
/** Width over height of the figure: the caption line and the screen. */
export const TOUR_ASPECT = 390 / (TOUR_SCREEN_H + CAPTION_H);
/** How long one place stands while the figure plays. */
const TOUR_MS = 3200;

/** The places in turn while playing, one caption naming the lit one; the first place, still, otherwise. */
export function PlacesTour({ playing }: { playing: boolean }) {
  useSceneTricks();
  const still = useStill();
  const moving = playing && !still;
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!moving) return;
    const id = window.setInterval(() => setStep((s) => (s + 1) % IN_ORDER.length), TOUR_MS);
    return () => window.clearInterval(id);
  }, [moving]);
  const picked = moving ? (IN_ORDER[step] ?? FIRST) : FIRST;
  const e = PLACE_ENTRIES[picked];
  const caption = (
    <p className="flex items-center gap-2 text-[17px] font-semibold">
      <Badge n={e.n} />
      {e.name}
      <span className="text-[15px] font-normal text-muted-foreground">· {GROUP_NAMES[e.group].toLowerCase()}</span>
    </p>
  );
  return (
    <PhoneScreen fill height={TOUR_SCREEN_H} caption={caption} label={`Where a trick can show: ${e.name}, lit on ${SCENE_LABEL[sceneOf(picked)].toLowerCase()}`}>
      <Screens picked={picked} />
    </PhoneScreen>
  );
}

// ── The walk: one trick, four steps ────────────────────────────────────────────────────────────────

interface Step {
  title: string;
  line: string;
  scene: SceneId;
  targets: readonly Target[];
}

const WALK: readonly Step[] = [
  { title: "You glance at the tile.", line: "Release Gates shows 5 of 7 checks green, at the top of the Dashboard.", scene: "dashboard", targets: [{ find: byText("Gates") }] },
  { title: "You open its Page.", line: "The tile opens the Page: every check, and a button that reruns the red one.", scene: "page", targets: [{ find: WHOLE }] },
  { title: "You see its mark in a session.", line: "While you read an agent, the chip says e2e red, and the mark on the Belt reruns it.", scene: "session", targets: [target("status"), target("belt")] },
  { title: "It asks you on the Hill.", line: "Before the tag, it asks one question. Your tap is the answer.", scene: "hill", targets: [target("hill")] },
];

function WalkScreen({ step, n }: { step: Step; n: number }): ReactNode {
  return (
    <PhoneScreen height={640} label={`Step ${String(n)}: ${step.title}`}>
      <Lit targets={step.targets}>
        <Scene id={step.scene} />
      </Lit>
    </PhoneScreen>
  );
}

/**
 * Release Gates through its places, as a short story in four steps. It fills its container's width and
 * sets its own height: two columns from a 640 px wide container, one below. It runs no loop.
 */
export function GatesWalk() {
  useSceneTricks();
  return (
    <div className="@container">
      <ol data-slot="gates-walk" className="grid grid-cols-1 gap-8 @min-[640px]:grid-cols-2">
        {WALK.map((step, i) => (
          <li key={step.title} className="min-w-0 space-y-3">
            <p className="flex items-start gap-2 text-[15px] leading-snug">
              <Badge n={i + 1} />
              <span>
                <span className="font-semibold">{step.title}</span> {step.line}
              </span>
            </p>
            <WalkScreen step={step} n={i + 1} />
          </li>
        ))}
      </ol>
    </div>
  );
}
