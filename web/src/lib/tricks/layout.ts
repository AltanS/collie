// THE HEIGHT EVERY NODE RESERVES (M94 slice 02, re-cut on the tree kinds in step 3; DESIGN.md section 2).
//
// A node's height is a fact about its SHAPE, never its data: a `para` reserves the lines its text
// needs (from the text's length, capped), a `code` with `max` reserves `max` lines, a `list` reserves
// its kids, and a `number`, a `meter`, a `chip`, a `button` and a step strip are one height each,
// whatever they hold. So a trick that rewrites its numbers every five seconds repaints and never
// moves a pixel, and a finger already on its way to a button lands on that button.
//
// The numbers are in rem, so a larger text size grows every box with its text, plus the few hairline
// pixels a frame adds. The renderer sets each LEAF's `height` from here; a container is the sum of
// its kids (they flow down; a `bar` is the tallest of its kids), which the leaves already fix. The
// same function decides whether a new view is a new FORM, which waits while a finger is down.

import { VIEW_LIMITS, type View, type ViewNode } from "./schema";

/** A reserved height: rem, which scales with the text size, plus px, which does not. */
export interface Reserve {
  rem: number;
  px: number;
}

/** The fixed heights of the leaves, in rem. `tap` is the 44px floor (DESIGN.md section 6). */
export const LEAF_REM = {
  /** A button, a one-line row, the placeholder: the tap floor. */
  tap: 2.75,
  /** A row with its second line, or a button with its `hint`: two lines inside the tap floor's air. */
  tall: 3.5,
  /** A number: its 32px figure line and its 16px label line, the label reserved even when absent. */
  number: 3,
  /** A meter: a 20px line of words, 8px of air and the 4px bar. */
  meter: 2,
  /** A chip: 24px. */
  chip: 1.5,
  /** A step strip (a `bar` of `chip` with `state`): the chips' 24px line, 4px of air and the 4px track. */
  strip: 2,
  /** One `line`, or one line of a `code`: a 16px mono line. */
  line: 1,
  /** One line of a `para`: a 20px body line. */
  paraLine: 1.25,
  /** A spacer, with or without its label: 16px. */
  spacer: 1,
  /** A group's head: its label and badge on a 24px line. */
  groupHead: 1.5,
} as const;

/** The gap between the nodes of a flow (a view, a card, a group): Tailwind's `gap-2`. */
export const FLOW_GAP_REM = 0.5;
/** A card's padding top and bottom (`py-3`), and its 1px border on both edges. */
const CARD_PAD_REM = 1.5;
const FRAME_PX = 2;
/** A code block's padding top and bottom (`py-2`). */
const CODE_PAD_REM = 1;

/**
 * THE PARA ESTIMATE. A para reserves the lines its text needs at the phone's width, from the text's
 * length: about 40 characters a line in the content face at 390px (14px text in a 342px column), at
 * least one line, at most `PARA_LINES_MAX` (a heading at most two). A longer text clamps with an
 * ellipsis inside its box. The estimate is a property of the text's length, so a para that keeps its
 * length keeps its height, and a figure that ticks (`23/34` to `24/34`) moves nothing.
 */
export const PARA_CHARS_PER_LINE = 40;
export const PARA_LINES_MAX = 8;
export const HEADING_LINES_MAX = 2;

/** A row's height as px at the default 16px rem, to pick the tallest kid of a bar. */
const REM_PX = 16;

/** A count held inside its limits, so a node from another Collie never sizes a box wildly. Not a number: the fallback. */
export function clampCount(value: number, limits: { min: number; max: number }, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(limits.max, Math.max(limits.min, Math.floor(value)));
}

/** The kids of a node, or none when it has no list of them: a node from the wire may carry any value in `kids`. */
export function kidsOf(node: ViewNode): readonly ViewNode[] {
  return "kids" in node && Array.isArray(node.kids) ? node.kids : [];
}

function sum(parts: readonly Reserve[], gapRem: number): Reserve {
  const gaps = Math.max(0, parts.length - 1) * gapRem;
  return parts.reduce((acc, part) => ({ rem: acc.rem + part.rem, px: acc.px + part.px }), { rem: gaps, px: 0 });
}

function tallest(parts: readonly Reserve[]): Reserve {
  return parts.reduce((best, part) => (part.rem * REM_PX + part.px > best.rem * REM_PX + best.px ? part : best), { rem: 0, px: 0 });
}

/** The words a para or a line holds: its text, or its runs' and links' texts end to end. */
export function textOf(node: ViewNode): string {
  if ("text" in node && node.text !== undefined) return node.text;
  return kidsOf(node).map(textOf).join("");
}

/** The lines a para reserves, from its text's length (see THE PARA ESTIMATE). */
export function paraLines(node: ViewNode): number {
  const attrs = node.kind === "para" ? node.attrs : undefined;
  // A bullet or a term takes room on the first line: count it as text.
  const extra = (attrs?.bullet?.length ?? 0) + (attrs?.term === undefined ? 0 : attrs.term.length + 1);
  const length = textOf(node).length + extra;
  const max = attrs?.role === "heading" ? HEADING_LINES_MAX : PARA_LINES_MAX;
  return Math.min(max, Math.max(1, Math.ceil(length / PARA_CHARS_PER_LINE)));
}

/** The lines a code block shows: its `max`, else its lines, inside the code limits. */
export function codeLines(node: ViewNode): number {
  const max = node.kind === "code" ? node.attrs?.max : undefined;
  if (max !== undefined) return clampCount(Number(max), VIEW_LIMITS.codeMax, 1);
  return clampCount(kidsOf(node).length, VIEW_LIMITS.codeMax, 1);
}

/** A bar of chips where a chip carries a `state`: the step strip (the first schema's `steps`). */
export function isStepStrip(node: ViewNode): boolean {
  if (node.kind !== "bar") return false;
  const kids = kidsOf(node);
  return kids.length > 0 && kids.every((kid) => kid.kind === "chip") && kids.some((kid) => kid.kind === "chip" && kid.attrs?.state !== undefined);
}

/** Whether a group draws its head: a label or a badge. A group with neither is a plain flow of its kids. */
export function groupHasHead(node: ViewNode): boolean {
  return node.kind === "group" && (node.attrs?.label !== undefined || node.attrs?.badge !== undefined);
}

/** The height a node reserves. A kind this Collie cannot draw reserves the placeholder's. */
export function reservedHeight(node: ViewNode): Reserve {
  switch (node.kind) {
    case "card":
      return add(sum(kidsOf(node).map(reservedHeight), FLOW_GAP_REM), { rem: CARD_PAD_REM, px: FRAME_PX });
    case "group": {
      const head: Reserve = { rem: LEAF_REM.groupHead, px: 0 };
      const headed = groupHasHead(node);
      // A group drawn closed is its head alone. The person's toggle after that is theirs, not a new form.
      if (headed && node.attrs?.fold === "closed") return head;
      return sum([...(headed ? [head] : []), ...kidsOf(node).map(reservedHeight)], FLOW_GAP_REM);
    }
    case "list":
      // A list reserves its kids: the rows inside one frame. An empty list keeps the frame's two lines.
      return add(sum(kidsOf(node).map(reservedHeight), 0), { rem: 0, px: FRAME_PX });
    case "row":
      return { rem: kidsOf(node).some((kid) => kid.kind === "para") ? LEAF_REM.tall : LEAF_REM.tap, px: 0 };
    case "bar":
      if (isStepStrip(node)) return { rem: LEAF_REM.strip, px: 0 };
      return tallest(kidsOf(node).map(reservedHeight));
    case "chip":
      return { rem: LEAF_REM.chip, px: 0 };
    case "button":
      return { rem: node.attrs.hint === undefined ? LEAF_REM.tap : LEAF_REM.tall, px: 0 };
    case "para":
      return { rem: paraLines(node) * LEAF_REM.paraLine, px: 0 };
    case "line":
      return { rem: LEAF_REM.line, px: 0 };
    case "run":
    case "link":
      return { rem: LEAF_REM.paraLine, px: 0 };
    case "code":
      return { rem: codeLines(node) * LEAF_REM.line + CODE_PAD_REM, px: FRAME_PX };
    case "image":
      // An image's height is its width times `h / w`: a ratio, reserved by `aspect-ratio`, not a length.
      return { rem: 0, px: 0 };
    case "meter":
      return { rem: LEAF_REM.meter, px: 0 };
    case "spacer":
      return { rem: LEAF_REM.spacer, px: 0 };
    case "number":
      return { rem: LEAF_REM.number, px: 0 };
    default:
      return { rem: LEAF_REM.tap, px: 0 };
  }
}

function add(a: Reserve, b: Reserve): Reserve {
  return { rem: a.rem + b.rem, px: a.px + b.px };
}

/** The height a whole view reserves: its nodes flow down the frame with the flow gap. */
export function viewHeight(view: View): Reserve {
  return sum(view.map(reservedHeight), FLOW_GAP_REM);
}

/** A reserve as a CSS length. */
export function heightCss(reserve: Reserve): string {
  if (reserve.px === 0) return `${reserve.rem}rem`;
  return `calc(${reserve.rem}rem + ${reserve.px}px)`;
}

/** The shape words of a node that change its boxes without changing its height: an image's ratio, a fold. */
function formWords(node: ViewNode): string {
  if (node.kind === "image") return `${node.attrs.w}x${node.attrs.h}`;
  if (node.kind === "group") return node.attrs?.fold ?? "";
  if (node.kind === "bar") return isStepStrip(node) ? "strip" : (node.attrs?.scroll ?? "");
  return "";
}

/**
 * The FORM of a node, as one string: its kind, its shape words and its reserved height, and its kids'
 * forms, and none of its data. Two nodes with the same form draw the same boxes in the same places,
 * so swapping one for the other only repaints. A different form waits while a finger is down
 * (DESIGN.md section 2).
 */
export function nodeForm(node: ViewNode): string {
  const height = heightCss(reservedHeight(node));
  // A para's and a line's kids are words; a code's lines scroll inside its reserved box: none is a box of its own.
  const kids = node.kind === "para" || node.kind === "line" || node.kind === "code" ? [] : kidsOf(node);
  const head = `${node.kind}:${height}:${formWords(node)}`;
  return kids.length === 0 ? head : `${head}(${kids.map(nodeForm).join(",")})`;
}

/** The form of a whole view: its nodes' forms, top to bottom. */
export function viewForm(view: View): string {
  return view.map(nodeForm).join("|");
}
