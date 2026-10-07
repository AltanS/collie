// The shell's runtime: `run({ loadModule, resolveFrame })` from remix/component, in place of
// `run(router)` from remix/spa (S1, `experiments/remix-v3/ACTION-PLAN.md` B).
//
// WHY NOT remix/spa. Its `run` clears `<body>` and renders again (research note 08, 2.1, probed): it
// can never adopt a server document. remix/component's `run` hydrates `clientEntry` islands in place
// (08, 2.2). remix/spa's own `run` is about thirty lines over that call, and this file is those
// lines with the one change that matters: `loadModule` answers the shell's island registry instead
// of throwing. Navigation stays in the browser: the top frame and unnamed frames resolve through the
// local router with the shell's existing `render` middleware and come back as `spaResponse`
// (08, 2.4). A named frame is fetched from the bridge: the pane's two (S2, `pane-screen` and
// `pane-status`) through routes/pane/pane-frames.ts, which answers from what the beat already brought,
// any other through remix/component's default request.
//
// The first routed navigation after a server boot replaces the body once (08, 2.4.3): the top frame
// has no content root yet, so it clears the hydrated island and builds one. The route tree is the
// same as the island's (app-root.tsx), so the swap draws the same screen.
import { run, spaResponse, type AppRuntime, type LoadModule, type ResolveFrameOptions } from "remix/component";
import type { Router } from "remix/spa";

import { isPaneFrameName } from "../routes/pane/frames";
import { resolvePaneFrame } from "../routes/pane/pane-frames";

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;

/** remix/spa's `followFrameRedirects`: up to ten hops, same origin only, 303 and POST turn into GET. */
async function followRedirects(
  router: Router,
  start: URL,
  init: RequestInit,
): Promise<{ response: Response; redirectedTo?: string }> {
  let url = start;
  let method = init.method?.toUpperCase() ?? "GET";
  let body = init.body;
  let redirectedTo: string | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await router.fetch(url, { ...init, method, body });
    if (!REDIRECTS.has(response.status)) return { response, redirectedTo };
    const location = response.headers.get("Location");
    if (!location) return { response };
    if (hop === MAX_REDIRECTS) break;
    const next = new URL(location, url);
    if (next.origin !== start.origin) throw new TypeError("SPA routes cannot redirect to another origin");
    const toGet =
      (response.status === 303 && method !== "GET" && method !== "HEAD") ||
      ((response.status === 301 || response.status === 302) && method === "POST");
    if (toGet) {
      method = "GET";
      body = undefined;
    }
    url = next;
    redirectedTo = url.href;
  }
  throw new TypeError(`SPA route exceeded ${String(MAX_REDIRECTS)} redirects`);
}

/** A form field as text: a file field sends its name, as a browser's own text encodings do. */
function fieldText(value: FormDataEntryValue): string {
  return value instanceof File ? value.name : value;
}

/** CRLF line ends, as `text/plain` form encoding writes them. */
function crlf(value: string): string {
  return value.replace(/\r\n|\r|\n/g, "\r\n");
}

/** remix/spa's `getRequestBody`: a raw FormData reload keeps the form's own encoding. */
function requestBody(options?: ResolveFrameOptions): BodyInit | undefined {
  const formData = options?.formData;
  const method = options?.method;
  if (!formData || !method || ["get", "head"].includes(method.toLowerCase())) return undefined;
  if (options.encType === "text/plain") {
    let text = "";
    for (const [name, value] of formData) text += `${crlf(name)}=${crlf(fieldText(value))}\r\n`;
    return new Blob([text], { type: "text/plain" });
  }
  if (options.encType !== "application/x-www-form-urlencoded") return formData;
  const params = new URLSearchParams();
  for (const [name, value] of formData) params.append(name, fieldText(value));
  return params;
}

/** A named frame from the bridge, as remix/component's default resolver asks for it. */
async function fetchNamedFrame(src: string, target: string, options: ResolveFrameOptions): Promise<Response> {
  const response = await fetch(src, {
    body: requestBody(options),
    headers: { Accept: "text/html", "X-Remix-Frame": "true", "X-Remix-Target": target },
    method: options.method,
    mode: "same-origin",
    signal: options.signal,
  });
  const html = response.headers.get("Content-Type")?.toLowerCase().includes("text/html") ?? false;
  if (response.status >= 500 || (response.status >= 300 && !html)) {
    throw new Error(`Failed to resolve frame: ${String(response.status)} ${response.statusText}`.trimEnd());
  }
  return response;
}

/** Start the runtime over `router`, hydrating whatever islands the document holds through `loadModule`. */
export function startAppRuntime(router: Router, loadModule: LoadModule): AppRuntime {
  return run({
    loadModule,
    async resolveFrame(src, options) {
      const target = options?.target;
      if (isPaneFrameName(target)) return resolvePaneFrame(src, target, options?.signal);
      if (target != null) return fetchNamedFrame(src, target, options ?? {});
      const { response, redirectedTo } = await followRedirects(router, new URL(src, document.baseURI), {
        method: options?.method,
        body: requestBody(options),
        signal: options?.signal,
      });
      return spaResponse.finalize(response, redirectedTo);
    },
  });
}
