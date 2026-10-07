// RECOVERY FROM A CORRUPT VDOM (kody survey, `experiments/remix-v3/research/07-kody.md` c.1).
//
// Something outside the runtime (Chrome Translate wrapping text nodes in `<font>`, an extension, a
// browser bug) can rewrite DOM the vdom still holds as diff anchors. Remix 3.0.0 then throws one of
// two errors, and after the first one every later tap can fail:
//
//   1. `NotFoundError: Failed to execute 'insertBefore' on 'Node'` out of the keyed move, then
//   2. `Framework invariant: Expected removed component to be committed` on the next navigation.
//
// A phone PWA stays open for days, so the page reloads itself ONCE. The match is exact on the
// wording (as kody's is), with no stack test: the stack is minified in production.
//
// LOOP GUARD. A fault that survives a reload would reload forever. A `sessionStorage` flag is set
// before the reload and cleared only after a successful boot (`main.tsx`), so the second failure in
// a row is left to the console. The flag lives per tab, so another tab is not held back.

/** The `sessionStorage` key the guard uses. */
export const RECONCILE_RELOAD_FLAG = "collie:reconcile-reload:v1";

/** The part of `Storage` the guard needs; a test passes a plain object. */
export interface FlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Whether `error` is one of the two reconcile failures. Exact wording, nothing wider. */
export function isReconcileError(error: Error): boolean {
  if (error.message.includes("Framework invariant: Expected removed component to be committed")) return true;
  return error.name === "NotFoundError" && error.message.includes("Failed to execute 'insertBefore'");
}

/**
 * Reload at most once per boot. Returns true when it asked for a reload. `reload` is injected so a
 * test needs no document; a storage that throws (private mode, a locked-down webview) counts as "no
 * reload", because an unguarded reload could loop.
 */
export function reloadOnReconcileError(error: Error, storage: FlagStorage | undefined, reload: () => void): boolean {
  if (!isReconcileError(error)) return false;
  if (storage === undefined) return false;
  try {
    if (storage.getItem(RECONCILE_RELOAD_FLAG) !== null) return false;
    storage.setItem(RECONCILE_RELOAD_FLAG, String(Date.now()));
  } catch {
    return false;
  }
  reload();
  return true;
}

/** A boot that got a screen up clears the flag, so a later fault in this tab may reload once again. */
export function clearReconcileReloadFlag(storage: FlagStorage | undefined): void {
  try {
    storage?.removeItem(RECONCILE_RELOAD_FLAG);
  } catch {
    // no storage: nothing was set
  }
}

/** `sessionStorage`, or undefined where the browser refuses even to name it. */
export function tabStorage(): FlagStorage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}
