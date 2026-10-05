import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { MarkdownText } from "@/components/markdown-text";
import { TokenLine } from "@/components/changes-view";
import { useLocale } from "@/hooks/use-locale";
import { HIGHLIGHT_MAX_LINES, highlightFile, highlightFileNow, languageForPath, type RowTokens } from "@/lib/diff-highlight";
import { RENDER_MAX_LINES, formatBytes, previewKindFor, splitLines, type PreviewKind } from "@/lib/files-view";
import { t, tn } from "@/lib/i18n";
import { asJsonBoolean, asJsonObject, asJsonString, type JsonValue } from "@/lib/json";
import { parseJsonTree } from "@/lib/json-tree";
import type { FileRead } from "@/lib/types";

// What the Files view draws for ONE file (ADR 0083): the source as numbered, coloured lines, or a
// Preview of a Markdown, JSON or HTML file. Presentational only, so the route and the playground
// mount the same markup.
//
// THE FILE IS HOSTILE TEXT. It is whatever sits on the operator's disk: a README from a stranger's
// repo, a saved web page. So every drawing here puts the file's characters into the DOM as TEXT
// NODES, and none of them is ever parsed as markup by this app (no `dangerouslySetInnerHTML`, the
// repo's XSS boundary, CLAUDE.md "Security posture"). The one place a file's HTML is allowed to be
// HTML is `HtmlPreview`, and there it goes into a sandboxed frame that cannot run a script, submit a
// form, or reach this app.

export type FileText = Extract<FileRead, { available: true }>;
export type FileView = "source" | "preview";

/** Whether Source or Preview opens first: Preview, for every type that has one (spec 04, rule 4). */
export function defaultView(path: string): FileView {
  return previewKindFor(path) === null ? "source" : "preview";
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="px-6 py-16 text-center text-sm leading-relaxed text-muted-foreground">{children}</p>;
}

/** One quiet line under a drawing, for the bound a read hit. */
function Note({ children }: { children: React.ReactNode }) {
  return <p className="px-4 pt-3 text-xs text-muted-foreground">{children}</p>;
}

/** The number of lines in `text`, without building the array. */
function countLines(text: string): number {
  let n = 1;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) n++;
  return n;
}

// ── Source ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The lines' syntax tokens, once sugar-high has loaded, or null until then and for a file with no
 * known language or one past the cap. The first file of a language draws plain and takes colour when
 * the highlighter arrives; after that the colour is computed in the same render as the rows.
 */
function useFileTokens(lines: readonly string[], path: string): RowTokens | null {
  const lang = languageForPath(path);
  const colourable = lang !== null && lines.length <= HIGHLIGHT_MAX_LINES;
  const now = useMemo(() => (colourable && lang !== null ? highlightFileNow(lines, lang) : null), [colourable, lines, lang]);
  const [done, setDone] = useState<{ lines: readonly string[]; tokens: RowTokens } | null>(null);
  useEffect(() => {
    if (!colourable || lang === null || now !== null) return;
    let live = true;
    const colour = async () => {
      try {
        const tokens = await highlightFile(lines, lang);
        if (live) setDone({ lines, tokens });
      } catch {
        // No highlighter (offline, a stale chunk): the plain lines are the whole answer.
      }
    };
    void colour();
    return () => {
      live = false;
    };
  }, [colourable, now, lines, lang]);
  return now ?? (done?.lines === lines ? done.tokens : null);
}

/**
 * A file as monospace lines with one number gutter. Long lines WRAP, anywhere, so a minified file
 * cannot push the page wide. The gutter is sized once by the widest number, so no line's text starts
 * at a different x. Ligatures are off: source is read character by character.
 */
export function SourceView({ text, path }: { text: string; path: string }) {
  const lines = useMemo(() => splitLines(text), [text]);
  const syntax = useFileTokens(lines, path);
  const shown = lines.length > RENDER_MAX_LINES ? lines.slice(0, RENDER_MAX_LINES) : lines;
  const gutter = { width: `calc(${Math.max(String(shown.length).length, 2)}ch + 0.5rem)` };
  return (
    <div
      className="font-mono text-xs leading-5 [font-variant-ligatures:none]"
      data-slot="file-source"
      data-highlighted={syntax ? "" : undefined}
    >
      {shown.map((line, i) => (
        <div key={i} className="flex pl-1">
          <span aria-hidden className="shrink-0 select-none pr-2 text-right text-muted-foreground tabular-nums" style={gutter}>
            {i + 1}
          </span>
          <span className="min-w-0 flex-1 pr-3 wrap-anywhere whitespace-pre-wrap">
            {syntax?.[i] ? <TokenLine tokens={syntax[i]} /> : line}
          </span>
        </div>
      ))}
      {shown.length < lines.length && <Note>{t("files.linesCapped")}</Note>}
    </div>
  );
}

// ── Markdown ───────────────────────────────────────────────────────────────────────────────────

/**
 * The renderer the transcript uses, in a document's width and rhythm. Raw HTML in the file is not
 * markdown's to run: the parser reads it as text, so `<script>` shows as the characters it is.
 */
export function MarkdownPreview({ text }: { text: string }) {
  return (
    <div className="mx-auto w-full max-w-prose px-4 py-4" data-slot="file-markdown">
      <MarkdownText text={text} className="space-y-3 leading-relaxed" />
    </div>
  );
}

// ── JSON ───────────────────────────────────────────────────────────────────────────────────────

/** Containers this deep and deeper start folded; the first two levels start open. */
const OPEN_DEPTH = 2;

function Leaf({ value }: { value: JsonValue }) {
  const text = asJsonString(value);
  if (text !== undefined) return <span className="text-syntax-string wrap-anywhere">{JSON.stringify(text)}</span>;
  const flag = asJsonBoolean(value);
  if (flag !== undefined) return <span className="text-syntax-keyword">{String(flag)}</span>;
  if (value === null) return <span className="text-syntax-keyword">null</span>;
  return <span className="text-syntax-constant">{String(value)}</span>;
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

function JsonNode({ name, value, depth }: { name: string | null; value: JsonValue; depth: number }) {
  const [open, setOpen] = useState(depth < OPEN_DEPTH);
  const label = name === null ? null : <span className="text-syntax-property wrap-anywhere">{name}</span>;
  const held = entriesOf(value);
  if (held === null) {
    return (
      <div className="flex min-h-6 items-start gap-1.5 pl-5">
        {label}
        {label && <span className="text-muted-foreground">:</span>}
        <Leaf value={value} />
      </div>
    );
  }
  const { rows, isArray } = held;
  const brackets = isArray ? "[]" : "{}";
  if (rows.length === 0) {
    return (
      <div className="flex min-h-6 items-start gap-1.5 pl-5">
        {label}
        {label && <span className="text-muted-foreground">:</span>}
        <span className="text-muted-foreground">{brackets}</span>
        <span className="text-muted-foreground">{t("files.json.empty")}</span>
      </div>
    );
  }
  const count = isArray ? tn("files.json.items", rows.length) : tn("files.json.keys", rows.length);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-6 w-full items-start gap-1.5 text-left active:bg-muted/50"
      >
        <Chevron aria-hidden className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
        {label ?? <span className="text-muted-foreground">{brackets}</span>}
        {/* The count stays on the row open or folded, so folding repaints and moves nothing. */}
        <span className="text-muted-foreground">{count}</span>
      </button>
      {open && (
        <div role="group" className="ml-2 border-l border-border pl-2">
          {rows.map(([key, child]) => (
            <JsonNode key={key} name={key} value={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A JSON file as a tree of folding nodes: the first two levels open, a count on every container. A
 * file that does not parse says why and shows its source; one with more than 5000 values shows its
 * source too, because a tree that size is slower than the file is long.
 */
export function JsonPreview({ text, path }: { text: string; path: string }) {
  const parsed = useMemo(() => parseJsonTree(text), [text]);
  if (parsed.kind === "ok") {
    return (
      <div className="px-4 py-3 font-mono text-xs leading-5" data-slot="file-json">
        <JsonNode name={null} value={parsed.value} depth={0} />
      </div>
    );
  }
  return (
    <>
      <p role="status" className="px-4 pt-3 pb-2 text-xs text-status-blocked wrap-anywhere">
        {parsed.kind === "error" ? t("files.json.error", { message: parsed.message }) : t("files.json.tooBig")}
      </p>
      <SourceView text={text} path={path} />
    </>
  );
}

// ── HTML ───────────────────────────────────────────────────────────────────────────────────────

/**
 * An HTML file in a sandboxed frame. NEVER inserted into this page's DOM.
 *
 * `sandbox=""` is the empty token list: no scripts, no forms, no popups, no top navigation, and
 * (because `allow-same-origin` is absent) an opaque origin, so the file cannot read this app's
 * storage or call its API either. `srcDoc` hands the frame its text without a request. A srcdoc
 * document INHERITS the shell's Content-Security-Policy, which is what keeps remote files off:
 * `img-src 'self'` and the other `'self'` sources still apply, so a remote image, style, font or
 * navigation is refused. What a hostile file CAN still do is cause blind same-origin GET requests
 * (an `<img src="/api/...">` is allowed by `'self'`), but it cannot read an answer and it cannot run
 * script. The caption says so, because a blank space where an image would be reads
 * as a bug. The white ground is the page the file was written against; a transparent one would show
 * a dark theme through a document that assumed white.
 */
export function HtmlPreview({ text }: { text: string }) {
  return (
    <figure className="flex flex-col gap-2 px-4 py-3" data-slot="file-html">
      <iframe
        title={t("files.html.frameTitle")}
        sandbox=""
        srcDoc={text}
        referrerPolicy="no-referrer"
        className="h-[60dvh] min-h-64 w-full border border-border bg-white"
      />
      <figcaption className="text-xs text-muted-foreground">{t("files.html.caption")}</figcaption>
    </figure>
  );
}

// ── One file ───────────────────────────────────────────────────────────────────────────────────

/**
 * What the file screen shows under its header. `view` is ignored for a type with no preview. A binary
 * file shows its size and nothing else; a read cut at the cap says so after the drawing.
 */
export function FileContent({ file, view }: { file: FileText; view: FileView }) {
  useLocale();
  if (file.binary) return <Quiet>{t("files.binary", { size: formatBytes(file.size) })}</Quiet>;
  if (file.text === "") return <Quiet>{t("files.fileEmpty")}</Quiet>;
  let kind: PreviewKind | null = view === "preview" ? previewKindFor(file.path) : null;
  // A Markdown file of more than 5000 lines is too much to parse and lay out as a page. It reads as
  // source, and the Source | Preview control stays, so the choice is still the reader's.
  if (kind === "markdown" && countLines(file.text) > RENDER_MAX_LINES) kind = null;
  return (
    <>
      {kind === "markdown" && <MarkdownPreview text={file.text} />}
      {kind === "json" && <JsonPreview text={file.text} path={file.path} />}
      {kind === "html" && <HtmlPreview text={file.text} />}
      {kind === null && <SourceView text={file.text} path={file.path} />}
      {file.truncated && <Note>{t("files.fileTruncated")}</Note>}
    </>
  );
}

