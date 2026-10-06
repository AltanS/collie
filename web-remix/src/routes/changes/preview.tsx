// What the Files view draws for ONE file (ADR 0083): the source as numbered, coloured lines, or a
// Preview of a Markdown, JSON or HTML file. Port of web/src/components/file-preview.tsx, and of the
// document half of web/src/components/markdown-text.tsx (the Chat renderer in `chat/markdown.tsx`
// has no link resolver and no heading anchors, which a README needs).
//
// THE FILE IS HOSTILE TEXT. It is whatever sits on the operator's disk: a README from a stranger's
// repo, a saved web page. So every drawing here puts the file's characters into the DOM as TEXT NODES,
// and none of them is ever parsed as markup by this app. The one place a file's HTML is allowed to be
// HTML is `HtmlPreview`, and there it goes into a sandboxed frame that cannot run a script, submit a
// form, or reach this app.
import { on, ref, unsafeHTML, type Handle, type RemixNode } from "remix/component";
import { ChevronDown, ChevronRight } from "lucide";

import { HIGHLIGHT_MAX_LINES, highlightFile, highlightFileNow, languageForPath, type RowTokens } from "@web/lib/diff-highlight";
import { resolveFileLink } from "@web/lib/files-link";
import { RENDER_MAX_LINES, formatBytes, previewKindFor, splitLines, type PreviewKind } from "@web/lib/files-view";
import { t, tn } from "@web/lib/i18n";
import { asJsonBoolean, asJsonObject, asJsonString, type JsonValue } from "@web/lib/json";
import { parseJsonTree } from "@web/lib/json-tree";
import { headingAnchors, parseMarkdown, spansText, type MdBlock, type MdSpan } from "@web/lib/markdown";
import type { FilesAt } from "@web/lib/nav";
import type { FileRead } from "@web/lib/types";

import { scheduleUpdate } from "../../lib/store";
import { Icon } from "../../ui/icon";
import { tokenLine } from "./parts";

export type FileText = Extract<FileRead, { available: true }>;
export type FileView = "source" | "preview";

/** Whether Source or Preview opens first: Preview, for every type that has one. */
export function defaultView(path: string): FileView {
  return previewKindFor(path) === null ? "source" : "preview";
}

function quiet(children: RemixNode): RemixNode {
  return <p class="px-6 py-16 text-center text-sm leading-relaxed text-muted-foreground">{children}</p>;
}

/** One quiet line under a drawing, for the bound a read hit. */
function note(children: RemixNode): RemixNode {
  return <p class="px-4 pt-3 text-xs text-muted-foreground">{children}</p>;
}

/** The number of lines in `text`, without building the array. */
function countLines(text: string): number {
  let n = 1;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) n++;
  return n;
}

// ── Source ─────────────────────────────────────────────────────────────────────────────────────

export interface SourceViewProps {
  text: string;
  path: string;
}

/**
 * A file as monospace lines with one number gutter. Long lines WRAP, anywhere, so a minified file
 * cannot push the page wide. The gutter is sized once by the widest number. Ligatures are off: source
 * is read character by character. The lines are split once per text; the colour arrives when the
 * highlighter loads (the first file of a language draws plain first).
 */
export function SourceView(handle: Handle<SourceViewProps>) {
  let splitFor: string | null = null;
  let lines: string[] = [];
  let done: { lines: readonly string[]; tokens: RowTokens } | null = null;
  let asked: readonly string[] | null = null;

  const colour = (target: readonly string[], lang: NonNullable<ReturnType<typeof languageForPath>>): void => {
    if (asked === target) return;
    asked = target;
    void (async () => {
      try {
        const tokens = await highlightFile(target, lang);
        if (handle.signal.aborted || asked !== target) return;
        done = { lines: target, tokens };
        scheduleUpdate(handle);
      } catch {
        // No highlighter (offline, a stale chunk): the plain lines are the whole answer.
      }
    })();
  };

  return () => {
    const { text, path } = handle.props;
    if (text !== splitFor) {
      splitFor = text;
      lines = splitLines(text);
    }
    const lang = languageForPath(path);
    const colourable = lang !== null && lines.length <= HIGHLIGHT_MAX_LINES;
    const now = colourable ? highlightFileNow(lines, lang) : null;
    if (colourable && now === null) {
      const target = lines;
      handle.queueTask(() => colour(target, lang));
    }
    const syntax = now ?? (done?.lines === lines ? done.tokens : null);
    const shown = lines.length > RENDER_MAX_LINES ? lines.slice(0, RENDER_MAX_LINES) : lines;
    const gutter = { width: `calc(${String(Math.max(String(shown.length).length, 2))}ch + 0.5rem)` };
    return (
      <div class="font-mono text-xs leading-5 [font-variant-ligatures:none]" data-slot="file-source" data-highlighted={syntax ? "" : undefined}>
        {shown.map((line, i) => {
          const tokens = syntax?.[i];
          return (
            <div key={String(i)} class="flex pl-1">
              <span aria-hidden="true" class="shrink-0 pr-2 text-right text-muted-foreground tabular-nums select-none" style={gutter}>
                {i + 1}
              </span>
              <span class="min-w-0 flex-1 pr-3 wrap-anywhere whitespace-pre-wrap">{tokens ? tokenLine(tokens) : line}</span>
            </div>
          );
        })}
        {shown.length < lines.length ? note(t("files.linesCapped")) : null}
      </div>
    );
  };
}

// ── Markdown ───────────────────────────────────────────────────────────────────────────────────

/**
 * How a link in a Markdown file opens another file or folder of the Files view. The route owns the
 * router, so it hands over both halves: the address (for a middle-click or a long-press) and the tap
 * (a move that goes down a level, so Back works by ADR 0067). Without it, such a link reads as text.
 */
export interface FileLinks {
  hrefFor(at: FilesAt): string;
  onOpen(at: FilesAt): void;
}

/** The element of `root` whose `id` is the fragment `hash` names, or null. Compared, never selected. */
function anchorIn(root: HTMLElement, hash: string): HTMLElement | null {
  let id = hash;
  try {
    id = decodeURIComponent(hash);
  } catch {
    // A malformed escape is taken as written.
  }
  id = id.toLowerCase();
  if (id === "") return null;
  for (const el of root.querySelectorAll<HTMLElement>("[id]")) if (el.id === id) return el;
  return null;
}

const LINK_CLASS = "text-primary underline underline-offset-2";
const NO_BREAK_MAX = 24;
const breakClass = (text: string): string => (text.length <= NO_BREAK_MAX ? "whitespace-nowrap" : "wrap-anywhere");

/** Where one `rel` link leads: a link the screen opens itself, or text. */
type Resolve = (href: string) => { href: string; onOpen: () => void } | null;

function spans(list: readonly MdSpan[], resolve: Resolve): RemixNode[] {
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
        return (
          <strong key={key} class="font-semibold">
            {spans(span.spans, resolve)}
          </strong>
        );
      case "italic":
        return (
          <em key={key} class="italic">
            {spans(span.spans, resolve)}
          </em>
        );
      case "link": {
        const label = spans(span.spans, resolve);
        if (!span.rel) {
          return (
            <a key={key} href={span.href} target="_blank" rel="noopener noreferrer" class={`${LINK_CLASS} ${breakClass(spansText(span.spans))}`}>
              {label}
            </a>
          );
        }
        const target = resolve(span.href);
        if (target === null) return <span key={key}>{label}</span>;
        return (
          <a
            key={key}
            href={target.href}
            class={`${LINK_CLASS} ${breakClass(spansText(span.spans))}`}
            mix={on("click", (event) => {
              if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              target.onOpen();
            })}
          >
            {label}
          </a>
        );
      }
    }
  });
}

const HEADING_CLASS = new Map<number, string>([
  [1, "mt-8 mb-2 text-2xl font-bold leading-tight tracking-tight"],
  [2, "mt-6 mb-2 text-xl font-semibold leading-tight"],
  [3, "mt-5 mb-1.5 text-base font-semibold leading-snug"],
]);
const HEADING_FALLBACK = "mt-4 mb-1 text-sm font-semibold leading-snug";
const ALIGN = new Map<string, string>([
  ["left", "text-left"],
  ["center", "text-center"],
  ["right", "text-right"],
]);

function block(md: MdBlock, anchor: string | null, resolve: Resolve): RemixNode {
  switch (md.kind) {
    case "heading":
      return (
        <div id={anchor ?? undefined} data-heading-level={md.level} class={`${HEADING_CLASS.get(md.level) ?? HEADING_FALLBACK} first:mt-0 ${anchor === null ? "" : "scroll-mt-28"}`}>
          {spans(md.spans, resolve)}
        </div>
      );
    case "code":
      return (
        <pre class="overflow-x-auto rounded-md border border-status-info/20 bg-status-info/5 px-2 py-1.5 font-mono text-[11px] leading-snug [font-variant-ligatures:none]">
          {md.text}
        </pre>
      );
    case "list": {
      const items = md.items.map((item, i) => (
        <li key={String(i)} class="pl-0.5">
          {spans(item, resolve)}
        </li>
      ));
      const cls = `ml-4 space-y-0.5 leading-relaxed ${md.ordered ? "list-decimal" : "list-disc"} marker:text-muted-foreground`;
      return md.ordered ? <ol class={cls}>{items}</ol> : <ul class={cls}>{items}</ul>;
    }
    case "quote":
      return <blockquote class="border-l-2 pl-2.5 leading-relaxed text-muted-foreground italic">{spans(md.spans, resolve)}</blockquote>;
    case "table":
      return (
        <div class="overflow-x-auto">
          <table class="w-max border-collapse text-xs">
            <thead>
              <tr>
                {md.header.map((cell, i) => (
                  <th key={String(i)} class={`border px-2 py-1 font-semibold ${ALIGN.get(md.align[i] ?? "left") ?? "text-left"}`}>
                    {spans(cell, resolve)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {md.rows.map((row, r) => (
                <tr key={String(r)}>
                  {row.map((cell, c) => (
                    <td key={String(c)} class={`border px-2 py-1 align-top ${ALIGN.get(md.align[c] ?? "left") ?? "text-left"}`}>
                      {spans(cell, resolve)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr class="border-border" />;
    default:
      return <p class="leading-relaxed">{spans(md.spans, resolve)}</p>;
  }
}

export interface MarkdownPreviewProps {
  text: string;
  path: string;
  links?: FileLinks;
}

/**
 * LINKS ARE RELATIVE TO THE FILE. A web address opens in a new tab. A relative path opens that file
 * or folder in Files; a root-absolute one is read from the Files root, never the app's origin; a
 * `#fragment` scrolls to the heading with that anchor, in place. A link that climbs past the root, or
 * that no one gave a way to open, reads as its label. Raw HTML in the file is not markdown's to run:
 * the parser reads it as text.
 */
export function MarkdownPreview(handle: Handle<MarkdownPreviewProps>) {
  let root: HTMLDivElement | null = null;
  let parsedFor: string | null = null;
  let blocks: MdBlock[] = [];
  let anchors: (string | null)[] = [];
  const resolve: Resolve = (href) => {
    if (href.startsWith("#")) {
      return {
        href,
        onOpen: () => {
          const target = root === null ? null : anchorIn(root, href.slice(1));
          target?.scrollIntoView({ block: "start" });
        },
      };
    }
    const { links, path } = handle.props;
    const at = links === undefined ? null : resolveFileLink(href, path);
    if (links === undefined || at === null) return null;
    return { href: links.hrefFor(at), onOpen: () => links.onOpen(at) };
  };
  return () => {
    const { text } = handle.props;
    if (text !== parsedFor) {
      parsedFor = text;
      blocks = parseMarkdown(text);
      anchors = headingAnchors(blocks);
    }
    return (
      <div
        class="mx-auto w-full max-w-prose px-4 py-4"
        data-slot="file-markdown"
        mix={ref((node: HTMLDivElement) => {
          root = node;
        })}
      >
        <div class="font-content space-y-3 text-sm leading-relaxed break-words">
          {blocks.map((md, i) => (
            <div key={String(i)} class="contents">
              {block(md, anchors[i] ?? null, resolve)}
            </div>
          ))}
        </div>
      </div>
    );
  };
}

// ── JSON ───────────────────────────────────────────────────────────────────────────────────────

/** Containers this deep and deeper start folded; the first two levels start open. */
const OPEN_DEPTH = 2;

function leaf(value: JsonValue): RemixNode {
  const text = asJsonString(value);
  if (text !== undefined) return <span class="text-syntax-string wrap-anywhere">{JSON.stringify(text)}</span>;
  const flag = asJsonBoolean(value);
  if (flag !== undefined) return <span class="text-syntax-keyword">{String(flag)}</span>;
  if (value === null) return <span class="text-syntax-keyword">null</span>;
  return <span class="text-syntax-constant">{String(value)}</span>;
}

/** The rows of an array or an object, or null for a value that holds none (a leaf). */
function entriesOf(value: JsonValue): { rows: [string, JsonValue][]; isArray: boolean } | null {
  if (Array.isArray(value)) return { rows: value.map((v, i): [string, JsonValue] => [String(i), v]), isArray: true };
  const object = asJsonObject(value);
  if (object === undefined) return null;
  const rows: [string, JsonValue][] = [];
  for (const [k, v] of Object.entries(object)) if (v !== undefined) rows.push([k, v]);
  return { rows, isArray: false };
}

interface JsonNodeProps {
  name: string | null;
  value: JsonValue;
  depth: number;
}

function JsonNode(handle: Handle<JsonNodeProps>) {
  let open = handle.props.depth < OPEN_DEPTH;
  return () => {
    const { name, value, depth } = handle.props;
    const label = name === null ? null : <span class="text-syntax-property wrap-anywhere">{name}</span>;
    const held = entriesOf(value);
    if (held === null) {
      return (
        <div class="flex min-h-6 items-start gap-1.5 pl-5">
          {label}
          {label ? <span class="text-muted-foreground">:</span> : null}
          {leaf(value)}
        </div>
      );
    }
    const { rows, isArray } = held;
    const brackets = isArray ? "[]" : "{}";
    if (rows.length === 0) {
      return (
        <div class="flex min-h-6 items-start gap-1.5 pl-5">
          {label}
          {label ? <span class="text-muted-foreground">:</span> : null}
          <span class="text-muted-foreground">{brackets}</span>
          <span class="text-muted-foreground">{t("files.json.empty")}</span>
        </div>
      );
    }
    const count = isArray ? tn("files.json.items", rows.length) : tn("files.json.keys", rows.length);
    return (
      <div>
        <button
          type="button"
          aria-expanded={open ? "true" : "false"}
          mix={on("click", () => {
            open = !open;
            void handle.update();
          })}
          class="flex min-h-6 w-full items-start gap-1.5 text-left active:bg-muted/50"
        >
          <Icon icon={open ? ChevronDown : ChevronRight} class="mt-1 size-3.5 shrink-0 text-muted-foreground" />
          {label ?? <span class="text-muted-foreground">{brackets}</span>}
          {/* The count stays on the row open or folded, so folding repaints and moves nothing. */}
          <span class="text-muted-foreground">{count}</span>
        </button>
        {open ? (
          <div role="group" class="ml-2 border-l border-border pl-2">
            {rows.map(([key, child]) => (
              <JsonNode key={key} name={key} value={child} depth={depth + 1} />
            ))}
          </div>
        ) : null}
      </div>
    );
  };
}

export interface TextPreviewProps {
  text: string;
  path: string;
}

/**
 * A JSON file as a tree of folding nodes: the first two levels open, a count on every container. A
 * file that does not parse says why and shows its source; one with more than 5000 values shows its
 * source too, because a tree that size is slower than the file is long.
 */
export function JsonPreview(handle: Handle<TextPreviewProps>) {
  let parsedFor: string | null = null;
  let parsed = parseJsonTree("null");
  return () => {
    const { text, path } = handle.props;
    if (text !== parsedFor) {
      parsedFor = text;
      parsed = parseJsonTree(text);
    }
    if (parsed.kind === "ok") {
      return (
        <div class="px-4 py-3 font-mono text-xs leading-5 [font-variant-ligatures:none]" data-slot="file-json">
          <JsonNode name={null} value={parsed.value} depth={0} />
        </div>
      );
    }
    return (
      <>
        <p role="status" class="px-4 pt-3 pb-2 text-xs wrap-anywhere text-status-blocked">
          {parsed.kind === "error" ? t("files.json.error", { message: parsed.message }) : t("files.json.tooBig")}
        </p>
        <SourceView text={text} path={path} />
      </>
    );
  };
}

// ── HTML ───────────────────────────────────────────────────────────────────────────────────────

/**
 * An HTML file in a sandboxed frame. NEVER inserted into this page's DOM. `sandbox=""` is the empty
 * token list: no scripts, no forms, no popups, no top navigation and, because `allow-same-origin` is
 * absent, an opaque origin, so the file cannot read this app's storage or call its API. `srcdoc`
 * hands the frame its text without a request, and inherits the shell's Content-Security-Policy, which
 * keeps remote files off. The white ground is the page the file was written against.
 */
export function htmlPreview(text: string): RemixNode {
  return (
    <figure class="flex flex-col gap-2 px-4 py-3" data-slot="file-html">
      <iframe
        title={t("files.html.frameTitle")}
        sandbox=""
        srcdoc={unsafeHTML(text)}
        referrerpolicy="no-referrer"
        class="h-[60dvh] min-h-64 w-full border border-border bg-white"
      />
      <figcaption class="text-xs text-muted-foreground">{t("files.html.caption")}</figcaption>
    </figure>
  );
}

// ── One file ───────────────────────────────────────────────────────────────────────────────────

export interface FileContentProps {
  file: FileText;
  view: FileView;
  links?: FileLinks;
}

/**
 * What the file screen shows under its header. `view` is ignored for a type with no preview. A binary
 * file shows its size and nothing else; a read cut at the cap says so after the drawing.
 */
export function FileContent(handle: Handle<FileContentProps>) {
  return () => {
    const { file, view, links } = handle.props;
    if (file.binary) return quiet(t("files.binary", { size: formatBytes(file.size) }));
    if (file.text === "") return quiet(t("files.fileEmpty"));
    let kind: PreviewKind | null = view === "preview" ? previewKindFor(file.path) : null;
    // A Markdown file of more than 5000 lines is too much to parse and lay out as a page. It reads as
    // source, and the Source | Preview control stays, so the choice is still the reader's.
    if (kind === "markdown" && countLines(file.text) > RENDER_MAX_LINES) kind = null;
    return (
      <>
        {kind === "markdown" ? <MarkdownPreview text={file.text} path={file.path} links={links} /> : null}
        {kind === "json" ? <JsonPreview text={file.text} path={file.path} /> : null}
        {kind === "html" ? htmlPreview(file.text) : null}
        {kind === null ? <SourceView text={file.text} path={file.path} /> : null}
        {file.truncated ? note(t("files.fileTruncated")) : null}
      </>
    );
  };
}

