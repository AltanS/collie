import { useMemo, type ReactNode, type Ref } from "react";

import type { AnsiSegment } from "@/lib/ansi";
import type { StyledLine } from "@/lib/blocks";
import { isPlainClick, useFileLinks, type FileLinkOpener, type FileLinkTarget } from "@/components/file-links";
import { MIRROR_INVERT, MIRROR_SPACE, styleFor } from "@/components/mirror-space";
import { renderCells } from "@/components/painted-cells";
import { findFilePaths } from "@/lib/file-paths";
import { cn } from "@/lib/utils";

// A path the agent printed is a link here too (ADR 0088), found per ROW on the row's plain text,
// after the ANSI parse. A path the terminal wrapped onto two rows is two pieces, and neither is
// joined to the other this round: each half is tried alone, and usually neither resolves. The
// link keeps the agent's colours and adds only the mirror's own link mark, an underline in
// `currentColor`, the way an autolinked URL in the pane mirror reads (`ansi-output.tsx`), with the
// same free em-relative tap pad. A tap on the link opens the file; a tap anywhere else does what it
// did before, because the pane's tap-to-focus already lets a tap on an `a` through.
const MIRROR_LINK_CLASS = "underline decoration-1 underline-offset-2 cursor-pointer py-[0.35em]";

/** The styled spans of one row's slice `[from, to)`, keyed so siblings never collide. */
function styledSlice(segments: readonly AnsiSegment[], from: number, to: number): ReactNode[] {
  const nodes: ReactNode[] = [];
  let at = 0;
  segments.forEach((s, si) => {
    const start = at;
    at += s.text.length;
    const a = Math.max(from, start);
    const b = Math.min(to, at);
    if (a >= b) return;
    nodes.push(
      <span key={`${si}:${a}`} style={styleFor(s)}>
        {renderCells(s.text.slice(a - start, b - start))}
      </span>,
    );
  });
  return nodes;
}

/** The paths in one row that the screen can open, in order, with where each leads. */
function rowLinks(text: string, open: FileLinkOpener): { start: number; end: number; target: FileLinkTarget }[] {
  const links: { start: number; end: number; target: FileLinkTarget }[] = [];
  for (const f of findFilePaths(text)) {
    const target = open(f);
    if (target !== null) links.push({ start: f.start, end: f.end, target });
  }
  return links;
}

/** One row: its styled spans, and any path in it wrapped in a link that keeps those spans. */
function MirrorRow({ line, open }: { line: StyledLine; open: FileLinkOpener | null }) {
  const text = useMemo(() => line.segments.map((s) => s.text).join(""), [line]);
  const links = useMemo(() => (open === null ? [] : rowLinks(text, open)), [text, open]);
  if (links.length === 0) {
    return line.segments.map((s, si) => (
      <span key={si} style={styleFor(s)}>
        {renderCells(s.text)}
      </span>
    ));
  }
  const nodes: ReactNode[] = [];
  let at = 0;
  for (const { start, end, target } of links) {
    if (start > at) nodes.push(...styledSlice(line.segments, at, start));
    nodes.push(
      <a
        key={`link:${start}`}
        href={target.href}
        onClick={(e) => {
          if (e.defaultPrevented || !isPlainClick(e)) return;
          e.preventDefault();
          target.onOpen();
        }}
        className={MIRROR_LINK_CLASS}
      >
        {styledSlice(line.segments, start, end)}
      </a>,
    );
    at = end;
  }
  if (at < text.length) nodes.push(...styledSlice(line.segments, at, text.length));
  return nodes;
}

/**
 * The raw region a lifted card replaced, mirrored verbatim — the ONE implementation shared by
 * every card's terminal-mode toggle (ADR 0056) plus the two cards that used to inline this
 * themselves (the generic menu and the unread-dialog card). Same treatment as the pane mirror:
 * React text nodes only (the XSS boundary is unchanged — nothing is ever set as innerHTML), and
 * the agent's own terminal colours (MIRROR_SPACE / MIRROR_INVERT, ADR 0002). Scrolls horizontally
 * on its own so a wide screen never makes the page pan.
 *
 * `wrap` breaks long rows instead, anywhere, the way the pane mirror's Wrap does: the prompt card's
 * subject (a command, a diff, a warning) must be readable at phone width without a sideways pan.
 * `className` adds to the box, e.g. a height cap with its own vertical scroll; `ref` reaches the
 * <pre>, the element that scrolls, for a caller that measures it.
 */
export function RawMirror({
  lines,
  wrap = false,
  className,
  ref,
}: {
  lines: StyledLine[];
  wrap?: boolean;
  className?: string;
  ref?: Ref<HTMLPreElement>;
}) {
  const open = useFileLinks();
  return (
    <pre
      ref={ref}
      className={cn(
        "m-0 rounded-lg px-2 py-1.5 font-mono text-[11px] leading-[1.25]",
        wrap ? "whitespace-pre-wrap wrap-anywhere" : "overflow-x-auto whitespace-pre",
        MIRROR_SPACE,
        MIRROR_INVERT,
        className,
      )}
    >
      {lines.map((line, li) => (
        <span key={li}>
          {li > 0 ? "\n" : null}
          <MirrorRow line={line} open={open} />
        </span>
      ))}
    </pre>
  );
}
