import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

import { ICONOIR } from "./src/components/icons/sets/iconoir";
import { PHOSPHOR, PHOSPHOR_FILL_KEEPS_REGULAR } from "./src/components/icons/sets/phosphor";
import type { GlyphNode } from "./src/components/icons/glyph-data";
import type { GlyphSetId } from "./src/lib/glyph-sets";

// THE GLYPH SET CHUNKS (ADR 0137). Each set other than lucide is one module,
// `virtual:collie-glyphs/<id>`, built here at build time from the icon package's own SVG files: only
// the files the family map under `src/components/icons/sets/` names, and only that set's weight. The
// app imports each with a static `import()` in one `switch` (`components/icons/glyphs.ts`), so each is
// one lazy chunk under `glyphs/`, out of the precache like `marks/`.
//
// WHAT A GLYPH BECOMES. lucide's own element list (`[tag, attrs][]`), which lucide-react's `Icon`
// draws, so a swapped glyph is drawn by the same component as a lucide one and keeps its defaults:
// the 24px box, `aria-hidden`, the class merge. Only flat shapes survive: a `<g>` that only clips is
// unwrapped, `<defs>` and `<clipPath>` go, and anything else stops the build, so no SVG feature the
// renderer does not draw can slip in. Attributes lucide's root already sets (round caps and joins,
// `currentColor` stroke) are dropped, and so is a child's own `stroke-width`, so the theme's icon
// weight reaches every stroked path. The data never reaches `innerHTML`: React builds every element.
//
// Both families are MIT. Their licence texts ship beside the chunks, in `public/glyphs/`.

/** Where the SVG files of one set are, and the root attributes its glyphs need. */
interface SetSource {
  /** Key to the family's file name, or null for a key the family does not draw. */
  map: Readonly<Record<string, string | null>>;
  /** The file of a name, under `node_modules`. */
  file: (name: string) => string;
  /** The viewBox every file of the family must have. */
  viewBox: string;
  /** Attributes on the `<svg>` that differ from lucide's defaults. */
  root: Readonly<Record<string, string>>;
}

const PHOSPHOR_ROOT = { viewBox: "0 0 256 256", fill: "currentColor", stroke: "none" };

export const SOURCES = {
  phosphor: {
    map: PHOSPHOR,
    file: (name) => `@phosphor-icons/core/assets/regular/${name}.svg`,
    viewBox: "0 0 256 256",
    root: PHOSPHOR_ROOT,
  },
  "phosphor-fill": {
    map: PHOSPHOR,
    // A few names keep their outline in the fill set (PHOSPHOR_FILL_KEEPS_REGULAR says why).
    file: (name) =>
      PHOSPHOR_FILL_KEEPS_REGULAR.includes(name)
        ? `@phosphor-icons/core/assets/regular/${name}.svg`
        : `@phosphor-icons/core/assets/fill/${name}-fill.svg`,
    viewBox: "0 0 256 256",
    root: PHOSPHOR_ROOT,
  },
  "phosphor-duotone": {
    map: PHOSPHOR,
    file: (name) => `@phosphor-icons/core/assets/duotone/${name}-duotone.svg`,
    viewBox: "0 0 256 256",
    root: PHOSPHOR_ROOT,
  },
  iconoir: {
    map: ICONOIR,
    file: (name) => `iconoir/icons/regular/${name}.svg`,
    viewBox: "0 0 24 24",
    root: {},
  },
} as const satisfies Record<Exclude<GlyphSetId, "lucide">, SetSource>;

export type ChunkedSetId = keyof typeof SOURCES;

const PREFIX = "virtual:collie-glyphs/";
const RESOLVED = `\0${PREFIX}`;

/** True for the id of a set chunk module, as Rollup reports it. */
export function isGlyphChunkModule(id: string): boolean {
  return id.startsWith(RESOLVED);
}

const DRAWN_ELEMENTS = new Set(["path", "circle", "rect", "line", "polyline", "polygon", "ellipse"]);
/** Elements dropped with everything inside them. */
const DROPPED = new Set(["defs", "clipPath", "mask", "title", "desc"]);
/** Attributes lucide's root already gives every child, or that must come from the theme. */
const INHERITED = new Map<string, string | null>([
  ["stroke-linecap", "round"],
  ["stroke-linejoin", "round"],
  ["stroke", "currentColor"],
  ["stroke-width", null],
]);

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function attributes(source: string, where: string): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /([a-zA-Z:-]+)\s*=\s*"([^"]*)"/g;
  for (const match of source.matchAll(pattern)) found.set(match[1], match[2]);
  const rest = source.replace(pattern, "").trim();
  if (rest !== "") throw new Error(`${where}: an attribute the glyph build cannot read: ${rest}`);
  return found;
}

/**
 * The shapes of one SVG file, as lucide's element list. Throws on anything the renderer would not
 * draw the same way: an unknown element, a `<g>` that does more than clip, text, or a wrong viewBox.
 */
export function parseGlyph(svg: string, viewBox: string, where: string): GlyphNode {
  const nodes: GlyphNode = [];
  const tags = /<(\/?)([a-zA-Z]+)((?:\s+[^>]*?)?)\s*(\/?)>/g;
  let dropping = 0;
  let last = 0;
  for (const match of svg.matchAll(tags)) {
    const between = svg.slice(last, match.index).trim();
    last = match.index + match[0].length;
    if (between !== "" && !between.startsWith("<?xml") && dropping === 0) throw new Error(`${where}: text in the glyph: ${between}`);
    const [, closing, tag, attrText, selfClosing] = match;
    if (closing === "/") {
      if (DROPPED.has(tag)) dropping -= 1;
      continue;
    }
    if (DROPPED.has(tag)) {
      if (selfClosing !== "/") dropping += 1;
      continue;
    }
    if (dropping > 0) continue;
    const attrs = attributes(attrText, where);
    if (tag === "svg") {
      if (attrs.get("viewBox") !== viewBox) throw new Error(`${where}: viewBox ${attrs.get("viewBox")}, expected ${viewBox}`);
      continue;
    }
    if (tag === "g") {
      const extra = [...attrs.keys()].filter((name) => name !== "clip-path" && name !== "id");
      if (extra.length > 0) throw new Error(`${where}: a <g> with ${extra.join(", ")} cannot be flattened`);
      continue;
    }
    if (!DRAWN_ELEMENTS.has(tag)) throw new Error(`${where}: <${tag}> is not a shape the glyph build draws`);
    const kept = new Map([["key", String(nodes.length)]]);
    for (const [name, value] of attrs) {
      if (name === "id" || name === "xmlns") continue;
      const inherited = INHERITED.get(name);
      if (inherited === null || inherited === value) continue;
      if (name === "fill" && value === "none") continue;
      kept.set(camel(name), value);
    }
    // SAFETY: DRAWN_ELEMENTS holds only SVG element names lucide's element type accepts.
    nodes.push([tag as GlyphNode[number][0], Object.fromEntries(kept)]);
  }
  if (nodes.length === 0) throw new Error(`${where}: no shape`);
  return nodes;
}

/** The source of one set's module: each distinct glyph once, then the key table pointing at them. */
export function setModule(id: ChunkedSetId, nodeModules: string): string {
  const source: SetSource = SOURCES[id];
  const distinct: string[] = [];
  const index = new Map<string, number>();
  const glyphs: string[] = [];
  for (const [key, name] of Object.entries(source.map)) {
    if (name === null) continue;
    let at = index.get(name);
    if (at === undefined) {
      const file = resolve(nodeModules, source.file(name));
      distinct.push(JSON.stringify(parseGlyph(readFileSync(file, "utf8"), source.viewBox, `${id}/${name}`)));
      at = distinct.length - 1;
      index.set(name, at);
    }
    glyphs.push(`${JSON.stringify(key)}:n[${at}]`);
  }
  return `const n=[${distinct.join(",")}];export default {id:${JSON.stringify(id)},root:${JSON.stringify(source.root)},glyphs:{${glyphs.join(",")}}};`;
}

/** The plugin: resolves `virtual:collie-glyphs/<id>` and builds its module from `node_modules`. */
export function glyphSetsPlugin(webDir: string): Plugin {
  const nodeModules = resolve(webDir, "node_modules");
  return {
    name: "collie-glyph-sets",
    resolveId(id) {
      return id.startsWith(PREFIX) ? `\0${id}` : null;
    },
    load(id) {
      if (!isGlyphChunkModule(id)) return null;
      const set = id.slice(RESOLVED.length);
      if (!(set in SOURCES)) throw new Error(`no glyph set ${set}`);
      // SAFETY: checked against SOURCES on the line above.
      return setModule(set as ChunkedSetId, nodeModules);
    },
  };
}
