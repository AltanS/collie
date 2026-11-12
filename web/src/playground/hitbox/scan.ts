// THE HITBOX SCANNER: finds every tap target under a root and measures what a finger actually
// reaches. It has TWO callers. `web/e2e/hitbox/*` transpiles this file, strips the `export`s and runs
// it inside a real Chromium page (`window.__hbScan`), and the playground's overlay cards call it in
// place on the real component they draw over. Both need it to run in a page and to need nothing from
// the app, so this file imports nothing and holds only DOM code: keep it that way.
//
// WHAT IT MEASURES, per interactive element:
//   box      the border box (`getBoundingClientRect`), the thing a person SEES as the control;
//   hit      the area where `document.elementFromPoint` returns the element or a child of it, found
//            by scanning the box plus a margin on every side, so a `::before` reach is found too;
//   probes   centre, four corners and four edge midpoints at 1px and at 4px inside the edge;
//   ink      the union of what the element paints (text, glyphs, its own fill and border);
//   gap      the distance from its box to the nearest OTHER target's box;
//   events   the handlers React holds on it (`__reactProps$…`) and the listeners added with
//            `addEventListener` when `window.__hbListeners` was installed before the page's scripts.
//
// IT NEVER PRESSES ANYTHING: it scrolls an element into view to read it and dispatches nothing.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScanOptions {
  /** CSS selector of the root to scan under. Default: the whole document. */
  root?: string;
  /** How far past the box the hit scan looks, in CSS px. Default 24: more than any reach in the app. */
  margin?: number;
  /** Scan every element with a handler, not only the browser's focusable ones. Default true. */
  handlers?: boolean;
  /** Scroll each target into view before reading it. Default true. */
  scroll?: boolean;
}

export interface Target {
  /** The accessible name, or the best text for it, at most 48 characters. */
  name: string;
  /** A short selector that finds it again: a `data-slot`, an id, or a tag path. */
  selector: string;
  tag: string;
  role: string | null;
  box: Rect;
  /** The bounding box of every point where the element (or a child) is hit. Null when none is. */
  hit: Rect | null;
  /** Share of the box's sample points that hit the element, 0..1, as measured with the target in the middle of its scroller. */
  hitShare: number;
  /** The same share where the target first stood, before it was scrolled to the middle. Null when it was not moved. */
  restShare: number | null;
  /** What covered it there, when that was not nothing. */
  restCoveredBy: string[];
  /** How far the hit area reaches beyond the box on each side (negative: stops short), in px. */
  reach: { top: number; right: number; bottom: number; left: number } | null;
  /** The probe points (centre, 4 corners, 4 edge midpoints, at 1px and 4px in) that did NOT hit. */
  probeMisses: string[];
  probeCount: number;
  /** What covers the box where it is not hit: up to three descriptions, most points first. */
  coveredBy: string[];
  /** What the element paints, or null when it paints nothing of its own (a bare overlay). */
  ink: Rect | null;
  /** The painted ancestor box (a card, a row, a ring) that reads as the control but is not it. */
  shell: Rect | null;
  /** Distance in px to the nearest other target's box, 0 when they touch or overlap. */
  gap: number | null;
  gapTo: string | null;
  /** The handlers and listeners found on the element. */
  events: string[];
  touchAction: string;
  pointerEvents: string;
  disabled: boolean;
  inline: boolean;
  /** A fixed or sticky ancestor, or the element itself. */
  fixed: boolean;
  opacity: number;
  /** Distance from the viewport's left and right edge to the hit area. */
  edge: { left: number; right: number };
  /** True when a hold on it does something else than the tap (`onContextMenu` with `onClickCapture`). */
  holdGuard: boolean;
}

export interface ScanResult {
  viewport: { w: number; h: number; dpr: number };
  targets: Target[];
}

const ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "combobox",
  "slider",
  "textbox",
  "searchbox",
  "spinbutton",
  "treeitem",
]);
const HANDLER_PROPS = ["onClick", "onPointerDown", "onPointerUp", "onTouchStart", "onTouchEnd", "onMouseDown", "onMouseUp"];
/** Handlers that are not a tap: a field's change, a key, a scroll. Left out of the events list. */
const NOT_A_TAP = /^on(Focus|Blur|Change|Input|Key|Scroll|Load|Error|Transition|Animation)/;
/** The native events a finger raises. React's form fields also hang `invalid`, `cancel` and the like on themselves. */
const TAP_EVENTS = new Set(["touchstart", "touchmove", "touchend", "touchcancel", "pointerdown", "pointerup", "pointermove", "pointercancel", "click", "mousedown", "mouseup", "contextmenu", "dblclick"]);

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function rectOf(r: { left: number; top: number; width: number; height: number }): Rect {
  return { x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height) };
}

function plain(x: number, y: number, w: number, h: number): Rect {
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}

declare global {
  interface Window {
    /** Filled by the census's init script: every `addEventListener` call, by element, before the app runs. */
    __hbListeners?: WeakMap<Element, Set<string>>;
  }
}

/** The props React keeps on a DOM node (`__reactProps$<id>`), or an empty list off a React tree. */
function reactPropsOf(el: Element): [string, unknown][] {
  const held = Object.entries(el).find(([key]) => key.startsWith("__reactProps$"));
  return held === undefined ? [] : Object.entries(held[1] ?? {});
}

/** Whether a prop is set: React leaves a handler it was not given as `undefined`. */
function propSet(props: [string, unknown][], name: string): boolean {
  return props.some(([key, value]) => key === name && value !== undefined && value !== null);
}

function listenersOf(el: Element): string[] {
  return Array.from(window.__hbListeners?.get(el) ?? []).filter((t) => TAP_EVENTS.has(t));
}

function eventsOf(el: Element): string[] {
  const out = new Set<string>();
  for (const [key, value] of reactPropsOf(el)) {
    if (/^on[A-Z]/.test(key) && value !== undefined && value !== null && !NOT_A_TAP.test(key)) out.add(key);
  }
  for (const t of listenersOf(el)) out.add(t);
  return Array.from(out).toSorted();
}

function isNatively(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "button" || tag === "select" || tag === "textarea" || tag === "summary") return true;
  if (tag === "a") return el.hasAttribute("href");
  if (el instanceof HTMLInputElement) return el.type !== "hidden";
  const role = el.getAttribute("role");
  if (role !== null && ROLES.has(role)) return true;
  const tabindex = el.getAttribute("tabindex");
  if (tabindex !== null && Number(tabindex) >= 0) return true;
  const editable = el.getAttribute("contenteditable");
  return editable === "true" || editable === "";
}

function hasHandler(el: Element): boolean {
  const props = reactPropsOf(el);
  return HANDLER_PROPS.some((k) => propSet(props, k));
}

function painted(el: Element): boolean {
  const s = getComputedStyle(el);
  const bg = s.backgroundColor;
  const hasBg = bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
  const hasBorder = ["top", "right", "bottom", "left"].some(
    (side) => parseFloat(s.getPropertyValue(`border-${side}-width`)) > 0 && s.getPropertyValue(`border-${side}-style`) !== "none",
  );
  return hasBg || hasBorder || s.backgroundImage !== "none";
}

function nameOf(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria !== null && aria.trim() !== "") return aria.trim().slice(0, 48);
  const by = el.getAttribute("aria-labelledby");
  if (by !== null) {
    const text = by
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    if (text !== "") return text.slice(0, 48);
  }
  const text = (el instanceof HTMLElement ? el.innerText : (el.textContent ?? "")).replace(/\s+/g, " ").trim();
  if (text !== "") return text.slice(0, 48);
  const title = el.getAttribute("title") ?? el.getAttribute("placeholder") ?? "";
  if (title !== "") return title.slice(0, 48);
  const alt = el.querySelector("img[alt]")?.getAttribute("alt") ?? "";
  if (alt !== "") return alt.slice(0, 48);
  const slot = el.getAttribute("data-slot");
  return slot !== null ? `[${slot}]` : `<${el.tagName.toLowerCase()}>`;
}

function selectorOf(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let depth = 0; cur !== null && cur !== document.body && depth < 4; depth += 1) {
    const slot = cur.getAttribute("data-slot");
    if (cur.id !== "" && !/^[:r]|\d{3,}/.test(cur.id)) {
      parts.unshift(`#${CSS.escape(cur.id)}`);
      break;
    }
    let seg = cur.tagName.toLowerCase();
    if (slot !== null) seg += `[data-slot="${slot}"]`;
    else if (cur.getAttribute("aria-label") !== null && depth === 0) seg += `[aria-label="${(cur.getAttribute("aria-label") ?? "").slice(0, 32)}"]`;
    else if (cur.parentElement !== null) {
      const same = Array.from(cur.parentElement.children).filter((c) => c.tagName === cur?.tagName);
      if (same.length > 1) seg += `:nth-of-type(${String(same.indexOf(cur) + 1)})`;
    }
    parts.unshift(seg);
    if (slot !== null && depth > 0) break;
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}

/** The visible rectangle of an element: its box, cut by the viewport and by every ancestor that clips. */
function clippedBox(el: Element): Rect | null {
  const b = el.getBoundingClientRect();
  let x0 = Math.max(b.left, 0);
  let y0 = Math.max(b.top, 0);
  let x1 = Math.min(b.right, window.innerWidth);
  let y1 = Math.min(b.bottom, window.innerHeight);
  for (let p = el.parentElement; p !== null; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (s.overflowX === "visible" && s.overflowY === "visible") continue;
    const pb = p.getBoundingClientRect();
    if (s.overflowX !== "visible") {
      x0 = Math.max(x0, pb.left);
      x1 = Math.min(x1, pb.right);
    }
    if (s.overflowY !== "visible") {
      y0 = Math.max(y0, pb.top);
      y1 = Math.min(y1, pb.bottom);
    }
  }
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function describeCover(hit: Element | null): string {
  if (hit === null) return "nothing";
  const slot = hit.getAttribute("data-slot");
  const aria = hit.getAttribute("aria-label");
  const cls = (hit.getAttribute("class") ?? "").split(/\s+/).slice(0, 3).join(".");
  const tag = hit.tagName.toLowerCase();
  if (slot !== null) return `${tag}[${slot}]`;
  if (aria !== null) return `${tag}[${aria.slice(0, 24)}]`;
  return cls === "" ? tag : `${tag}.${cls}`;
}

function isHit(el: Element, at: Element | null): boolean {
  if (at === null) return false;
  if (at === el || el.contains(at)) return true;
  // A tap on a LABEL's own padding is a tap on its control: the browser forwards the click and the focus
  // (a search field inside a padded row takes the whole row). `control` is that association, whether by
  // nesting or by `for`.
  return at instanceof HTMLLabelElement && at.control === el;
}

function fixedOrSticky(el: Element): boolean {
  for (let p: Element | null = el; p !== null; p = p.parentElement) {
    const pos = getComputedStyle(p).position;
    if (pos === "fixed" || pos === "sticky") return true;
  }
  return false;
}

/** What the element paints: its own fill and border, else the union of what its children paint. */
function inkOf(el: Element, box: DOMRect): Rect | null {
  const inks: { left: number; top: number; right: number; bottom: number }[] = [];
  if (painted(el)) inks.push(box);
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    if (n instanceof Text) {
      if ((n.textContent ?? "").trim() === "") continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of Array.from(range.getClientRects())) if (r.width > 0 && r.height > 0) inks.push(r);
      continue;
    }
    if (!(n instanceof Element)) continue;
    const tag = n.tagName.toLowerCase();
    const cs = getComputedStyle(n);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
    const draws = tag === "svg" || tag === "img" || tag === "canvas" || tag === "video" || (!(n instanceof SVGElement) && painted(n));
    if (!draws) continue;
    const r = n.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) inks.push(r);
  }
  if (inks.length === 0) return null;
  const x0 = Math.min(...inks.map((r) => r.left));
  const y0 = Math.min(...inks.map((r) => r.top));
  const x1 = Math.max(...inks.map((r) => r.right));
  const y1 = Math.max(...inks.map((r) => r.bottom));
  return plain(x0, y0, x1 - x0, y1 - y0);
}

/** A painted ancestor that reads as the control and is larger than what the finger reaches: a card, a ring. */
function shellOf(el: Element, box: DOMRect, reach: Rect): Rect | null {
  let p = el.parentElement;
  for (let depth = 0; p !== null && depth < 3; depth += 1, p = p.parentElement) {
    if (isNatively(p) || p === document.body) return null;
    const pb = p.getBoundingClientRect();
    if (pb.width * pb.height > box.width * box.height * 4) return null;
    if (!painted(p)) continue;
    const slack = Math.max(
      pb.left < reach.x - 3 ? reach.x - pb.left : 0,
      pb.right > reach.x + reach.w + 3 ? pb.right - (reach.x + reach.w) : 0,
      pb.top < reach.y - 3 ? reach.y - pb.top : 0,
      pb.bottom > reach.y + reach.h + 3 ? pb.bottom - (reach.y + reach.h) : 0,
    );
    if (slack > 0) return rectOf(pb);
  }
  return null;
}

/** The elements a finger can press under `root`, the browser's own controls and the ones React wires a handler to. */
function collect(root: ParentNode, withHandlers: boolean): Element[] {
  const candidates: Element[] = [];
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (el.tagName === "HTML" || el.tagName === "BODY") continue;
    const natively = isNatively(el);
    if (el.closest("[aria-hidden='true'], [inert]") !== null && !natively) continue;
    if (el instanceof SVGElement && el.tagName.toLowerCase() !== "svg") continue;
    if (!natively && !(withHandlers && hasHandler(el))) continue;
    if (el.closest("[data-hb-skip]") !== null) continue;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") continue;
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) continue;
    candidates.push(el);
  }
  // A handler-only wrapper whose child is the real control is the same target twice: keep the control.
  const natives = candidates.filter(isNatively);
  return candidates.filter((el) => {
    if (natives.includes(el)) return true;
    const area = el.getBoundingClientRect().width * el.getBoundingClientRect().height;
    return !natives.some((n) => el.contains(n) && area <= n.getBoundingClientRect().width * n.getBoundingClientRect().height * 1.05);
  });
}


interface HitMeasure {
  hit: Rect | null;
  hitShare: number;
  reach: Target["reach"];
  probeMisses: string[];
  probeCount: number;
  coveredBy: string[];
}

/** Where a finger lands on the element as it stands now: the probes, then the scan. */
function measureHit(el: Element, margin: number): HitMeasure {
  const box = el.getBoundingClientRect();
  const vis = clippedBox(el);
  let hit: Rect | null = null;
  let hitShare = 0;
  let reach: Target["reach"] = null;
  const coverCount = new Map<string, number>();
  const probeMisses: string[] = [];
  let probeCount = 0;
  if (vis !== null) {
    // The probe points of the brief: centre, four corners, four edge midpoints, at 1px and at 4px in.
    const probeAt = (label: string, x: number, y: number) => {
      probeCount += 1;
      if (!isHit(el, document.elementFromPoint(x, y))) probeMisses.push(label);
    };
    for (const inset of [1, 4]) {
      const ix = Math.min(inset, vis.w / 2 - 0.01);
      const iy = Math.min(inset, vis.h / 2 - 0.01);
      const l = vis.x + ix;
      const r = vis.x + vis.w - ix;
      const t = vis.y + iy;
      const b = vis.y + vis.h - iy;
      const cx = vis.x + vis.w / 2;
      const cy = vis.y + vis.h / 2;
      const at = String(inset);
      if (inset === 1) probeAt("centre", cx, cy);
      probeAt(`corner-tl@${at}`, l, t);
      probeAt(`corner-tr@${at}`, r, t);
      probeAt(`corner-bl@${at}`, l, b);
      probeAt(`corner-br@${at}`, r, b);
      probeAt(`edge-t@${at}`, cx, t);
      probeAt(`edge-b@${at}`, cx, b);
      probeAt(`edge-l@${at}`, l, cy);
      probeAt(`edge-r@${at}`, r, cy);
    }
    // The scan: the visible box plus the margin, clipped to the viewport. The step is 2px on a small
    // target and wider on a big one, so a full-width row costs about what a chip does.
    const sx0 = Math.max(0, vis.x - margin);
    const sy0 = Math.max(0, vis.y - margin);
    const sx1 = Math.min(window.innerWidth - 0.01, vis.x + vis.w + margin);
    const sy1 = Math.min(window.innerHeight - 0.01, vis.y + vis.h + margin);
    const step = Math.max(2, Math.ceil(Math.max(vis.w, vis.h) / 90));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let inBox = 0;
    let inBoxHit = 0;
    for (let y = sy0 + step / 2; y < sy1; y += step) {
      for (let x = sx0 + step / 2; x < sx1; x += step) {
        const at = document.elementFromPoint(x, y);
        const hitHere = isHit(el, at);
        if (x >= vis.x && x <= vis.x + vis.w && y >= vis.y && y <= vis.y + vis.h) {
          inBox += 1;
          if (hitHere) inBoxHit += 1;
          else {
            const d = describeCover(at);
            coverCount.set(d, (coverCount.get(d) ?? 0) + 1);
          }
        }
        if (hitHere) {
          minX = Math.min(minX, x - step / 2);
          maxX = Math.max(maxX, x + step / 2);
          minY = Math.min(minY, y - step / 2);
          maxY = Math.max(maxY, y + step / 2);
        }
      }
    }
    hitShare = inBox === 0 ? 0 : round(inBoxHit / inBox);
    if (Number.isFinite(minX)) {
      // The scan's own cell is `step` wide, so a hit area that fills the box can read up to half a
      // step past it. Clamp to the box where it agrees within that, so a plain button says reach 0.
      const snap = (v: number, edge: number) => (Math.abs(v - edge) <= step / 2 + 0.01 ? edge : v);
      const hx0 = snap(minX, vis.x);
      const hy0 = snap(minY, vis.y);
      const hx1 = snap(maxX, vis.x + vis.w);
      const hy1 = snap(maxY, vis.y + vis.h);
      hit = plain(hx0, hy0, hx1 - hx0, hy1 - hy0);
      reach = { top: round(box.top - hy0), right: round(hx1 - box.right), bottom: round(hy1 - box.bottom), left: round(box.left - hx0) };
    }
  }

  return {
    hit,
    hitShare,
    reach,
    probeMisses,
    probeCount,
    coveredBy: Array.from(coverCount.entries())
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([d, n]) => `${d} x${String(n)}`),
  };
}

/** Scan the page (or `opts.root`) for tap targets. */
export function scanTargets(opts: ScanOptions = {}): ScanResult {
  const margin = opts.margin ?? 24;
  const doScroll = opts.scroll ?? true;
  const root: ParentNode = opts.root === undefined ? document : (document.querySelector(opts.root) ?? document);
  const els = collect(root, opts.handlers ?? true);
  const targets: Target[] = [];

  for (const el of els) {
    if (doScroll) {
      const v = el.getBoundingClientRect();
      if (v.top < 0 || v.bottom > window.innerHeight || v.left < 0 || v.right > window.innerWidth) {
        el.scrollIntoView({ block: "center", inline: "center" });
      }
    }
    const s = getComputedStyle(el);
    const props = reactPropsOf(el);

    let m = measureHit(el, margin);
    let restShare: number | null = null;
    let restCoveredBy: string[] = [];
    if (doScroll && (m.hit === null || m.hitShare < 0.9)) {
      restShare = m.hitShare;
      restCoveredBy = m.coveredBy;
      el.scrollIntoView({ block: "center", inline: "center" });
      m = measureHit(el, margin);
    }
    const { hit, hitShare, reach, probeMisses, probeCount } = m;

    const box = el.getBoundingClientRect();
    const ink = inkOf(el, box);
    const shell = shellOf(el, box, hit ?? rectOf(box));
    targets.push({
      name: nameOf(el),
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      box: rectOf(box),
      hit,
      hitShare,
      restShare,
      restCoveredBy,
      reach,
      probeMisses,
      probeCount,
      coveredBy: m.coveredBy,
      ink,
      shell,
      gap: null,
      gapTo: null,
      events: eventsOf(el),
      touchAction: s.touchAction,
      pointerEvents: s.pointerEvents,
      disabled: (el instanceof HTMLButtonElement && el.disabled) || el.getAttribute("aria-disabled") === "true",
      inline: s.display === "inline",
      fixed: fixedOrSticky(el),
      opacity: Number(s.opacity),
      edge: { left: round(hit?.x ?? box.left), right: round(window.innerWidth - ((hit?.x ?? box.left) + (hit?.w ?? box.width))) },
      holdGuard: propSet(props, "onContextMenu") && propSet(props, "onClickCapture"),
    });
  }

  // The gap, from LIVE rects after one settle: each target was scrolled into view alone, so the numbers
  // stored above come from different scroll offsets, and the distance between two of them would lie.
  const live = els.map((e) => e.getBoundingClientRect());
  for (const [i, t] of targets.entries()) {
    const a = live[i];
    const ea = els[i];
    if (a === undefined || ea === undefined) continue;
    let best = Infinity;
    let bestJ = -1;
    for (const [j, eb] of els.entries()) {
      const b = live[j];
      if (i === j || b === undefined || ea.contains(eb) || eb.contains(ea)) continue;
      const d = Math.hypot(Math.max(0, a.left - b.right, b.left - a.right), Math.max(0, a.top - b.bottom, b.top - a.bottom));
      if (d < best) {
        best = d;
        bestJ = j;
      }
    }
    t.gap = bestJ < 0 ? null : round(best);
    t.gapTo = targets[bestJ]?.name ?? null;
  }

  return { viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }, targets };
}
