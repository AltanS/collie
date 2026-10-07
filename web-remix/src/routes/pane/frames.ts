// The pane's two server frames (S2 of the Remix 3 plan, `experiments/remix-v3/ACTION-PLAN.md` B):
// the names, the `src` both sides draw, and the fragment format. Shared by the browser
// (routes/pane/pane-frames.ts), the shell's renderer (ssr/frames.tsx) and, through the renderer, the
// bridge (bridge/http/controllers/frames.ts). Pure: no browser API, safe on Bun.
//
// WHAT STREAMS. `pane-screen` is the Terminal's rows (screen/screen.tsx `ScreenRows`), `pane-status`
// the agent's statusline rows (statusline.tsx `StatusRows`). Both are cut from ONE pane read, so one
// request carries both (see THE POLL ANSWER). The `<pre>` and the strip around them, the header, the
// strips, the card, the composer, the belt and the sheets stay the browser's. Chat stays the browser's
// too: its window has its own after-cursor protocol (web's `fetchChat`), which a whole-fragment
// reload would throw away.
//
// THE SRC is the pane's own page URL (`/pane/<id>` with its `?h=`/`?s=` scope), plus the read window
// (`lines`) and the agent whose adapter parses the screen (`agent`, absent with the raw-terminal pref
// or for a bare shell). It is mounted with `href()` on BOTH sides: the server never fetches it (the
// document hands the frames to the renderer already drawn, ssr/render.tsx), so the mount trap of
// research note 08 §3.6 does not arise, and an identical src keeps the hydrated frame's `src` equal to
// the one the browser draws. Everything that changes the rows' markup is in the src, so a change of
// it is a new URL and never meets a stale ETag; the font, the wrap and the theme are on the `<pre>`,
// outside the frame, and change nothing here.
//
// THE POLL ANSWER. A request with `X-Collie-Poll: <frame names>` gets every named frame and the pane
// read itself in one body, so the beat costs one request and one multiplexer read, as the JSON read
// did:
//
//   <script type="application/json" data-collie-pane-read>{the read}</script>
//   <template data-collie-frame="pane-status">…rows…</template>
//   <template data-collie-frame="pane-screen">…rows…</template>
//
// WITHOUT THE TEXT. The rows are drawn on the bridge from the pane's text, so a read that carried the
// text too sent the screen twice (the JSON `text` was 5.3 KiB of a 14.7 KiB answer). The answer leaves
// `text` and `logicalText` out and carries `screen` (lib/pane-read.ts) instead: the dialog's blocks,
// the composer's draft, the footer, the row counts and a stamp, computed with the shared pure
// functions (routes/pane/screen-model.ts). What still needs the text asks for it, by adding the token
// `text` to `X-Collie-Poll` (the find bar, which marks rows the server cannot mark); that answer is the
// whole read and no `screen`, as before. The reader that places the newest reply over the mirror
// (latest-reply.tsx) sends a probe instead, two 48-letter strings in `X-Collie-Reply`, and the answer's
// `screen.reply` says where they sit.
//
// The read goes first: with the text in it, its JSON string held most of the rows' text, and gzip
// found it again (the window is 32 KiB). A request without the header (Remix's own default resolver)
// gets the one frame `X-Remix-Target` names, as plain rows. Text in rows is escaped, so `</template>`
// and `</script>` occur only as these closers (the JSON escapes every `<`).

import { PROBE_CHARS } from "@web/lib/latest-reply";
import { panePath } from "@web/lib/nav";
import type { Scope } from "@web/lib/scope";

import type { PaneRead, PaneReadLite } from "../../lib/pane-read";

export const SCREEN_FRAME = "pane-screen";
export const STATUS_FRAME = "pane-status";
export type PaneFrameName = typeof SCREEN_FRAME | typeof STATUS_FRAME;
export const PANE_FRAMES: readonly PaneFrameName[] = [SCREEN_FRAME, STATUS_FRAME];

/** The request header that asks for a poll answer: the frame names, comma separated. */
export const POLL_HEADER = "x-collie-poll";
/** The token in `X-Collie-Poll` that asks for the read WITH its text (see THE POLL ANSWER). */
export const POLL_TEXT = "text";
/** The request header that carries the reply probe (see THE POLL ANSWER). */
export const REPLY_HEADER = "x-collie-reply";
/** The response header every answer of the frame route carries: proof it is ours, not a proxy's page. */
export const FRAME_ANSWER_HEADER = "x-collie-frame";

export function isPaneFrameName(name: string | null | undefined): name is PaneFrameName {
  return name === SCREEN_FRAME || name === STATUS_FRAME;
}

/** The frame names a poll header asks for, known names only, in a fixed order. */
export function pollTargets(header: string | null): PaneFrameName[] {
  if (header === null) return [];
  const asked = new Set(header.split(",").map((part) => part.trim()));
  return PANE_FRAMES.filter((name) => asked.has(name));
}

/** True when a poll header asks for the text as well as the screen model. */
export function pollWantsText(header: string | null): boolean {
  return header !== null && header.split(",").some((part) => part.trim() === POLL_TEXT);
}

/** The poll header for these frames, with the text when `text` is set. */
export function pollHeader(targets: readonly PaneFrameName[], text: boolean): string {
  return text ? [...targets, POLL_TEXT].join(",") : targets.join(",");
}

/**
 * The newest reply's two probes: the first and last PROBE_CHARS letters and digits of its prose, folded
 * (web's `fold`). The bridge locates them on the screen with web's `locateReply`.
 */
export interface ReplyProbe {
  head: string;
  tail: string;
}

/** The probe as the request header carries it: two percent-encoded strings with a dot between. */
export function encodeProbe(probe: ReplyProbe): string {
  return `${encodeURIComponent(probe.head)}.${encodeURIComponent(probe.tail)}`;
}

/** The probe a header carries, or undefined for none or one that is not two whole probes. */
export function decodeProbe(header: string | null): ReplyProbe | undefined {
  if (header === null) return undefined;
  const parts = header.split(".");
  if (parts.length !== 2) return undefined;
  try {
    const head = decodeURIComponent(parts[0] ?? "");
    const tail = decodeURIComponent(parts[1] ?? "");
    return head.length === PROBE_CHARS && tail.length === PROBE_CHARS ? { head, tail } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The frames' src, root-relative (the caller mounts it with `href()`): the pane's page path, the read
 * window and the parse's agent.
 */
export function paneFramePath(paneId: string, scope: Scope, lines: number, agent: string | undefined): string {
  const path = panePath(paneId, scope);
  const query = new URLSearchParams({ lines: String(lines) });
  if (agent !== undefined && agent !== "") query.set("agent", agent);
  return `${path}${path.includes("?") ? "&" : "?"}${query.toString()}`;
}

/** What a frame URL asks the renderer for: the read window and the parse's agent. */
export interface PaneFrameParams {
  lines: number | undefined;
  agent: string | undefined;
}

export function paneFrameParams(url: URL): PaneFrameParams {
  const lines = Number.parseInt(url.searchParams.get("lines") ?? "", 10);
  const agent = url.searchParams.get("agent");
  return { lines: Number.isFinite(lines) && lines > 0 ? lines : undefined, agent: agent === null || agent === "" ? undefined : agent };
}

// ── The poll answer ─────────────────────────────────────────────────────────────────────────────────

const READ_OPEN = '<script type="application/json" data-collie-pane-read>';
const READ_CLOSE = "</script>";
const templateOpen = (name: PaneFrameName): string => `<template data-collie-frame="${name}">`;
const TEMPLATE_CLOSE = "</template>";

/** The read as JSON safe inside a `<script>`: every `<` escaped, so no `</script>` can close it early. */
function scriptJson(read: PaneRead | PaneReadLite): string {
  return JSON.stringify(read).replaceAll("<", "\\u003c");
}

/** Assemble a poll answer (see the file header). */
export function pollAnswer(read: PaneRead | PaneReadLite, frames: Partial<Record<PaneFrameName, string>>): string {
  let out = `${READ_OPEN}${scriptJson(read)}${READ_CLOSE}`;
  for (const name of [STATUS_FRAME, SCREEN_FRAME] as const) {
    const html = frames[name];
    if (html !== undefined) out += `${templateOpen(name)}${html}${TEMPLATE_CLOSE}`;
  }
  return out;
}

export interface ParsedPollAnswer {
  read: PaneRead;
  frames: Partial<Record<PaneFrameName, string>>;
}

/**
 * Split a poll answer, or null when the body is not one (a page from somewhere else). Only an answer
 * that carried the frame route's own header reaches this (pane-frames.ts), and its read is the pane
 * route's own body, so the JSON is taken as that body.
 */
export function parsePollAnswer(body: string): ParsedPollAnswer | null {
  if (!body.startsWith(READ_OPEN)) return null;
  const readEnd = body.indexOf(READ_CLOSE, READ_OPEN.length);
  if (readEnd === -1) return null;
  let read: PaneRead;
  try {
    // SAFETY: the bridge's own pane read, serialised by `pollAnswer` on the frame route; a body that
    // does not start with the exact data block above was refused before this line.
    const wire = JSON.parse(body.slice(READ_OPEN.length, readEnd)) as PaneRead | PaneReadLite;
    // A read without its text carries `screen` and holds "" here; `screen` is what tells it from a blank pane.
    read = "text" in wire ? wire : { ...wire, text: "" };
  } catch {
    return null;
  }
  const frames: Partial<Record<PaneFrameName, string>> = {};
  let at = readEnd + READ_CLOSE.length;
  for (const name of [STATUS_FRAME, SCREEN_FRAME] as const) {
    const open = templateOpen(name);
    if (!body.startsWith(open, at)) continue;
    const end = body.indexOf(TEMPLATE_CLOSE, at + open.length);
    if (end === -1) return null;
    frames[name] = body.slice(at + open.length, end);
    at = end + TEMPLATE_CLOSE.length;
  }
  return { read, frames };
}
