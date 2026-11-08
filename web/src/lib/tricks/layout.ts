// THE HEIGHT EVERY NODE RESERVES (M94 slice 02, DESIGN.md section 2).
//
// A node's height is a fact about its FORM, never its data: a `text` reserves its `lines`, a `list`
// its `rows`, a `number`, a `progress`, a `steps` and a `time` one height each, whatever they hold.
// So a trick that rewrites its numbers every five seconds repaints and never moves a pixel, and a
// finger already on its way to a button lands on that button.
//
// The numbers are in rem, so a larger text size grows every box with its text, plus the few hairline
// pixels a frame adds. The renderer sets each leaf's `height` from here; a layout's height is the sum
// (a stack) or the tallest child (a row) of its children's, which the leaves already fix. The same
// function decides whether a new view is a new FORM, which waits while a finger is down.

import { CORE_NODE_KINDS, VIEW_LIMITS, type Gap, type TextRole, type ViewNode } from "./schema";

/** A reserved height: rem, which scales with the text size, plus px, which does not. */
export interface Reserve {
  rem: number;
  px: number;
}

/** The line box of each text role, in rem. Each role states its own line height, so a line is a number. */
export const ROLE_LINE_REM = {
  display: 2,
  title: 1.25,
  body: 1.25,
  caption: 1,
  mono: 1,
} as const satisfies { readonly [R in TextRole]: number };

/** The gap scale of a layout, in rem: Tailwind's `gap-1`, `gap-2` and `gap-4`. */
export const GAP_REM = { tight: 0.25, normal: 0.5, loose: 1 } as const satisfies { readonly [G in Gap]: number };

/** The fixed heights of the leaves, in rem. `TAP` is the 44px floor (DESIGN.md section 6). */
export const LEAF_REM = {
  /** A row of a list, a button, a mark, the placeholder: the tap floor. */
  tap: 2.75,
  /** A number: its 32px value line and its 16px label line, the label reserved even when absent. */
  number: 3,
  /** One `kv` row in one column: label and value on a 24px line. */
  kvRow: 1.5,
  /** One `kv` cell in two columns: a 16px label over a 20px value. */
  kvCell: 2.25,
  /** A `progress` or a `steps`: a 20px line of words, 8px of air and the 4px bar. */
  bar: 2,
  /** A `time`: one 20px line. */
  time: 1.25,
} as const;

/** The list frame's two hairlines (ui/list-group.tsx, `--row-rule` at its default 1px). */
const LIST_FRAME_PX = 2;
/** A row's height as px at the default 16px rem, to pick the tallest child of a row. */
const REM_PX = 16;

const CORE: ReadonlySet<string> = new Set(CORE_NODE_KINDS);

/** A number from a node, held inside its limits, so a node from another Collie never sizes a box wildly. */
export function clampCount(value: number | undefined, limits: { min: number; max: number }, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(limits.max, Math.max(limits.min, Math.floor(value)));
}

function sum(parts: readonly Reserve[], gapRem: number): Reserve {
  const gaps = Math.max(0, parts.length - 1) * gapRem;
  return parts.reduce((acc, part) => ({ rem: acc.rem + part.rem, px: acc.px + part.px }), { rem: gaps, px: 0 });
}

function tallest(parts: readonly Reserve[]): Reserve {
  return parts.reduce((best, part) => (part.rem * REM_PX + part.px > best.rem * REM_PX + best.px ? part : best), { rem: 0, px: 0 });
}

/** The children of a layout node, or none for a node that has none (or a malformed one). */
function childrenOf(node: ViewNode): readonly ViewNode[] {
  return "children" in node && Array.isArray(node.children) ? node.children : [];
}

/** The height a node reserves. A kind this Collie cannot draw reserves the placeholder's. */
export function reservedHeight(node: ViewNode): Reserve {
  if (!CORE.has(node.kind)) return { rem: LEAF_REM.tap, px: 0 };
  switch (node.kind) {
    case "stack":
      return sum(childrenOf(node).map(reservedHeight), GAP_REM[node.gap ?? "normal"] ?? GAP_REM.normal);
    case "row":
      return tallest(childrenOf(node).map(reservedHeight));
    case "text":
      return { rem: clampCount(node.lines, VIEW_LIMITS.textLines, 1) * (ROLE_LINE_REM[node.role ?? "body"] ?? ROLE_LINE_REM.body), px: 0 };
    case "number":
      return { rem: LEAF_REM.number, px: 0 };
    case "kv": {
      const rows = clampCount(Array.isArray(node.rows) ? node.rows.length : 1, VIEW_LIMITS.kvRows, 1);
      return node.cols === 2 ? { rem: Math.ceil(rows / 2) * LEAF_REM.kvCell, px: 0 } : { rem: rows * LEAF_REM.kvRow, px: 0 };
    }
    case "list":
      return { rem: clampCount(node.rows, VIEW_LIMITS.listRows, 1) * LEAF_REM.tap, px: LIST_FRAME_PX };
    case "button":
    case "mark":
      return { rem: LEAF_REM.tap, px: 0 };
    case "progress":
    case "steps":
      return { rem: LEAF_REM.bar, px: 0 };
    case "time":
      return { rem: LEAF_REM.time, px: 0 };
    default:
      return { rem: LEAF_REM.tap, px: 0 };
  }
}

/** A reserve as a CSS length. */
export function heightCss(reserve: Reserve): string {
  if (reserve.px === 0) return `${reserve.rem}rem`;
  return `calc(${reserve.rem}rem + ${reserve.px}px)`;
}

/**
 * The FORM of a view, as one string: the kinds, the layout words and every reserved height, and none
 * of the data. Two views with the same form draw the same boxes in the same places, so swapping one
 * for the other only repaints. A different form waits while a finger is down (DESIGN.md section 2).
 */
export function viewForm(node: ViewNode): string {
  const height = heightCss(reservedHeight(node));
  const kids = childrenOf(node);
  if (kids.length === 0 || !CORE.has(node.kind)) return `${node.kind}:${height}`;
  const words = "gap" in node || "align" in node ? `${node.gap ?? ""}/${node.align ?? ""}` : "";
  return `${node.kind}:${height}:${words}(${kids.map(viewForm).join(",")})`;
}
