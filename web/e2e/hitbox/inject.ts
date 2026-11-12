import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";
import { transformWithOxc } from "vite";

import type { ScanOptions, ScanResult } from "@/playground/hitbox/scan";

// THE SCANNER, PUT INTO A PAGE. `src/playground/hitbox/scan.ts` is DOM code with no imports, so it
// can run in a page as it stands once TypeScript has turned it into JavaScript and its `export`s are
// gone. This does exactly that and nothing else: the playground's overlays call the same file in
// place, so a number on the census and a rectangle on a card come from one function.

const SCAN_PATH = fileURLToPath(new URL("../../src/playground/hitbox/scan.ts", import.meta.url));

async function scanSource(): Promise<string> {
  const out = await transformWithOxc(readFileSync(SCAN_PATH, "utf8"), SCAN_PATH, { lang: "ts", target: "es2022" });
  return `${out.code.replaceAll(/^export /gm, "")}\nwindow.__hbScan = scanTargets;\n`;
}

/**
 * Before any script of the page runs: the scanner, and a record of every `addEventListener` call so
 * the census can say which native events an element listens to (React's own go through its root, and
 * are read off the element's props instead). Passive: it calls through to the real method.
 */
const LISTENER_REGISTRY = `
window.__hbListeners = new WeakMap();
const __add = EventTarget.prototype.addEventListener;
EventTarget.prototype.addEventListener = function (type, listener, options) {
  if (this instanceof Element) {
    let set = window.__hbListeners.get(this);
    if (!set) { set = new Set(); window.__hbListeners.set(this, set); }
    set.add(String(type));
  }
  return __add.call(this, type, listener, options);
};
`;

/** Install the scanner and the listener record. Call before the first `page.goto`. */
export async function installScanner(page: Page): Promise<void> {
  await page.addInitScript({ content: LISTENER_REGISTRY });
  await page.addInitScript({ content: await scanSource() });
}

/** Run the scanner in the page as it is now. */
export async function scan(page: Page, opts: ScanOptions = {}): Promise<ScanResult> {
  return page.evaluate((o) => {
    const run = window.__hbScan;
    if (run === undefined) throw new Error("the scanner is not installed: call installScanner before the first goto");
    return run(o);
  }, opts);
}
