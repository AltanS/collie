// THE ISLANDS DOCUMENT (S3): `/` and `/pane/:paneId` as server HTML with islands (ssr/islands-layout.tsx),
// and the snapshot frames' answer (islands/snapshot-wire.ts). Rendered on Bun with the same rules as the
// S1 document (ssr/render.tsx): one request's stores primed, the whole tree built inside one synchronous
// call, every store reset before the call returns.
//
// WHICH DOCUMENT. The islands document draws the dashboard's Dashboard view and a pane's Terminal with
// the pane frames on. Anything else gets the S1/S2 document (one `AppRoot` island, the static shell's
// code): the switch is off (`collie:islands:v1`, `?islands=0`), the Crew or Files view, a pane whose
// Chat would show (the device chose Chat and the pane has a journal to read), or the frames off.
// The bridge marks an islands document with `X-Collie-Document: islands`; the resolver refuses anything
// without it (islands/resolver.ts), so a soft navigation onto a page drawn the other way becomes a
// document load.
//
// THE DATA BLOCK. The snapshot, the config, the pane read and the hashes of the snapshot frames go in one
// `<script type="application/json" id="collie-boot">` (islands/document-data.ts), never in island props.
import { renderToStream } from "remix/component/server";

import { isMultiHost } from "@web/lib/hosts";

import { withIslandsHtml } from "../lib/acts";
import { matchAppRoute } from "../lib/app-route";
import { snapshot } from "../lib/data";
import { dashPrefs, islandsPref, applyIslandsParam } from "../lib/prefs";
import { withServerRender } from "../lib/server-render";
import { resetStores } from "../lib/store";
import { href } from "../routes";
import { findPane } from "../routes/pane/data";
import { isPaneFrameName } from "../routes/pane/frames";
import { BOOT_SCRIPT_ID, documentDataScript, type DocumentData } from "../islands/document-data";
import { islandModule, ISLAND_SOURCES } from "../islands/ids";
import { decodeRanks, frameHash, isSnapshotFrameName, snapshotAnswer, type SnapshotFrameName, type SnapshotFramePart } from "../islands/snapshot-wire";
import { paneDrawsIslands } from "./islands-eligible";
import { homeListContent, IslandsLayout, paneHeadContent, type IslandsPage } from "./islands-layout";
import { drain, FLUSH_MARKER, prime, resolveFrame as paneFrameResolver, splitHead, spliceDocument, type DocumentInput } from "./render";

export interface IslandsDocumentInput extends DocumentInput {
  /** Each island module's chunk and its imports, mounted (the bridge reads Vite's manifest). */
  preloads?: Readonly<Record<string, readonly string[]>>;
}

export interface RenderedDocument {
  html: string;
  /** True for an islands document (the bridge marks it). */
  islands: boolean;
}

/** The page this request's islands document draws, or null for the S1/S2 document. Call primed. */
function islandsPageOf(input: DocumentInput): IslandsPage | null {
  applyIslandsParam(input.url, true);
  if (!islandsPref.get()) return null;
  const route = matchAppRoute(input.url);
  if (route === null) return null;
  const p = dashPrefs.get();
  const data = snapshot.get().data;
  const view = p.dashView === "crew" && !isMultiHost(data?.servers) ? "dashboard" : p.dashView;
  if (route.kind === "home") return view === "dashboard" ? { kind: "home" } : null;
  return paneDrawsIslands(findPane(data, route.paneId)) ? { kind: "pane", paneId: route.paneId } : null;
}

/** The page's own URL, mounted: the snapshot frames' src. */
function pageSrc(url: URL): string {
  return href(`${url.pathname}${url.search}`);
}

/** The node of a snapshot frame for the primed request. */
function snapshotFrameNode(name: SnapshotFrameName, page: IslandsPage, heldRanks?: ReadonlyMap<string, number>) {
  if (name === "home-list") return page.kind === "home" ? homeListContent(heldRanks) : null;
  return page.kind === "pane" ? paneHeadContent(page.paneId) : null;
}

/**
 * The frame HTML with what changes on every render taken out (the runtime's random frame and island
 * ids, a fragment's own `rmx-data` and style head), so two renders of the same list hash the same.
 */
function stableHtml(html: string): string {
  return html
    .replace(/^<head>[\s\S]*?<\/head>/, "")
    .replace(/<script type="application\/json" id="rmx-data">[\s\S]*?<\/script>/g, "")
    .replace(/rmx:[hf]:[A-Za-z0-9_-]+/g, "rmx")
    .replace(FLUSH_MARKER, "");
}

/** The hash of each snapshot frame a rendered document drew inline. */
/** The runtime's data block, as far as this file reads it: each frame's name by its id. */
interface RmxFrames {
  [id: string]: { name?: string };
}

function heldHashes(html: string): DocumentData["held"] {
  // The document's own block is the LAST one: a frame's content carries its own before it.
  const data = [...html.matchAll(/<script type="application\/json" id="rmx-data">([\s\S]*?)<\/script>/g)].at(-1)?.[1];
  if (data === undefined) return {};
  let frames: RmxFrames;
  try {
    // SAFETY: the runtime's own data block from this render; only `f[id].name` is read.
    frames = (JSON.parse(data) as { f?: RmxFrames }).f ?? {};
  } catch {
    return {};
  }
  const pairs = Object.entries(frames).flatMap(([id, frame]) => {
    if (!isSnapshotFrameName(frame.name)) return [];
    const open = `<!-- rmx:f:${id} -->`;
    const start = html.indexOf(open);
    const end = start === -1 ? -1 : html.indexOf("<!-- /rmx:f -->", start + open.length);
    return end === -1 ? [] : [[frame.name, frameHash(stableHtml(html.slice(start + open.length, end)))] as const];
  });
  return Object.fromEntries(pairs);
}

/** Island module URLs resolved with their chunks, so the document preloads them. */
function clientEntryResolver(preloads: IslandsDocumentInput["preloads"]) {
  // Every island id carries its export (islands/ids.ts: `collie:<module>#<Export>`).
  return (entryId: string) => {
    const hash = entryId.lastIndexOf("#");
    const moduleUrl = hash === -1 ? entryId : entryId.slice(0, hash);
    const exportName = hash === -1 ? "" : entryId.slice(hash + 1);
    return { href: moduleUrl, exportName, preloads: [...(preloads?.[moduleUrl] ?? [])] };
  };
}

/** The data block, before `</body>`. */
function withDataBlock(html: string, data: DocumentData): string {
  const at = html.lastIndexOf("</body>");
  if (at === -1) throw new Error("ssr: document has no </body>");
  return `${html.slice(0, at)}${documentDataScript(data)}${html.slice(at)}`;
}

/**
 * The document for one request: the islands document when this page is drawn that way, else null (the
 * caller renders the S1/S2 document). The tree is built synchronously inside this call.
 */
export function renderIslandsDocument(indexHtml: string, input: IslandsDocumentInput): Promise<string> | null {
  let errors: unknown[] = [];
  let page: IslandsPage | null = null;
  const stream = withServerRender(input.base, () => {
    resetStores();
    try {
      prime(input);
      page = islandsPageOf(input);
      if (page === null) return null;
      const drawn = page;
      const src = pageSrc(input.url);
      const panes = paneFrameResolver(input);
      return withIslandsHtml(() =>
        renderToStream(<IslandsLayout page={drawn} src={src} />, {
          onError: (error) => void errors.push(error),
          resolveClientEntry: clientEntryResolver(input.preloads),
          resolveFrame: (frameSrc, target) => {
            if (isPaneFrameName(target)) return panes(frameSrc, target);
            if (isSnapshotFrameName(target)) {
              const node = snapshotFrameNode(target, drawn);
              return node === null ? "" : renderToStream(node, { resolveClientEntry: clientEntryResolver(input.preloads) });
            }
            return "";
          },
        }),
      );
    } finally {
      resetStores();
    }
  });
  if (stream === null) return null;
  return drain(stream).then((raw) => {
    if (errors.length > 0) throw errors[0];
    errors = [];
    const html = raw.replace(FLUSH_MARKER, "");
    const rendered = splitHead(html);
    const data: DocumentData = {
      path: `${input.url.pathname}${input.url.search}`,
      origin: input.url.origin,
      snapshot: input.snapshot,
      snapshotAt: input.snapshotAt,
      config: input.config,
      held: heldHashes(rendered.body),
    };
    if (input.pane !== undefined) data.pane = { ...input.pane, frames: true };
    return withDataBlock(spliceDocument(indexHtml, rendered), data);
  });
}

export interface SnapshotFramesInput extends IslandsDocumentInput {
  /** `X-Collie-Snap`: the frames asked for and the hash each holds. */
  held: ReadonlyMap<SnapshotFrameName, string>;
  /** `X-Collie-Ranks`, raw. */
  ranks: string | null;
  /** The snapshot's JSON as `/api/snapshot` would send it. */
  snapshotJson: string;
  /** A plain named-frame request (no `X-Collie-Snap`): the one frame's HTML alone, not the answer. */
  raw?: boolean;
}

/**
 * The snapshot frames' answer for one beat (islands/snapshot-wire.ts), or null when this page is not an
 * islands page (the browser then falls back to the JSON read).
 */
export function renderSnapshotFrames(input: SnapshotFramesInput): Promise<string> | null {
  const streams: { name: SnapshotFrameName; stream: ReadableStream<Uint8Array> }[] = [];
  const page = withServerRender(input.base, () => {
    resetStores();
    try {
      prime(input);
      const drawn = islandsPageOf(input);
      if (drawn === null) return null;
      const ranks = decodeRanks(input.ranks);
      const heldRanks = ranks !== null && ranks.order === dashPrefs.get().paneOrder ? new Map(ranks.keys.map((k, i) => [k, i] as const)) : undefined;
      withIslandsHtml(() => {
        for (const name of input.held.keys()) {
          if (!isSnapshotFrameName(name)) continue;
          const node = snapshotFrameNode(name, drawn, heldRanks);
          if (node !== null) streams.push({ name, stream: renderToStream(node, { resolveClientEntry: clientEntryResolver(input.preloads) }) });
        }
      });
      return drawn;
    } finally {
      resetStores();
    }
  });
  if (page === null) return null;
  return (async () => {
    const parts: SnapshotFramePart[] = [];
    if (input.raw === true) {
      const first = streams[0];
      return first === undefined ? "" : (await drain(first.stream)).replace(FLUSH_MARKER, "");
    }
    for (const { name, stream } of streams) {
      const html = (await drain(stream)).replace(FLUSH_MARKER, "");
      const hash = frameHash(stableHtml(html));
      if (input.held.get(name) !== hash) parts.push({ name, hash, html });
    }
    return snapshotAnswer(input.snapshotJson, parts);
  })();
}

export { BOOT_SCRIPT_ID, ISLAND_SOURCES, islandModule };
