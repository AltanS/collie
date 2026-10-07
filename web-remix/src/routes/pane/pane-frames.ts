// The browser half of the pane's server frames (S2; routes/pane/frames.ts says what they are).
//
// ONE PLACE DECIDES WHEN, THIS IS HOW. The beat is still lib/polling.ts's, unchanged: the same five
// rules, the hidden and idle and long-upload skips, "look now" on return, the 300 ms burst after a
// send. The pane's poll source asks this module instead of web's `fetchPane` while the switch is on
// (`framesActive`). One beat is ONE request: the poll answer carries both frames and the read
// (frames.ts, THE POLL ANSWER), with the read's ETag as `If-None-Match`.
//
//   - 304: nothing. No reload, no diff, no store write, no `reloadStart`. The cadence hears
//     "unchanged" (`markPollResult(false)`), as from a JSON 304.
//   - 200: the read goes into the pane's store (so the card, the composer, the find bar and the
//     reply card still read the text), into web's pane cache (so its ETag and the dialog guard's
//     baseline, `textBeforeLastSend`, see it, `notePaneRead`), and the cadence hears whether the text
//     changed. The frames' HTML is HELD here by src, and each mounted frame is told `reload()`; the
//     runtime asks `resolvePaneFrame`, which hands back the held HTML with no second request, and
//     diffs it into the frame by `data-rmx-key` (C/src/runtime/diff-dom.ts). So `reloadStart` and
//     `reloadComplete` are the runtime's own, fired only when something arrived.
//
// WHY NOT LET `reload()` FETCH. The runtime treats a 304 as a failure (no HTML) and an empty body as
// "clear the frame" (C/src/runtime/frame.ts, `renderFrameStream`); `reload()` takes no options, so a
// resolver cannot say "nothing changed". Answering the conditional request first, then reloading from
// what arrived, is the only way a 304 writes nothing.
//
// FROZEN. While the reader is scrolled up in the Terminal (`focus.following` false), the screen frame
// is not reloaded: the rows under the eye stay put (REMIX3.md rule 8), exactly as the browser-drawn
// mirror freezes them. The held HTML keeps moving; the first beat or the jump back to the tail
// (`focus` back to following) reloads the frame from it at once, with no request.
//
// NOT OURS. Every answer of the bridge's frame route carries `X-Collie-Frame`. An answer without it
// (a proxy's sign-in page, a service worker's shell, an older bridge, the e2e static server) is not a
// fragment: the switch LATCHES off for the page's life (`framesLatched`) and that beat reads the JSON
// route instead, so the screen never diffs a whole page into a frame.
//
// OFFLINE (M46). A failed request leaves the frames as they are and the store's last body in place,
// and puts the error on the store exactly as the JSON read did, so the pane says "can't reach" over the
// last rows it had. Nothing is cached beyond what the JSON path kept.
import type { FrameHandle } from "remix/component";

import { fetchPane, notePaneRead, withTimeout, XHR_HEADER, XHR_HEADER_VALUE } from "@web/lib/api";
import { markLive } from "@web/lib/connection-health";
import { authHeader } from "@web/lib/pairing";
import { internScope, paneScopeKey, scopeFromUrl, type Scope } from "@web/lib/scope";
import { observeServerBuild, SERVER_BUILD_HEADER } from "@web/lib/server-build";
import type { PaneReadResponse } from "@web/lib/types";

import { paneStore } from "../../lib/data";
import { focus, markPollResult } from "../../lib/polling";
import { paneFrames } from "../../lib/prefs";
import { createStore } from "../../lib/store";
import { href } from "../../routes";
import { pollPane } from "./data";
import {
  FRAME_ANSWER_HEADER,
  PANE_FRAMES,
  paneFramePath,
  parsePollAnswer,
  POLL_HEADER,
  SCREEN_FRAME,
  type PaneFrameName,
  type ParsedPollAnswer,
} from "./frames";

/** The GET deadline every read has (web/src/lib/api.ts). */
const GET_TIMEOUT_MS = 10_000;
/** The panes whose frames are held: the open one, a prefetched one, slack for a sideways move. */
const HELD_MAX = 8;
/** The statuses the screen branches on (routes/pane/data.ts). */
const KNOWN_STATUSES = new Set([401, 403, 404, 409, 502, 503]);

/** One pane read and the frames cut from it, by the frames' src. A part is null when it is on screen
 *  but not held as text (a server document drew it); undefined when it was never asked for. */
interface Held {
  etag: string | null;
  read: PaneReadResponse;
  parts: Partial<Record<PaneFrameName, string | null>>;
}

const held = new Map<string, Held>();
/** What each mounted frame shows: the src and the ETag of the HTML it was last given. */
const shown = new Map<PaneFrameName, { src: string; etag: string | null }>();
/** Requests in flight by src, so the beat, a frame's own first load and a prefetch share one. */
const inflight = new Map<string, { targets: readonly PaneFrameName[]; answer: Promise<Answer> }>();

/** True once an answer was not the bridge's fragment: the JSON read for the rest of the page's life. */
export const framesLatched = createStore(false);

/** The switch is on and nothing has shown the frame route to be missing. */
export function framesActive(): boolean {
  return paneFrames.get() && !framesLatched.get();
}

/** The frames' src for a pane, mounted: what the pane's `<Frame>`s draw and what is held by. */
export function paneFrameSrc(paneId: string, scope: Scope, lines: number, agent: string | undefined): string {
  return href(paneFramePath(paneId, scope, lines, agent));
}

function hold(src: string, entry: Held): void {
  held.delete(src);
  held.set(src, entry);
  if (held.size > HELD_MAX) {
    const oldest = held.keys().next().value;
    if (oldest !== undefined) held.delete(oldest);
  }
}

// ── The mounted frames ──────────────────────────────────────────────────────────────────────────────

interface Binding {
  /** The frame by name, if it is mounted (`handle.frames.get`). */
  frame(name: PaneFrameName): FrameHandle | undefined;
  /** The open pane's frames src now. */
  src(): string;
}

let binding: Binding | null = null;

/**
 * The open pane hands over how to find its frames, for as long as it is mounted (pane.tsx). A follow
 * resumed reloads the screen frame from what is held, at once.
 */
export function bindPaneFrames(next: Binding, signal: AbortSignal): void {
  binding = next;
  const stop = focus.subscribe(() => {
    if (focus.get().following) reloadMounted(next.src());
  });
  signal.addEventListener(
    "abort",
    () => {
      stop();
      if (binding === next) binding = null;
      shown.clear();
    },
    { once: true },
  );
}

/** Reload every mounted frame of `src` that shows something older than what is held. */
function reloadMounted(src: string): void {
  const entry = held.get(src);
  if (binding === null || entry === undefined) return;
  for (const name of PANE_FRAMES) {
    const frame = binding.frame(name);
    // A frame whose vnode carries another src is about to resolve that one itself (diffFrame).
    if (frame === undefined || frame.src !== src) continue;
    if (name === SCREEN_FRAME && !focus.get().following) continue;
    if (!isHeld(entry.parts[name])) continue;
    const now = shown.get(name);
    if (now !== undefined && now.src === src && now.etag === entry.etag) continue;
    void reloadFrame(frame, name);
  }
}

/** A reload the runtime gave up on (a newer one took over, or it failed) leaves the frame unknown. */
async function reloadFrame(frame: FrameHandle, name: PaneFrameName): Promise<void> {
  try {
    const signal = await frame.reload();
    if (signal.aborted) shown.delete(name);
  } catch {
    shown.delete(name);
  }
}

/** A frame's HTML is here as text (null: on screen from a document, but not held as text). */
function isHeld(part: string | null | undefined): part is string {
  return part !== undefined && part !== null;
}

// ── The request ─────────────────────────────────────────────────────────────────────────────────────

type Answer =
  | { kind: "fresh"; etag: string | null; parsed: ParsedPollAnswer }
  | { kind: "same"; etag: string | null }
  | { kind: "refused"; status: number; detail: string }
  | { kind: "foreign" };

async function request(src: string, targets: readonly PaneFrameName[], etag: string | null, seen: boolean, signal: AbortSignal | undefined): Promise<Answer> {
  const headers = new Headers({
    Accept: "text/html",
    "X-Remix-Frame": "true",
    "X-Remix-Target": targets[0] ?? SCREEN_FRAME,
    [POLL_HEADER]: targets.join(","),
    [XHR_HEADER]: XHR_HEADER_VALUE,
    ...authHeader(),
  });
  // The pane's own beat marks it seen; a prefetch and a frame's first load do not (web's `fetchPane`).
  if (seen) headers.set("x-collie-seen", "1");
  if (etag !== null) headers.set("if-none-match", etag);
  const res = await fetch(src, {
    headers,
    signal: withTimeout(signal, GET_TIMEOUT_MS),
    mode: "same-origin",
    redirect: "manual",
    cache: "no-store",
  });
  // A fronting proxy's redirect to its sign-in page reads as a 401, as web's `apiFetch` reads it.
  if (res.type === "opaqueredirect") return { kind: "refused", status: 401, detail: "redirected to sign-in" };
  if (res.headers.get(FRAME_ANSWER_HEADER) === null) {
    void res.body?.cancel();
    return { kind: "foreign" };
  }
  observeServerBuild(res.headers.get(SERVER_BUILD_HEADER));
  if (res.status === 304) {
    markLive();
    return { kind: "same", etag: res.headers.get("etag") ?? etag };
  }
  if (!res.ok) return { kind: "refused", status: res.status, detail: await res.text() };
  const parsed = parsePollAnswer(await res.text());
  if (parsed === null) return { kind: "foreign" };
  markLive();
  return { kind: "fresh", etag: res.headers.get("etag"), parsed };
}

/** One request per src at a time: a caller whose frames are all in the one in flight waits for it. */
function shared(src: string, targets: readonly PaneFrameName[], etag: string | null, seen: boolean, signal: AbortSignal | undefined): Promise<Answer> {
  const running = inflight.get(src);
  if (running !== undefined && targets.every((name) => running.targets.includes(name))) return running.answer;
  const answer = request(src, targets, etag, seen, signal).finally(() => {
    if (inflight.get(src)?.answer === answer) inflight.delete(src);
  });
  inflight.set(src, { targets, answer });
  return answer;
}

/** A fresh answer, held and recorded everywhere the JSON read would have been. */
function take(src: string, paneId: string, scope: Scope, answer: Extract<Answer, { kind: "fresh" }>): Held {
  const entry: Held = { etag: answer.etag, read: answer.parsed.read, parts: { ...answer.parsed.frames } };
  hold(src, entry);
  if (answer.etag !== null) notePaneRead(paneId, scope, answer.etag, answer.parsed.read);
  return entry;
}

function latch(): void {
  framesLatched.set(true);
}

// ── The beat's read ─────────────────────────────────────────────────────────────────────────────────

export interface PaneFramesPoll {
  /** The pane store's key (`paneScopeKey`). */
  key: string;
  paneId: string;
  scope: Scope;
  lines: number;
  /** The agent whose adapter parses the screen (`parseAgent`). */
  agent: string | undefined;
  /** The frames the open screen shows: both under the Terminal, the status band alone under Chat. */
  targets: readonly PaneFrameName[];
}

/**
 * One beat of the open pane through its frames. Resolves true when the text changed. It is the cadence's
 * "is the screen still moving" signal (`markPollResult`), as `pollPane` is on the JSON path.
 */
export async function pollPaneFrames(poll: PaneFramesPoll, signal: AbortSignal): Promise<boolean> {
  const { key, paneId, scope, lines, agent, targets } = poll;
  const src = paneFrameSrc(paneId, scope, lines, agent);
  const before = held.get(src);
  // Conditional only when every frame asked for is already on screen or held: a 304 must leave
  // nothing missing.
  const etag = before !== undefined && targets.every((name) => before.parts[name] !== undefined) ? before.etag : null;
  const store = paneStore(key);
  let answer: Answer;
  try {
    answer = await shared(src, targets, etag, true, signal);
  } catch (error) {
    if (!(error instanceof Error) || error.name === "AbortError") return false;
    store.update((prev) => ({ ...prev, error: error.message, status: undefined }));
    return false;
  }
  switch (answer.kind) {
    case "foreign":
      latch();
      return pollPane(key, paneId, scope, signal, lines);
    case "refused":
      store.update((prev) => ({
        ...prev,
        error: `${src} → ${String(answer.status)} ${answer.detail}`,
        status: KNOWN_STATUSES.has(answer.status) ? answer.status : undefined,
      }));
      return false;
    case "same": {
      // The read is the one held, so the store keeps its body; an error it carried is over.
      if (store.get().error !== undefined && before !== undefined) store.set({ data: before.read, error: undefined, status: undefined });
      markPollResult(false);
      reloadMounted(src);
      return false;
    }
    case "fresh": {
      const entry = take(src, paneId, scope, answer);
      const changed = entry.read.text !== store.get().data?.text;
      // The store compares by value (lib/data.ts): the same screen wakes nobody.
      store.set({ data: entry.read, error: undefined, status: undefined });
      markPollResult(changed);
      reloadMounted(src);
      return changed;
    }
  }
}

// ── A frame's own load (the runtime's resolver) ─────────────────────────────────────────────────────

/**
 * The runtime asks for a frame's content: on a reload this module started (the held HTML), or when a
 * frame mounts in the browser (the held HTML if a prefetch or a beat brought it, else one request). A
 * frame that cannot be filled gets nothing: the pane's notice says why.
 */
export async function resolvePaneFrame(src: string, target: PaneFrameName, signal: AbortSignal | undefined): Promise<string> {
  const ready = (): string | null => {
    const entry = held.get(src);
    const part = entry?.parts[target];
    if (entry === undefined || !isHeld(part)) return null;
    shown.set(target, { src, etag: entry.etag });
    return part;
  };
  const now = ready();
  if (now !== null) return now;
  const running = inflight.get(src);
  if (running !== undefined) {
    await running.answer.catch(() => undefined);
    const after = ready();
    if (after !== null) return after;
  }
  const url = new URL(src, "http://local.invalid");
  const paneId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  const scope = internScope(scopeFromUrl(url.href));
  let answer: Answer;
  try {
    answer = await shared(src, PANE_FRAMES, null, false, signal);
  } catch {
    return "";
  }
  if (answer.kind === "foreign") {
    latch();
    return "";
  }
  if (answer.kind !== "fresh") return ready() ?? "";
  const entry = take(src, paneId, scope, answer);
  // The rows and the screen's other readers stay on one read; the cadence hears only the beat.
  paneStore(paneScopeKey(scope, paneId)).set({ data: entry.read, error: undefined, status: undefined });
  return ready() ?? "";
}

// ── Before the screen mounts ────────────────────────────────────────────────────────────────────────

/**
 * The dashboard's pointerdown prefetch (routes/home/open-pane.ts), through the frames: both frames and
 * the read, held for the screen's first frame, never marking the pane seen. Resolves the read.
 */
export async function prefetchPaneFrames(paneId: string, scope: Scope, lines: number, agent: string | undefined): Promise<PaneReadResponse | undefined> {
  const src = paneFrameSrc(paneId, scope, lines, agent);
  const before = held.get(src);
  const etag = before !== undefined && PANE_FRAMES.every((name) => isHeld(before.parts[name])) ? before.etag : null;
  try {
    const answer = await shared(src, PANE_FRAMES, etag, false, undefined);
    if (answer.kind === "fresh") return take(src, paneId, scope, answer).read;
    if (answer.kind === "same") return before?.read;
    if (answer.kind === "foreign") {
      // Not the frame route: the JSON prefetch, as the beat falls back to the JSON read.
      latch();
      return await fetchPane(paneId, lines, scope, undefined, { seen: false });
    }
  } catch {
    // the screen's own first read reports it
  }
  return undefined;
}

/**
 * A server document drew the pane's frames from this read (main.tsx): held as on screen, so the first
 * beat asks with its ETag and an unchanged pane answers 304.
 */
export function primePaneFrames(src: string, paneId: string, scope: Scope, etag: string | null, read: PaneReadResponse): void {
  hold(src, { etag, read, parts: { [SCREEN_FRAME]: null, "pane-status": null } });
  for (const name of PANE_FRAMES) shown.set(name, { src, etag });
  if (etag !== null) notePaneRead(paneId, scope, etag, read);
}

/** For tests: forget everything held. */
export function resetPaneFrames(): void {
  held.clear();
  shown.clear();
  inflight.clear();
  binding = null;
  framesLatched.set(false);
}
