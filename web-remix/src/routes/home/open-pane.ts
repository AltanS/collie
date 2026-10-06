// Open a pane from a row (web/'s usePaneOpen): at the pane's own scope, with the `pane` glide when
// the mirror is ready in time. The read starts on `pointerdown` (`prefetchPane`, `seen: false`, so a
// prefetch never clears the unseen mark) and warms lib/api.ts's conditional cache the pane screen
// reads first; the tap waits READY_WAIT_MS for it at most, else it goes with the plain slide.
import { navigate } from "remix/component";

import { paneScope } from "@web/lib/hosts";
import { panePath } from "@web/lib/nav";
import type { AgentView } from "@web/lib/types";

import { fetchPane } from "../../lib/api";
import { address, snapshot } from "../../lib/data";
import { glideForwardWhenReady } from "../../lib/glide";
import { href } from "../../routes";

let warming: { key: string; ready: Promise<unknown> } | null = null;

/** The pane's path at its own scope: the URL a tap goes to, and the row's glide key. */
export function paneTarget(pane: AgentView): string {
  const body = snapshot.get().data;
  return panePath(pane.paneId, paneScope(address.get().scope, pane, body?.servers, body?.sessions));
}

/** Start the mirror read a tap would wait for. */
export function prefetchPane(pane: AgentView): void {
  const key = paneTarget(pane);
  if (warming?.key === key) return;
  const body = snapshot.get().data;
  const scope = paneScope(address.get().scope, pane, body?.servers, body?.sessions);
  warming = { key, ready: fetchPane(pane.paneId, scope, undefined, false).catch(() => undefined) };
}

/** Open `pane` in-page; `row` is the glide's origin. */
export function openPane(pane: AgentView, row?: HTMLElement): void {
  const key = paneTarget(pane);
  const ready = warming?.key === key ? warming.ready : Promise.resolve();
  warming = null;
  glideForwardWhenReady("pane", key, ready, () => void navigate(href(key)), row);
}
