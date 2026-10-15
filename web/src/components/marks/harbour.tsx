// THE HARBOUR MARK (M57 spec 10): a sea otter, floating on its back in the harbour.
//
// Idle: it floats and rises and falls on a slow swell, and once in a long while a hind paw twitches.
// Loading: it juggles a pebble in the theme's primary colour, with a squash at each catch and a
// stretch at each throw, and the whole animal answers the catch (head, paws, foot, tail, water).
// Lost: it has dived. Only the tip of its tail is above the water line, in the muted ink, and
// nothing moves. The story, the keyframe table and the byte count are in harbour.notes.md.
//
// The rules are the dog's (components/collie-mark.tsx), on purpose:
//
// - Ink is `currentColor`, the knockout is `var(--cm-paper)`, the two accents are `--cm-a1` (the
//   pebble, from `--primary`) and `--cm-a2` (the water, from `--status-info`). They are set on the
//   element as custom properties, so the test helpers that read the dog read this mark too.
// - The stylesheet is one module constant. A `<style>` inside an inline SVG is document-scoped, so
//   every class and keyframe here carries the `hb-` prefix and a second mark on the page is harmless.
// - Every keyframe name starts with `cm-`, so the header's rate ramp (collie-home.tsx) collects these
//   animations and throws one round of the juggle the way it throws one turn of the dog's orbit.
// - `cm-live` is on the root while loading, as on the dog: the header's tests read it there.
// - The drawing is plain JSX, not an `innerHTML` string, so a re-render of the header keeps the same
//   nodes and never restarts a running animation.
// - Under `prefers-reduced-motion: reduce` every animated class stops. Loading still reads: the static
//   loading pose holds the pebble up in the air, the ripple shows and the accents are at full colour.

import type { CSSProperties } from "react";
import { useId } from "react";

import type { MarkProps } from "./contract";

// Transform origins are in the drawing's own units (`transform-box: view-box`), so every part turns
// about a joint of the otter and not about its own box.
const STYLE =
  ".hb-otter,.hb-body,.hb-head,.hb-paws,.hb-pebble,.hb-spin,.hb-foot,.hb-tail,.hb-wave,.hb-ripple{transform-box:view-box}" +
  ".hb-otter{transform-origin:32px 46px}.hb-body{transform-origin:32px 46px}.hb-head{transform-origin:20px 35px}" +
  ".hb-paws{transform-origin:33px 40px}.hb-pebble{transform-origin:33px 35.5px}.hb-spin{transform-origin:33px 32px}" +
  ".hb-foot{transform-origin:44px 37px}.hb-tail{transform-origin:46px 43px}.hb-ripple{transform-origin:32px 46px;opacity:0}" +
  // Idle: one swell at the dog's 48 s scale, and a hind paw that twitches once every 28.8 s.
  ".hb-rest .hb-otter{animation:cm-hb-float 48s ease-in-out infinite}" +
  ".hb-rest .hb-foot{animation:cm-hb-twitch 28.8s linear infinite}" +
  // Loading: ten parts on one 1.8 s clock. The `transform` and `opacity` beside each animation are
  // the still loading pose that reduced motion shows.
  ".cm-live .hb-otter{animation:cm-hb-dip 1.8s ease-in-out infinite}" +
  ".cm-live .hb-body{animation:cm-hb-squash 1.8s ease-in-out infinite}" +
  ".cm-live .hb-head{transform:rotate(-8deg);animation:cm-hb-look 1.8s ease-in-out infinite}" +
  ".cm-live .hb-paws{transform:translate(0,-1.4px);animation:cm-hb-flick 1.8s ease-in-out infinite}" +
  ".cm-live .hb-pebble{transform:translate(0,-13px);animation:cm-hb-toss 1.8s linear infinite}" +
  ".cm-live .hb-spin{animation:cm-hb-spin 1.8s linear infinite}" +
  ".cm-live .hb-foot{animation:cm-hb-kick 1.8s ease-in-out infinite}" +
  ".cm-live .hb-tail{animation:cm-hb-slap 1.8s ease-in-out infinite}" +
  ".cm-live .hb-wave{animation:cm-hb-roll 1.8s linear infinite}" +
  ".cm-live .hb-ripple{opacity:.8;animation:cm-hb-ring 1.8s ease-out infinite}" +
  "@keyframes cm-hb-float{0%,100%{transform:translate(0,0) rotate(0)}50%{transform:translate(0,.7px) rotate(-.8deg)}}" +
  "@keyframes cm-hb-twitch{0%,61%,66%,100%{transform:rotate(0)}62%{transform:rotate(-16deg)}63%{transform:rotate(5deg)}64.2%{transform:rotate(-9deg)}}" +
  // The pebble: a high throw and a low one. Each segment carries its own easing, so it slows on the
  // way up and speeds on the way down, and the scale is the squash and the stretch.
  "@keyframes cm-hb-toss{" +
  "0%{transform:translate(0,0) scale(1,1)}" +
  "4%{transform:translate(0,.7px) scale(1.14,.84);animation-timing-function:cubic-bezier(.2,.7,.4,1)}" +
  "10%{transform:translate(0,-6px) scale(.84,1.2);animation-timing-function:cubic-bezier(.3,.8,.5,1)}" +
  "24%{transform:translate(0,-18px) scale(1,1);animation-timing-function:cubic-bezier(.5,0,.8,.4)}" +
  "36%{transform:translate(0,-5px) scale(.86,1.16);animation-timing-function:cubic-bezier(.4,0,1,1)}" +
  "40%{transform:translate(0,0) scale(1.26,.74);animation-timing-function:ease-out}" +
  "46%{transform:translate(0,-.8px) scale(.94,1.07);animation-timing-function:ease-in-out}" +
  "51%{transform:translate(0,0) scale(1,1)}" +
  "55%{transform:translate(0,.5px) scale(1.1,.88);animation-timing-function:cubic-bezier(.2,.7,.4,1)}" +
  "60%{transform:translate(0,-4px) scale(.88,1.14);animation-timing-function:cubic-bezier(.3,.8,.5,1)}" +
  "68%{transform:translate(0,-10px) scale(1,1);animation-timing-function:cubic-bezier(.5,0,.8,.4)}" +
  "75%{transform:translate(0,-3px) scale(.9,1.1);animation-timing-function:cubic-bezier(.4,0,1,1)}" +
  "78%{transform:translate(0,0) scale(1.18,.8);animation-timing-function:ease-out}" +
  "84%{transform:translate(0,-.4px) scale(.97,1.04);animation-timing-function:ease-in-out}" +
  "90%,100%{transform:translate(0,0) scale(1,1)}}" +
  // The pebble is an ellipse, so a half turn looks the same as a whole one: 540 degrees loops clean.
  "@keyframes cm-hb-spin{0%,4%{transform:rotate(0)}40%,55%{transform:rotate(360deg)}78%,100%{transform:rotate(540deg)}}" +
  "@keyframes cm-hb-flick{0%,16%,47%,65%,85%,100%{transform:translate(0,0)}4%{transform:translate(0,.8px)}9%{transform:translate(0,-2.4px)}36%{transform:translate(0,-1.2px)}40%{transform:translate(0,1px)}55%{transform:translate(0,.6px)}59%{transform:translate(0,-1.8px)}75%{transform:translate(0,-.9px)}78%{transform:translate(0,.8px)}}" +
  "@keyframes cm-hb-look{0%,4%,48%,86%,100%{transform:rotate(0)}24%{transform:rotate(-9deg)}40%{transform:rotate(1.5deg)}68%{transform:rotate(-5deg)}78%{transform:rotate(1deg)}}" +
  "@keyframes cm-hb-dip{0%,36%,54%,74%,92%,100%{transform:translate(0,0)}41%{transform:translate(0,.9px)}48%{transform:translate(0,-.3px)}79%{transform:translate(0,.6px)}86%{transform:translate(0,-.2px)}}" +
  "@keyframes cm-hb-squash{0%,37%,53%,75%,90%,100%{transform:scale(1,1)}41%{transform:scale(1.035,.92)}47%{transform:scale(.99,1.03)}79%{transform:scale(1.025,.95)}85%{transform:scale(.995,1.015)}}" +
  "@keyframes cm-hb-kick{0%,100%{transform:rotate(0)}8%{transform:rotate(-14deg)}16%{transform:rotate(6deg)}24%{transform:rotate(-12deg)}32%{transform:rotate(4deg)}41%{transform:rotate(-16deg)}50%{transform:rotate(4deg)}60%{transform:rotate(-12deg)}70%{transform:rotate(4deg)}79%{transform:rotate(-14deg)}88%{transform:rotate(3deg)}}" +
  "@keyframes cm-hb-slap{0%,30%,47%,70%,85%,100%{transform:rotate(0)}37%{transform:rotate(-16deg)}41%{transform:rotate(4deg)}75%{transform:rotate(-10deg)}79%{transform:rotate(3deg)}}" +
  "@keyframes cm-hb-roll{0%{transform:translate(0,0)}100%{transform:translate(-12px,0)}}" +
  "@keyframes cm-hb-ring{0%,39%,63%,77%,99%,100%{transform:scale(.4,.4);opacity:0}41%{transform:scale(.55,.55);opacity:.9}62%{transform:scale(1.5,1.5);opacity:0}79%{transform:scale(.5,.5);opacity:.7}98%{transform:scale(1.25,1.25);opacity:0}}" +
  "@media (prefers-reduced-motion: reduce){.hb-otter,.hb-body,.hb-head,.hb-paws,.hb-pebble,.hb-spin,.hb-foot,.hb-tail,.hb-wave,.hb-ripple{animation:none!important}}";

/** The full drawing at 64 units, and the header weight: the same drawing, framed to the otter. */
const VIEW = { full: "0 0 64 64", header: "7 6 48 48" };

/** The water line's stroke by weight: thicker in the header so it holds at 24 px. */
const WATER = { full: 1.6, header: 2.1 };

// A swell with a 6 unit wavelength, long enough on both sides to roll two wavelengths to the left,
// and a shorter, fainter one below it.
const WAVE = "M-8 46q3-1.4 6 0t6 0t6 0t6 0t6 0t6 0t6 0t6 0t6 0t6 0t6 0t6 0t6 0t6 0";
const SWELL = "M14 51.5q3-1.2 6 0t6 0t6 0t6 0t6 0t6 0";

// The otter: a body bent like a banana (head and feet up, belly low), clipped at the water line.
const BODY = "M17.5 34.5C21 45.5 38 47.5 44.5 38.5";
const TAIL = "M45 43C48.5 39.2 51.6 38.2 54.4 38.8C53.4 41.4 50.4 43.8 47 45Z";
const TAIL_TIP = "M28.4 48C27.9 40.5 25.8 33.6 23.6 28.4A2.2 2.2 0 0 1 27.9 27.1C30.3 33.1 32.9 40.6 34.6 48Z";

function vars(state: "idle" | "loading" | "lost", paper: string): CSSProperties {
  const set = {
    display: "block",
    flex: "none",
    // Lost: the ink drops to the muted foreground, so `currentColor` is grey everywhere in the drawing.
    color: state === "lost" ? "var(--muted-foreground)" : "inherit",
    // Quieter at rest, full colour while loading: the colour half of "working" that reduced motion keeps.
    "--cm-a1": state === "loading" ? "var(--primary)" : "color-mix(in oklab, var(--primary) 72%, var(--cm-paper))",
    "--cm-a2": state === "loading" ? "var(--status-info)" : "color-mix(in oklab, var(--status-info) 55%, var(--cm-paper))",
    "--cm-paper": paper,
  };
  // SAFETY: the keys are CSS properties and custom properties, every value a string. React passes unknown style
  // keys straight through to the DOM; the cast exists only because CSSProperties has no index
  // signature for `--*`. The same cast the dog makes.
  return set as CSSProperties;
}

/** The harbour otter. One inline `<svg>`, the three states of the mark contract. */
export function HarbourMark({
  size = 32,
  state = "idle",
  paper = "var(--background)",
  title,
  className,
  weight = "full",
}: MarkProps) {
  // Ids inside an inline SVG are document-scoped, so the water's fade is per instance.
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const fade = `hb${uid}f`;
  const mask = `hb${uid}m`;
  const above = `hb${uid}a`;
  const live = state === "loading" ? "cm-live" : "";
  const classes = className === undefined ? live || undefined : (live + " " + className).trim() || undefined;
  const lost = state === "lost";
  const water = lost ? "currentColor" : "var(--cm-a2)";
  return (
    <svg
      width={size}
      height={size}
      className={classes}
      viewBox={VIEW[weight]}
      role={title === undefined ? "presentation" : "img"}
      style={vars(state, paper)}
    >
      {title === undefined ? null : <title>{title}</title>}
      <style>{STYLE}</style>
      <defs>
        <linearGradient id={fade} gradientUnits="userSpaceOnUse" x1="6" y1="0" x2="56" y2="0">
          <stop offset="0" stopColor="#000" />
          <stop offset="0.16" stopColor="#fff" />
          <stop offset="0.84" stopColor="#fff" />
          <stop offset="1" stopColor="#000" />
        </linearGradient>
        <clipPath id={above}>
          <rect x="-10" y="-10" width="84" height="55.6" />
        </clipPath>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect width="64" height="64" fill={`url(#${fade})`} />
        </mask>
      </defs>
      {lost ? (
        <g>
          {/* Dived: the rings it left, a tail tip, two bubbles. Nothing here is animated. */}
          <ellipse cx="31.6" cy="46" rx="13" ry="2.2" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.45" />
          <ellipse cx="31.6" cy="46" rx="7.5" ry="1.4" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.8" />
          <g clipPath={`url(#${above})`}>
            <path d={TAIL_TIP} fill="currentColor" />
          </g>
          <circle cx="17.4" cy="41" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="14.2" cy="36.6" r="1.15" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </g>
      ) : (
        <g className={state === "idle" ? "hb-rest" : undefined}>
          <ellipse className="hb-ripple" cx="32" cy="46" rx="13" ry="2.2" fill="none" stroke="var(--cm-a2)" strokeWidth="1.2" />
          <g clipPath={`url(#${above})`}>
            <g className="hb-otter">
              <g className="hb-tail">
                <path d={TAIL} fill="currentColor" />
              </g>
              <g className="hb-foot">
                <path d="M44 37L47 27" stroke="currentColor" strokeWidth="4.4" strokeLinecap="round" />
                <ellipse cx="48.4" cy="24.2" rx="3.2" ry="4.6" transform="rotate(22 48.4 24.2)" fill="currentColor" />
              </g>
              <g className="hb-body">
                <path d={BODY} fill="none" stroke="currentColor" strokeWidth="13" strokeLinecap="round" />
              </g>
              <g className="hb-head">
                <circle cx="9.8" cy="27.2" r="1.5" fill="currentColor" />
                <ellipse cx="16.6" cy="29.6" rx="9.2" ry="6.2" transform="rotate(-22 16.6 29.6)" fill="currentColor" />
                <ellipse cx="23" cy="26.4" rx="4" ry="3" transform="rotate(-22 23 26.4)" fill="color-mix(in oklab, currentColor 30%, var(--cm-paper))" />
                <circle cx="25.6" cy="25" r="1.35" fill="currentColor" />
                <circle cx="18.4" cy="27" r="1.4" fill="var(--cm-paper)" />
              </g>
              <g className="hb-paws" fill="currentColor" stroke="currentColor" strokeWidth="4" strokeLinecap="round">
                <path d="M28 41.5L29.6 35.8M35 41.5L36.2 36" />
                <circle cx="29.6" cy="35.4" r="2.6" stroke="none" />
                <circle cx="36.2" cy="35.6" r="2.6" stroke="none" />
              </g>
              <g className="hb-pebble">
                <g className="hb-spin">
                  <ellipse cx="33" cy="32" rx="4.4" ry="3.5" fill="var(--cm-a1)" stroke="var(--cm-paper)" strokeWidth="2.4" paintOrder="stroke" />
                </g>
              </g>
            </g>
          </g>
        </g>
      )}
      <g mask={`url(#${mask})`}>
        <g className={lost ? undefined : "hb-wave"}>
          <path d={WAVE} fill="none" stroke="var(--cm-paper)" strokeWidth={WATER[weight] + 2.6} strokeLinecap="round" />
          <path d={WAVE} fill="none" stroke={water} strokeWidth={WATER[weight]} strokeLinecap="round" />
          {size < 32 ? null : <path d={SWELL} fill="none" stroke={water} strokeWidth={WATER[weight] * 0.7} strokeLinecap="round" opacity="0.5" />}
        </g>
      </g>
    </svg>
  );
}
