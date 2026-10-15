import type { CSSProperties } from "react";
import { useId } from "react";

import { cn } from "@/lib/utils";

import type { MarkProps } from "./contract";

// THE DAYLIGHT MARK (M57 spec 10): a hare in the sun. The story, the state table and every keyframe
// are in daylight.notes.md beside this file.
//
// It is drawn for 24px in direct sun first: one filled silhouette, no hairline. The two fine parts
// (the thigh line and the gap between the ears) are knockouts in the paper colour, 2.5 units wide,
// which is a pixel at 24px. The eye is a knockout disc with an ink pupil, the sharp eye of the story.
//
// THE THREE STATES
// - idle: the hare sits upright, the sun stands high to its right, its shadow lies short to the
//   left. One loop only: the near ear flicks once every 20 s. Nothing else moves.
// - loading: the day runs. The sun crosses the sky in 1.8 s, the shadow swings under the hare as a
//   sundial does, the body bounces in a ready crouch, both ears twitch, the eye darts, the rays
//   pulse. Seven animated parts, each on its own element.
// - lost: no sun, no shadow, the hare sits hunched with its head turned away and its ears flat.
//   Ink drops to --muted-foreground. No animation at all.
//
// COLOUR SAYS THE STATE TOO. Under reduced motion every loop stops, and loading still reads as
// different from idle: the sun is at full strength with its rays, where idle draws it pale and bare.
//
// THE STYLESHEET IS SHARED. A <style> inside an inline SVG is document-scoped, so every rule and
// every keyframe name starts with `cm-dl-`: two marks on one page (the gallery draws all four) can
// never pick up each other's rules. The `cm-` start is also what the header's rate ramp collects
// (collie-home.tsx), so a round speeds this hare up and down the way it does the dog.
//
// SVG TRANSFORMS. A CSS transform replaces an element's transform attribute, so no element here
// carries both: the parts that move in CSS sit in groups of their own. `transform-origin` is in
// viewBox units, measured from the drawing's (0, 0) and not from the corner a weight frames.

// The figure, facing right, in a 64 by 64 box with the ground at y 56.
const BODY =
  "M14 56C8 55 8 45 12 38C16 31 24 26 31 23C34 18 40 16 45 17C50 18 55 22 56 25C56 28 52 30 47 30" +
  "C46 34 46 38 46 43L46.5 52.5C49 53 52 54 52 56Z";
const EAR_FAR = "M34 21C29 15 26 8 26 1C31 4 36 11 39.5 18Z";
const EAR_NEAR = "M38 19C36 12 35 6 36 0C40 3 43 10 43.5 17Z";
const THIGH = "M23 56C19 50 20 42 26 38C31 36 35 39 36 43";
// The lost pose: the same seat and haunch, the head lowered and turned away (no nose, no eye), the
// two ears laid back flat over the shoulders.
const LOST =
  "M14 56C8 55 8 45 12 38C16 31 24 27 31 25C33 21 38 19 42 20C47 21 50 25 49 29C48 32 47 35 46 43" +
  "L46.5 52.5C49 53 52 54 52 56Z";
const LOST_EAR_FAR = "M38 21C31 16 23 14 15 15C21 19 28 22 35 25Z";
const LOST_EAR_NEAR = "M40 23C33 20 25 20 16 22C23 25 30 27 37 27Z";

// Eight rays around the sun's centre, as one path of short round-capped strokes.
const RAYS = Array.from({ length: 8 }, (_, i) => {
  const a = (i * Math.PI) / 4;
  const p = (r: number) => `${(Math.sin(a) * r).toFixed(2)} ${(-Math.cos(a) * r).toFixed(2)}`;
  return `M${p(8.5)}L${p(10.5)}`;
}).join("");

/**
 * Every rule of the mark. The sun turns about (32, 64), a point under the ground, so it rises at the
 * left edge, passes behind the ears and sets past the right edge. At rest it stands at 20 degrees,
 * high on the right. The shadow is the silhouette flipped and flattened onto the ground at y 56 and
 * sheared away from the sun: its angle is the sun's times -1.2, so it lies long when the sun is low.
 * In loading the sun turns 120 degrees per round at an even speed, with one jump while it is out of
 * the frame (60 to -60 degrees at a third of the round); the shadow fades out before that jump and
 * back in after it, so the swing never snaps in view.
 */
const STYLE = [
  ".cm-dl-sun{transform-origin:32px 64px;transform:rotate(20deg)}",
  ".cm-dl-disc{fill:var(--cm-a2);opacity:.55}",
  ".cm-dl-bright{opacity:1}",
  ".cm-dl-rays{fill:none;stroke:var(--cm-a2);stroke-width:2.6px;stroke-linecap:round}",
  ".cm-dl-cast{fill:var(--cm-a1);opacity:.45;transform-origin:0 56px;transform:skewX(-24deg) scaleY(-.14)}",
  ".cm-dl-crouch{transform-origin:30px 56px}",
  ".cm-dl-near{transform-origin:41px 18px}",
  ".cm-dl-far{transform-origin:37px 20px}",
  // idle: the one loop. The ear rests 95 per cent of the 20 s, then flicks for 0.8 s.
  "@keyframes cm-dl-flick{0%,95%{transform:none}96%{transform:rotate(-18deg)}97%{transform:rotate(6deg)}" +
    "98%{transform:rotate(-8deg)}99%,100%{transform:none}}",
  ".cm-dl-flick{animation:cm-dl-flick 20s ease-in-out infinite}",
  // loading: seven loops on the 1.8 s round, or a third or a half of it.
  "@keyframes cm-dl-day{0%{transform:rotate(20deg)}33.33%{transform:rotate(60deg)}" +
    "33.34%{transform:rotate(-60deg)}100%{transform:rotate(20deg)}}",
  ".cm-dl-day{animation:cm-dl-day 1.8s linear infinite}",
  "@keyframes cm-dl-swing{0%,100%{transform:skewX(-24deg) scaleY(-.14);opacity:.45}" +
    "20%{transform:skewX(-52.8deg) scaleY(-.14);opacity:.45}33.33%{transform:skewX(-72deg) scaleY(-.14);opacity:0}" +
    "33.34%{transform:skewX(72deg) scaleY(-.14);opacity:0}46.67%{transform:skewX(52.8deg) scaleY(-.14);opacity:.45}}",
  ".cm-dl-swing{animation:cm-dl-swing 1.8s linear infinite}",
  "@keyframes cm-dl-pulse{0%,100%{transform:none}50%{transform:scale(1.22)}}",
  ".cm-dl-pulse{animation:cm-dl-pulse .6s ease-in-out infinite}",
  "@keyframes cm-dl-bounce{0%,100%{transform:none}35%{transform:scale(1.06,.9)}70%{transform:scale(.97,1.05)}}",
  ".cm-dl-bounce{animation:cm-dl-bounce .9s ease-in-out infinite}",
  "@keyframes cm-dl-twitch{0%,100%{transform:none}12%{transform:rotate(-11deg)}24%{transform:rotate(4deg)}36%{transform:none}}",
  ".cm-dl-twitch{animation:cm-dl-twitch 1.8s ease-in-out infinite}",
  "@keyframes cm-dl-perk{0%,48%,100%{transform:none}60%{transform:rotate(-13deg)}72%{transform:rotate(5deg)}84%{transform:none}}",
  ".cm-dl-perk{animation:cm-dl-perk 1.8s ease-in-out infinite}",
  "@keyframes cm-dl-look{0%,22%,100%{transform:none}30%,52%{transform:translateX(-1.6px)}60%,74%{transform:translateY(-.8px)}}",
  ".cm-dl-look{animation:cm-dl-look 1.8s ease-in-out infinite}",
  // Every animated class, stopped. Colour still tells loading from idle: a bright sun with rays.
  "@media (prefers-reduced-motion: reduce){.cm-dl-flick,.cm-dl-day,.cm-dl-swing,.cm-dl-pulse,.cm-dl-bounce," +
    ".cm-dl-twitch,.cm-dl-perk,.cm-dl-look{animation:none!important}}",
].join("");

/** The header weight is the drawing itself; the full weight frames it with sky and ground around. */
const VIEW = { full: "-10 -13 84 84", header: "0 -3 64 64" };

const vars = (paper: string, lost: boolean): CSSProperties => {
  const set = {
    display: "block",
    flex: "none",
    "--cm-a1": "var(--primary)",
    "--cm-a2": "var(--syntax-entity)",
    "--cm-paper": paper,
  };
  // Lost greys the ink. The other two states leave the colour to the caller, so it stays unset.
  const style = lost ? { ...set, color: "var(--muted-foreground)" } : set;
  // SAFETY: every key is `display`, `flex`, `color` or a CSS custom property, and every value is a
  // string. React passes unknown style keys straight through to the DOM. The cast exists only because
  // CSSProperties has no index signature for `--*`; it widens nothing.
  return style as CSSProperties;
};

/**
 * The Daylight theme's header mark, a hare. Ink is `currentColor`, the knockout is `--cm-paper`
 * (the `paper` prop), the accents are `--cm-a1` (the shadow, default `--primary`) and `--cm-a2`
 * (the sun, default `--syntax-entity`).
 */
export function DaylightMark({
  size = 32,
  state = "idle",
  paper = "var(--background)",
  title,
  className,
  weight = "full",
}: MarkProps) {
  // The shadow and the halo reuse the silhouette through `<use>`, and an id in an inline SVG is
  // document-scoped, so each instance names its own. The colons React puts in the id are stripped.
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const bodyId = `dl${uid}-body`;
  const silId = `dl${uid}-sil`;
  const loading = state === "loading";
  const lost = state === "lost";
  // `cm-live` on the root while loading is the hosts' one question to every mark (test/collie-mark.ts).
  const classes = cn(loading && "cm-live", className);
  const ink = "currentColor";
  const knock = "var(--cm-paper)";
  return (
    <svg
      width={size}
      height={size}
      viewBox={VIEW[weight]}
      className={classes === "" ? undefined : classes}
      role={title === undefined ? "presentation" : "img"}
      style={vars(paper, lost)}
    >
      {title === undefined ? null : <title>{title}</title>}
      <style>{STYLE}</style>
      {lost ? (
        <g fill={ink}>
          <path d={LOST} />
          <path d={THIGH} fill="none" stroke={knock} strokeWidth={2.5} strokeLinecap="round" />
          <path d={LOST_EAR_FAR} stroke={knock} strokeWidth={2.5} paintOrder="stroke" />
          <path d={LOST_EAR_NEAR} stroke={knock} strokeWidth={2.5} paintOrder="stroke" />
        </g>
      ) : (
        <>
          <defs>
            <path id={bodyId} d={BODY} />
            <g id={silId}>
              <use href={`#${bodyId}`} />
              <path d={EAR_FAR} />
              <path d={EAR_NEAR} />
            </g>
          </defs>
          <g className={cn("cm-dl-sun", loading && "cm-dl-day")}>
            <g transform="translate(32 4)">
              {loading ? (
                <g className="cm-dl-pulse">
                  <path className="cm-dl-rays" d={RAYS} />
                </g>
              ) : null}
              <circle className={cn("cm-dl-disc", loading && "cm-dl-bright")} r={6.5} />
            </g>
          </g>
          <use href={`#${silId}`} className={cn("cm-dl-cast", loading && "cm-dl-swing")} />
          <g className={cn("cm-dl-crouch", loading && "cm-dl-bounce")}>
            <use href={`#${bodyId}`} fill="none" stroke={knock} strokeWidth={5} strokeLinejoin="round" />
            <g className={cn("cm-dl-far", loading && "cm-dl-perk")}>
              <path d={EAR_FAR} fill={ink} stroke={knock} strokeWidth={2.5} paintOrder="stroke" />
            </g>
            <g className={cn("cm-dl-near", loading ? "cm-dl-twitch" : "cm-dl-flick")}>
              <path d={EAR_NEAR} fill={ink} stroke={knock} strokeWidth={2.5} paintOrder="stroke" />
            </g>
            <use href={`#${bodyId}`} fill={ink} />
            <path d={THIGH} fill="none" stroke={knock} strokeWidth={2.5} strokeLinecap="round" />
            <circle cx={47.5} cy={21.5} r={2.7} fill={knock} />
            <g className={loading ? "cm-dl-look" : undefined}>
              <circle cx={48.3} cy={21.5} r={1.3} fill={ink} />
            </g>
          </g>
        </>
      )}
    </svg>
  );
}
