// THE TRICKS EXPLAINER'S FIGURES, one per chapter, for the website's page /tricks/how-it-works and for the
// playground's own chapters (tricks-explainer/), which draw the same figures: one drawing per idea.
//
// The contract with the site (its `mountFigure`):
// - `FIGURE_NAMES` is the site's `data-figure-slot` values, in chapter order, as a plain array literal
//   (a site test reads it as text).
// - A figure fills its container's width and keeps `aspect` (width / height, 1 to 1.6), so the site can
//   reserve the box. It is drawn for a 342 px column: no text in it is under 12 px there. One exception:
//   `where-a-trick-can-show` is a phone, portrait, at `TOUR_ASPECT` (about 0.6).
// - A figure in `LIVE_FIGURES` has a live twin: a component the site may mount WITHOUT `inert`, so a
//   reader can use it. It fills the container's width and sets its own height; it takes no props.
// - `playing` false draws the last frame, still; so does reduced motion. A figure loops only while
//   playing, and leaves no timer behind when it unmounts.
// - Self-contained: no network, no bridge, and no playground fixture. Every name in a figure is fictional
//   and written here or in the plain-data modules it imports (flows.ts, place-ids.ts, place-world.ts).
//   The places figure mounts the app's real screens on a memory router (it never touches the URL), and
//   while it is mounted it answers `GET /api/tricks` itself, in front of `fetch`; every other request
//   passes through.
// - The site adds the caption and the "sample data" line; a figure carries neither.
//
// DEV-ONLY, like the rest of `src/playground/`.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { renderView, type RenderCtx } from "@/lib/tricks/render";
import { PLACE_KINDS, type View } from "@/lib/tricks/schema";
import { cn } from "@/lib/utils";

import { HILL_FLOW, PROGRAM_FLOW, REQUEST_LINE, VIEW_FLOW } from "./tricks-explainer/flows";
import { HUE_BORDER, HUE_TEXT, HUE_VAR, Num, wash, type Hue, type Seg } from "./tricks-explainer/hues";
import { COMPACT_ASPECT, TricksMap, type MapFocus } from "./tricks-explainer/map";
import { useStill } from "./tricks-explainer/motion";
import { GatesWalk, PlacesExplorer, PlacesTour, TOUR_ASPECT } from "./tricks-explainer/place-explorer";

export const FIGURE_NAMES = [
  "what-a-trick-is",
  "where-a-trick-can-show",
  "two-kinds",
  "example-program-trick",
  "example-hill",
  "example-agent-view",
  "trust",
  "write-your-own",
] as const;
export type FigureName = (typeof FIGURE_NAMES)[number];

/**
 * The figures of round 2 that the website cut retired: their chapters are docs only now, and `trust`
 * holds what "thinking" and "agent-rules" said. They still render, so the site's old slots keep working
 * until it has switched to FIGURE_NAMES. Delete them after that.
 */
export const RETIRED_FIGURE_NAMES = ["parts", "thinking", "agent-rules"] as const;
export type RetiredFigureName = (typeof RETIRED_FIGURE_NAMES)[number];

export interface FigureProps {
  /** The site pauses a figure that is off screen. false renders the last still frame. */
  playing: boolean;
}

export interface Figure {
  render: (props: FigureProps) => ReactNode;
  /** Width divided by height. The site reserves the box before the figure loads, so nothing jumps. */
  aspect: number;
}

/** How long one step of a looping figure stands. */
const LOOP_MS = 2600;

/** A figure's box: the container's width, the figure's own aspect, nothing past it. */
export function FigureBox({ aspect, children, className }: { aspect: number; children: ReactNode; className?: string }) {
  const style: CSSProperties = { aspectRatio: String(aspect) };
  return (
    <div className={cn("w-full overflow-hidden", className)} style={style}>
      {children}
    </div>
  );
}

// ── An HTML figure, drawn like a picture ───────────────────────────────────────────────────────

/** The width an HTML figure is laid out at. The SVG figures share it as their viewBox width. */
export const FIGURE_WIDTH = 342;

/**
 * Lays an HTML figure out at FIGURE_WIDTH and scales it to the container's width, as a picture scales.
 * Text that wraps at 342 px wraps the same at 520 px, so the height is always width / aspect and the
 * site's reserved box has no empty band, and no text is under 12 px from 342 px up.
 */
function AsPicture({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = outer.current;
    if (el === null || !("ResizeObserver" in window)) return;
    const measure = () => {
      if (el.clientWidth > 0) setScale(el.clientWidth / FIGURE_WIDTH);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const inner: CSSProperties = { width: FIGURE_WIDTH, transform: `scale(${String(scale)})`, transformOrigin: "0 0" };
  return (
    <div ref={outer} className="w-full">
      <div style={inner}>{children}</div>
    </div>
  );
}

// ── The map, still and looping ─────────────────────────────────────────────────────────────────

/** The steps of a flow, one after the other, while playing; the last one, still, otherwise. */
function MapLoop({ flow, label, playing }: { flow: readonly MapFocus[]; label: string; playing: boolean }) {
  const still = useStill();
  const moving = playing && !still;
  const last = flow.length - 1;
  const [step, setStep] = useState(moving ? 0 : last);
  useEffect(() => {
    if (!moving) return;
    const id = window.setInterval(() => setStep((s) => (s + 1) % flow.length), LOOP_MS);
    return () => window.clearInterval(id);
  }, [moving, flow.length]);
  const shown = moving ? step : last;
  return <TricksMap compact still={!moving} focus={flow[shown] ?? {}} label={label} />;
}

const T = { fontSize: 12, fill: "var(--foreground)" } as const;

// ── 2. The two kinds ───────────────────────────────────────────────────────────────────────────

const KINDS_BOX: [number, number] = [342, 262];

function KindStep({ x, y, hue, lines, mono = false }: { x: number; y: number; hue: Hue; lines: readonly string[]; mono?: boolean }) {
  const h = 14 + lines.length * 16;
  return (
    <g>
      <rect x={x} y={y} width={156} height={h} rx={2} fill={wash(hue, 14)} stroke={HUE_VAR[hue]} strokeWidth={1.5} />
      {lines.map((line, i) => (
        <text key={line} x={x + 10} y={y + 20 + i * 16} {...T} className={mono ? "font-mono" : undefined}>
          {line}
        </text>
      ))}
    </g>
  );
}

function Down({ x, y, hue }: { x: number; y: number; hue: Hue }) {
  return <path d={`M${x} ${y} L${x} ${y + 14} M${x - 5} ${y + 9} L${x} ${y + 15} L${x + 5} ${y + 9}`} fill="none" stroke={HUE_VAR[hue]} strokeWidth={1.75} />;
}

/** A program trick beside an agent view: the folder, who draws, where it shows. */
export function KindsSketch() {
  return (
    <svg viewBox={`0 0 ${KINDS_BOX[0]} ${KINDS_BOX[1]}`} role="img" aria-label="A program trick beside an agent view: what the folder holds, who draws, and where it shows" className="block h-auto w-full">
      <text x={6} y={18} fontSize={14} fontWeight={700} fill={HUE_VAR.trick}>
        A program trick
      </text>
      <KindStep x={4} y={30} hue="trick" mono lines={["trick.toml", "program.sh"]} />
      <Down x={82} y={78} hue="bridge" />
      <KindStep x={4} y={98} hue="bridge" lines={["The bridge runs it:", "a timer, a file, a tap"]} />
      <Down x={82} y={146} hue="trick" />
      <KindStep x={4} y={166} hue="phone" lines={["It prints parts.", `The phone draws them`, `in ${PLACE_KINDS.length} places, and the Hill.`]} />

      <text x={186} y={18} fontSize={14} fontWeight={700} fill={HUE_VAR.agent}>
        An agent view
      </text>
      <KindStep x={182} y={30} hue="trick" mono lines={["trick.toml", "rules.md"]} />
      <Down x={260} y={78} hue="agent" />
      <KindStep x={182} y={98} hue="agent" lines={["A session's agent", "reads the rules"]} />
      <Down x={260} y={146} hue="agent" />
      <KindStep x={182} y={166} hue="phone" lines={["It draws one screen", "in that session's", "agent view."]} />
    </svg>
  );
}

// ── 3. The parts ───────────────────────────────────────────────────────────────────────────────

/** One screen made of parts, drawn by the REAL renderer: a number, chips, rows, a button. */
const PARTS_VIEW: View = [
  { kind: "number", text: "5/7", attrs: { label: "gates green", tone: "accent" } },
  {
    kind: "bar",
    kids: [
      { kind: "chip", text: "unit", attrs: { tone: "ok", icon: "check" } },
      { kind: "chip", text: "web", attrs: { tone: "ok", icon: "check" } },
      { kind: "chip", text: "e2e", attrs: { tone: "danger", icon: "x" } },
    ],
  },
  {
    kind: "list",
    kids: [
      { kind: "row", text: "e2e: pane glide", attrs: { end: "red", tone: "danger" } },
      { kind: "row", text: "windows", attrs: { end: "running", tone: "warn" } },
    ],
  },
  { kind: "bar", kids: [{ kind: "button", attrs: { label: "Rerun red", intent: "rerun" } }] },
];

const PARTS_CTX: RenderCtx = { partKey: "lodge/gates/figure", stale: false, onTap: () => {}, onLink: () => {}, now: Date.parse("2026-11-11T09:41:00Z") };

export function PartsSketch() {
  return <div className="rounded-sm border border-border bg-background p-3">{renderView(PARTS_VIEW, PARTS_CTX)}</div>;
}

// ── 8. The rules ───────────────────────────────────────────────────────────────────────────────

const FRAME = "━━━";

const HELP_EXCERPT: readonly Seg[] = [
  { t: `${FRAME} Collie: the rules of the trick "morph" begin ${FRAME}\n`, hue: "bridge" },
  { t: "Put the answer first. Short words, short lines.\nLabel each button with what happens when it is tapped.\n", hue: "trick" },
  { t: `${FRAME} Collie: the rules of the trick "morph" end ${FRAME}`, hue: "bridge" },
];

function Lines({ title, segs }: { title: string; segs: readonly Seg[] }) {
  return (
    <div className="rounded-sm border border-border bg-card">
      <p className="border-b border-border px-2 py-1 font-mono text-[12px] text-muted-foreground">{title}</p>
      <pre className="px-2 py-1.5 font-mono text-[12px] leading-snug break-words whitespace-pre-wrap">
        {segs.map((s, i) => (
          <span key={i} className={s.hue === undefined ? undefined : HUE_TEXT[s.hue]}>
            {s.n !== undefined && s.hue !== undefined && <Num n={s.n} hue={s.hue} className="mr-1 size-5 align-[-3px] text-[12px]" />}
            {s.t}
          </span>
        ))}
      </pre>
    </div>
  );
}

export function RulesSketch() {
  return (
    <div className="space-y-1">
      <Lines title="typed into the session" segs={REQUEST_LINE} />
      <p className={cn("text-center font-mono text-[12px] leading-tight", HUE_TEXT.agent)}>↓ the agent runs the [rules: …] command</p>
      <Lines title="what it reads" segs={HELP_EXCERPT} />
    </div>
  );
}

// ── 9. Trust ───────────────────────────────────────────────────────────────────────────────────

/** Who is trusted with what: the page's three columns, as one figure. */
export const TRUST_COLUMNS: readonly { hue: Hue; title: string; outline?: boolean; items: readonly string[] }[] = [
  {
    hue: "bridge",
    title: "Collie checks",
    items: ["every part against a closed list", "10 seconds and 64 KiB per run", "that what runs is what you approved", "the code, for five risky things"],
  },
  { hue: "you", title: "Your tap decides", items: ["Add, and the switch", "each version, Decision and view"] },
  { hue: "you", title: "Your job", outline: true, items: ["read the code, or ask an agent to"] },
];

/** The two facts the website keeps from the docs-only chapters, under the trust columns. */
export const TRUST_FACTS: readonly { hue: Hue; title: string; text: string }[] = [
  { hue: "agent", title: "The thinking", text: "is your own agent's. Collie calls no model." },
  { hue: "trick", title: "An agent's rules", text: "are text you read before you switch on." },
];

export function TrustSketch() {
  return (
    <div className="grid grid-cols-2 gap-2">
      {TRUST_COLUMNS.map((c, i) => (
        <section key={c.title} aria-label={c.title} className={cn("rounded-sm border bg-card px-3 py-2", i === 0 && "col-span-2", HUE_BORDER[c.hue], c.outline === true && "border-dashed")}>
          <p className={cn("text-[13px] font-semibold", HUE_TEXT[c.hue])}>{c.title}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12px] leading-snug">
            {c.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ))}
      {TRUST_FACTS.map((f) => (
        <section key={f.title} aria-label={f.title} className={cn("rounded-sm border bg-card px-3 py-2", HUE_BORDER[f.hue])}>
          <p className={cn("text-[13px] font-semibold", HUE_TEXT[f.hue])}>{f.title}</p>
          <p className="mt-1 text-[12px] leading-snug">{f.text}</p>
        </section>
      ))}
    </div>
  );
}

// ── 10. Write your own ─────────────────────────────────────────────────────────────────────────

/** The four commands, and what each one is for. */
export const WRITE_COMMANDS: readonly { cmd: string; hue: Hue; what: string }[] = [
  { cmd: "collie trick init disk-space", hue: "trick", what: "Makes the folder, with a starter program." },
  { cmd: "collie trick dev disk-space", hue: "bridge", what: "Runs it once, prints what the phone would draw." },
  { cmd: "collie trick check ~/.config/collie/tricks/disk-space", hue: "bridge", what: "Checks the manifest and the code." },
  { cmd: "collie trick on disk-space", hue: "you", what: "Your yes, in a shell of your own." },
];

export function WriteSketch() {
  return (
    <ol className="space-y-2">
      {WRITE_COMMANDS.map((c, i) => (
        <li key={c.cmd} className="flex gap-2">
          <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[12px] font-bold", HUE_BORDER[c.hue], HUE_TEXT[c.hue])}>{i + 1}</span>
          <div className="min-w-0">
            <p className={cn("font-mono text-[12px] break-words", HUE_TEXT[c.hue])}>{c.cmd}</p>
            <p className="text-[12px] text-muted-foreground">{c.what}</p>
          </div>
        </li>
      ))}
      <li className={cn("rounded-sm border px-2 py-1.5", HUE_BORDER.agent)}>
        <p className="text-[12px]">Or an agent writes it and proposes it to you:</p>
        <p className={cn("font-mono text-[12px] break-words", HUE_TEXT.agent)}>collie trick propose ~/work/disk-space</p>
      </li>
    </ol>
  );
}

// ── The table ──────────────────────────────────────────────────────────────────────────────────

const KINDS_ASPECT = KINDS_BOX[0] / KINDS_BOX[1];

export const FIGURES = {
  "what-a-trick-is": {
    aspect: COMPACT_ASPECT,
    render: () => <TricksMap compact callouts label="The map: your phone, the bridge on your machine, your agent sessions, a trick folder, and you" />,
  },
  // A phone, portrait: the one figure under an aspect of 1. Its live twin is in LIVE_FIGURES.
  "where-a-trick-can-show": { aspect: TOUR_ASPECT, render: ({ playing }) => <PlacesTour playing={playing} /> },
  "two-kinds": { aspect: KINDS_ASPECT, render: () => <KindsSketch /> },
  parts: { aspect: 1.336, render: () => <AsPicture><PartsSketch /></AsPicture> },
  "example-program-trick": {
    aspect: COMPACT_ASPECT,
    render: ({ playing }) => <MapLoop flow={PROGRAM_FLOW} playing={playing} label="The map, lit step by step for one run of a program trick" />,
  },
  "example-hill": {
    aspect: COMPACT_ASPECT,
    render: ({ playing }) => <MapLoop flow={HILL_FLOW} playing={playing} label="The map, lit step by step for a trick that asks on the Hill" />,
  },
  "example-agent-view": {
    aspect: COMPACT_ASPECT,
    render: ({ playing }) => <MapLoop flow={VIEW_FLOW} playing={playing} label="The map, lit step by step for one turn of an agent view" />,
  },
  thinking: {
    aspect: COMPACT_ASPECT,
    render: () => <TricksMap compact models focus={{ lit: ["agent", "trick"] }} label="The map, marking where a model can think: only in the agent sessions, and in a trick only if its author makes it call one" />,
  },
  "agent-rules": { aspect: 1.025, render: () => <AsPicture><RulesSketch /></AsPicture> },
  trust: { aspect: 1.152, render: () => <AsPicture><TrustSketch /></AsPicture> },
  "write-your-own": { aspect: 1.402, render: () => <AsPicture><WriteSketch /></AsPicture> },
} satisfies Record<FigureName | RetiredFigureName, Figure>;

/**
 * Blocks: full-width pieces of the page that are not figures. The site mounts one without an aspect box
 * and without `inert`; it fills the container's width and sets its own height. It takes no props.
 * - `gates-walk`: Release Gates in four steps on the app's real screens, at the end of chapter 2. Two columns from
 *   a 640 px wide container, one below. Static: no loop, no timer left after it unmounts.
 */
export const BLOCKS = {
  "gates-walk": GatesWalk,
} as const satisfies Record<string, () => ReactNode>;

/** Figures with a live twin the site may mount without `inert`. The key is the figure's slot name. */
export const LIVE_FIGURES = {
  "where-a-trick-can-show": PlacesExplorer,
} as const satisfies Partial<Record<FigureName, () => ReactNode>>;

/** A figure as the site mounts it: its box, then the figure. The playground's chapters draw it the same way. */
export function FigureSlot({ name, playing = true, className }: { name: FigureName | RetiredFigureName; playing?: boolean; className?: string }) {
  const figure = FIGURES[name];
  return (
    <FigureBox aspect={figure.aspect} className={className}>
      {figure.render({ playing })}
    </FigureBox>
  );
}
