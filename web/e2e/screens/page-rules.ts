// THE PAGE HALF OF THE SCREEN LIST'S RULES: R1 to R3, as DOM code that runs inside a page. Like the hitbox scanner
// (`src/playground/hitbox/scan.ts`) this file imports nothing at runtime and holds only top-level functions, so
// `rules.ts` can turn it into JavaScript, strip the `export`s and install it before the page's scripts. Keep it that way.
// The rules themselves are written down in `rules.ts`.

export type RuleId = "no-sideways-scroll" | "no-cut-text" | "nothing-covers-a-label" | "targets";

export interface Violation {
  rule: RuleId;
  /** A short selector that finds the element again, with the start of its text. */
  selector: string;
  detail: string;
}

export interface LayoutOptions {
  /** CSS selector of the one subtree R3 looks at (an open dialog hides the page under it). Null: the document. */
  root: string | null;
}

declare global {
  interface Window {
    __screensCheck?: (opts: LayoutOptions) => Violation[];
  }
}

const SKIP = new Set(["INPUT", "TEXTAREA", "SELECT", "OPTION", "SCRIPT", "STYLE", "NOSCRIPT", "TITLE", "HEAD"]);
const CONTROL = "button, a[href], [role=tab], [role=button], [role=link]";

function short(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let depth = 0; cur !== null && cur !== document.body && depth < 4; depth += 1) {
    const slot = cur.getAttribute("data-slot");
    let seg = cur.tagName.toLowerCase();
    if (slot !== null) seg += `[data-slot="${slot}"]`;
    else if (cur.getAttribute("aria-label") !== null && depth === 0) seg += `[aria-label="${(cur.getAttribute("aria-label") ?? "").slice(0, 32)}"]`;
    parts.unshift(seg);
    if (slot !== null && depth > 0) break;
    cur = cur.parentElement;
  }
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 32);
  return `${parts.join(" > ")}${text === "" ? "" : ` "${text}"`}`;
}

function shown(el: Element): boolean {
  for (let p: Element | null = el; p !== null; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return false;
    if (Number(s.opacity) === 0) return false;
  }
  return true;
}

/** True when `x, y` lies inside every ancestor that clips: the point is really drawn. */
function unclipped(el: Element, x: number, y: number): boolean {
  for (let p = el.parentElement; p !== null; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (s.overflowX === "visible" && s.overflowY === "visible") continue;
    const b = p.getBoundingClientRect();
    if (x < b.left || x > b.right || y < b.top || y > b.bottom) return false;
  }
  return true;
}

/** The screen-reader-only pattern: a box of 2px or less that clips what it holds. Nobody sees it, so no rule reads it. */
function hidden(el: Element): boolean {
  const b = el.getBoundingClientRect();
  return b.width <= 2 || b.height <= 2;
}

function scrollsX(s: CSSStyleDeclaration): boolean {
  return s.overflowX === "auto" || s.overflowX === "scroll";
}

function hasOwnText(el: Element): boolean {
  return Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
}

function masked(s: CSSStyleDeclaration): boolean {
  const m = s.maskImage !== "" && s.maskImage !== "none" ? s.maskImage : s.getPropertyValue("-webkit-mask-image");
  return m !== "" && m !== "none";
}

/** R1. The document, the body, `main` and everything above it; then any other scroller that fills a large part of the window and does not scroll sideways on purpose. */
function sideways(): Violation[] {
  const targets: Element[] = [document.documentElement, document.body];
  for (let p: Element | null = document.querySelector("main"); p !== null; p = p.parentElement) targets.push(p);
  for (const el of Array.from(document.querySelectorAll("*"))) {
    if (targets.includes(el)) continue;
    const s = getComputedStyle(el);
    if ((s.overflowY !== "auto" && s.overflowY !== "scroll") || scrollsX(s)) continue;
    const b = el.getBoundingClientRect();
    if (b.width * b.height >= window.innerWidth * window.innerHeight * 0.4) targets.push(el);
  }
  const out: Violation[] = [];
  for (const el of targets) {
    const over = el.scrollWidth - el.clientWidth;
    if (over <= 1) continue;
    out.push({ rule: "no-sideways-scroll", selector: short(el), detail: `scrolls sideways by ${String(over)}px (scrollWidth ${String(el.scrollWidth)}, clientWidth ${String(el.clientWidth)})` });
  }
  return out;
}

/** R2. An element with text of its own, wider than its box, with no sign that it is cut. */
function cutText(): Violation[] {
  const out: Violation[] = [];
  for (const el of Array.from(document.querySelectorAll("*"))) {
    if (SKIP.has(el.tagName) || el instanceof SVGElement || !hasOwnText(el)) continue;
    if (el.clientWidth === 0 || el.scrollWidth <= el.clientWidth + 1) continue;
    if (!shown(el) || hidden(el)) continue;
    const s = getComputedStyle(el);
    if (s.textOverflow === "ellipsis" || masked(s) || scrollsX(s)) continue;
    let excused = false;
    for (let p = el.parentElement; p !== null && !excused; p = p.parentElement) {
      const ps = getComputedStyle(p);
      excused = masked(ps) || (scrollsX(ps) && p.scrollWidth > p.clientWidth + 1);
    }
    if (excused) continue;
    out.push({ rule: "no-cut-text", selector: short(el), detail: `text is ${String(el.scrollWidth)}px wide in a ${String(el.clientWidth)}px box, with no ellipsis, fade or scroller` });
  }
  return out;
}

/** The point to hit for an element: the middle of its widest line of own text, or the middle of a control's box. Null when it is off the window or clipped away. */
function centreOf(el: Element): { x: number; y: number } | null {
  let rect: DOMRect | null = null;
  if (hasOwnText(el) && !el.matches(CONTROL)) {
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType !== Node.TEXT_NODE || (n.textContent ?? "").trim() === "") continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of Array.from(range.getClientRects())) if (r.width > 0 && r.height > 0 && (rect === null || r.width > rect.width)) rect = r;
    }
  } else {
    const b = el.getBoundingClientRect();
    if (b.width > 0 && b.height > 0) rect = b;
  }
  if (rect === null) return null;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return null;
  return unclipped(el, x, y) ? { x, y } : null;
}

function describe(el: Element | null): string {
  if (el === null) return "nothing";
  const slot = el.getAttribute("data-slot");
  const aria = el.getAttribute("aria-label");
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
  return `${el.tagName.toLowerCase()}${slot === null ? "" : `[data-slot="${slot}"]`}${aria === null ? "" : `[aria-label="${aria.slice(0, 24)}"]`}${text === "" ? "" : ` "${text}"`}`;
}

/** Whether the element draws something of its own: a fill, an image, a border, a shadow, or a pseudo-element that does. */
function paints(el: Element): boolean {
  if (el instanceof SVGElement || el instanceof HTMLImageElement || el instanceof HTMLCanvasElement || el instanceof HTMLVideoElement) return true;
  for (const pseudo of [null, "::before", "::after"] as const) {
    const s = getComputedStyle(el, pseudo);
    if (pseudo !== null && (s.content === "none" || s.content === "normal")) continue;
    const bg = s.backgroundColor;
    if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return true;
    if (s.backgroundImage !== "none" || s.boxShadow !== "none") return true;
    for (const side of ["top", "right", "bottom", "left"]) {
      if (Number.parseFloat(s.getPropertyValue(`border-${side}-width`)) > 0 && s.getPropertyValue(`border-${side}-style`) !== "none") return true;
    }
  }
  return false;
}

function fixedLayer(el: Element): boolean {
  for (let p: Element | null = el; p !== null; p = p.parentElement) {
    const pos = getComputedStyle(p).position;
    if (pos === "fixed" || pos === "sticky") return true;
  }
  return false;
}

/** The element sits in a scroller that really scrolls and the cover is outside it: scrolling clears it. */
function scrollsUnder(el: Element, top: Element): boolean {
  for (let p = el.parentElement; p !== null; p = p.parentElement) {
    const s = getComputedStyle(p);
    const scrolls = (scrollsX(s) && p.scrollWidth > p.clientWidth + 1) || ((s.overflowY === "auto" || s.overflowY === "scroll") && p.scrollHeight > p.clientHeight + 1);
    if (scrolls && !p.contains(top)) return true;
  }
  return false;
}

/** R3. A hit test at the centre of what a person reads or presses. */
function covers(root: string | null): Violation[] {
  const scope: ParentNode = root === null ? document : (document.querySelector(root) ?? document);
  const out: Violation[] = [];
  for (const el of Array.from(scope.querySelectorAll("*"))) {
    if (SKIP.has(el.tagName) || el instanceof SVGElement) continue;
    const control = el.matches(CONTROL);
    if (!control && !hasOwnText(el)) continue;
    if (!shown(el) || hidden(el) || getComputedStyle(el).pointerEvents === "none") continue;
    // A sheet's backdrop is a button as large as the window, and it lies under its own sheet on purpose.
    const size = el.getBoundingClientRect();
    if (control && size.width >= window.innerWidth * 0.9 && size.height >= window.innerHeight * 0.9) continue;
    const at = centreOf(el);
    if (at === null) continue;
    const top = document.elementFromPoint(at.x, at.y);
    // No top element at all: the centre is on or past the window's edge (elementFromPoint answers null only there), a
    // label half below the fold of a page that scrolls. That is no cover; a window too narrow for a label is R1's.
    if (top === null) continue;
    if (top !== null && (top === el || el.contains(top) || top.contains(el))) continue;
    // Not a cover a person can see: a hit area that paints nothing (a card's stretched link), chrome that content scrolls
    // under (a fixed or sticky bar), or a pinned control over the end of a scroller.
    if (top !== null && !paints(top) && !hasOwnText(top)) continue;
    if (top !== null && fixedLayer(top) && !fixedLayer(el)) continue;
    if (top !== null && scrollsUnder(el, top)) continue;
    out.push({ rule: "nothing-covers-a-label", selector: short(el), detail: `at (${String(Math.round(at.x))}, ${String(Math.round(at.y))}) the top element is ${describe(top)}` });
  }
  return out;
}

/** R1 to R3 on the page as it stands. */
export function checkLayout(opts: LayoutOptions): Violation[] {
  return [...sideways(), ...cutText(), ...covers(opts.root)];
}
