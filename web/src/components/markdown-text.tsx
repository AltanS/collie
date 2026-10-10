import { createContext, useContext, useMemo, type ReactNode } from "react";

import { useFileLinks, type FileLinkTarget } from "@/components/file-links";
import { CopyableBlock } from "@/components/ui/copyable-block";
import { codeSpanPath, findFilePaths } from "@/lib/file-paths";
import { headingAnchors, parseMarkdown, spansText, type MdBlock, type MdSpan } from "@/lib/markdown";
import { splitHighlight } from "@/lib/transcript-search";

// Renders the Markdown AST as React elements. Every string from the log reaches the DOM as a TEXT
// NODE — there is no `dangerouslySetInnerHTML` here and there must never be one. That is the repo's
// XSS boundary (CLAUDE.md §"Security posture"): the parser decides *structure*, never markup, so a
// transcript containing `<script>` renders those characters and nothing executes.
//
// Sizing/colour deliberately track the surrounding transcript styles rather than introducing a
// prose theme — this is a reading view inside a terminal-ish app, not a document viewer.

// The active find query, threaded via context rather than a prop drilled through every nested span —
// highlighting is a cross-cutting display concern, and the AST walk is already recursive.
const QueryContext = createContext("");

/**
 * Where a link that is NOT a web address leads, as the screen showing the text decides it.
 *
 * The parser keeps a relative path (`./other.md`), a root-absolute one and a `#fragment` as links
 * flagged `rel`, because only the screen knows what they are relative to. `local` is a link the
 * screen can open itself: `href` is what a middle-click or a long-press copies, `onOpen` is the tap.
 * `text` is a link that leads nowhere here, and reads as its label.
 */
export type LinkTarget = { kind: "local"; href: string; onOpen: () => void } | { kind: "text" };

/** Asks the screen where one `rel` link leads. Never called for an http(s) or mailto link. */
export type LinkResolver = (href: string) => LinkTarget;

// The resolver, threaded the way the find query is. With none (the transcript) a `rel` link is its
// label as plain text: a dead anchor would be worse than none, and raw Markdown worse still.
const LinkContext = createContext<LinkResolver | null>(null);

/**
 * What the screen draws for one `![alt](src)` (ADR 0090), or null to draw the alt text, as an image
 * has always read. Only a screen that passes one gets image spans at all: the parse is asked for
 * them only then, so the transcript's images stay their alt text.
 */
export type ImageResolver = (src: string, alt: string) => ReactNode | null;

const ImageContext = createContext<ImageResolver | null>(null);

/** One image span: the screen's drawing of it, or its alt text when the screen draws none. */
function ImageSpan({ src, alt }: { src: string; alt: string }) {
  const resolve = useContext(ImageContext);
  const drawn = resolve?.(src, alt) ?? null;
  return drawn ?? <TextRun text={alt} />;
}

/** Literal text with find hits marked. Still text nodes — `<mark>` is structure, never parsed markup. */
function Hit({ text }: { text: string }) {
  const query = useContext(QueryContext);
  if (query.trim() === "") return <>{text}</>;
  const pieces = splitHighlight(text, query);
  if (pieces.length === 1 && !pieces[0]!.hit) return <>{text}</>;
  return (
    <>
      {pieces.map((piece, i) =>
        piece.hit ? (
          <mark key={i} className="rounded-sm bg-amber-300/70 text-inherit dark:bg-amber-500/40">
            {piece.text}
          </mark>
        ) : (
          <span key={i}>{piece.text}</span>
        ),
      )}
    </>
  );
}

/**
 * How long a chip or a link may be and still refuse to break at all.
 *
 * ── WHY THIS IS A NUMBER AND NOT A CSS PROPERTY ──────────────────────────────
 * A hyphen and a slash are ORDINARY wrap opportunities. No `overflow-wrap` setting changes that,
 * and `word-break: keep-all` does not either (measured in Chromium, 2026-09-30: it suppresses
 * nothing in Latin text). So `--force` broke as `--` / `force` and `readme-herdr-client` broke
 * after either hyphen, whenever one happened to land near the right edge. The only property that
 * forbids those breaks is `white-space: nowrap`, and that one forbids the break we DO want: a 78
 * character path under it ran 312px past the column, off the side of a phone.
 *
 * So the renderer decides, because it is the one thing here that can see the text. Short enough to
 * fit a line of its own: never break it. Longer than that: break anywhere, since it has to break
 * somewhere.
 *
 * ── AND WHY 24 ───────────────────────────────────────────────────────────────
 * Measured against the built stylesheet at this face and size: the first chip to overrun a column
 * is 36 characters at 280px, 42 at 320px and 44 at 340px. 280px is about as narrow as this prose
 * ever gets (a 320px phone, less the stream's padding and a list's indent), so 24 keeps a third of
 * that narrowest measure in hand for a device whose OS font scale is turned up. It covers what
 * agents actually write in backticks: a flag, a short sha, a file name, a branch, `origin/main`.
 */
const NO_BREAK_MAX = 24;

/** How a chip or a link is allowed to break, given the text it holds. See {@link NO_BREAK_MAX}. */
function breakClass(text: string): string {
  return text.length <= NO_BREAK_MAX ? "whitespace-nowrap" : "wrap-anywhere";
}

/** What a run of spans reads as, flattened — for length, never for rendering. */
const flatten = spansText;

/** A plain click on a local link is the screen's to handle; a modified one is the browser's. */
function isPlainClick(e: React.MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

const LINK_CLASS = "text-primary underline underline-offset-2";

// Inside a link's label nothing else may be a link: an anchor inside an anchor is invalid HTML, and
// the outer one is what the author meant.
const InLinkContext = createContext(false);

/**
 * THE CODE CHIP. The same blue the docs site draws (`collie-website/src/components/prose.tsx`): one
 * blue at 10% fill, 20% edge and full ink. See the `code` case of `Span` for why each part is what it is.
 */
const CHIP_CLASS =
  "rounded-sm border border-status-info/20 bg-status-info/10 px-1 py-px font-mono text-[0.9em] [font-variant-ligatures:none] text-status-info";

/**
 * A path the agent printed, as a chip that opens it in Files (ADR 0088). The chip is the code chip,
 * and the link affordance is the one every in-app link here wears, an underline, in the chip's own
 * ink: no new colour. A plain tap moves inside the app; a modified click is the browser's.
 */
function PathChip({ target, text }: { target: FileLinkTarget; text: string }) {
  return (
    <a
      href={target.href}
      onClick={(e) => {
        if (e.defaultPrevented || !isPlainClick(e)) return;
        e.preventDefault();
        target.onOpen();
      }}
      className="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <code className={`${CHIP_CLASS} underline underline-offset-2 ${breakClass(text)}`}>
        <Hit text={text} />
      </code>
    </a>
  );
}

/**
 * A run of plain prose. Every path in it that resolves under the Changes root, and that the bridge
 * said exists (ADR 0088), becomes a chip; the rest, and every other path, stays text. Asking the
 * opener is what queues a path for that check. With no opener (History, a Files preview)
 * this is the plain run it always was.
 */
function TextRun({ text }: { text: string }) {
  const open = useFileLinks();
  const inLink = useContext(InLinkContext);
  const found = useMemo(() => (open === null || inLink ? [] : findFilePaths(text)), [open, inLink, text]);
  if (open === null || found.length === 0) return <Hit text={text} />;
  const nodes: ReactNode[] = [];
  let at = 0;
  for (const f of found) {
    const target = open(f);
    if (target === null) continue;
    if (f.start > at) nodes.push(<Hit key={`t${at}`} text={text.slice(at, f.start)} />);
    nodes.push(<PathChip key={`p${f.start}`} target={target} text={text.slice(f.start, f.end)} />);
    at = f.end;
  }
  if (nodes.length === 0) return <Hit text={text} />;
  if (at < text.length) nodes.push(<Hit key={`t${at}`} text={text.slice(at)} />);
  return <>{nodes}</>;
}

/** A code span: a chip, and a tappable one when the whole span is a path that resolves and exists. */
function CodeSpan({ text }: { text: string }) {
  const open = useFileLinks();
  const inLink = useContext(InLinkContext);
  const found = open === null || inLink ? null : codeSpanPath(text);
  const target = found === null || open === null ? null : open(found);
  if (target !== null) return <PathChip target={target} text={text} />;
  return (
    <code className={`${CHIP_CLASS} ${breakClass(text)}`}>
      <Hit text={text} />
    </code>
  );
}

function LinkSpan({ span }: { span: Extract<MdSpan, { kind: "link" }> }) {
  const resolve = useContext(LinkContext);
  const label = (
    <InLinkContext.Provider value>
      <Spans spans={span.spans} />
    </InLinkContext.Provider>
  );
  if (!span.rel) {
    // `href` was scheme-checked in the parser. noreferrer/noopener because these URLs come from
    // agent output, and target=_blank keeps the PWA shell alive behind the tap.
    //
    // Same break rule as a chip, and for the same reason: `http://bluefin:8788` is full of slashes
    // and colons, every one of them a wrap opportunity, and an address split across two lines is
    // one you have to reassemble in your head before you trust the tap.
    return (
      <a
        href={span.href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${LINK_CLASS} ${breakClass(flatten(span.spans))}`}
      >
        {label}
      </a>
    );
  }
  const target = resolve?.(span.href);
  if (target === undefined || target.kind === "text") return label;
  return (
    <a
      href={target.href}
      onClick={(e) => {
        if (e.defaultPrevented || !isPlainClick(e)) return;
        e.preventDefault();
        target.onOpen();
      }}
      className={`${LINK_CLASS} ${breakClass(flatten(span.spans))}`}
    >
      {label}
    </a>
  );
}

// Emphasis and links hold child spans (agents nest them — ``**`sha`**`` is routine), so this recurses
// through <Spans>. `code` is the leaf.
function Span({ span }: { span: MdSpan }) {
  switch (span.kind) {
    case "bold":
      return (
        <strong className="font-semibold">
          <Spans spans={span.spans} />
        </strong>
      );
    case "italic":
      return (
        <em className="italic">
          <Spans spans={span.spans} />
        </em>
      );
    case "code":
      // THE SAME CHIP THE DOCS SITE DRAWS (`collie-website/src/components/prose.tsx`): one blue at
      // 10% fill, 20% edge and full ink. A flat `bg-muted` chip was grey ink on a grey wash inside
      // grey prose, so a reader scanning a paragraph for "which bit of this is a literal" had no
      // colour to search for. Same token on both sides, so a command looks like one thing wherever
      // it is read.
      //
      // `wrap-anywhere` AND NOT `break-all`. `break-all` breaks at whatever character the line ends
      // on, so a short sha split as `6c` / `70894d` across two lines with room to spare on the next
      // one. `anywhere` breaks only a token that cannot fit a line of its own, which is the case the
      // rule was there for.
      //
      // THE VERTICAL PADDING IS 1px AND THAT IS A MEASUREMENT, not a taste. A chip is a box around a
      // MONO glyph inside a PROPORTIONAL line: the mono content area is 17px at this size, so `py-0.5`
      // plus the 1px edge made the box 23px tall inside a 22.75px line, and two chips on consecutive
      // wrapped lines touched. At 1px the box is 19px and the rhythm holds. The horizontal padding
      // is untouched; that one is only ever about the glyphs.
      //
      // A span that is one path the screen can open is the same chip, tappable (`CodeSpan`).
      return <CodeSpan text={span.text} />;
    case "link":
      return <LinkSpan span={span} />;
    case "image":
      return <ImageSpan src={span.src} alt={span.alt} />;
    default:
      return <TextRun text={span.text} />;
  }
}

const Spans = ({ spans }: { spans: MdSpan[] }) => (
  <>
    {spans.map((span, i) => (
      <Span key={i} span={span} />
    ))}
  </>
);

// Maps, not object literals: both are addressed with a value parsed out of the agent's own
// markdown (a heading level, a column alignment), so an object lookup could reach an inherited name.
const HEADING_CLASS = new Map<number, string>([
  [1, "text-base font-semibold"],
  [2, "text-[0.95rem] font-semibold"],
  [3, "text-sm font-semibold"],
]);

// A DOCUMENT (the Files preview of a README) is read, not skimmed, so its headings take a real scale
// where Chat's stay one step apart: the title clearly above the section, the section above the
// subsection, and more air above a heading than below it so each one belongs to what follows. Margins
// collapse between blocks, so `mt-*` is the gap above and `mb-*` the gap below, and `first:mt-0` keeps
// a title at the top of the page from starting low. Levels 4 to 6 stay body size, in semibold.
const DOCUMENT_HEADING_CLASS = new Map<number, string>([
  [1, "mt-8 mb-2 text-2xl font-bold leading-tight tracking-tight"],
  [2, "mt-6 mb-2 text-xl font-semibold leading-tight"],
  [3, "mt-5 mb-1.5 text-base font-semibold leading-snug"],
]);
const DOCUMENT_HEADING_FALLBACK = "mt-4 mb-1 text-sm font-semibold leading-snug";

const ALIGN_CLASS = new Map<string, string>([
  ["left", "text-left"],
  ["center", "text-center"],
  ["right", "text-right"],
]);

/** `chat` is agent prose, sized for a phone transcript. `document` is a file the operator opened to read. */
export type MarkdownVariant = "chat" | "document";

function Block({ block, anchor, variant }: { block: MdBlock; anchor: string | null; variant: MarkdownVariant }) {
  switch (block.kind) {
    case "heading": {
      // Levels 4-6 are rare in agent prose and don't earn another size step on a phone.
      if (variant === "document") {
        const cls = DOCUMENT_HEADING_CLASS.get(block.level) ?? DOCUMENT_HEADING_FALLBACK;
        return (
          <div
            id={anchor ?? undefined}
            data-heading-level={block.level}
            className={`${cls} first:mt-0 ${anchor === null ? "" : "scroll-mt-28"}`}
          >
            <Spans spans={block.spans} />
          </div>
        );
      }
      const cls = HEADING_CLASS.get(block.level) ?? "text-sm font-semibold";
      // `scroll-mt-28` clears the Files screen's sticky file bar, so a tap on `#install` leaves the
      // heading in view and not behind it. Harmless where nothing sticks.
      return (
        <div id={anchor ?? undefined} className={`${cls} mt-1 leading-snug ${anchor === null ? "" : "scroll-mt-28"}`}>
          <Spans spans={block.spans} />
        </div>
      );
    }
    case "code":
      return (
        <CopyableBlock text={block.text}>
          <pre className="overflow-x-auto rounded-md border border-status-info/20 bg-status-info/5 px-2 py-1.5 font-mono text-[11px] leading-snug [font-variant-ligatures:none]">
            <Hit text={block.text} />
          </pre>
        </CopyableBlock>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      // `leading-relaxed`, the same as a paragraph. Without it a list took `text-sm`'s own 20px line
      // and a paragraph took 22.75px, so the SAME prose read at two different paces depending on
      // whether it had a bullet in front of it, and a list was the one place a code chip did not fit.
      return (
        <Tag
          className={`ml-4 space-y-0.5 leading-relaxed ${block.ordered ? "list-decimal" : "list-disc"} marker:text-muted-foreground`}
        >
          {block.items.map((item, i) => (
            <li key={i} className="pl-0.5">
              <Spans spans={item} />
            </li>
          ))}
        </Tag>
      );
    }
    case "quote":
      return (
        <blockquote className="border-l-2 pl-2.5 leading-relaxed text-muted-foreground italic">
          <Spans spans={block.spans} />
        </blockquote>
      );
    case "table":
      // Columns can't be made to fit a phone, so the table keeps its real widths and pans inside its
      // own scroller — the same thing a mobile browser does with a table on any normal page.
      return (
        <CopyableBlock text={block.source}>
          <div className="overflow-x-auto">
            <table className="w-max border-collapse text-xs">
              <thead>
                <tr>
                  {block.header.map((cell, i) => (
                    <th
                      key={i}
                      className={`border px-2 py-1 font-semibold ${ALIGN_CLASS.get(block.align[i] ?? "left") ?? "text-left"}`}
                    >
                      <Spans spans={cell} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td
                        key={c}
                        className={`border px-2 py-1 align-top ${ALIGN_CLASS.get(block.align[c] ?? "left") ?? "text-left"}`}
                      >
                        <Spans spans={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CopyableBlock>
      );
    case "rule":
      return <hr className="border-border" />;
    default:
      return (
        <p className="leading-relaxed">
          <Spans spans={block.spans} />
        </p>
      );
  }
}

/**
 * Render agent prose as formatted Markdown. Memoised on the source string: a transcript page holds
 * dozens of these and the parse is pure, so re-parsing on every unrelated re-render is pure waste.
 *
 * `resolveLink` is for a screen that knows what a relative link is relative to (the Files preview).
 * `headingIds` gives each heading its GitHub-style anchor id, for that same screen's `#fragment`
 * links; the transcript leaves both off, so its links and ids are what they always were.
 */
export function MarkdownText({
  text,
  className,
  query = "",
  resolveLink,
  resolveImage,
  headingIds = false,
  variant = "chat",
}: {
  text: string;
  className?: string;
  /** Active find query — occurrences render as marks. Empty disables highlighting entirely. */
  query?: string;
  /** Where a relative or fragment link leads. Without it such a link reads as its label. */
  resolveLink?: LinkResolver;
  /** How an image is drawn. Without it every image reads as its alt text, and none is parsed as one. */
  resolveImage?: ImageResolver;
  /** Give each heading an `id` (its anchor). Off by default: an id on every transcript heading is a collision. */
  headingIds?: boolean;
  /** `document` sizes headings as a page. Chat, the default, renders exactly as it always did. */
  variant?: MarkdownVariant;
}) {
  const withImages = resolveImage !== undefined;
  const blocks = useMemo(() => parseMarkdown(text, { images: withImages }), [text, withImages]);
  const anchors = useMemo(() => (headingIds ? headingAnchors(blocks) : null), [blocks, headingIds]);
  return (
    <QueryContext.Provider value={query}>
      <LinkContext.Provider value={resolveLink ?? null}>
        <ImageContext.Provider value={resolveImage ?? null}>
          <div className={`font-content space-y-2 text-sm break-words ${className ?? ""}`}>
            {blocks.map((block, i) => (
              <Block key={i} block={block} anchor={anchors?.[i] ?? null} variant={variant} />
            ))}
          </div>
        </ImageContext.Provider>
      </LinkContext.Provider>
    </QueryContext.Provider>
  );
}
