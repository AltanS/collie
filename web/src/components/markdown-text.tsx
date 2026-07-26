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
      return (
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] break-all">
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
          className="text-primary underline underline-offset-2 break-all"
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

const HEADING_CLASS: Record<number, string> = {
  1: "text-base font-semibold",
  2: "text-[0.95rem] font-semibold",
  3: "text-sm font-semibold",
};

function Block({ block }: { block: MdBlock }) {
  switch (block.kind) {
    case "heading": {
      // Levels 4-6 are rare in agent prose and don't earn another size step on a phone.
      const cls = HEADING_CLASS[block.level] ?? "text-sm font-semibold";
      return (
        <div className={`${cls} mt-1 leading-snug`}>
          <Spans spans={block.spans} />
        </div>
      );
    }
    case "code":
      return (
        <pre className="overflow-x-auto rounded-md border bg-muted/50 px-2 py-1.5 font-mono text-[11px] leading-snug">
          <Hit text={block.text} />
        </pre>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          className={`ml-4 space-y-0.5 ${block.ordered ? "list-decimal" : "list-disc"} marker:text-muted-foreground`}
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
        <blockquote className="border-l-2 pl-2.5 text-muted-foreground italic">
          <Spans spans={block.spans} />
        </blockquote>
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
      <div className={`space-y-2 text-sm break-words ${className ?? ""}`}>
        {blocks.map((block, i) => (
          <Block key={i} block={block} />
        ))}
      </div>
    </QueryContext.Provider>
  );
}
