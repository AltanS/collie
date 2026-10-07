// The server-render switch (S1, `experiments/remix-v3/ACTION-PLAN.md` B): true only while the bridge
// builds a document's component tree, which is ONE synchronous call (`renderToStream` builds every
// segment inside the stream's `start`, before its first await; `ssr/render.test.tsx` pins that).
//
// Why a flag and not `"document" in globalThis`: the unit tests run with no document too, and they
// must keep exercising the real paths (`want`, the pairing latch, the stores). Only a server render
// turns setup side effects off: a registration that would outlive the request (a poll source, a
// listener on a module set, a timer) has no `handle.signal` abort to end it on the server, where the
// signal is a frozen one that never aborts (C/src/server/stream.ts `ssrSignal`).
//
// The flag also carries the mount (ADR 0052) for links drawn during the render: web's
// `basePath()` reads `<meta name="collie-base">` from the live document, and there is none on Bun,
// so with no document it asks the source this module installs (web/src/lib/base-path.ts).

import { setServerMountSource } from "@web/lib/base-path";

interface ServerRender {
  /** The mount the document is served under, `/` or `/collie/`. */
  base: string;
}

let current: ServerRender | null = null;

// web's `basePath()` asks this when there is no document; outside a render that is a unit test, `/`.
setServerMountSource(() => current?.base ?? "/");

/** True while a server render builds its tree. Setup code that registers anything checks it first. */
export function onServer(): boolean {
  return current !== null;
}

/** The mount of the document being rendered on the server, or null in the browser. */
export function serverBase(): string | null {
  return current?.base ?? null;
}

/**
 * Run `build` with the switch on. `build` must be synchronous: the switch is a module variable, and
 * only a synchronous build keeps two requests from seeing each other's state.
 */
export function withServerRender<T>(base: string, build: () => T): T {
  if (current !== null) throw new Error("server-render: a render is already in progress");
  current = { base };
  try {
    return build();
  } finally {
    current = null;
  }
}
