// Open a pane from a row (web/'s usePaneOpen): at the pane's own scope, with the `pane` glide when
// the mirror is ready in time. The read starts on `pointerdown` (`prefetchPane`) and the tap waits
// READY_WAIT_MS for it at most, else it goes with the plain slide.
//
// THE PREFETCH IS THE SCREEN'S OWN FIRST READ (web/src/lib/pane-prefetch.ts): the same `?lines=600`
// window through web's `fetchPane` (routes/pane/data.ts says why the pane reads through that module),
// with `seen: false` so a finger that lands on a row on its way to a scroll never clears the unseen
// mark; the pane screen's own first poll sends the seen read once it is up. On the tap, the answer is
// written into the pane's store, so the screen draws its text on its first frame instead of waiting
// for a second round trip. It used to read `/api/pane/:id` with the bridge's default window through
// this shell's api.ts, which warmed neither web's ETag cache nor the store: every tap paid two serial
// reads, and a Herdr read that misses its fast path costs about 100 ms each (measured 2026-10-06).
//
// THE PREFETCH ALSO PARSES. As soon as the read lands, its text goes through the pane's own parse
// (routes/pane/parse.ts: blocks, card, mirror rows, tail reads), in that network task, between the
// finger going down and the tap. The pane's first render finds the parse in the shared cache and only
// draws, so the parse (about 35 ms at 4x CPU) leaves the tap's render task.
//
// WITH THE PANE FRAMES ON (S2) the prefetch is the frames' own first read (routes/pane/pane-frames.ts
// `prefetchPaneFrames`): the read and both frames' rows in one answer, held for the screen's first
// frame, so the rows land in the same task as the route's commit with no second request.

import { fetchPane } from "@web/lib/api";
import { paneScope } from "@web/lib/hosts";
import { panePath } from "@web/lib/nav";
import { paneScopeKey, type Scope } from "@web/lib/scope";
import type { AgentView } from "@web/lib/types";

import { navigate } from "../../lib/navigate";
import { address, paneStore, snapshot } from "../../lib/data";
import type { PaneRead } from "../../lib/pane-read";
import { displayPrefs } from "../../lib/prefs";
import { glideForwardWhenReady } from "../../lib/glide";
import { href } from "../../routes";
import { PANE_LINES } from "../pane/data";
import { framesActive, prefetchPaneFrames } from "../pane/pane-frames";
import { parseAgent, warmParse } from "../pane/parse";

/** How long a started read stays on offer to a tap (web/'s PREFETCH_TTL_MS). */
const PREFETCH_TTL_MS = 2000;

interface Warming {
  /** The pane's path at its scope: the tap's URL and the row's glide key. */
  key: string;
  /** The pane store's key (`paneScopeKey`), the one the pane route reads. */
  storeKey: string;
  at: number;
  read: Promise<PaneRead | undefined>;
}

let warming: Warming | null = null;

function scopeOf(pane: AgentView): Scope {
  const body = snapshot.get().data;
  return paneScope(address.get().scope, pane, body?.servers, body?.sessions);
}

/** The pane's path at its own scope: the URL a tap goes to, and the row's glide key. */
export function paneTarget(pane: AgentView): string {
  return panePath(pane.paneId, scopeOf(pane));
}

/** Start the mirror read a tap would wait for; a fresh one for the same pane is reused. */
export function prefetchPane(pane: AgentView): void {
  const scope = scopeOf(pane);
  const key = panePath(pane.paneId, scope);
  const now = Date.now();
  if (warming?.key === key && now - warming.at < PREFETCH_TTL_MS) return;
  const agent = parseAgent(pane.agent, displayPrefs.get().rawTerminal);
  const fetched: Promise<PaneRead | undefined> = framesActive()
    ? prefetchPaneFrames(pane.paneId, scope, PANE_LINES, agent)
    : fetchPane(pane.paneId, PANE_LINES, scope, undefined, { seen: false });
  const read = fetched.then(
    (body) => {
      // A read without its text (a frames answer) carries its parse already: nothing to warm.
      if (body !== undefined && body.screen === undefined) warmParse(body.text, agent);
      return body;
    },
    () => undefined,
  );
  warming = { key, storeKey: paneScopeKey(scope, pane.paneId), at: now, read };
}

/** Open `pane` in-page; `row` is the glide's origin. */
export function openPane(pane: AgentView, row?: HTMLElement): void {
  const key = paneTarget(pane);
  const held = warming?.key === key && Date.now() - warming.at < PREFETCH_TTL_MS ? warming : null;
  warming = null;
  const ready = held === null ? Promise.resolve() : held.read.then((body) => seed(held.storeKey, body));
  glideForwardWhenReady("pane", key, ready, () => void navigate(href(key)), row);
}

/**
 * The prefetched answer into the pane's store. Nothing reads that store before the pane screen
 * mounts, and the read started on this tap's own `pointerdown`, so it is the newest answer there is.
 */
function seed(storeKey: string, body: PaneRead | undefined): void {
  if (body === undefined) return;
  paneStore(storeKey).set({ data: body, error: undefined, status: undefined });
}
