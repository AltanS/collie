// The server half of S1 (`experiments/remix-v3/ACTION-PLAN.md` B): the bridge's document for `/` and
// `/pane/:paneId`, rendered on Bun from one request's snapshot.
//
// THE DOCUMENT is the built `web/dist/index.html`, head byte for byte (the bridge has already put
// its mount in, ADR 0052), with the body replaced by one `AppRoot` island and the `rmx-data` script
// Remix writes for it. `css()` rules the render collected go at the end of the head.
//
// NO REQUEST SEES ANOTHER'S DATA. The shell's stores are module singletons (lib/data.ts, prefs,
// polling), so a render primes them for its request and resets them all right after. That is only
// safe because the whole component tree, every setup and every render, runs inside ONE synchronous
// call: `renderToStream` builds its segments in the stream's `start`, before the first await
// (C/src/server/stream.ts). `render.test.tsx` pins that, and renders two snapshots back to back and
// interleaved to prove neither output carries the other's panes. While the tree builds,
// `onServer()` is true, and setup code that would register something past the request (a poll
// source, a listener on a module set) skips it.
//
// Bun, not the browser: this module and everything it imports must evaluate with no `document`,
// `window`, `localStorage` or `navigator` (REMIX3.md, "Server document").
import "./build-info";

import { renderToStream } from "remix/component/server";

import { internScope, scopeFromUrl, viewAllFromUrl } from "@web/lib/scope";

import { AppRoot, matchAppRoute, type AppRootProps } from "../app-root";
import { snapshotPath } from "../lib/api";
import { clock } from "../lib/clock";
import { config, noteAddress, snapshot, snapshotAt } from "../lib/data";
import { primePrefs } from "../lib/prefs";
import { withServerRender } from "../lib/server-render";
import { resetStores } from "../lib/store";

export interface DocumentInput {
  /** The page's absolute URL with the mount taken off (what the router matches). */
  url: URL;
  /** The mount the document is served under (`/` or `/collie/`). */
  base: string;
  snapshot: AppRootProps["snapshot"];
  /** When the snapshot was built, epoch ms. */
  snapshotAt: number;
  config: AppRootProps["config"];
  /** The device's prefs, as the `collie-prefs` cookie carries them; null when it sent none. */
  prefs: string | null;
  /** The render's clock, epoch ms. */
  now: number;
}

/** Prime every store the first render reads, for this request only. */
function prime(input: DocumentInput): void {
  noteAddress(input.url);
  snapshot.set({ data: input.snapshot, error: undefined, status: undefined });
  snapshotAt.set(input.snapshotAt);
  config.set({ data: input.config, error: undefined, status: undefined });
  clock.set(input.now);
  primePrefs(input.prefs);
}

/** Drain a byte stream to text. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream) out += decoder.decode(chunk, { stream: true });
  return out + decoder.decode();
}

/** Remix's stream markers (`<!-- rmx:flush ... -->`); a one-chunk body carries one. */
const FLUSH_MARKER = /<!-- rmx:flush [a-z]+ -->/g;

/**
 * The island's markup and its `rmx-data` script, plus the `<style>` tags of any `css()` rules the
 * render collected (a fragment render puts them in a leading `<head>`, trap 10.2 in note 08).
 */
export interface RenderedBody {
  head: string;
  body: string;
}

/**
 * Render the body for one request. The tree is built synchronously inside this call, with the
 * request's state primed and every store reset again before the call returns; the promise only
 * drains the bytes already built.
 */
export function renderAppBody(input: DocumentInput): Promise<RenderedBody> {
  const props: AppRootProps = {
    path: `${input.url.pathname}${input.url.search}`,
    origin: input.url.origin,
    snapshot: input.snapshot,
    snapshotAt: input.snapshotAt,
    config: input.config,
  };
  let errors: unknown[] = [];
  const stream = withServerRender(input.base, () => {
    resetStores();
    try {
      prime(input);
      return renderToStream(<AppRoot {...props} />, { onError: (error) => void errors.push(error) });
    } finally {
      resetStores();
    }
  });
  return drain(stream).then((html) => {
    if (errors.length > 0) throw errors[0];
    errors = [];
    return splitHead(html.replace(FLUSH_MARKER, ""));
  });
}

const LEADING_HEAD = /^<head>([\s\S]*?)<\/head>/;

function splitHead(html: string): RenderedBody {
  const head = LEADING_HEAD.exec(html);
  if (head === null) return { head: "", body: html };
  return { head: head[1] ?? "", body: html.slice(head[0].length) };
}

const BODY = /(<body[^>]*>)[\s\S]*(<\/body>)/;

/**
 * The served document: `indexHtml` (already mounted) with `rendered` spliced in. The head stays as
 * it is, plus the render's styles before `</head>`; the body's children are replaced, so the static
 * boot splash is not in a server document.
 */
export function spliceDocument(indexHtml: string, rendered: RenderedBody): string {
  if (!BODY.test(indexHtml)) throw new Error("ssr: index.html has no <body>");
  const withBody = indexHtml.replace(BODY, (_all, open: string, close: string) => `${open}${rendered.body}${close}`);
  if (rendered.head === "") return withBody;
  const at = withBody.indexOf("</head>");
  if (at === -1) throw new Error("ssr: index.html has no </head>");
  return `${withBody.slice(0, at)}${rendered.head}${withBody.slice(at)}`;
}

/** The whole server document for one request. */
export async function renderAppDocument(indexHtml: string, input: DocumentInput): Promise<string> {
  return spliceDocument(indexHtml, await renderAppBody(input));
}

/** Whether `url` (mount off) is a route the bridge renders a document for: `/` and `/pane/:paneId`. */
export function isDocumentRoute(url: URL): boolean {
  return matchAppRoute(url) !== null;
}

/**
 * The `/api/snapshot` path (query included) the page at `url` would poll: its `?h=`/`?s=` scope and
 * its `?all=1` breadth, through the poll's own builder, so the document renders the body the first
 * poll reads.
 */
export function snapshotApiPath(url: URL): string {
  return snapshotPath(internScope(scopeFromUrl(url.href)), viewAllFromUrl(url.href));
}

/**
 * Whether this module was compiled with Remix's JSX. Bun's bundler compiles it under
 * web-remix/tsconfig.json (`jsxImportSource: "remix/component"`); Bun's runtime, run from the repo
 * root, takes the root tsconfig and would hand back React elements, which the renderer cannot draw.
 * The bridge asks before it serves a document (bridge/http/controllers/document.ts).
 */
export function rendersRemixJsx(): boolean {
  const probe: unknown = <i />;
  return probe instanceof Object && "$rmx" in probe;
}
