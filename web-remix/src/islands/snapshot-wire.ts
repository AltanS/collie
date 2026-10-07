// The snapshot frames' wire format (S3), shared by the browser (islands/snapshot-frames.ts), the shell's
// renderer (ssr/snapshot-frames.tsx) and, through the renderer, the bridge. Pure: safe on Bun.
//
// WHAT THEY ARE. The server HTML of an islands page that follows the snapshot: `home-list` (the
// dashboard's list, its chips and its tab bar) and `pane-head` (the pane's identity in the header).
// Each is a named `<Frame>` whose src is the page's own URL. The `live` island keeps them current.
//
// ONE REQUEST PER BEAT. The snapshot beat of an islands page asks the page URL with
// `X-Collie-Snap: <name>=<hash>,…`, one entry per frame on the page with the hash of the HTML it holds
// (empty when it holds none). The answer carries the snapshot itself, which every island's store reads,
// and the HTML of each named frame whose hash moved, so an unchanged list costs no bytes:
//
//   <script type="application/json" data-collie-snapshot>{the snapshot}</script>
//   <template data-collie-frame="home-list" data-hash="k3x9">…</template>
//
// The answer carries `X-Collie-Frame: snapshot`. The rows keep their order between beats unless the
// operator asked for another (lib/frozen-ranks.ts): the browser sends the order it shows in
// `X-Collie-Ranks: <order>:<row key>,<row key>,…` and the server draws by it while the order is the same.
// Every `<` in the JSON is escaped, so `</script>` and `</template>` close only what they open.

export const HOME_LIST_FRAME = "home-list";
export const PANE_HEAD_FRAME = "pane-head";
export type SnapshotFrameName = typeof HOME_LIST_FRAME | typeof PANE_HEAD_FRAME;
export const SNAPSHOT_FRAMES: readonly SnapshotFrameName[] = [HOME_LIST_FRAME, PANE_HEAD_FRAME];

/** The request header of a snapshot beat (see the file header). */
export const SNAP_HEADER = "x-collie-snap";
/** The request header with the row order the page shows. */
export const RANKS_HEADER = "x-collie-ranks";
/** The value of `X-Collie-Frame` on a snapshot answer. */
export const SNAPSHOT_ANSWER = "snapshot";

export function isSnapshotFrameName(name: string | null | undefined): name is SnapshotFrameName {
  return name === HOME_LIST_FRAME || name === PANE_HEAD_FRAME;
}

/** `name=hash,…` for the frames a page holds. */
export function encodeHeld(held: ReadonlyMap<SnapshotFrameName, string>): string {
  return [...held].map(([name, hash]) => `${name}=${hash}`).join(",");
}

/** The frames a snapshot beat asks for, known names only, with the hash each holds ("" for none). */
export function decodeHeld(header: string | null): Map<SnapshotFrameName, string> {
  const out = new Map<SnapshotFrameName, string>();
  if (header === null) return out;
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    const name = (at === -1 ? part : part.slice(0, at)).trim();
    if (isSnapshotFrameName(name)) out.set(name, at === -1 ? "" : part.slice(at + 1).trim());
  }
  return out;
}

/** `order:key,key,…` (row keys URI-encoded), or null when there is nothing to hold. */
export function encodeRanks(order: string, keys: readonly string[]): string | null {
  if (keys.length === 0) return null;
  return `${order}:${keys.map(encodeURIComponent).join(",")}`;
}

export function decodeRanks(header: string | null): { order: string; keys: string[] } | null {
  if (header === null) return null;
  const at = header.indexOf(":");
  if (at <= 0) return null;
  try {
    const keys = header
      .slice(at + 1)
      .split(",")
      .filter((k) => k !== "")
      .map(decodeURIComponent);
    return { order: header.slice(0, at), keys };
  } catch {
    return null;
  }
}

/** A short, stable hash of a frame's HTML (FNV-1a, 32 bits, base 36). */
export function frameHash(html: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < html.length; i++) {
    h ^= html.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const SNAP_OPEN = '<script type="application/json" data-collie-snapshot>';
const SNAP_CLOSE = "</script>";
const TEMPLATE_CLOSE = "</template>";
const TEMPLATE_OPEN = /^<template data-collie-frame="([a-z-]+)" data-hash="([0-9a-z]*)">/;

export interface SnapshotFramePart {
  name: SnapshotFrameName;
  hash: string;
  html: string;
}

/** Assemble a snapshot answer from the snapshot's JSON (already serialised) and the moved frames. */
export function snapshotAnswer(snapshotJson: string, frames: readonly SnapshotFramePart[]): string {
  let out = `${SNAP_OPEN}${snapshotJson.replaceAll("<", "\\u003c")}${SNAP_CLOSE}`;
  for (const f of frames) out += `<template data-collie-frame="${f.name}" data-hash="${f.hash}">${f.html}${TEMPLATE_CLOSE}`;
  return out;
}

export interface ParsedSnapshotAnswer {
  snapshot: unknown;
  frames: SnapshotFramePart[];
}

/** Split a snapshot answer, or null when the body is not one. */
export function parseSnapshotAnswer(body: string): ParsedSnapshotAnswer | null {
  if (!body.startsWith(SNAP_OPEN)) return null;
  const end = body.indexOf(SNAP_CLOSE, SNAP_OPEN.length);
  if (end === -1) return null;
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(body.slice(SNAP_OPEN.length, end));
  } catch {
    return null;
  }
  const frames: SnapshotFramePart[] = [];
  let at = end + SNAP_CLOSE.length;
  while (at < body.length) {
    const open = TEMPLATE_OPEN.exec(body.slice(at, at + 96));
    if (open === null) return null;
    const name = open[1];
    if (!isSnapshotFrameName(name)) return null;
    const close = body.indexOf(TEMPLATE_CLOSE, at + open[0].length);
    if (close === -1) return null;
    frames.push({ name, hash: open[2] ?? "", html: body.slice(at + open[0].length, close) });
    at = close + TEMPLATE_CLOSE.length;
  }
  return { snapshot, frames };
}
