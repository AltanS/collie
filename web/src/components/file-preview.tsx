import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";

import { MarkdownText, type ImageResolver, type LinkResolver } from "@/components/markdown-text";
import { TokenLine } from "@/components/changes-view";
import { ImageFrame } from "@/components/ui/image-frame";
import { useLocale } from "@/hooks/use-locale";
import type { FileImageAnswer } from "@/lib/api";
import { fileVersionOf, type ImageVersion } from "@/lib/file-image-cache";
import { HIGHLIGHT_MAX_LINES, highlightFile, highlightFileNow, languageForPath, type RowTokens } from "@/lib/diff-highlight";
import { resolveFileLink, resolveImageSrc } from "@/lib/files-link";
import {
  RENDER_MAX_LINES,
  baseName,
  formatBytes,
  imageCaption,
  isRasterImagePath,
  previewKindFor,
  splitLines,
  type PreviewKind,
} from "@/lib/files-view";
import { t, tn } from "@/lib/i18n";
import { asJsonBoolean, asJsonObject, asJsonString, type JsonValue } from "@/lib/json";
import { parseJsonTree } from "@/lib/json-tree";
import { cn } from "@/lib/utils";
import type { FilesAt } from "@/lib/nav";
import type { FileRead } from "@/lib/types";

// What the Files view draws for ONE file (ADR 0083): the source as numbered, coloured lines, or a
// Preview of a Markdown, JSON, HTML or SVG file, or a picture (ADR 0090). Presentational only, so the
// route and the playground mount the same markup; the bytes of a picture come through a loader the
// caller hands in ({@link FileImages}).
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

/** The quiet line a screen shows while a file or a picture is on its way. */
export function FilesLoading() {
  useLocale();
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {t("files.loading")}
    </div>
  );
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
 *
 * `line` is the 1-based line a printed path named (`src/a.ts:12`, ADR 0088). That row wears the
 * "this is the current one" ground (`bg-accent`, the switchers' token) and is brought to the middle
 * of the screen once, when it first draws, so the sticky file bar never covers it. The ground is
 * paint only, so no row moves (DESIGN.md §2). A line past the end, or past the render cap, is no line.
 */
export function SourceView({ text, path, line }: { text: string; path: string; line?: number }) {
  const lines = useMemo(() => splitLines(text), [text]);
  const syntax = useFileTokens(lines, path);
  const shown = lines.length > RENDER_MAX_LINES ? lines.slice(0, RENDER_MAX_LINES) : lines;
  const gutter = { width: `calc(${Math.max(String(shown.length).length, 2)}ch + 0.5rem)` };
  const target = line !== undefined && line >= 1 && line <= shown.length ? line - 1 : -1;
  const targetRow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (target !== -1) targetRow.current?.scrollIntoView({ block: "center" });
  }, [target, path]);
  return (
    <div
      className="font-mono text-xs leading-5 [font-variant-ligatures:none]"
      data-slot="file-source"
      data-highlighted={syntax ? "" : undefined}
    >
      {shown.map((row, i) => (
        <div
          key={i}
          ref={i === target ? targetRow : undefined}
          aria-current={i === target ? "location" : undefined}
          className={cn("flex pl-1", i === target && "bg-accent")}
        >
          <span aria-hidden className="shrink-0 select-none pr-2 text-right text-muted-foreground tabular-nums" style={gutter}>
            {i + 1}
          </span>
          <span className="min-w-0 flex-1 pr-3 wrap-anywhere whitespace-pre-wrap">
            {syntax?.[i] ? <TokenLine tokens={syntax[i]} /> : row}
          </span>
        </div>
      ))}
      {shown.length < lines.length && <Note>{t("files.linesCapped")}</Note>}
    </div>
  );
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

/**
 * The renderer the transcript uses, in a document's width and rhythm. Raw HTML in the file is not
 * markdown's to run: the parser reads it as text, so `<script>` shows as the characters it is.
 *
 * LINKS ARE RELATIVE TO THE FILE. A web address opens in a new tab as it does in the transcript. A
 * relative path opens that file or folder in Files; a root-absolute one is read from the Files root,
 * never the app's origin; a `#fragment` scrolls to the heading with that anchor, in place, and does
 * nothing when there is none. A link that climbs past the root, or that no one gave a way to open,
 * reads as its label.
 */
export function MarkdownPreview({
  text,
  path,
  links,
  images,
  version = null,
}: {
  text: string;
  path: string;
  links?: FileLinks;
  images?: FileImages;
  /** The Markdown file's own version (size and mtime), which its pictures are held under. */
  version?: string | null;
}) {
  const root = useRef<HTMLDivElement>(null);
  const resolve = useCallback<LinkResolver>(
    (href) => {
      if (href.startsWith("#")) {
        return {
          kind: "local",
          href,
          onOpen: () => {
            const target = root.current === null ? null : anchorIn(root.current, href.slice(1));
            target?.scrollIntoView({ block: "start" });
          },
        };
      }
      const at = links === undefined ? null : resolveFileLink(href, path);
      if (links === undefined || at === null) return { kind: "text" };
      return { kind: "local", href: links.hrefFor(at), onOpen: () => links.onOpen(at) };
    },
    [links, path],
  );
  // An image the file names by a relative path is drawn from the root through the same reads as the
  // Files view's own (ADR 0090); anything else, a remote picture first of all, stays its alt text.
  const drawImage = useCallback<ImageResolver>(
    (src, alt) => {
      if (images === undefined) return null;
      const at = resolveImageSrc(src, path);
      if (at === null) return null;
      const kind = previewKindFor(at) === "svg" ? "svg" : isRasterImagePath(at) ? "raster" : null;
      if (kind === null) return null;
      // A Markdown picture has no read answer of its own to take a version from, so it is held under
      // the Markdown file's: a changed file, or a refresh, asks for its pictures again.
      return <MarkdownImage path={at} kind={kind} alt={alt} images={images} tag={version === null ? null : `${path}@${version}`} />;
    },
    [images, path, version],
  );
  return (
    <div ref={root} className="mx-auto w-full max-w-prose px-4 py-4" data-slot="file-markdown">
      <MarkdownText
        text={text}
        className="space-y-3 leading-relaxed"
        resolveLink={resolve}
        resolveImage={images === undefined ? undefined : drawImage}
        headingIds
        variant="document"
      />
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
      <div className="px-4 py-3 font-mono text-xs leading-5 [font-variant-ligatures:none]" data-slot="file-json">
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

// ── Pictures (ADR 0090) ────────────────────────────────────────────────────────────────────────

/**
 * Where a picture's bytes come from. The route builds it from the screen's pane or workspace and its
 * scope, so a picture on a crew member is read off that member's disk like its text. `bytes` asks the
 * bridge's image read (a raster picture, typed by its bytes); `text` asks the ordinary text read and
 * answers null for a file that is not whole text (an SVG drawn inside a Markdown file). Both may be
 * asked again for the same path: a file's bytes change under one name, so the screen keeps none of
 * them itself. `bytes` is given the file's version (null when it has none) and may hold the answer in
 * memory under it (lib/file-image-cache.ts); the object URLs stay per view either way.
 */
export interface FileImages {
  bytes(path: string, signal: AbortSignal, version: ImageVersion | null): Promise<FileImageAnswer>;
  text(path: string, signal: AbortSignal): Promise<string | null>;
}

/**
 * An object URL for `blob` while the component shows it, and null before. The URL is made in an
 * effect and REVOKED by that effect's cleanup, on unmount and whenever the blob changes, so a phone
 * that pages through a folder of pictures holds the bytes of the one on screen and no more.
 */
function useObjectUrl(blob: Blob | null): string | null {
  const [made, setMade] = useState<{ blob: Blob; url: string } | null>(null);
  useEffect(() => {
    if (blob === null) return;
    const url = URL.createObjectURL(blob);
    setMade({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  // A URL made for an earlier blob is revoked already, and says nothing about this one.
  return made !== null && made.blob === blob ? made.url : null;
}

/** The natural size of a drawn picture, kept per URL so a new picture starts without one. */
function useNaturalSize(url: string) {
  const [size, setSize] = useState<{ url: string; width: number; height: number } | null>(null);
  const [broken, setBroken] = useState<string | null>(null);
  const onLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      setSize({ url, width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight });
    },
    [url],
  );
  const onError = useCallback(() => setBroken(url), [url]);
  const known = size !== null && size.url === url ? size : null;
  return { width: known?.width, height: known?.height, broken: broken === url, onLoad, onError };
}

/** Why a picture is not drawn, as the line under the binary file's size says it. */
type ImageMiss = "too-large" | "not-image" | "failed" | "undrawable";

const IMAGE_MISS_KEY = {
  "too-large": "files.image.tooLarge",
  "not-image": "files.image.notImage",
  failed: "files.image.failed",
  undrawable: "files.image.undrawable",
} as const;

/** The binary line a picture falls back to, with the reason it was not drawn. */
function ImageMissed({ file, why }: { file: FileText; why: ImageMiss }) {
  return (
    <Quiet>
      {t("files.binary", { size: formatBytes(file.size) })}
      <span className="mt-1 block text-xs">{t(IMAGE_MISS_KEY[why])}</span>
    </Quiet>
  );
}

/** One picture on its board, with its caption, in the file screen's column. */
function PictureView({ file, url, type }: { file: FileText; url: string; type: string }) {
  const natural = useNaturalSize(url);
  if (natural.broken) return <ImageMissed file={file} why="undrawable" />;
  return (
    <div className="px-4 py-3" data-slot="file-image">
      <ImageFrame
        src={url}
        alt={baseName(file.path)}
        caption={imageCaption({ width: natural.width, height: natural.height, size: file.size, type })}
        onLoad={natural.onLoad}
        onError={natural.onError}
      />
    </div>
  );
}

type ImageLoad = { file: FileText; blob: Blob; type: string } | { file: FileText; miss: ImageMiss };

/**
 * A raster picture the text read called binary: its bytes from the bridge's image read, drawn from an
 * object URL that is revoked when the file changes or the screen goes. A refusal (413, 415), a failed
 * read, or bytes this browser cannot draw fall back to the binary line with the reason. `file` is the
 * text read's answer, so a refresh of the screen, which reads the file again, asks for the bytes again.
 */
function ImagePreview({ file, images }: { file: FileText; images: FileImages }) {
  const [load, setLoad] = useState<ImageLoad | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    const fetchIt = async (): Promise<void> => {
      try {
        const tag = fileVersionOf(file.size, file.mtimeMs);
        const answer = await images.bytes(file.path, abort.signal, tag === null ? null : { tag, own: true });
        if (abort.signal.aborted) return;
        setLoad(answer.outcome === "image" ? { file, blob: answer.blob, type: answer.blob.type } : { file, miss: answer.outcome });
      } catch {
        if (!abort.signal.aborted) setLoad({ file, miss: "failed" });
      }
    };
    void fetchIt();
    return () => abort.abort();
  }, [file, images]);
  // An answer for an earlier read of this screen says nothing about this one.
  const now = load !== null && load.file === file ? load : null;
  const url = useObjectUrl(now !== null && "blob" in now ? now.blob : null);
  if (now !== null && "miss" in now) return <ImageMissed file={file} why={now.miss} />;
  if (now === null || url === null) return <FilesLoading />;
  return <PictureView file={file} url={url} type={now.type} />;
}

/**
 * An SVG file drawn as a picture: its text, which the text read already holds, as a Blob typed
 * `image/svg+xml` behind an object URL, in an `<img>`. An SVG inside `<img>` runs no script and loads
 * nothing, so a hostile file can draw and do nothing else; it is never put into this page's DOM.
 */
export function SvgPreview({ file }: { file: FileText }) {
  const blob = useMemo(() => new Blob([file.text], { type: "image/svg+xml" }), [file.text]);
  const url = useObjectUrl(blob);
  if (url === null) return <FilesLoading />;
  return <PictureView file={file} url={url} type="image/svg+xml" />;
}

/**
 * One image of a Markdown file, from the root (ADR 0090). Its alt text stands in while it loads and
 * stays when it cannot load, which is how every image in a Markdown preview read before.
 */
function MarkdownImage({
  path,
  kind,
  alt,
  images,
  tag,
}: {
  path: string;
  kind: "raster" | "svg";
  alt: string;
  images: FileImages;
  /** The Markdown file's version the picture is held under, or null for no holding. */
  tag: string | null;
}) {
  const [loaded, setLoaded] = useState<{ path: string; blob: Blob } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    const fetchIt = async (): Promise<void> => {
      try {
        let blob: Blob | null = null;
        if (kind === "svg") {
          const text = await images.text(path, abort.signal);
          if (text !== null) blob = new Blob([text], { type: "image/svg+xml" });
        } else {
          const answer = await images.bytes(path, abort.signal, tag === null ? null : { tag, own: false });
          if (answer.outcome === "image") blob = answer.blob;
        }
        if (!abort.signal.aborted && blob !== null) setLoaded({ path, blob });
      } catch {
        // The alt text is the answer.
      }
    };
    void fetchIt();
    return () => abort.abort();
  }, [path, kind, images, tag]);
  const url = useObjectUrl(loaded !== null && loaded.path === path ? loaded.blob : null);
  const [broken, setBroken] = useState<string | null>(null);
  if (url === null || broken === url) return <>{alt}</>;
  return <img src={url} alt={alt} onError={() => setBroken(url)} className="inline-block h-auto max-w-full" />;
}

// ── One file ───────────────────────────────────────────────────────────────────────────────────

/**
 * What the file screen shows under its header. `view` is ignored for a type with no preview. A binary
 * file shows its size and nothing else, unless its name says it is a picture and `images` can fetch
 * it: then it is drawn, whatever `view` says, since a picture has no Source (ADR 0090). A read cut at
 * the cap says so after the drawing. `line` marks one line of the Source (see `SourceView`); a
 * Preview has no lines, and ignores it.
 */
export function FileContent({
  file,
  view,
  links,
  images,
  line,
}: {
  file: FileText;
  view: FileView;
  links?: FileLinks;
  images?: FileImages;
  line?: number;
}) {
  useLocale();
  if (file.binary) {
    if (images !== undefined && isRasterImagePath(file.path)) return <ImagePreview file={file} images={images} />;
    return <Quiet>{t("files.binary", { size: formatBytes(file.size) })}</Quiet>;
  }
  if (file.text === "") return <Quiet>{t("files.fileEmpty")}</Quiet>;
  let kind: PreviewKind | null = view === "preview" ? previewKindFor(file.path) : null;
  // A Markdown file of more than 5000 lines is too much to parse and lay out as a page. It reads as
  // source, and the Source | Preview control stays, so the choice is still the reader's.
  if (kind === "markdown" && countLines(file.text) > RENDER_MAX_LINES) kind = null;
  return (
    <>
      {kind === "markdown" && <MarkdownPreview text={file.text} path={file.path} links={links} images={images} version={fileVersionOf(file.size, file.mtimeMs)} />}
      {kind === "json" && <JsonPreview text={file.text} path={file.path} />}
      {kind === "html" && <HtmlPreview text={file.text} />}
      {kind === "svg" && <SvgPreview file={file} />}
      {kind === null && <SourceView text={file.text} path={file.path} line={line} />}
      {file.truncated && <Note>{t("files.fileTruncated")}</Note>}
    </>
  );
}

