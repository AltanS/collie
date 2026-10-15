// The Nightwatch mark: a horned owl on a branch, the animal that keeps the night watch. Spec 10 of
// M57; the story, the state table and every keyframe are in `nightwatch.notes.md` beside this file.
//
// Drawn to glow quietly on a true black page. The owl is a line of ink round a dim mass (ink mixed
// at 14 percent into the paper), so most of it is close to the ground it sits on. The light comes
// from two places only: the eyes, in the theme's primary, and a thin ring behind the head that
// breathes while the app works.
//
//   <NightwatchMark size={40} weight="header" />                 idle
//   <NightwatchMark size={40} weight="header" state="loading" />  working
//   <NightwatchMark size={40} weight="header" state="lost" />     asleep
//
// THE RULES IT KEEPS, the same as the dog's (collie-mark.tsx):
//
// - One `<svg>`, nothing beside it. Ink is `currentColor`, the knockout is `var(--cm-paper)`.
// - The stylesheet is a module constant. A <style> inside an inline SVG is DOCUMENT-scoped, so every
//   owl on a page shares one set of rules and the state lives in classes and custom properties on
//   the element. Every class and keyframe name carries `nw-` so it cannot meet the dog's or another
//   mark's.
// - `cm-live` on the root while loading. That is the class every host and test reads to ask "is the
//   mark working" (test/collie-mark.ts), and the rule that starts the loading motion.
// - Every keyframe name starts with `cm-`, so the header's rate ramp (collie-home.tsx) collects the
//   loading motion and throws it like a wheel. Every loading loop is 1.8 s or a half of it and starts
//   and ends on the rest pose, so a round of the ramp lands where it began and nothing snaps when it
//   ends.
// - Loading is a COLOUR as well as a motion: the eyes and the ring come up to the full primary and
//   the ear tufts stand up. Under reduced motion the loops stop and that colour and pose still say
//   "working".
// - Lost runs no animation at all. The eyes are shut, the head is down, the tufts lie flat, and the
//   ink drops to the theme's muted foreground.
//
// THE GEOMETRY is a 100 unit square. `header` crops to the drawing (1..99 across, -2..96 down, with
// room for a lifted tuft); `full` gives it air.

import type { CSSProperties } from "react";
import { useId } from "react";

import type { MarkProps, MarkState } from "./contract";

const STYLE =
  // The quiet mass: the ink at 14 percent in the paper. Dark warm grey on black, a shade under the
  // paper by day.
  ".nw-mass{fill:color-mix(in oklab,currentColor 14%,var(--cm-paper))}" +
  ".nw-paper{fill:var(--cm-paper)}" +
  // Every moving part turns about a point in the drawing's own units.
  ".nw-halo,.nw-glow,.nw-body,.nw-lift,.nw-head,.nw-face,.nw-pupil,.nw-tuft-l,.nw-tuft-r,.nw-eye-l,.nw-eye-r{transform-box:view-box}" +
  ".nw-halo,.nw-glow{transform-origin:50px 44px}" +
  ".nw-body{transform-origin:50px 93px}" +
  ".nw-head{transform-origin:50px 60px}" +
  ".nw-tuft-l{transform-origin:36px 21px}" +
  ".nw-tuft-r{transform-origin:64px 21px}" +
  ".nw-eye-l{transform-origin:37px 41px}" +
  ".nw-eye-r{transform-origin:63px 41px}" +
  ".nw-halo{opacity:.16}" +
  ".nw-glow{opacity:0}" +
  ".nw-shut{display:none}" +
  // LOADING. The still pose first: what a reduced-motion reader sees, and the colour that says
  // "working" with no motion at all.
  ".cm-live .nw-halo{opacity:.6}" +
  ".cm-live .nw-glow{opacity:.6}" +
  ".cm-live .nw-tuft-l{transform:rotate(8deg)}" +
  ".cm-live .nw-tuft-r{transform:rotate(-8deg)}" +
  // Then the loops. Nine classes on ten elements, one 1.8 s clock, staggered: the eyes lead, the face
  // follows, the head follows the face, the tufts lift twice a turn, the body squashes and the head
  // rides it.
  "@keyframes cm-nw-halo{0%,100%{opacity:.28;transform:scale(.94)}50%{opacity:.85;transform:scale(1.02)}}" +
  "@keyframes cm-nw-glow{0%,100%{opacity:.2}60%{opacity:.85}}" +
  "@keyframes cm-nw-squash{0%,80%,100%{transform:none}38%{transform:scale(1.035,.955)}62%{transform:scale(.985,1.025)}}" +
  "@keyframes cm-nw-bob{0%,80%,100%{transform:none}38%{transform:translateY(2.4px)}62%{transform:translateY(-1.8px)}}" +
  "@keyframes cm-nw-turn{0%,100%{transform:none}28%{transform:rotate(-6deg)}68%{transform:rotate(6deg)}}" +
  "@keyframes cm-nw-face{0%,100%{transform:none}24%{transform:translateX(-3.5px)}64%{transform:translateX(3.5px)}}" +
  "@keyframes cm-nw-look{0%,86%,100%{transform:none}14%{transform:translate(-2.4px,.6px)}54%{transform:translate(2.4px,.6px)}}" +
  "@keyframes cm-nw-tuft-l{0%,84%,100%{transform:none}20%,60%{transform:rotate(12deg) scale(1.08)}42%{transform:rotate(3deg)}}" +
  "@keyframes cm-nw-tuft-r{0%,90%,100%{transform:none}26%,66%{transform:rotate(-12deg) scale(1.08)}48%{transform:rotate(-3deg)}}" +
  ".cm-live .nw-halo{animation:cm-nw-halo 1.8s ease-in-out infinite}" +
  ".cm-live .nw-glow{animation:cm-nw-glow 1.8s ease-in-out infinite}" +
  ".cm-live .nw-body{animation:cm-nw-squash 1.8s ease-in-out infinite}" +
  ".cm-live .nw-lift{animation:cm-nw-bob 1.8s ease-in-out infinite}" +
  ".cm-live .nw-head{animation:cm-nw-turn 1.8s ease-in-out infinite}" +
  ".cm-live .nw-face{animation:cm-nw-face 1.8s ease-in-out infinite}" +
  ".cm-live .nw-pupil{animation:cm-nw-look 1.8s ease-in-out infinite}" +
  ".cm-live .nw-tuft-l{animation:cm-nw-tuft-l 1.8s ease-in-out infinite}" +
  ".cm-live .nw-tuft-r{animation:cm-nw-tuft-r 1.8s ease-in-out infinite}" +
  // IDLE. A head drift of two degrees in all, once in 48 s, and a blink. The blink loop is 61 s with
  // two blinks in it, at 24.4 s and 51.9 s, so the gaps are 27.5 s and 33.6 s and never the same
  // twice in a row. Nothing else moves.
  "@keyframes cm-nw-drift{0%,100%{transform:none}25%{transform:rotate(1deg)}75%{transform:rotate(-1deg)}}" +
  "@keyframes cm-nw-blink{0%,39.75%,40.25%,84.75%,85.25%,100%{transform:none}40%,85%{transform:scaleY(.12)}}" +
  ".nw-rest .nw-head{animation:cm-nw-drift 48s ease-in-out infinite}" +
  ".nw-rest .nw-eye-l{animation:cm-nw-blink 61s linear infinite}" +
  ".nw-rest .nw-eye-r{animation:cm-nw-blink 61s linear infinite}" +
  // LOST. A still pose, no animation: the head sinks into the body and dips, the tufts lie flat,
  // the eyes are two shut lids, the ring and the glow are gone.
  ".nw-lost .nw-head{transform:translateY(5px) rotate(-3deg)}" +
  ".nw-lost .nw-face{transform:translateY(1.5px)}" +
  ".nw-lost .nw-tuft-l{transform:translateY(3px) rotate(-12deg)}" +
  ".nw-lost .nw-tuft-r{transform:translateY(3px) rotate(12deg)}" +
  ".nw-lost .nw-body{transform:scale(1.03,.97)}" +
  ".nw-lost .nw-eye-l,.nw-lost .nw-eye-r,.nw-lost .nw-halo,.nw-lost .nw-glow{display:none}" +
  ".nw-lost .nw-shut{display:inline}" +
  "@media (prefers-reduced-motion: reduce){.nw-halo,.nw-glow,.nw-body,.nw-lift,.nw-head,.nw-face,.nw-pupil,.nw-tuft-l,.nw-tuft-r,.nw-eye-l,.nw-eye-r{animation:none!important}}";

const VIEW = { full: "-14 -16 128 128", header: "-3 -10 106 106" };

/**
 * The two accents, by state. `--cm-a1` is the theme's `primary` (the eyes, the ring and the glow);
 * `--cm-a2` is the theme's `ring` (the rim round each iris, a step darker in Nightwatch, so the eye
 * has depth at 64 px). At rest both are pulled a third of the way to the muted foreground, which
 * lowers their chroma; while loading they are the tokens themselves. Lost has no eye to colour.
 */
const ACCENTS = {
  idle: {
    a1: "color-mix(in oklab, var(--primary) 70%, var(--muted-foreground))",
    a2: "color-mix(in oklab, var(--ring) 70%, var(--muted-foreground))",
  },
  loading: { a1: "var(--primary)", a2: "var(--ring)" },
  lost: { a1: "var(--muted-foreground)", a2: "var(--muted-foreground)" },
} satisfies Record<MarkState, { a1: string; a2: string }>;

const vars = (state: MarkState, paper: string): CSSProperties => {
  const base = {
    display: "block",
    flex: "none",
    "--cm-a1": ACCENTS[state].a1,
    "--cm-a2": ACCENTS[state].a2,
    "--cm-paper": paper,
  };
  // Lost drops the ink itself, so every stroke and the mass follow it to the muted foreground.
  const set = state === "lost" ? { ...base, color: "var(--muted-foreground)" } : base;
  // SAFETY: every key is a CSS property or a custom property and every value is a string. React
  // passes unknown style keys straight through to the DOM. The cast exists only because
  // CSSProperties has no index signature for `--*`; it widens nothing.
  return set as CSSProperties;
};

const INK = "currentColor";

export function NightwatchMark({
  size = 32,
  state = "idle",
  paper = "var(--background)",
  title,
  className,
  weight = "full",
}: MarkProps) {
  // The glow's gradient needs an id, and an id in an inline SVG is document-scoped: a header owl and
  // a splash owl would share one. `useId` gives each instance its own; the colons go because a
  // `url(#...)` reference does not survive them.
  const glow = `nw${useId().replace(/[^A-Za-z0-9_-]/g, "")}-glow`;
  const live = state === "loading" ? "cm-live" : "";
  const classes = className === undefined ? live || undefined : (live + " " + className).trim() || undefined;
  return (
    <svg
      width={size}
      height={size}
      viewBox={VIEW[weight]}
      className={classes}
      role={title === undefined ? "presentation" : "img"}
      style={vars(state, paper)}
    >
      <style>{STYLE}</style>
      {title === undefined ? null : <title>{title}</title>}
      <defs>
        <radialGradient id={glow} cx="50" cy="42" r="46" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: "var(--cm-a1)", stopOpacity: 0.5 }} />
          <stop offset="0.62" style={{ stopColor: "var(--cm-a1)", stopOpacity: 0.28 }} />
          <stop offset="1" style={{ stopColor: "var(--cm-a1)", stopOpacity: 0 }} />
        </radialGradient>
      </defs>
      <g className={state === "idle" ? "nw-rest" : state === "lost" ? "nw-lost" : undefined}>
        <circle className="nw-glow" cx="50" cy="42" r="46" fill={`url(#${glow})`} />
        <circle className="nw-halo" cx="50" cy="44" r="40" fill="none" stroke="var(--cm-a1)" strokeWidth="2.6" />
        {/* The branch it keeps watch from. */}
        <path d="M12 93.5H88" fill="none" stroke={INK} strokeWidth="5" strokeLinecap="round" />
        <g className="nw-body">
          <path
            className="nw-mass"
            d="M31 48C21 58 20 80 33 89C41 95 59 95 67 89C80 80 79 58 69 48Z"
            stroke={INK}
            strokeWidth="5"
            strokeLinejoin="round"
          />
          {/* The folded wings, and the talons on the branch. */}
          <path
            d="M30 62C29 73 32 82 40 88M70 62C71 73 68 82 60 88M44 89V95M56 89V95"
            fill="none"
            stroke={INK}
            strokeWidth="3.2"
            strokeLinecap="round"
          />
        </g>
        <g className="nw-lift">
          <g className="nw-head">
            <path className="nw-tuft-l nw-mass" d="M32 24L21 7L45 17Z" stroke={INK} strokeWidth="4.6" strokeLinejoin="round" />
            <path className="nw-tuft-r nw-mass" d="M68 24L79 7L55 17Z" stroke={INK} strokeWidth="4.6" strokeLinejoin="round" />
            <path
              className="nw-mass"
              d="M50 14C71 14 84 26 84 41C84 55 69 62 50 62C31 62 16 55 16 41C16 26 29 14 50 14Z"
              stroke={INK}
              strokeWidth="5"
            />
            <g className="nw-face">
              {/* The facial disc: two dark sockets the eyes glow out of. */}
              <circle className="nw-paper" cx="37" cy="40" r="12.5" stroke={INK} strokeWidth="2.4" />
              <circle className="nw-paper" cx="63" cy="40" r="12.5" stroke={INK} strokeWidth="2.4" />
              <g className="nw-eye-l">
                <circle cx="37" cy="41" r="8.6" fill="var(--cm-a1)" stroke="var(--cm-a2)" strokeWidth="1.6" />
                <circle className="nw-pupil nw-paper" cx="37" cy="41" r="3.9" />
              </g>
              <g className="nw-eye-r">
                <circle cx="63" cy="41" r="8.6" fill="var(--cm-a1)" stroke="var(--cm-a2)" strokeWidth="1.6" />
                <circle className="nw-pupil nw-paper" cx="63" cy="41" r="3.9" />
              </g>
              {/* Shut lids, drawn only while lost. */}
              <path
                className="nw-shut"
                d="M28 42Q37 48 46 42M54 42Q63 48 72 42"
                fill="none"
                stroke={INK}
                strokeWidth="3"
                strokeLinecap="round"
              />
              <path d="M45.5 47.5H54.5L50 57Z" fill={INK} stroke={INK} strokeWidth="1.5" strokeLinejoin="round" />
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
