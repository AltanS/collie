// The SIGN-IN CARD — the panel an agent's `/login` draws over a sign-in field (profile.ts
// `FrameLayout.secret`): the title, the sign-in address, the steps, and the field's label. Claude
// Code 2.1.325 prints the address from column 0 across the whole pane, pi 1.3.0 one cell in, omp
// 18.6.1 inside a rounded box; each wraps it at the row's edge, so the mirror shows six to ten rows of
// a broken address that no tap can open. The card holds the panel's own words with the address joined
// back into one link (box-url-join.ts, links.ts), as the Authentication box card does.
//
// The field itself is the composer's: the frame the profile finds is the input box, so the card never
// shows the prompt row or anything under it. That keeps what was typed (pi shows it as typed) out of
// the card. The card is a `box-text`: it prints no key and owns no keyboard (dialog-contract.ts), so
// the composer and the Send Protocol read the screen exactly as they do without it.
//
// Harness-neutral: every shape comes from the profile's layout (`idle.frameAlternates`), and the rows
// are read the same way for every harness. A side border (`│ … │`) and the rows' common indent are
// taken off, the width is the widest row left, and runs of spaces inside a row are one space (Claude
// sets `(c to copy)` in a column of its own).
//
// Pure functions over parsed line text.

import { lineText, type StyledLine } from "../blocks";
import { findLinks } from "../links";
import { findInputFrame, type IdleProfile } from "../surface/frame";
import { joinBrokenUrls } from "./box-url-join";
import type { BoxTextModel, BoxTextRun } from "./box-text-model";

/** The card found over a sign-in field: it stands from `startLine` to the end of the screen. */
export interface SignInCardRegion {
  startLine: number;
  model: BoxTextModel;
}

const SIDE_BORDER = /^│(.*)│$/u;

function runsOf(content: string): BoxTextRun[] {
  const runs: BoxTextRun[] = [];
  let at = 0;
  for (const link of findLinks(content)) {
    if (link.start > at) runs.push({ kind: "plain", text: content.slice(at, link.start) });
    runs.push({ kind: "link", text: content.slice(link.start, link.end), href: link.href });
    at = link.end;
  }
  if (at < content.length) runs.push({ kind: "plain", text: content.slice(at) });
  return runs;
}

/** A row without its side border and the one padding cell inside it. */
function unbordered(text: string): string {
  const row = text.trimEnd();
  const inner = SIDE_BORDER.exec(row)?.[1];
  return inner === undefined ? row : inner.slice(1).trimEnd();
}

function indentOf(text: string): number {
  return text.length - text.trimStart().length;
}

/** The rows with blank rows at both ends dropped and each run of blank rows made one. */
function tidied(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/** The sign-in card over the profile's sign-in field on `lines`, or null when the field is not on screen. */
export function detectSignInCard(lines: StyledLine[], idle: IdleProfile): SignInCardRegion | null {
  const frame = findInputFrame(lines, idle);
  if (frame?.secret === undefined) return null;
  const rows = lines.slice(frame.top + 1, frame.interior.prompt).map((line) => unbordered(lineText(line)));
  const indent = Math.min(...rows.filter((row) => row.trim() !== "").map(indentOf));
  const cut = rows.map((row) => (row.trim() === "" ? "" : row.slice(Number.isFinite(indent) ? indent : 0)));
  const width = Math.max(0, ...cut.map((row) => row.length));
  const joined = tidied(joinBrokenUrls(cut, width).map((line) => line.trim().replace(/\s{2,}/gu, " ")));
  // The title: the box's own label (omp sets it in the top edge), else the panel's first row.
  const title = frame.label ?? joined[0] ?? "";
  const body = frame.label === null ? tidied(joined.slice(1)) : joined;
  if (title === "") return null;
  return { startLine: frame.top, model: { title, phase: "filled", text: body.map((line) => (line === "" ? [] : runsOf(line))) } };
}
