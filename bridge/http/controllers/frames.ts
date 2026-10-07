// The pane's server frames (S2 of the Remix 3 plan, `experiments/remix-v3/ACTION-PLAN.md` B): a GET
// on `/pane/:paneId` that carries `X-Remix-Frame: true` and `X-Remix-Target: pane-screen|pane-status`
// is answered with that frame's rows as an HTML fragment, not with the document. The shell's
// `routes/pane/frames.ts` says what the frames are and how a poll answer is laid out.
//
// THE SAME READ AS THE JSON ROUTE, NO HOP. The pane is read through the pane route's own body
// (`browserPaneRead`, ./pane.ts): the read gate, the seen mark (`x-collie-seen`), the attention stamp
// and the crew forward to the machine that owns the pane, exactly as for `GET /api/pane/:id`. Its
// ETag is the answer's ETag, and an `If-None-Match` that matches it is a 304 before anything renders.
// A refusal (403, 404, 502...) keeps its status and goes out as plain text.
//
// ONE URL, TWO ANSWERS. The document (./document.ts) and the frames share `/pane/:paneId`, so every
// answer here, and the document, says `Vary: X-Remix-Frame, X-Remix-Target, X-Collie-Poll`, and none
// is stored (`no-store`). A frame request NEVER falls through to the document or the static shell:
// a page diffed into a frame would nest the app inside itself (research note 08, 4.2).
//
// OURS OR NOT. Every answer the frame route gives about a pane carries `X-Collie-Frame`. When it
// cannot render at all (no renderer compiled in, an unknown frame name) it answers without that
// header, and the browser reads the pane as JSON for the rest of the page's life
// (web-remix/src/routes/pane/pane-frames.ts, NOT OURS).
//
// The fragments are the shell's own components rendered on Bun (web-remix/src/ssr/frames.tsx), pure
// functions of the read, so the last few are kept by ETag: two phones on one pane render once.

import type { BridgeHttp } from "../deps.ts";
import { BUILD_HEADER } from "../../server.ts";
import { secure } from "../middleware/secure.ts";
import { browserPaneRead } from "./pane.ts";

/** The frame names this route serves (web-remix/src/routes/pane/frames.ts). */
type PaneFrameName = "pane-screen" | "pane-status";

/** A pane read as the JSON route returns it. */
interface PaneRead {
  text: string;
  logicalText?: string;
}

/** What this route uses of the shell's renderer (web-remix/src/ssr/render.tsx). */
export interface FrameRenderer {
  isPaneFrameName(name: string | null | undefined): name is PaneFrameName;
  pollTargets(header: string | null): PaneFrameName[];
  paneReadApiPath(url: URL, paneId: string): string;
  renderPaneFrames(
    input: { text: string; logicalText?: string; agent: string | undefined },
    targets: readonly PaneFrameName[],
  ): Promise<Partial<Record<PaneFrameName, string>>>;
  pollAnswer(read: PaneRead, frames: Partial<Record<PaneFrameName, string>>): string;
}

/** What {@link serveFrame} reads. A narrow seam, so a test needs no `startServer`. */
export interface FrameDeps {
  renderer(): Promise<FrameRenderer | null>;
  /** The pane route's own GET of `/api/pane/:paneId` (`browserPaneRead`). */
  paneRead(req: Request, apiUrl: URL, rawPaneId: string): Promise<Response>;
  buildId(): Promise<string>;
}

/** The request headers that pick a frame, and the one that asks for a poll answer. */
const FRAME_HEADER = "x-remix-frame";
const TARGET_HEADER = "x-remix-target";
const POLL_HEADER = "x-collie-poll";
/** On every answer about a pane: proof to the browser that this is the frame route's own. */
export const FRAME_ANSWER_HEADER = "x-collie-frame";
/** Every answer on `/pane/:paneId`, document included, depends on these request headers. */
export const FRAME_VARY = "X-Remix-Frame, X-Remix-Target, X-Collie-Poll";
/** Below this many bytes a fragment goes out raw. */
const GZIP_MIN_BYTES = 1024;
/** Rendered fragments kept by ETag, agent and frames. */
const RENDERED_MAX = 8;

/** True when `req` asks for a named frame (Remix's top-frame navigations carry no target). */
export function isFrameRequest(req: Request): boolean {
  return req.headers.get(FRAME_HEADER) === "true" && req.headers.get(TARGET_HEADER) !== null;
}

function frameHeaders(target: string | null, build: string, extra: Record<string, string> = {}): Headers {
  const headers = new Headers({ "cache-control": "private, no-store", vary: FRAME_VARY, [BUILD_HEADER]: build, ...extra });
  if (target !== null) headers.set(FRAME_ANSWER_HEADER, target);
  return headers;
}

/** A refusal: plain text, our header only when it is a statement about the pane. */
function refuse(status: number, body: string, target: string | null, build: string): Response {
  return secure(new Response(body, { status, headers: frameHeaders(target, build, { "content-type": "text/plain; charset=utf-8" }) }));
}

const rendered = new Map<string, Partial<Record<PaneFrameName, string>>>();

function remember(key: string, frames: Partial<Record<PaneFrameName, string>>): void {
  rendered.delete(key);
  rendered.set(key, frames);
  if (rendered.size > RENDERED_MAX) {
    const oldest = rendered.keys().next().value;
    if (oldest !== undefined) rendered.delete(oldest);
  }
}

/** The JSON body of an in-process response, gunzipped if the read was compressed after all. */
async function bodyText(res: Response): Promise<string> {
  if (res.headers.get("content-encoding") === "gzip") return new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await res.arrayBuffer())));
  return res.text();
}

/**
 * The frame answer for `req` at `url` (the routed URL, mount already off), or null when `req` is not a
 * named-frame request (the document and the static shell answer it then).
 */
export async function serveFrame(deps: FrameDeps, req: Request, url: URL): Promise<Response | null> {
  if (!isFrameRequest(req)) return null;
  const target = req.headers.get(TARGET_HEADER);
  const build = await deps.buildId();
  const match = /^\/pane\/([^/]+)\/?$/.exec(url.pathname);
  const renderer = await deps.renderer();
  // Not a frame this collie can draw: no header, so the browser stops asking (file header).
  if (match === null || renderer === null || !renderer.isPaneFrameName(target)) return refuse(404, "no such frame", null, build);
  if (req.method !== "GET" && req.method !== "HEAD") return refuse(405, "method not allowed", target, build);
  const rawPaneId = match[1] ?? "";
  let paneId: string;
  try {
    paneId = decodeURIComponent(rawPaneId);
  } catch {
    return refuse(400, "malformed URL", target, build);
  }
  const poll = req.headers.get(POLL_HEADER);
  const asked = renderer.pollTargets(poll);
  const targets: readonly PaneFrameName[] = poll === null || asked.length === 0 ? [target] : asked;

  // The pane read, as the browser's JSON poll would ask for it: same headers (the gate reads Host,
  // Origin and the identity headers; the seen mark reads `x-collie-seen`; the ETag is forwarded), no
  // frame headers, and no compression, since this body is read here and not sent.
  const apiUrl = new URL(renderer.paneReadApiPath(url, paneId), url);
  const headers = new Headers(req.headers);
  for (const name of [FRAME_HEADER, TARGET_HEADER, POLL_HEADER, "accept-encoding", "accept"]) headers.delete(name);
  const read = await deps.paneRead(new Request(apiUrl, { method: "GET", headers, signal: req.signal }), apiUrl, rawPaneId);
  const etag = read.headers.get("etag");
  if (read.status === 304) {
    return secure(new Response(null, { status: 304, headers: frameHeaders(target, build, etag === null ? {} : { etag }) }));
  }
  if (read.status !== 200) return refuse(read.status, await bodyText(read), target, build);

  let body: PaneRead;
  try {
    // SAFETY: a 200 from the pane route is its own `PaneReadResponse` (bridge/server.ts `readPane`),
    // or a crew member's answer to the same route; a body that does not parse is caught here.
    body = JSON.parse(await bodyText(read)) as PaneRead;
  } catch {
    return refuse(502, "unreadable pane read", target, build);
  }
  const agent = url.searchParams.get("agent") || undefined;
  const key = `${etag ?? ""}\u0000${agent ?? ""}\u0000${targets.join(",")}`;
  let frames = etag === null ? undefined : rendered.get(key);
  if (frames === undefined) {
    frames = await renderer.renderPaneFrames({ text: body.text, logicalText: body.logicalText, agent }, targets);
    if (etag !== null) remember(key, frames);
  }
  const html = poll === null ? (frames[target] ?? "") : renderer.pollAnswer(body, frames);

  const out = frameHeaders(target, build, { "content-type": "text/html; charset=utf-8" });
  if (etag !== null) out.set("etag", etag);
  let bytes = new TextEncoder().encode(html);
  if (bytes.byteLength >= GZIP_MIN_BYTES && /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "")) {
    bytes = Bun.gzipSync(bytes);
    out.set("content-encoding", "gzip");
    out.set("vary", `${FRAME_VARY}, Accept-Encoding`);
  }
  out.set("content-length", String(bytes.byteLength));
  return secure(new Response(req.method === "HEAD" ? null : bytes, { headers: out }));
}

/** The bridge's own wiring of {@link FrameDeps}. */
export function frameDeps(deps: BridgeHttp, renderer: () => Promise<FrameRenderer | null>, buildId: () => Promise<string>): FrameDeps {
  return {
    renderer,
    paneRead: (req, apiUrl, rawPaneId) => browserPaneRead(deps, req, apiUrl, rawPaneId),
    buildId,
  };
}
