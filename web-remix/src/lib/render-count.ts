// A render counter for tests: `window.__collieRenders[name]` counts the render passes of the
// components that call `countRender(name)`. On in a dev build, and in a production build only when
// the document was opened with `?debug` in its URL (the e2e sets it; e2e/quiet-polls.spec.ts). Off,
// each call is one boolean test. Nothing reads the counts but a test.

declare global {
  interface Window {
    __collieRenders?: Record<string, number>;
  }
}

function enabled(): boolean {
  if (!("window" in globalThis)) return false;
  if (import.meta.env?.MODE !== "production") return true;
  try {
    return new URLSearchParams(window.location.search).has("debug");
  } catch {
    return false;
  }
}

const on = enabled();

/** Count one render pass of `name` (call it first thing in the render function). */
export function countRender(name: string): void {
  if (!on) return;
  const counts = (window.__collieRenders ??= {});
  counts[name] = (counts[name] ?? 0) + 1;
}
