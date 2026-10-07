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
// THE PANE'S FRAMES (S2). A pane document carries the pane read the bridge took for it (`input.pane`),
// and the Terminal draws its rows and the statusline's as `<Frame>`s (routes/pane/frames.ts). Frames
// here have no fallback, so they are blocking: `renderToStream` asks `resolveFrame` for each while it
// builds, and this module answers with the rows drawn from that same read (ssr/frames.tsx), inline and
// in full, with no request of any kind. Only the browser's reloads reach the bridge's frame route.
//
// Bun, not the browser: this module and everything it imports must evaluate with no `document`,
// `window`, `localStorage` or `navigator` (REMIX3.md, "Server document").
import "./build-info";

import { renderToStream } from "remix/component/server";

import { internScope, paneScopeKey, scopeFromUrl, viewAllFromUrl } from "@web/lib/scope";
import type { PaneReadResponse } from "@web/lib/types";

import { AppRoot, matchAppRoute, type AppRootProps } from "../app-root";
import { snapshotPath } from "../lib/api";
import { clock } from "../lib/clock";
import { address, config, noteAddress, paneStore, snapshot, snapshotAt } from "../lib/data";
import { applyFramesParam, paneFrames, primePrefs } from "../lib/prefs";
import { isPaneFrameName, paneFrameParams } from "../routes/pane/frames";
import { PANE_LINES } from "../routes/pane/data";
import { paneFrameNodes } from "./frames";
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
  /** For a pane document: the pane read the bridge took for it (S2), and its ETag. */
  pane?: { read: PaneReadResponse; etag: string | null };
}

/** Prime every store the first render reads, for this request only. */
function prime(input: DocumentInput): void {
  noteAddress(input.url);
  snapshot.set({ data: input.snapshot, error: undefined, status: undefined });
  snapshotAt.set(input.snapshotAt);
  config.set({ data: input.config, error: undefined, status: undefined });
  clock.set(input.now);
  primePrefs(input.prefs);
  applyFramesParam(input.url, true);
  const route = matchAppRoute(input.url);
  if (route?.kind === "pane" && input.pane !== undefined) {
    paneStore(paneScopeKey(address.get().scope, route.paneId)).set({ data: input.pane.read, error: undefined, status: undefined });
  }
}

/**
 * The rows of a pane frame the document draws (see the file header), built synchronously from the
 * request's read while the tree builds: `renderToStream` builds its segments before its first await.
 */
function resolveFrame(input: DocumentInput): (src: string, target?: string) => ReadableStream<Uint8Array> | string {
  return (src, target) => {
    if (input.pane === undefined || !isPaneFrameName(target)) return "";
    const { agent } = paneFrameParams(new URL(src, input.url));
    const nodes = paneFrameNodes({ text: input.pane.read.text, logicalText: input.pane.read.logicalText, agent });
    return renderToStream(nodes[target]);
  };
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
      // The mode this document draws the pane in, from the cookie's prefs and `?frames=`: the browser
      // hydrates in the same mode for this page, whatever its own storage says (main.tsx).
      if (input.pane !== undefined) props.pane = { ...input.pane, frames: paneFrames.get() };
      return renderToStream(<AppRoot {...props} />, { onError: (error) => void errors.push(error), resolveFrame: resolveFrame(input) });
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

/**
 * The `/api/pane/:id` path (query included) a frame request at `url` reads: the frame's `lines` and
 * its page's `?h=`/`?s=` scope, in the API's long names. The bridge reads the pane through its own pane
 * route with this (bridge/http/controllers/frames.ts).
 */
export function paneReadApiPath(url: URL, paneId: string): string {
  const { lines } = paneFrameParams(url);
  const scope = internScope(scopeFromUrl(url.href));
  const query = new URLSearchParams();
  if (lines !== undefined) query.set("lines", String(lines));
  if (scope.host) query.set("host", scope.host);
  if (scope.session) query.set("session", scope.session);
  const search = query.toString();
  return `/api/pane/${encodeURIComponent(paneId)}${search === "" ? "" : `?${search}`}`;
}

export { renderPaneFrames } from "./frames";
export { pollAnswer, pollTargets, isPaneFrameName, FRAME_ANSWER_HEADER, POLL_HEADER } from "../routes/pane/frames";

/**
 * The `/api/pane/:id` path a pane document at `url` reads (S2): the shell's poll window and the page's
 * scope, so the read the frames are drawn from is the one the first beat asks again with its ETag.
 * Null for any other page.
 */
export function documentPaneReadPath(url: URL): string | null {
  const route = matchAppRoute(url);
  if (route?.kind !== "pane") return null;
  const withLines = new URL(url);
  withLines.searchParams.set("lines", String(PANE_LINES));
  return paneReadApiPath(withLines, route.paneId);
}
