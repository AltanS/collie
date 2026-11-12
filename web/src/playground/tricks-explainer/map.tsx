// The one drawing of the tricks explainer: the phone, the bridge on your machine, your agent sessions,
// a trick folder and you. Every section draws it again and lights the part it talks about, so the
// reader builds one map. Two layouts of the same map: flat when it has room, stacked on a phone.
//
// A step can send a token: a small labelled chip, in the hue of whoever wrote what it carries, that
// travels along the lit arrow from the source box to the target box (1.2 s, eased) and rests there
// until the next step. Under reduced motion it does not travel: it sits on the middle of the arrow.
// The token is drawn over the map; it never moves the page.
// DEV-ONLY, like the rest of `src/playground/`.

import { useEffect, useId, useState, type ReactNode } from "react";

import { HUE_VAR, wash, type Hue } from "./hues";
import { useStill } from "./motion";

export type BoxId = "phone" | "bridge" | "agent" | "trick" | "you";
export type ArrowId = "link" | "run" | "type" | "cmd" | "tap";

const BOX_HUE = { phone: "phone", bridge: "bridge", agent: "agent", trick: "trick", you: "you" } as const satisfies Record<BoxId, Hue>;
const ARROW_HUE = { link: "phone", run: "bridge", type: "bridge", cmd: "agent", tap: "you" } as const satisfies Record<ArrowId, Hue>;
/** The callout number of each arrow, as section 0 explains them. */
export const ARROW_NUMBER = { link: 1, run: 2, type: 3, cmd: 4, tap: 5 } as const satisfies Record<ArrowId, number>;

type Point = readonly [number, number];

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface ArrowGeo {
  /** Where the line starts and ends. A token goes from `from` to `to`, or back when the step says so. */
  from: Point;
  to: Point;
  both: boolean;
  /** Where the callout number sits. */
  num: Point;
}
interface Layout {
  view: [number, number];
  machine: Rect;
  machineLabel: Point;
  boxes: Record<Exclude<BoxId, "you">, Rect>;
  you: [number, number, number];
  arrows: Record<ArrowId, ArrowGeo>;
  /** The compact layout: one line per box, 12 px text. */
  small: boolean;
}

const WIDE: Layout = {
  view: [960, 470],
  machine: { x: 318, y: 12, w: 632, h: 450 },
  machineLabel: [334, 38],
  boxes: {
    phone: { x: 10, y: 70, w: 236, h: 180 },
    bridge: { x: 350, y: 70, w: 262, h: 180 },
    agent: { x: 718, y: 70, w: 222, h: 180 },
    trick: { x: 372, y: 312, w: 218, h: 136 },
  },
  you: [128, 370, 36],
  arrows: {
    link: { from: [248, 215], to: [348, 215], both: true, num: [298, 239] },
    tap: { from: [128, 332], to: [128, 252], both: false, num: [106, 292] },
    run: { from: [481, 252], to: [481, 310], both: true, num: [459, 281] },
    type: { from: [614, 200], to: [716, 200], both: false, num: [665, 180] },
    cmd: { from: [716, 232], to: [614, 232], both: false, num: [665, 254] },
  },
  small: false,
};

/**
 * The compact map: wider than tall, drawn at 1:1 for a 342 px column, so no text is under 12 px there. The
 * phone layout of the page and the website's figures. Boxes say less here: one line each.
 */
const FIG: Layout = {
  view: [342, 310],
  machine: { x: 4, y: 96, w: 334, h: 208 },
  machineLabel: [14, 113],
  boxes: {
    phone: { x: 84, y: 8, w: 166, h: 72 },
    bridge: { x: 18, y: 122, w: 306, h: 64 },
    trick: { x: 18, y: 222, w: 146, h: 76 },
    agent: { x: 178, y: 222, w: 146, h: 76 },
  },
  you: [30, 64, 22],
  arrows: {
    tap: { from: [54, 66], to: [82, 66], both: false, num: [68, 32] },
    link: { from: [167, 82], to: [167, 120], both: true, num: [189, 101] },
    run: { from: [80, 188], to: [80, 220], both: true, num: [58, 204] },
    type: { from: [222, 188], to: [222, 220], both: false, num: [200, 204] },
    cmd: { from: [290, 220], to: [290, 188], both: false, num: [312, 204] },
  },
  small: true,
};

/** The words in each box: a title, lines, and marks on lines of their own under them. */
interface BoxWords {
  title: string;
  lines: string[];
  marks: string[];
}

/** The compact map's words: the title and one short line. The marks are the same. */
const COMPACT_LINE = { phone: "ColliePWA", bridge: "Collie on your machine", agent: "Claude Code, Codex …", trick: "trick.toml" } as const satisfies Record<Exclude<BoxId, "you">, string>;

/** `models` switches the boxes to say where a model can think. `compact` keeps one line. */
function boxLines(id: Exclude<BoxId, "you">, models: boolean, compact: boolean): BoxWords {
  const words = fullLines(id, models);
  return compact ? { ...words, lines: [COMPACT_LINE[id]] } : words;
}

function fullLines(id: Exclude<BoxId, "you">, models: boolean): BoxWords {
  switch (id) {
    case "phone":
      return { title: "Phone", lines: ["ColliePWA in your browser", "draws Collie's own parts"], marks: models ? ["no model"] : [] };
    case "bridge":
      return { title: "Bridge", lines: ["Collie on your machine", "checks, stores, writes", "runs tricks on a timer"], marks: models ? ["no model"] : [] };
    case "agent":
      return { title: "Agent sessions", lines: ["Claude Code, Codex …", "in terminal panes"], marks: [models ? "◆ a model thinks" : "◆ model"] };
    case "trick":
      return { title: "Trick folder", lines: ["trick.toml", "a program, or rules"], marks: models ? ["◇ a model only if", "its author calls one"] : [] };
  }
}

export interface MapFocus {
  /** The boxes in full colour. Absent: every box. */
  readonly lit?: readonly BoxId[];
  /** The arrow that carries something now, drawn strong. Absent: every arrow, quiet. */
  readonly arrow?: ArrowId;
  /** The token's label: what the arrow carries now. */
  readonly payload?: string;
  /** The hue of whoever wrote what the token carries. Absent: the arrow's own. */
  readonly hue?: Hue;
  /** The token goes against the line's own direction (on a two-way arrow). */
  readonly back?: boolean;
}

const NO_FOCUS: MapFocus = {};

interface MapProps {
  focus?: MapFocus;
  /** Draw the numbered callouts on the arrows (section 0). */
  callouts?: boolean;
  /** Mark which boxes hold a model (section 5). */
  models?: boolean;
  label: string;
  /** Always the compact layout, whatever the width: a website figure. */
  compact?: boolean;
  /** Tokens sit still on their arrow, as under reduced motion: a figure that is not playing. */
  still?: boolean;
}

/** The map, in the layout its own width suits: stacked below 640 px of room, flat above. */
export function TricksMap(props: MapProps) {
  if (props.compact === true) return <MapSvg g={FIG} {...props} />;
  return (
    <div className="@container">
      <div className="mx-auto max-w-[480px] @[640px]:hidden">
        <MapSvg g={FIG} {...props} />
      </div>
      <div className="hidden @[640px]:block">
        <MapSvg g={WIDE} {...props} />
      </div>
    </div>
  );
}

/** Width divided by height of the compact map: what a figure reserves. */
export const COMPACT_ASPECT = FIG.view[0] / FIG.view[1];

/** The travelling chip. Mounted fresh for each step (its key), it starts at the source and eases to the target. */
function Token({ from, to, label, hue, small, still }: { from: Point; to: Point; label: string; hue: Hue; small: boolean; still: boolean }) {
  const [there, setThere] = useState(false);
  useEffect(() => {
    if (still) return;
    // Two frames: the first paints the chip at the source, the second starts the move.
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => setThere(true));
    });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
  }, [still]);
  const mid: Point = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  const at = still ? mid : there ? to : from;
  const font = small ? 12 : 13;
  const w = label.length * font * 0.62 + 16;
  const h = font + 10;
  return (
    <g aria-hidden="true" style={{ transform: `translate(${at[0]}px, ${at[1]}px)`, transition: still ? undefined : "transform 1200ms cubic-bezier(0.45, 0, 0.25, 1)" }}>
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={2} fill={wash(hue, 22)} stroke={HUE_VAR[hue]} strokeWidth={1.5} />
      <text x={0} y={font * 0.36} textAnchor="middle" fontSize={font} fontWeight={700} fill={HUE_VAR[hue]} className="font-mono">
        {label}
      </text>
    </g>
  );
}

function MapSvg({ g, focus = NO_FOCUS, callouts = false, models = false, label, still: frozen = false }: MapProps & { g: Layout }) {
  const uid = useId().replaceAll(":", "");
  const still = useStill() || frozen;
  const isLit = (id: BoxId) => focus.lit === undefined || focus.lit.includes(id);
  const font = g.small ? { title: 14, line: 12, top: 40, step: 15 } : { title: 19, line: 15, top: 58, step: 21 };

  const arrowOf = (id: ArrowId): ReactNode => {
    const a = g.arrows[id];
    const active = focus.arrow === id;
    const quiet = focus.arrow !== undefined && !active;
    const hue = active ? (focus.hue ?? ARROW_HUE[id]) : ARROW_HUE[id];
    const colour = quiet ? "var(--rule)" : HUE_VAR[hue];
    const marker = quiet ? `${uid}-m-quiet` : `${uid}-m-${hue}`;
    return (
      <g key={id} className="transition-opacity duration-700 motion-reduce:transition-none" opacity={quiet ? 0.6 : 1}>
        <path
          d={`M${a.from[0]} ${a.from[1]} L${a.to[0]} ${a.to[1]}`}
          fill="none"
          stroke={colour}
          strokeWidth={active ? 3 : 1.75}
          markerEnd={`url(#${marker})`}
          markerStart={a.both ? `url(#${marker})` : undefined}
        />
        {callouts && (
          <g>
            <circle cx={a.num[0]} cy={a.num[1]} r={10} fill="var(--background)" stroke={colour} strokeWidth={1.5} />
            <text x={a.num[0]} y={a.num[1] + 4} textAnchor="middle" fontSize={12} fontWeight={700} fill={colour} className="font-mono">
              {ARROW_NUMBER[id]}
            </text>
          </g>
        )}
      </g>
    );
  };

  const boxOf = (id: Exclude<BoxId, "you">): ReactNode => {
    const r = g.boxes[id];
    const hue = BOX_HUE[id];
    const lit = isLit(id);
    const { title, lines, marks } = boxLines(id, models, g.small);
    return (
      <g key={id} className="transition-opacity duration-700 motion-reduce:transition-none" opacity={lit ? 1 : 0.32}>
        <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={2} fill={lit ? wash(hue, 14) : "var(--background)"} stroke={HUE_VAR[hue]} strokeWidth={lit ? 2 : 1.25} />
        <text x={r.x + 12} y={r.y + (g.small ? 22 : 30)} fontSize={font.title} fontWeight={700} fill={HUE_VAR[hue]}>
          {title}
        </text>
        {lines.map((line, i) => (
          <text key={i} x={r.x + 12} y={r.y + font.top + i * font.step} fontSize={font.line} fill="var(--foreground)">
            {line}
          </text>
        ))}
        {/* Each mark on a line of its own, under the box's lines, so the two can never overlap. */}
        {marks.map((mark, i) => (
          <text
            key={mark}
            x={r.x + 12}
            y={r.y + font.top + (lines.length + i) * font.step + (g.small ? 2 : 4)}
            fontSize={font.line}
            fontWeight={700}
            fill={mark === "no model" ? "var(--muted-foreground)" : HUE_VAR.agent}
          >
            {mark}
          </text>
        ))}
      </g>
    );
  };

  const [cx, cy, cr] = g.you;
  const youLit = isLit("you");
  const markerHues: Hue[] = ["you", "phone", "bridge", "agent", "trick"];
  const moving = focus.arrow === undefined ? null : g.arrows[focus.arrow];
  const tokenHue = focus.arrow === undefined ? "bridge" : (focus.hue ?? ARROW_HUE[focus.arrow]);

  return (
    <svg viewBox={`0 0 ${g.view[0]} ${g.view[1]}`} role="img" aria-label={label} className="block h-auto w-full max-w-full overflow-visible">
      <defs>
        {markerHues.map((hue) => (
          <marker key={hue} id={`${uid}-m-${hue}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill={HUE_VAR[hue]} />
          </marker>
        ))}
        <marker id={`${uid}-m-quiet`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--rule)" />
        </marker>
      </defs>
      <rect x={g.machine.x} y={g.machine.y} width={g.machine.w} height={g.machine.h} rx={2} fill="none" stroke="var(--rule)" strokeDasharray="6 5" />
      <text x={g.machineLabel[0]} y={g.machineLabel[1]} fontSize={12} fill="var(--muted-foreground)" className="font-mono">
        your machine
      </text>
      {(["phone", "bridge", "agent", "trick"] as const).map(boxOf)}
      <g className="transition-opacity duration-700 motion-reduce:transition-none" opacity={youLit ? 1 : 0.32}>
        <circle cx={cx} cy={cy} r={cr} fill={youLit ? wash("you", 14) : "var(--background)"} stroke={HUE_VAR.you} strokeWidth={youLit ? 2 : 1.25} />
        <text x={cx} y={cy + 5} textAnchor="middle" fontSize={font.title} fontWeight={700} fill={HUE_VAR.you}>
          You
        </text>
      </g>
      {(["link", "tap", "run", "type", "cmd"] as const).map(arrowOf)}
      {moving !== null && focus.payload !== undefined && (
        <Token
          key={`${focus.arrow}|${focus.payload}|${focus.back === true ? "back" : "on"}`}
          from={focus.back === true ? moving.to : moving.from}
          to={focus.back === true ? moving.from : moving.to}
          label={focus.payload}
          hue={tokenHue}
          small={g.small}
          still={still}
        />
      )}
    </svg>
  );
}
