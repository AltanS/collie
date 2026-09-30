import { createContext, useContext, useMemo } from "react";

import { parseMarkdown, type MdBlock, type MdSpan } from "@/lib/markdown";
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
      return (
        <code className="rounded-sm border border-status-info/20 bg-status-info/10 px-1 py-px font-mono text-[0.9em] text-status-info wrap-anywhere">
          <Hit text={span.text} />
        </code>
      );
    case "link":
      // `href` was scheme-checked in the parser. noreferrer/noopener because these URLs come from
      // agent output, and target=_blank keeps the PWA shell alive behind the tap.
      return (
        <a
          href={span.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2 wrap-anywhere"
        >
          <Spans spans={span.spans} />
        </a>
      );
    default:
      return <Hit text={span.text} />;
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

const ALIGN_CLASS = new Map<string, string>([
  ["left", "text-left"],
  ["center", "text-center"],
  ["right", "text-right"],
]);

function Block({ block }: { block: MdBlock }) {
  switch (block.kind) {
    case "heading": {
      // Levels 4-6 are rare in agent prose and don't earn another size step on a phone.
      const cls = HEADING_CLASS.get(block.level) ?? "text-sm font-semibold";
      return (
        <div className={`${cls} mt-1 leading-snug`}>
          <Spans spans={block.spans} />
        </div>
      );
    }
    case "code":
      return (
        <pre className="overflow-x-auto rounded-md border border-status-info/20 bg-status-info/5 px-2 py-1.5 font-mono text-[11px] leading-snug">
          <Hit text={block.text} />
        </pre>
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
 */
export function MarkdownText({
  text,
  className,
  query = "",
}: {
  text: string;
  className?: string;
  /** Active find query — occurrences render as marks. Empty disables highlighting entirely. */
  query?: string;
}) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <QueryContext.Provider value={query}>
      <div className={`font-content space-y-2 text-sm break-words ${className ?? ""}`}>
        {blocks.map((block, i) => (
          <Block key={i} block={block} />
        ))}
      </div>
    </QueryContext.Provider>
  );
}
