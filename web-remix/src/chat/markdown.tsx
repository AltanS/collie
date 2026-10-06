// Agent prose, drawn from web/src/lib/markdown.ts's pure parser (read-only). Port of the parts of
// web/src/components/markdown-text.tsx a Chat reply needs: headings, paragraphs, code, lists, quotes,
// tables and rules, with bold, italic, inline code and links inside them. Text is text nodes only.
//
// A link the parser marked `rel` (a relative path, a fragment) has no known destination on this
// screen, so it shows as its label alone, as the React renderer does with no resolver. Every other
// link was scheme-checked by the parser (`classifyHref`) and opens in a new tab.
import type { Handle, RemixNode } from "remix/component";

import { parseMarkdown, type MdBlock, type MdSpan } from "@web/lib/markdown";
import { cn } from "@web/lib/utils";

/** web's breakClass: a short chip never breaks, a long one breaks only where it cannot fit a line. */
const NO_BREAK_MAX = 24;
function breakClass(text: string): string {
  return text.length <= NO_BREAK_MAX ? "whitespace-nowrap" : "wrap-anywhere";
}

/** web's ALIGN_CLASS: a column's alignment, left when the table names none. */
const ALIGN_CLASS = { left: "text-left", center: "text-center", right: "text-right" } as const;

function spans(list: readonly MdSpan[]): RemixNode[] {
  return list.map((span, i) => {
    const key = String(i);
    switch (span.kind) {
      case "text":
        return span.text;
      case "code":
        return (
          <code
            key={key}
            class={`rounded-sm border border-status-info/20 bg-status-info/10 px-1 py-px font-mono text-[0.9em] [font-variant-ligatures:none] text-status-info ${breakClass(span.text)}`}
          >
            {span.text}
          </code>
        );
      case "bold":
        return <strong key={key} class="font-semibold">{spans(span.spans)}</strong>;
      case "italic":
        return <em key={key}>{spans(span.spans)}</em>;
      case "link":
        if (span.rel) return <span key={key}>{spans(span.spans)}</span>;
        return (
          <a key={key} href={span.href} target="_blank" rel="noopener noreferrer" class="text-primary underline underline-offset-2">
            {spans(span.spans)}
          </a>
        );
    }
  });
}

function block(md: MdBlock): RemixNode {
  switch (md.kind) {
    case "heading":
      return <p class="mt-1 font-semibold">{spans(md.spans)}</p>;
    case "paragraph":
      return <p>{spans(md.spans)}</p>;
    case "code":
      return (
        <pre class="overflow-x-auto rounded-md border border-status-info/20 bg-status-info/5 px-2 py-1.5 font-mono text-[11px] leading-snug [font-variant-ligatures:none]">
          {md.text}
        </pre>
      );
    case "list":
      return md.ordered ? (
        <ol class="list-decimal space-y-0.5 pl-5">
          {md.items.map((item, i) => (
            <li key={String(i)}>{spans(item)}</li>
          ))}
        </ol>
      ) : (
        <ul class="list-disc space-y-0.5 pl-5">
          {md.items.map((item, i) => (
            <li key={String(i)}>{spans(item)}</li>
          ))}
        </ul>
      );
    case "quote":
      return <blockquote class="border-l-2 border-border pl-3 text-muted-foreground">{spans(md.spans)}</blockquote>;
    case "table":
      return (
        <div class="overflow-x-auto">
          <table class="w-max border-collapse text-xs">
            <thead>
              <tr>
                {md.header.map((cell, i) => (
                  <th key={String(i)} class={`border px-2 py-1 font-semibold ${ALIGN_CLASS[md.align[i] ?? "left"]}`}>{spans(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {md.rows.map((row, r) => (
                <tr key={String(r)}>
                  {row.map((cell, i) => (
                    <td key={String(i)} class={`border px-2 py-1 align-top ${ALIGN_CLASS[md.align[i] ?? "left"]}`}>{spans(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr class="border-border" />;
  }
}

export function MarkdownText(handle: Handle<{ text: string; class?: string }>) {
  let source: string | undefined;
  let blocks: MdBlock[] = [];
  return () => {
    const { text } = handle.props;
    // Parsed once per text: a poll that re-renders the stream re-renders an unchanged reply for free.
    if (text !== source) {
      source = text;
      blocks = parseMarkdown(text);
    }
    return (
      <div class={cn("font-content flex min-w-0 flex-col gap-2 text-sm leading-relaxed break-words", handle.props.class)}>
        {blocks.map((md, i) => (
          <div key={String(i)} class="contents">
            {block(md)}
          </div>
        ))}
      </div>
    );
  };
}
