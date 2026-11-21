// WHAT R5 MEASURES ON A PAGE, found by the DOM: the runs of text, the icons that stand alone, the controls that
// need an edge, the pairs of states a person must tell apart, and the controls to hover and to focus. This file runs
// IN THE PAGE: `r5.ts` strips its types with Vite's transform and evaluates it there (as `screens/rules.ts` installs
// `page-rules.ts`), then calls `window.__r5probe`. So it imports nothing. It finds and describes; every colour is read
// later, from the screenshot (`r5.ts`).

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextProbe {
  el: string;
  text: string;
  rects: Box[];
  size: number;
  weight: number;
  large: boolean;
  classes: string;
  /** The ink's own alpha times every opacity above it: under 1, the ink is a token thinned on the way to the screen. */
  alpha: number;
}

export interface IconProbe {
  el: string;
  box: Box;
  classes: string;
}

export interface ControlProbe {
  el: string;
  kind: "field" | "switch" | "check";
  box: Box;
}

export interface PairProbe {
  kind: "selected" | "open" | "focused-pane";
  el: string;
  box: Box;
  /** The peer it must be told apart from: an unselected sibling. Absent for `open`, which is read against its own ground. */
  peer?: { el: string; box: Box };
}

export interface TargetProbe {
  el: string;
  box: Box;
  /** An index into `window.__r5targets`, so the spec can focus or hover the very element. */
  index: number;
}

export interface Probes {
  texts: TextProbe[];
  icons: IconProbe[];
  controls: ControlProbe[];
  pairs: PairProbe[];
  hovers: TargetProbe[];
  focuses: TargetProbe[];
  view: { w: number; h: number };
}

export interface ProbeOptions {
  /** A dialog is open: measure inside it only, the page under the scrim is not what a person reads. */
  root: string | null;
  /** How many controls to hover and to focus, at most. */
  hovers: number;
  focuses: number;
}

declare global {
  interface Window {
    __r5targets?: Element[];
    __r5probe?: (opts: ProbeOptions) => Probes;
  }
}

function boxOf(r: DOMRect): Box {
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}
function inView(r: DOMRect): boolean {
  return r.width >= 2 && r.height >= 2 && r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight;
}
function clipBox(b: Box): Box {
  const x = Math.max(0, b.x);
  const y = Math.max(0, b.y);
  return { x, y, w: Math.min(window.innerWidth, b.x + b.w) - x, h: Math.min(window.innerHeight, b.y + b.h) - y };
}

/** Not drawn for a person: the terminal mirror (its palette is the theme's `ansi`, gated on its own), a harness's brand mark, the header character, or anything hidden. */
function excluded(el: Element): boolean {
  for (let e: Element | null = el; e !== null; e = e.parentElement) {
    const cls = e.getAttribute("class") ?? "";
    if (cls.includes("mirror-ground") || cls.includes("terminal-muse")) return true;
    if (e.getAttribute("role") === "img" && /(?:logo|agent icon)$/u.test(e.getAttribute("aria-label") ?? "")) return true;
    if (e.getAttribute("data-slot") === "collie-mark") return true;
    if (e.getAttribute("aria-hidden") === "true" && e.tagName !== "svg" && e.closest("svg") === null && e.querySelector("svg") === null && e.textContent?.trim() === "") return true;
  }
  return false;
}

function opacityOf(el: Element): number {
  let o = 1;
  for (let e: Element | null = el; e !== null; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
  return o;
}

/** The alpha of a computed colour (`rgb()`, `rgba()`, `oklab(... / a)`, `color(srgb ... / a)`). */
function alphaOf(colour: string): number {
  const m = /\/\s*([\d.]+%?)\s*\)$/u.exec(colour) ?? /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/u.exec(colour);
  if (m === null) return 1;
  const v = m[1]!;
  return v.endsWith("%") ? Number.parseFloat(v) / 100 : Number.parseFloat(v);
}

/** Disabled controls are exempt from the contrast floors (WCAG 1.4.3, "inactive user interface components"). */
function disabled(el: Element): boolean {
  return el.closest(":disabled, [aria-disabled='true'], [inert], [data-disabled]") !== null;
}

function isClipped(el: Element): boolean {
  const cs = getComputedStyle(el);
  if (cs.visibility !== "visible") return true;
  if (cs.clip === "rect(0px, 0px, 0px, 0px)" || cs.clipPath === "inset(50%)") return true;
  return false;
}

/** True when the point is drawn by `el` or something inside or around it, not by a layer over it. Pointer-transparent layers are trusted. */
function ownsPoint(el: Element, x: number, y: number): boolean {
  if (getComputedStyle(el).pointerEvents === "none") return true;
  const hit = document.elementFromPoint(x, y);
  if (hit === null) return false;
  return hit === el || el.contains(hit) || hit.contains(el);
}

function describe(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const slot = el.getAttribute("data-slot");
  const role = el.getAttribute("role");
  const label = el.getAttribute("aria-label");
  const own = slot !== null ? `[data-slot=${slot}]` : role !== null ? `[role=${role}]` : "";
  const holder = el.closest("[data-slot]");
  const ctx = holder !== null && holder !== el ? `${holder.getAttribute("data-slot") ?? ""} ` : "";
  const name = label ?? (el.textContent ?? "").replaceAll(/\s+/gu, " ").trim().slice(0, 32);
  return `${ctx}${tag}${own}${name === "" ? "" : ` "${name}"`}`;
}

function visibleText(el: Element): boolean {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    if ((n.textContent ?? "").trim() === "") continue;
    const parent = n.parentElement;
    if (parent === null || isClipped(parent)) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width > 2 && r.height > 2) return true;
  }
  return false;
}

/** True when an element paints a box of its own: an edge or a fill. */
function draws(e: Element): boolean {
  const cs = getComputedStyle(e);
  const edge = Number.parseFloat(cs.borderBottomWidth) > 0 && cs.borderBottomColor !== "rgba(0, 0, 0, 0)";
  return edge || cs.backgroundColor !== "rgba(0, 0, 0, 0)";
}

/** The region of the page a control stands in, so hovers and focuses spread over the sidebar, the header, a column and a dialog. */
function region(el: Element): string {
  const r = el.closest("[role=dialog], [data-slot=wide-sidebar], [data-slot=space-header], header, nav, aside, [data-slot=composer-actions], main, section");
  return r === null ? "page" : (r.getAttribute("data-slot") ?? r.getAttribute("role") ?? r.tagName.toLowerCase());
}

export function collectProbes(opts: ProbeOptions): Probes {
  const view = { w: window.innerWidth, h: window.innerHeight };
  const scope: Element = (opts.root === null ? null : document.querySelector(opts.root)) ?? document.body;
  const targets: Element[] = [];
  window.__r5targets = targets;

  // ── Text ────────────────────────────────────────────────────────────────────
  const texts: TextProbe[] = [];
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const text = (n.textContent ?? "").trim();
    const el = n.parentElement;
    if (text === "" || el === null) continue;
    if (el.closest("script, style, noscript, svg, textarea, option") !== null) continue;
    if (excluded(el) || isClipped(el) || disabled(el) || opacityOf(el) < 0.05) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const rects = [...range.getClientRects()].filter(inView).map((r) => clipBox(boxOf(r)));
    if (rects.length === 0) continue;
    const first = rects[0]!;
    if (!ownsPoint(el, first.x + first.w / 2, first.y + first.h / 2)) continue;
    const cs = getComputedStyle(el);
    const size = Number.parseFloat(cs.fontSize);
    const weight = Number.parseInt(cs.fontWeight, 10);
    const cls = el.getAttribute("class") ?? "";
    texts.push({ el: describe(el), text: text.slice(0, 40), rects: rects.slice(0, 4), size, weight, large: size >= 24 || (size >= 18.66 && weight >= 700), classes: cls.slice(0, 300), alpha: alphaOf(cs.color) * opacityOf(el) });
  }
  // A field's typed value and its placeholder are text too.
  for (const field of scope.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea")) {
    const r = field.getBoundingClientRect();
    if (!inView(r) || excluded(field) || isClipped(field) || disabled(field)) continue;
    const words = field.value !== "" ? field.value : field.placeholder;
    if (words.trim() === "") continue;
    const cs = getComputedStyle(field);
    const size = Number.parseFloat(cs.fontSize);
    const pad = Number.parseFloat(cs.paddingLeft);
    const line = Math.min(r.height, size * 1.6);
    const box = clipBox({ x: r.left + pad, y: r.top + Math.max(0, (Math.min(r.height, 80) - line) / 2), w: Math.max(4, r.width - pad * 2), h: line });
    const ph = field.value === "" ? getComputedStyle(field, "::placeholder").color : cs.color;
    texts.push({ el: `${describe(field)}${field.value === "" ? " (placeholder)" : ""}`, text: words.slice(0, 40), rects: [box], size, weight: Number.parseInt(cs.fontWeight, 10), large: size >= 24, classes: field.className.slice(0, 300), alpha: alphaOf(ph) * opacityOf(field) });
  }

  // ── Icons that carry meaning alone ──────────────────────────────────────────
  const icons: IconProbe[] = [];
  for (const svg of scope.querySelectorAll("svg")) {
    if (svg.parentElement?.closest("svg") !== null && svg.parentElement?.closest("svg") !== undefined) continue;
    const r = svg.getBoundingClientRect();
    if (!inView(r) || r.width < 8 || r.height < 8 || r.width > 64 || r.height > 64) continue;
    if (excluded(svg) || isClipped(svg) || disabled(svg) || opacityOf(svg) < 0.05) continue;
    if (!ownsPoint(svg, r.left + r.width / 2, r.top + r.height / 2)) continue;
    // An icon beside its own words is decoration (WCAG 1.4.11 asks for the words); one that stands alone is the label.
    const holder = svg.closest("button, a, [role=button], [role=tab], [role=menuitem], [role=link], [role=option], li, [data-slot]");
    if (holder !== null && visibleText(holder)) continue;
    icons.push({ el: describe(holder ?? svg), box: clipBox(boxOf(r)), classes: (svg.getAttribute("class") ?? "").slice(0, 200) });
  }

  // ── Controls whose edge is the control ──────────────────────────────────────
  const controls: ControlProbe[] = [];
  for (const el of scope.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select, [role=switch], [role=checkbox], [role=radio], input[type=checkbox], input[type=radio]")) {
    const r = el.getBoundingClientRect();
    if (!inView(r) || excluded(el) || isClipped(el) || disabled(el)) continue;
    const role = el.getAttribute("role");
    const type = el.getAttribute("type");
    const kind = role === "switch" ? "switch" : role === "checkbox" || role === "radio" || type === "checkbox" || type === "radio" ? "check" : "field";
    // A sr-only input inside a drawn switch: measure the drawn one, its label.
    if (r.width < 4 || r.height < 4) continue;
    // A radio or a check that carries its own words is a segment of a control, named by its words (WCAG 1.4.11 asks
    // for the edge of a box that has none): the selected rule reads it instead.
    if (kind === "check" && (visibleText(el) || r.width > 32 || r.height > 32)) continue;
    // A field drawn with no edge of its own sits in a box that draws it (the composer's reply box): measure that box.
    let drawn: Element = el;
    for (let up: Element | null = el, depth = 0; up !== null && depth < 5; up = up.parentElement, depth += 1) {
      const ur = up.getBoundingClientRect();
      if (ur.width > r.width + 120 || ur.height > r.height + 120) break;
      if (draws(up)) {
        drawn = up;
        break;
      }
    }
    controls.push({ el: describe(el), kind, box: clipBox(boxOf(drawn.getBoundingClientRect())) });
  }

  // ── States a person must tell apart ─────────────────────────────────────────
  const pairs: PairProbe[] = [];
  const SELECTED = "[aria-selected='true'], [aria-current='page'], [aria-current='true'], [aria-current='location'], [data-state='active'], [aria-pressed='true'], [role=radio][aria-checked='true'], [role=menuitemradio][aria-checked='true']";
  const seen = new Set<Element>();
  for (const el of scope.querySelectorAll(SELECTED)) {
    const r = el.getBoundingClientRect();
    if (!inView(r) || excluded(el) || isClipped(el) || seen.has(el)) continue;
    seen.add(el);
    const attr = ["aria-selected", "aria-current", "data-state", "aria-pressed", "aria-checked"].find((a) => el.hasAttribute(a))!;
    // The peer: the nearest element of the same tag and role that is not in the state, up to three levels out.
    let peer: Element | undefined;
    for (let up: Element | null = el.parentElement, depth = 0; up !== null && depth < 4 && peer === undefined; up = up.parentElement, depth += 1) {
      peer = [...up.querySelectorAll(el.tagName)].find((c) => {
        if (c === el || c.contains(el) || el.contains(c)) return false;
        if (c.getAttribute("role") !== el.getAttribute("role")) return false;
        const v = c.getAttribute(attr);
        if (v === "true" || v === "page" || v === "active" || v === "location") return false;
        const cr = c.getBoundingClientRect();
        // A peer is the same kind of item: as tall, and drawn by the same utilities (half its class names or more in
        // common), so a fold toggle or a "+" beside a run of tabs is not taken for an unselected tab.
        const own = new Set((el.getAttribute("class") ?? "").split(/\s+/u).filter(Boolean));
        const theirs = (c.getAttribute("class") ?? "").split(/\s+/u).filter(Boolean);
        const common = theirs.filter((t) => own.has(t)).length;
        const alike = own.size + theirs.length === 0 || common / Math.max(own.size, theirs.length) >= 0.5;
        return inView(cr) && Math.abs(cr.height - r.height) <= 4 && alike && !isClipped(c);
      });
    }
    if (peer === undefined) continue;
    pairs.push({ kind: "selected", el: describe(el), box: clipBox(boxOf(r)), peer: { el: describe(peer), box: clipBox(boxOf(peer.getBoundingClientRect())) } });
  }
  // A trigger of a menu, a dialog or a list (`aria-haspopup`): TRIGGER_OPEN's job. A disclosure that shows a region in
  // place (a sidebar toggle, a fold) says its state with its chevron and its words, and is not held to a fill.
  for (const el of document.querySelectorAll("[aria-expanded='true'][aria-haspopup]:not([aria-haspopup='false'])")) {
    const r = el.getBoundingClientRect();
    if (!inView(r) || excluded(el) || isClipped(el) || el.getAttribute("role") === "combobox" || el.tagName === "INPUT") continue;
    if (r.width > view.w * 0.6 || r.height > 80) continue;
    pairs.push({ kind: "open", el: describe(el), box: clipBox(boxOf(r)) });
  }
  const focusedFrame = document.querySelector('[data-slot="wide-layout"] section[data-focused] [data-slot="column-frame"]');
  const otherFrame = document.querySelector('[data-slot="wide-layout"] section[data-col-key]:not([data-focused]) [data-slot="column-frame"]');
  if (focusedFrame !== null && otherFrame !== null) {
    pairs.push({
      kind: "focused-pane",
      el: "column-frame (focused)",
      box: clipBox(boxOf(focusedFrame.getBoundingClientRect())),
      peer: { el: "column-frame", box: clipBox(boxOf(otherFrame.getBoundingClientRect())) },
    });
  }

  // ── Controls to hover and to focus, spread over the regions of the page ─────
  const pick = (selector: string, max: number, test: (el: Element) => boolean): TargetProbe[] => {
    const perRegion = new Map<string, number>();
    const out: TargetProbe[] = [];
    for (const el of scope.querySelectorAll(selector)) {
      if (out.length >= max) break;
      const r = el.getBoundingClientRect();
      if (!inView(r) || r.top < 1 || r.left < 1 || r.bottom > view.h - 1 || r.right > view.w - 1) continue;
      if (r.width > view.w * 0.6 || excluded(el) || isClipped(el) || disabled(el) || !test(el)) continue;
      if (!ownsPoint(el, r.left + r.width / 2, r.top + r.height / 2)) continue;
      const key = `${region(el)}:${el.getAttribute("role") ?? el.tagName}`;
      const n = perRegion.get(key) ?? 0;
      if (n >= 2) continue;
      perRegion.set(key, n + 1);
      targets.push(el);
      out.push({ el: describe(el), box: boxOf(r), index: targets.length - 1 });
    }
    return out;
  };
  const hovers = pick("button, a[href], [role=button], [role=tab], [role=menuitem], [role=option]", opts.hovers, (el) => {
    const cls = el.getAttribute("class") ?? "";
    return /(?:^|\s)hover:bg-/u.test(cls) && el.getAttribute("aria-expanded") !== "true";
  });
  const focuses = pick("button, a[href], input:not([type=hidden]), textarea, [role=tab], [role=menuitem], [role=switch], [role=option], [tabindex='0']", opts.focuses, () => true);

  return { texts, icons, controls, pairs, hovers, focuses, view };
}
