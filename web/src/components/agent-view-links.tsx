import { Fragment, useMemo, type ReactNode } from "react";

import { isPlainClick, useFileLinks, type FileLinkOpener } from "@/components/file-links";
import { LINK_CLASS, breakClass } from "@/components/markdown-text";
import { codeSpanPath, findFilePaths, type FoundPath } from "@/lib/file-paths";
import { linkHost } from "@/lib/hill/reader";
import { findBareUrls } from "@/lib/markdown";
import { HostWords } from "@/lib/tricks/render";

// LINKS IN AN AGENT VIEW'S TEXT. The agent draws a line, a row's title, a table cell or a caption as
// plain words, and the same words in Chat carry links: a web address opens in a new tab, and a printed
// path opens in the Files view once the bridge has said it exists (components/file-links.tsx, ADR 0088).
// This is that same pass for an agent view, and nothing else: it asks Chat's own detectors
// (`findBareUrls`, `findFilePaths`) and Chat's own opener (`useFileLinks`, the one the session's detail
// screen provides), so the existence check, the pane scoping and the refusal rules are Chat's, and a path
// the bridge has not confirmed stays text.
//
// The renderer takes the result as `RenderCtx.linkText` (lib/tricks/render.tsx) and applies it only to
// text that is not inside a button, a chip, a link or a row that is itself a link. Decisions on the hill,
// tricks and the playground never get it.

const URL_CLASS = (text: string) => `${LINK_CLASS} ${breakClass(text)}`;

/** The look of a printed path in Chat's own tool output (`PathText` in chat-cards.tsx): an underline in the text's ink. */
const PATH_CLASS = "underline underline-offset-2";

interface Piece {
  start: number;
  end: number;
  node: ReactNode;
}

/**
 * The paths in a run of text. Chat reads prose by `findFilePaths`, which needs a folder in the path, and
 * a code span by `codeSpanPath`, which also takes a bare name (`section.tsx`). A row title in an agent view, a table
 * cell or a line is often one file name and nothing else, so a text that is wholly one path is read the
 * way a code span is.
 */
function pathsIn(text: string): FoundPath[] {
  const whole = codeSpanPath(text);
  if (whole === null) return findFilePaths(text);
  const start = text.length - text.trimStart().length;
  return [{ ...whole, start, end: text.trimEnd().length }];
}

/**
 * `text` with its web addresses and its confirmed paths as links, or `text` itself when it has none (the
 * renderer and its tests rely on the identity). Asking the opener queues each unknown path for the
 * existence check, as drawing a path in Chat does.
 */
export function linkViewText(text: string, open: FileLinkOpener | null): ReactNode {
  // A bare address shows where it really goes, as a link node does (review 10 W10): the host the browser
  // opens, after the words, so `https://bank.example@evil.example` reads "evil.example".
  const pieces: Piece[] = findBareUrls(text).map((u) => {
    const host = linkHost(u.href);
    return {
      start: u.start,
      end: u.end,
      node: (
        <Fragment key={`u${String(u.start)}`}>
          <a href={u.href} target="_blank" rel="noopener noreferrer" className={URL_CLASS(text.slice(u.start, u.end))}>
            {text.slice(u.start, u.end)}
          </a>
          {host !== "" && <HostWords host={host} />}
        </Fragment>
      ),
    };
  });
  if (open !== null) {
    for (const f of pathsIn(text)) {
      if (pieces.some((p) => f.start < p.end && p.start < f.end)) continue;
      const target = open(f);
      if (target === null) continue;
      pieces.push({
        start: f.start,
        end: f.end,
        node: (
          <a
            key={`p${String(f.start)}`}
            href={target.href}
            onClick={(e) => {
              if (e.defaultPrevented || !isPlainClick(e)) return;
              e.preventDefault();
              target.onOpen();
            }}
            className={PATH_CLASS}
          >
            {text.slice(f.start, f.end)}
          </a>
        ),
      });
    }
  }
  if (pieces.length === 0) return text;
  pieces.sort((a, b) => a.start - b.start);
  const nodes: ReactNode[] = [];
  let at = 0;
  for (const p of pieces) {
    if (p.start > at) nodes.push(text.slice(at, p.start));
    nodes.push(p.node);
    at = p.end;
  }
  if (at < text.length) nodes.push(text.slice(at));
  return <>{nodes}</>;
}

/**
 * An agent view's `linkText`: stable while the session's opener is, so a block's memo runs again only
 * when a path became known to exist.
 */
export function useViewLinkText(): (text: string) => ReactNode {
  const open = useFileLinks();
  return useMemo(() => (text: string) => linkViewText(text, open), [open]);
}
