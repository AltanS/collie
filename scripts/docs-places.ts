#!/usr/bin/env bun
// The pictures of a trick's places in the docs: docs/images/tricks/places.png (all eight, numbered)
// and docs/images/tricks/place-<id>.png (one place each), drawn as phone wireframes.
//
//   bun scripts/docs-places.ts          write the PNGs (needs ImageMagick's `magick` with SVG support)
//
// Why wireframes and not screenshots: a place is a spot in Collie's own layout, and a wireframe shows
// the spot without a trick's or a person's content in it. The pictures hold no words, so the
// translated docs show them unchanged; the page text says which place is which. Why PNG and not SVG:
// the website draws every `.svg` under docs/images/ itself and its docs sync refuses one it does not
// know (collie-website `src/components/doc-figures/keys.ts`); a PNG it serves as it is.
//
// The layout follows the app: on a session, the status line sits above the Belt, and the Belt above
// the composer; the Belt's mark of a trick sits at the end of its scrolling strip, before Collie's
// fixed block; the agent view is a third view beside Terminal and Chat. On the Dashboard, tiles sit
// in a strip at the top, a trick's Page is a row under Tricks, and a bottom bar item comes after the
// Hill. Session settings rows sit in the ⋮ sheet, after Collie's rows, under the trick's heading.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PLACE_IDS = ["dashboard", "session", "tabbar", "status", "belt", "agent-view", "menu", "float"] as const;
export type PlaceId = (typeof PLACE_IDS)[number];
type Screen = "dashboard" | "session" | "menu";

/** Which phone screen shows the place, and its number on the overview picture. */
export const PLACE_SCREEN = {
  dashboard: "dashboard",
  session: "dashboard",
  tabbar: "dashboard",
  status: "session",
  belt: "session",
  "agent-view": "session",
  menu: "menu",
  float: "session",
} as const satisfies Record<PlaceId, Screen>;

/** The alt text of each place picture, one sentence that says what the picture shows. */
export const PLACE_ALT = {
  dashboard: "The Dashboard, with a trick's tile at the end of the strip of tiles at the top.",
  session: "The Dashboard, with a trick's Page as a row under Tricks.",
  tabbar: "The Dashboard, with a trick's item at the end of the bottom bar, after the Hill.",
  status: "A session, with a trick's chip at the left end of the status line, above the Belt.",
  belt: "A session, with a trick's mark at the end of the Belt's scrolling strip, before Collie's fixed block.",
  "agent-view": "A session, with the agent view as a third view beside Terminal and Chat.",
  menu: "A session's settings sheet, with a trick's rows in a group of its own after Collie's rows.",
  float: "A session, with a trick's small moving picture in the free area above the status line, clear of the Belt and the composer.",
} as const satisfies Record<PlaceId, string>;

/** The alt text of the overview picture. */
export const OVERVIEW_ALT = "Three phone screens, the Dashboard, a session and a session's settings sheet, with the eight places of a trick numbered.";

const W = 220;
const H = 440;
const INK = "#2b2b2b";
const SOFT = "#efede8";
const SOFTER = "#f6f5f2";
const MID = "#dcd9d3";
const ACCENT = "#e07a2e";
const ACCENT_SOFT = "#fdeee1";

type Mark = { id: PlaceId; n?: number };

function badge(x: number, y: number, n: number | undefined): string {
  if (n === undefined) return "";
  return `<circle cx="${x}" cy="${y}" r="7" fill="${INK}"/><text x="${x}" y="${y + 3}" font-family="Noto Sans, sans-serif" font-size="8.5" font-weight="600" fill="#fff" text-anchor="middle">${n}</text>`;
}

function hi(marks: readonly Mark[], id: PlaceId): Mark | undefined {
  return marks.find((m) => m.id === id);
}

function bar(x: number, y: number, w: number, h: number, fill = SOFT, r = 3): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/>`;
}

function frameOpen(ox: number, oy: number): string {
  return `<g transform="translate(${ox} ${oy})"><rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="24" fill="#fff" stroke="${INK}" stroke-width="1.2"/><clipPath id="c${ox}"><rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="23"/></clipPath><g clip-path="url(#c${ox})">`;
}

const FRAME_CLOSE = "</g></g>";

function header(): string {
  // A title and the ⋮ button.
  return bar(16, 23, 90, 8, MID) + [0, 4.5, 12].map((d) => `<circle cx="${W - 20}" cy="${21 + d}" r="1.4" fill="${INK}"/>`).join("");
}

function dashboard(marks: readonly Mark[]): string {
  const out: string[] = [header()];
  // The strip of tiles at the top: Collie's are grey, a trick's tile is the last one.
  const tile = hi(marks, "dashboard");
  [0, 1, 2].forEach((i) => out.push(`<circle cx="${30 + i * 38}" cy="62" r="14" fill="${SOFT}"/>`));
  out.push(`<circle cx="${30 + 3 * 38}" cy="62" r="14" fill="${tile ? ACCENT : SOFT}" ${tile ? `stroke="${ACCENT}" stroke-width="1.2" stroke-opacity="0.3"` : ""}/>`);
  if (tile) out.push(badge(30 + 3 * 38 + 16, 48, tile.n));
  // Spaces and their sessions.
  out.push(bar(16, 92, 60, 5.5, MID));
  [0, 1, 2, 3].forEach((i) => out.push(bar(16, 106 + i * 36, W - 32, 30, SOFTER, 8), bar(26, 114 + i * 36, 90, 4.5, MID), bar(26, 125 + i * 36, 56, 5, SOFT)));
  // The Tricks group and a trick's Page row.
  const page = hi(marks, "session");
  out.push(bar(16, 260, 44, 5.5, MID));
  out.push(`<rect x="16" y="274" width="${W - 32}" height="30" rx="8" fill="${page ? ACCENT_SOFT : SOFTER}" ${page ? `stroke="${ACCENT}" stroke-width="1.2"` : ""}/>`);
  out.push(`<circle cx="31" cy="289" r="4.5" fill="${page ? ACCENT : MID}"/>`, bar(44, 286, 80, 4.5, page ? ACCENT : MID));
  if (page) out.push(badge(W - 22, 274, page.n));
  out.push(`<rect x="16" y="310" width="${W - 32}" height="30" rx="8" fill="${SOFTER}"/>`, `<circle cx="31" cy="325" r="4.5" fill="${MID}"/>`, bar(44, 322, 64, 4.5, MID));
  // The bottom bar: Collie's four items, the Hill fourth, then a trick's item.
  const item = hi(marks, "tabbar");
  out.push(`<rect x="0" y="${H - 54}" width="${W}" height="54" fill="${SOFTER}"/>`, `<line x1="0" y1="${H - 54}" x2="${W}" y2="${H - 54}" stroke="${SOFT}" stroke-width="0.8"/>`);
  for (let i = 0; i < 5; i++) {
    const cx = 22 + i * 44;
    const on = i === 4 && item;
    if (on) out.push(`<rect x="${cx - 18}" y="${H - 48}" width="36" height="34" rx="9" fill="${ACCENT_SOFT}" stroke="${ACCENT}" stroke-width="1.2"/>`);
    out.push(`<rect x="${cx - 7}" y="${H - 42}" width="14" height="12" rx="3" fill="${on ? ACCENT : i === 0 ? INK : MID}"/>`, bar(cx - 10, H - 25, 20, 4, on ? ACCENT : MID, 2));
  }
  if (item) out.push(badge(22 + 4 * 44 + 14, H - 52, item.n));
  return out.join("");
}

function sessionBody(marks: readonly Mark[]): string {
  const out: string[] = [header()];
  // Terminal | Chat | the agent view, the third view.
  const view = hi(marks, "agent-view");
  out.push(`<rect x="16" y="44" width="${W - 32}" height="22" rx="11" fill="${SOFTER}"/>`);
  const seg = (W - 32) / 3;
  out.push(`<rect x="${16 + seg}" y="44" width="${seg}" height="22" rx="11" fill="#fff" stroke="${MID}" stroke-width="0.8"/>`);
  out.push(`<rect x="${16 + 2 * seg + 1}" y="45" width="${seg - 2}" height="20" rx="10" fill="${view ? ACCENT_SOFT : SOFTER}" ${view ? `stroke="${ACCENT}" stroke-width="1.2"` : ""}/>`);
  [0, 1, 2].forEach((i) => out.push(bar(16 + i * seg + seg / 2 - 14, 52, 28, 4.5, i === 2 && view ? ACCENT : i === 1 ? INK : MID)));
  if (view) out.push(badge(W - 24, 74, view.n));
  // The tabs and panes of the space.
  [0, 1, 2].forEach((i) => out.push(`<rect x="${16 + i * 50}" y="76" width="44" height="14" rx="7" fill="${i === 0 ? MID : SOFT}"/>`));
  // The chat: a message of yours on the right, the agent's turns on the left.
  out.push(`<rect x="${W - 116}" y="104" width="100" height="26" rx="10" fill="${SOFT}"/>`);
  [0, 1, 2, 3, 4].forEach((i) => out.push(bar(16, 144 + i * 12, [170, 150, 176, 120, 160][i] ?? 140, 4.5, SOFT)));
  out.push(`<rect x="16" y="210" width="${W - 32}" height="44" rx="8" fill="${SOFTER}"/>`, bar(26, 222, 110, 4.5, MID), bar(26, 236, 80, 4.5, SOFT));
  [0, 1].forEach((i) => out.push(bar(16, 266 + i * 12, [150, 100][i] ?? 100, 4.5, SOFT)));
  // The status line: a trick's chip at the left end, the model and the usage at the right end.
  const chip = hi(marks, "status");
  out.push(`<rect x="16" y="${H - 116}" width="40" height="14" rx="7" fill="${chip ? ACCENT : SOFT}"/>`);
  out.push(bar(W - 102, H - 112, 34, 4.5, MID), bar(W - 62, H - 112, 46, 4.5, MID));
  if (chip) out.push(badge(64, H - 109, chip.n));
  // The Belt: the scrolling strip of controls, a trick's mark at its end, Collie's fixed block at the right.
  const mark = hi(marks, "belt");
  out.push(`<rect x="0" y="${H - 96}" width="${W}" height="36" fill="${SOFTER}"/>`);
  [0, 1, 2].forEach((i) => out.push(`<circle cx="${24 + i * 32}" cy="${H - 78}" r="11" fill="#fff" stroke="${MID}" stroke-width="0.8"/>`));
  out.push(`<circle cx="${24 + 3 * 32}" cy="${H - 78}" r="11" fill="${mark ? ACCENT : "#fff"}" stroke="${mark ? ACCENT : MID}" stroke-width="0.8"/>`);
  out.push(`<rect x="${W - 62}" y="${H - 92}" width="56" height="28" rx="14" fill="${MID}"/>`, `<line x1="${W - 70}" y1="${H - 92}" x2="${W - 70}" y2="${H - 64}" stroke="${MID}" stroke-width="0.8"/>`);
  if (mark) out.push(badge(24 + 3 * 32 + 13, H - 92, mark.n));
  // A floating picture: a small sprite in the free area, above the status line and clear of every landmark.
  const pet = hi(marks, "float");
  if (pet) out.push(`<rect x="${W - 56}" y="${H - 160}" width="32" height="32" rx="9" fill="${ACCENT_SOFT}" stroke="${ACCENT}" stroke-width="1.2"/>`, `<circle cx="${W - 46}" cy="${H - 148}" r="2" fill="${ACCENT}"/>`, `<circle cx="${W - 34}" cy="${H - 148}" r="2" fill="${ACCENT}"/>`, bar(W - 47, H - 140, 14, 3.5, ACCENT, 2), badge(W - 24, H - 160, pet.n));
  // The composer.
  out.push(`<rect x="12" y="${H - 54}" width="${W - 60}" height="38" rx="19" fill="#fff" stroke="${MID}" stroke-width="0.8"/>`, bar(28, H - 38, 70, 4.5, SOFT));
  out.push(`<circle cx="${W - 30}" cy="${H - 35}" r="17" fill="${INK}"/>`);
  return out.join("");
}

function menu(marks: readonly Mark[]): string {
  const rows = hi(marks, "menu");
  const out: string[] = [sessionBody([]), `<rect x="0" y="0" width="${W}" height="${H}" fill="${INK}" fill-opacity="0.35"/>`];
  // The ⋮ sheet: Collie's rows and Close, then the trick's group under its heading.
  const top = 130;
  out.push(`<rect x="0" y="${top}" width="${W}" height="${H - top + 20}" rx="20" fill="#fff"/>`, bar(W / 2 - 18, top + 8, 36, 4, MID, 2));
  [0, 1, 2, 3].forEach((i) => out.push(`<circle cx="30" cy="${top + 34 + i * 30}" r="4.5" fill="${MID}"/>`, bar(44, top + 31 + i * 30, [90, 70, 104, 54][i] ?? 60, 4.5, MID)));
  out.push(`<line x1="16" y1="${top + 150}" x2="${W - 16}" y2="${top + 150}" stroke="${SOFT}" stroke-width="0.8"/>`);
  out.push(bar(16, top + 162, 64, 5, rows ? ACCENT : MID), bar(16, top + 174, 84, 5.5, rows ? ACCENT : INK));
  out.push(`<rect x="10" y="${top + 188}" width="${W - 20}" height="68" rx="10" fill="${rows ? ACCENT_SOFT : SOFTER}" ${rows ? `stroke="${ACCENT}" stroke-width="1.2"` : ""}/>`);
  [0, 1].forEach((i) => out.push(`<circle cx="30" cy="${top + 206 + i * 30}" r="4.5" fill="${rows ? ACCENT : MID}"/>`, bar(44, top + 203 + i * 30, [96, 72][i] ?? 72, 4.5, rows ? ACCENT : MID), `<rect x="${W - 46}" y="${top + 199 + i * 30}" width="26" height="14" rx="7" fill="${rows ? ACCENT : SOFT}"/>`));
  if (rows) out.push(badge(W - 16, top + 188, rows.n));
  return out.join("");
}

function phone(screen: Screen, marks: readonly Mark[], ox: number, oy: number): string {
  const body = screen === "dashboard" ? dashboard(marks) : screen === "session" ? sessionBody(marks) : menu(marks);
  return frameOpen(ox, oy) + body + FRAME_CLOSE;
}

function svg(width: number, height: number, inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${inner}</svg>`;
}

/** The overview: three phones, every place numbered in PLACE_IDS order. */
export function overviewSvg(): string {
  const marks = PLACE_IDS.map((id, i) => ({ id, n: i + 1 }));
  const gap = 40;
  const pad = 16;
  const screens: Screen[] = ["dashboard", "session", "menu"];
  const inner = screens.map((s, i) => phone(s, marks.filter((m) => PLACE_SCREEN[m.id] === s), pad + i * (W + gap), pad)).join("");
  return svg(pad * 2 + 3 * W + 2 * gap, pad * 2 + H, inner);
}

/**
 * The part of the phone each place picture shows, top and bottom in phone units: enough of the
 * screen around the place to see where it sits, not the whole phone, so a section stays short.
 */
const PLACE_CROP = {
  dashboard: [0, 190],
  session: [220, 360],
  tabbar: [250, H],
  status: [250, H],
  belt: [250, H],
  "agent-view": [0, 150],
  menu: [100, H],
  float: [190, H],
} as const satisfies Record<PlaceId, readonly [number, number]>;

/** One place on its own phone, cropped to the part of the screen around it. */
export function placeSvg(id: PlaceId): string {
  const pad = 16;
  const [top, bottom] = PLACE_CROP[id];
  const y = top === 0 ? 0 : pad + top;
  const h = (bottom === H ? pad * 2 + H : pad + bottom) - y;
  const width = pad * 2 + W;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 ${y} ${width} ${h}">${phone(PLACE_SCREEN[id], [{ id }], pad, pad)}</svg>`;
}

function render(svgText: string, out: string, tmp: string): void {
  const src = join(tmp, "in.svg");
  writeFileSync(src, svgText);
  const r = Bun.spawnSync(["magick", "-background", "none", "-density", "192", src, "-strip", "-depth", "8", out]);
  if (r.exitCode !== 0) throw new Error(`magick failed for ${out}: ${r.stderr.toString()}`);
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const dir = join(root, "docs/images/tricks");
  mkdirSync(dir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "docs-places-"));
  try {
    render(overviewSvg(), join(dir, "places.png"), tmp);
    for (const id of PLACE_IDS) render(placeSvg(id), join(dir, `place-${id}.png`), tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`docs-places: wrote ${PLACE_IDS.length + 1} pictures to docs/images/tricks/`);
}
