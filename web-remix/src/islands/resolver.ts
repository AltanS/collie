// THE CHOKE POINT of the islands runtime (S3): `resolveFrame` for `run()`, the one function every soft
// navigation and every frame reload goes through. Research note 10 sections 1, 4.5, 6.3 and 9.2 are its
// contract; REMIX3.md "Islands and soft navigation" restates it.
//
// TOP FRAME (a link, `navigate()`, Back and Forward), in this order:
//   1. Await the glide's gate. A cached document commits in microtasks, before the view transition's old
//      snapshot exists, and the glide would morph the new page into itself (note 10, 4.5, probed). The
//      gate opens when the old snapshot is taken, or after 500 ms (lib/glide.ts GATE_MAX_MS).
//   2. A GET takes the prefetched answer when there is one (islands/prefetch.ts), as `clone()` of the
//      unread `Response`, else fetches with the runtime's own request shape.
//   3. The answer is checked, and anything that is not an islands document of THIS build becomes a
//      document load of the same URL (`location.assign`) and an `AbortError` here, so the runtime never
//      diffs a static shell, a proxy's page or a 500 text into the page (note 10, 6.3: a dead page
//      otherwise): a status of 500 or more, no `X-Collie-Document: islands`, an `X-Collie-Build` that
//      is not the running bundle's (a deploy happened: old JS must not run new HTML), a fetch that
//      rejects (offline, the network). 4xx with an islands document is drawn (the runtime's default
//      accepts 4xx HTML). A 403 mid-session answers with the static shell, which has no marker, so it
//      takes the document load too, and the static shell boots on its own (or the service worker's).
//   4. The stores are primed from the new document's data block BEFORE the runtime diffs it in, so the
//      islands that re-render with the new page's props read the new page's data (islands/seed.ts).
//   5. Redirects: the runtime follows `redirected` on the `Response`, which `clone()` keeps.
//   A non-GET top-frame request (a form; there are none before S4) is fetched with its body and goes
//   through the same checks, so an answer that is not a document (a 204) never empties the page.
//
// NAMED FRAMES: the pane's two (S2, held by the beat, routes/pane/pane-frames.ts), the snapshot frames
// (`home-list` and the rest, held by the snapshot beat, islands/snapshot-frames.ts), and any other with
// the runtime's default request.
import type { ResolveFrameOptions } from "remix/component";

import { BUILD } from "@web/lib/build";

import { glideGate } from "../lib/glide";
import { isPaneFrameName } from "../routes/pane/frames";
import { documentDataOf } from "./document-data";
import { refusalOf, type Refusal } from "./refusal";
import { DOCUMENT_HEADERS, takePrefetched } from "./prefetch";
import { seedFromDocument } from "./seed";
import { isSnapshotFrameName, resolveSnapshotFrame } from "./snapshot-frames";

interface LastRefusal {
  reason: Refusal | null;
  href: string;
}

/** The last refusal, read by e2e/islands.spec.ts. */
export const lastRefusal: LastRefusal = { reason: null, href: "" };
if ("document" in globalThis) Object.assign(globalThis, { __collieRefusal: lastRefusal });

/** Leave the runtime for a document load of `href`. Never returns. */
function hardNavigate(href: string, reason: Refusal): never {
  lastRefusal.reason = reason;
  lastRefusal.href = href;
  console.info(`Collie: ${reason}, loading ${href} as a document`);
  window.location.assign(href);
  throw new DOMException(`Collie: ${reason}`, "AbortError");
}

/** A form's body, as the runtime's default resolver encodes it. */
function requestBody(options: ResolveFrameOptions | undefined): BodyInit | undefined {
  const formData = options?.formData;
  const method = options?.method?.toLowerCase();
  if (!formData || !method || method === "get" || method === "head") return undefined;
  if (options?.encType === "application/x-www-form-urlencoded") {
    const params = new URLSearchParams();
    for (const [name, value] of formData) params.append(name, value instanceof File ? value.name : value);
    return params;
  }
  return formData;
}

async function resolveTop(src: string, options: ResolveFrameOptions | undefined): Promise<Response> {
  const gate = glideGate();
  if (gate) await gate;
  const url = new URL(src, document.baseURI);
  const method = options?.method?.toUpperCase() ?? "GET";
  const prefetched = method === "GET" ? await takePrefetched(url.href) : null;
  let response = prefetched?.response ?? null;
  if (response === null) {
    try {
      response = await fetch(url, { headers: DOCUMENT_HEADERS, method, body: requestBody(options), mode: "same-origin", signal: options?.signal });
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      hardNavigate(url.href, "network");
    }
  }
  const refused = refusalOf(response, BUILD.id);
  if (refused !== null) hardNavigate(response.redirected ? response.url : url.href, refused);
  // Read a COPY for the data block (a prefetch read it already); the runtime gets the unread original.
  const text = (await prefetched?.text) ?? (await response.clone().text());
  const data = documentDataOf(text);
  if (data === null) hardNavigate(url.href, "not-a-document");
  if (options?.signal?.aborted) throw new DOMException("superseded", "AbortError");
  await seedFromDocument(data);
  return response;
}

/** A named frame no beat holds: the runtime's default request. */
async function fetchNamedFrame(src: string, target: string, options: ResolveFrameOptions | undefined): Promise<Response> {
  const response = await fetch(src, {
    headers: { ...DOCUMENT_HEADERS, "X-Remix-Target": target },
    method: options?.method,
    body: requestBody(options),
    mode: "same-origin",
    signal: options?.signal,
  });
  const html = response.headers.get("Content-Type")?.toLowerCase().includes("text/html") ?? false;
  if (response.status >= 500 || (response.status >= 300 && !html)) {
    throw new Error(`Failed to resolve frame: ${String(response.status)} ${response.statusText}`.trimEnd());
  }
  return response;
}

/** `resolveFrame` for the islands runtime (islands/boot.ts). */
export async function resolveIslandFrame(src: string, options?: ResolveFrameOptions): Promise<Response | string> {
  const target = options?.target;
  if (target == null) return resolveTop(src, options);
  // The pane frames' module is a pane page's only (it brings the dialog model); the dashboard never loads it.
  if (isPaneFrameName(target)) return (await import("../routes/pane/pane-frames")).resolvePaneFrame(src, target, options?.signal);
  if (isSnapshotFrameName(target)) return resolveSnapshotFrame(src, target, options?.signal);
  return fetchNamedFrame(src, target, options);
}
