// The one place Collie asks what the runtime it landed in can actually do.
//
// Collie's bundle evaluates in four places that are NOT the same environment: a modern phone
// browser, an older WebView, the service worker (`sw.ts` — no `window`, no `document`), and jsdom
// under Vitest (no `ResizeObserver`). Every one of those questions used to be answered inline with
// a bare `typeof X === "undefined"` scattered across the module that cared, which is the shape
// `anti-slop/no-runtime-typeof` exists to collect: a representation check standing in for a
// contract. The contract is "what this runtime provides", it is answered exactly once here, and
// every call site reads a plain value.
//
// These are FUNCTIONS, not module-scope constants, on purpose: a global can appear after this
// module is first imported (a test installing a `ResizeObserver`, a polyfill loading late), and a
// constant captured at import time would answer for the wrong runtime forever.
//
// Each probe asks `"name" in <its owner>` rather than `typeof name`: the question really is whether
// the runtime PROVIDES the capability, and the owner (`globalThis`, `Intl`, `AbortSignal`) is the
// thing that would provide it — so the check names what it means instead of inspecting a
// representation, and works unchanged in the page, the worker and jsdom.

/** True in a page (`window` exists). False in the service worker. */
export function hasWindow(): boolean {
  return "window" in globalThis;
}

/** True where a DOM document exists — a page, but not the service worker. */
export function hasDocument(): boolean {
  return "document" in globalThis;
}

/** True where element resizes can be observed. jsdom has no `ResizeObserver`. */
export function hasResizeObserver(): boolean {
  return "ResizeObserver" in globalThis;
}

/**
 * A grapheme segmenter, or `null` on an engine without `Intl.Segmenter` (Firefox <125, Safari
 * <14.1). Callers in the main chunk must fall back to per-code-point iteration rather than
 * constructing one at module evaluation, which would white-screen the whole PWA at boot.
 */
export function graphemeSegmenter(): Intl.Segmenter | null {
  if (!("Intl" in globalThis)) return null;
  if (!("Segmenter" in Intl)) return null;
  return new Intl.Segmenter(undefined, { granularity: "grapheme" });
}

/**
 * An abort signal that fires after `ms`, or `null` on an older WebView without
 * `AbortSignal.timeout` — where the caller degrades to no timeout rather than crashing.
 */
export function abortSignalAfter(ms: number): AbortSignal | null {
  if (!("timeout" in AbortSignal)) return null;
  return AbortSignal.timeout(ms);
}

/**
 * The composition of several abort signals (aborts when the first of them does), or `null` on an
 * engine without `AbortSignal.any`.
 */
export function abortSignalAny(signals: AbortSignal[]): AbortSignal | null {
  if (!("any" in AbortSignal)) return null;
  return AbortSignal.any(signals);
}
