// The omp TOOL-APPROVAL dialog grammar (.adr/0078), the third omp screen this adapter lifts and the
// first whose tap can run something: Approve lets the agent run a shell command or write a file. The
// dialog blocks the agent until a human decides, which is why it is worth a card, and why every
// choice below leans toward declining.
//
// The screen, as omp 18.4.10 draws it (`omp--v18-4-approval-bash.txt`; pi-tui
// `overlays/hook-selector.ts`, the body from `formatApprovalPrompt` in `tools/approval.ts`):
//
//     ╭─ Allow tool: bash ─────────────────────────────────╮     the title, `Allow tool: <tool>`
//     │                                                    │
//     │ Command: echo hello-approval                       │     the body: what is being approved
//     │                                                    │
//     │  ❯ Approve                                         │     the pointed row: pointer, label
//     │    Deny                                            │
//     │                                                    │
//     │ ↑/↓ navigate  ⏎ select  ⎋ cancel                   │     the footer, segments split by two spaces
//     │                                                    │
//     ╰────────────────────────────────────────────────────╯
//
// The body is the dialog's subject and is free text: `Command: <command>` for `bash` (an optional
// `Reason: …` row above it when a config pattern asked for approval), or `Path: <path>`, a row reading
// `Content:` and the file's content for `write`. omp word-wraps every body row to the box, so one long
// command can take several rows, and the box grows with the body (`omp--v18-4-approval-write-long.txt`).
//
// THE TWO PRESETS, each read off its own capture and nothing more. The pointer is the symbol preset's
// `nav.cursor`, and the footer is built from the same install's keycaps, so a screen must match ONE
// preset in both places:
//   * omp 18.4.10, `unicode` (the default): `❯` and `↑/↓ navigate  ⏎ select  ⎋ cancel`
//     (`omp--v18-4-approval-*.txt`);
//   * omp 18.1.17, `nerd`: U+F054 (nf-fa-chevron_right) and `up/down navigate  enter select  esc cancel`
//     (`omp--approval-*.txt`).
// The other pairings decline. omp 18.4's `nerd` preset prints private-use keycaps in its footers (the
// Ask captures of 18.4.4 show U+F0311 and U+F12B7), so a chevron under `⏎`/`⎋` is a pair omp does not
// print; `❯` over the text keycaps (18.1 in `unicode`) may exist but is not captured; the `ascii`
// preset's `>` is the most common glyph in a transcript and is not captured either.
//
// WHAT A TAP SENDS. The footer prints the arrows and Enter, so every key is one the screen named (ADR
// 0009), and no digit is invented. `Approve` is ADR 0055's walk: `Enter` when the pointer is on it,
// `Up` then `Enter` when the pointer is on Deny. `Deny` is ALWAYS `Down` then `Enter`, wherever the
// pointer is: omp's list clamps at its ends (`MenuSelection.move(delta, false)`), so Down from Deny
// stays on Deny. That one change from ADR 0055 makes every race resolve toward Deny: a pointer that
// moves at the desk after the guard's read and before the keys land can turn an Approve tap into a
// denial, never a Deny tap into an approval. The card's last row is the footer's way out in its own
// words (`Cancel`), sending `Escape`, which omp also reports to the agent as a denial.
//
// WHAT THE CARD SHOWS, so nobody approves blind. The caption is the title (`Allow tool: bash`, the
// tool's name). The Approve button's description is the body, row by row, rows joined by ` ↵ ` so a
// newline in a command is never read as a space; that overstates a soft wrap as a break, which is the
// safe direction. The `question` (the card's accessible name) is the title and the same rows. Nothing
// is ever shortened or hidden: a bash body is shown whole, and so is a `write` body, up to
// MAX_CONTENT_ROWS rows of content, past which the screen declines to the raw mirror. omp itself
// shortens every field to 2000 characters (`truncateForPrompt`), and a field it shortened declines
// below. The box's title and body also stay in the raw mirror above the card, verbatim.
//
// FAIL CLOSED. Every piece below is required, and any one missing returns null, which leaves the raw
// mirror and the unread-dialog card's Escape exactly as slice 1 drew them:
//   * the bottom border is the last non-blank row. Under the 18.1.17 preset alone it may also be the row
//     above one row of anything (the operator's usage strip, kept out of the signature); the 18.4.10
//     captures carry none, and a box left behind by an exited omp must not read as one;
//   * from the border up: a blank box row, the footer, a blank box row, exactly two option rows, a
//     blank box row. So a third option (`Always for this session`, which omp prints first on its config
//     approvals), a search status row and a clipped footer all decline;
//   * the footer is exactly one preset's, character for character (a `·` between the segments, as the
//     other omp footers print, is another footer), and the options read exactly `Approve` then `Deny`
//     with exactly one carrying that preset's pointer;
//   * every body row opens with the box's left side, the first is not blank, and a blank box row sits
//     under the title. A body row is free text and its right side is not required, as ask.ts reads its
//     question rows: every byte of it binds the tap, and the card shows all of it but the border;
//   * the title is exactly `Allow tool: <name>` with no countdown, and the tool is `bash` or `write`,
//     the two with captured bodies. Their body must have the captured shape (an optional `Reason:` row,
//     then `Command:`; or `Path:`, then a row reading `Content:`);
//   * the body carries neither omp's own elision mark (`[…Nch elided…]`, so omp hid part of the
//     subject from the terminal too) nor a `Provider safety checks:` section (uncaptured), nor a
//     control, zero-width or bidi character, which can make the card read differently from the command;
//   * a region short enough for the bridge to bind (32000 characters, as resume.ts and ask.ts).
//
// Pure functions over `StyledLine[]`, tail-anchored like every other grammar.

import type { StyledLine } from "../../blocks";
import type { PromptModel, PromptOption } from "../prompt-model";
import { isBlank, lineText, rstrip } from "./markers";
import { readOmpHintList } from "./modal";

export interface ApprovalRegion {
  model: PromptModel;
  /** Index of the `Approve` row: the card replaces [`startLine` … the tail], and the title and body
   *  above it stay in the raw mirror. */
  startLine: number;
}

/** One keycap dialect: the footer and the pointer the same symbol preset draws. */
interface Preset {
  /** The footer's text, exactly: segments joined by the two spaces omp prints between them. */
  footer: string;
  /** `theme.nav.cursor`, the pointer in front of the pointed row. */
  pointer: string;
  /** Whether a capture of this preset carries a one-row usage strip under the box. Only then is one
   *  row of anything allowed under the border (see the header, FAIL CLOSED). */
  strip: boolean;
}

const PRESETS: readonly Preset[] = [
  // omp 18.4.10, `unicode` preset (`omp--v18-4-approval-bash.txt`).
  { footer: "↑/↓ navigate  ⏎ select  ⎋ cancel", pointer: "❯", strip: false },
  // omp 18.1.17, `nerd` preset (`omp--approval-bash.txt`): U+F054 as the pointer, text keycaps.
  { footer: "up/down navigate  enter select  esc cancel", pointer: "\u{F054}", strip: true },
];

/** The two tools whose approval body is captured, and so the only two lifted. */
const LIFTED_TOOLS = new Set(["bash", "write"]);

/** The bridge's cap on a bound region less a margin, as resume.ts. */
const MAX_REGION_CHARS = 32_000;

/** How tall the body may be before the scan stops: a bound against scrollback, not a layout fact. */
const MAX_BODY_ROWS = 200;

/** How many rows of a `write` body's content the card shows. Past it the screen declines: the card is
 *  what someone approves from, so it never hides a row. omp shortens every field to 2000 characters
 *  itself (`truncateForPrompt`), which keeps an ordinary file under this. */
const MAX_CONTENT_ROWS = 30;

/** The badge on the pointed row. The nerd preset's chevron is a private-use glyph the card's face may
 *  not carry, so both presets show the `❯` it stands for. */
const POINTER_BADGE = "❯";

/** What joins two body rows on the card's visible description. */
const ROW_BREAK = " ↵ ";

const TITLE = /^╭─ Allow tool: ([A-Za-z0-9_.:-]+) ─+╮$/;
const BOTTOM = /^╰─+╯$/;
const BOX_ROW = /^│ ([\s\S]*)│$/;
/** A body row: the box's left side, then free text up to the right side if there is one (as ask.ts
 *  reads its question rows). */
const BODY_ROW = /^│ ([\s\S]*?)(?:\s*│)?$/;
const BLANK_ROW = /^│\s*│$/;
/** A row that belongs to a box frame, which the usage strip under the border must not be. */
const FRAME_START = /^[│╭╰├┌└]/;
/** omp's own mark for a field it shortened (`truncateForPrompt`), with every space taken out so a
 *  wrap anywhere inside it still matches. */
const OMP_ELISION = /\[…\d+chelided…\]/;
const SAFETY_SECTION = "Provider safety checks:";
/** Characters that change how a line reads without being seen: zero-width and directional marks, the
 *  bidi embeddings, overrides and isolates, the word joiner and the byte-order mark. A body that
 *  carries one is not shown as a card, because the card is what someone approves from. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u;

/** A C0 or C1 control character, found by code so the pattern stays free of raw control escapes. */
function hasControl(row: string): boolean {
  for (let i = 0; i < row.length; i++) {
    const code = row.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Detect omp's tool-approval dialog at the tail of `lines`. Returns a `prompt-select` model whose
 * options are `Approve`, `Deny` and the footer's own way out, and the index of the `Approve` row; null
 * when any piece of evidence is missing.
 */
export function detectApprovalRegion(lines: StyledLine[]): ApprovalRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));

  // 1. The tail: the bottom border, or the border with one row of anything under it.
  let end = texts.length - 1;
  while (end >= 0 && isBlank(texts[end]!)) end--;
  if (end < 0) return null;
  let bottom = end;
  if (!BOTTOM.test(texts[end]!)) {
    if (FRAME_START.test(texts[end]!)) return null;
    bottom = end - 1;
  }
  // The border sits nine rows under the title at the least: the spacer, one body row, the seven fixed
  // rows below the body.
  if (bottom < 9 || !BOTTOM.test(texts[bottom]!)) return null;

  // 2. From the border up: blank, footer, blank, Approve, Deny, blank.
  if (!BLANK_ROW.test(texts[bottom - 1]!) || !BLANK_ROW.test(texts[bottom - 3]!)) return null;
  const footerRow = BOX_ROW.exec(texts[bottom - 2]!);
  if (footerRow === null) return null;
  const preset = PRESETS.find((p) => footerRow[1]!.trim() === p.footer);
  const footer = readOmpHintList(footerRow[1]!);
  if (preset === undefined || footer === null) return null;
  // A row under the border is the operator's statusline, and only the 18.1.17 captures hold one. A box
  // that omp left behind on a pane that is now a shell would pass for it, and `Up`, `Enter` in a shell
  // runs the last command, so a preset whose captures carry none accepts none.
  if (bottom !== end && !preset.strip) return null;
  const approveAt = bottom - 5;
  const approve = readOption(texts[approveAt]!, preset);
  const deny = readOption(texts[bottom - 4]!, preset);
  if (approve?.label !== "Approve" || deny?.label !== "Deny") return null;
  if (approve.pointed === deny.pointed) return null;
  if (!BLANK_ROW.test(texts[bottom - 6]!)) return null;

  // 3. The body, read upward to the title. Every row opens with the box's left side; the title is the
  //    first row that opens with its corner instead.
  let titleAt = bottom - 7;
  while (titleAt >= 0 && !TITLE.test(texts[titleAt]!)) {
    if (bottom - titleAt > MAX_BODY_ROWS || !BODY_ROW.test(texts[titleAt]!)) return null;
    titleAt--;
  }
  if (titleAt < 0) return null;
  const tool = TITLE.exec(texts[titleAt]!)![1]!;
  if (!LIFTED_TOOLS.has(tool)) return null;
  // The spacer omp draws under the title, then at least one body row.
  if (titleAt + 2 > bottom - 7 || !BLANK_ROW.test(texts[titleAt + 1]!)) return null;
  const bodyRows = texts.slice(titleAt + 2, bottom - 6);
  // A row that ends in `…` with no right border may be a row omp clipped, which wrapped overflow would
  // not look like. The card cannot tell the two apart, so it declines.
  if (bodyRows.some((row) => !row.endsWith("│") && row.endsWith("…"))) return null;
  const body = bodyRows.map(bodyText);
  if (body[0]!.length === 0) return null;
  const shown = summarise(tool, body);
  if (shown === null) return null;

  // 4. The signature is the region verbatim, title through the bottom border, trailing padding off.
  //    It carries the pointer column and every body row, so a pointer moved between the render and
  //    the tap, or a different call with the same tool, refuses the tap (ADR 0055 point 6). The usage
  //    strip under the border is not in it: it ticks.
  const region = texts.slice(titleAt, bottom + 1);
  const signature = region.join("\n");
  if (signature.length > MAX_REGION_CHARS) return null;
  const pointedRow = approve.pointed ? approveAt : approveAt + 1;
  const coreSignature = region
    .map((row, i) => (titleAt + i === pointedRow ? row.replace(preset.pointer, " ") : row))
    .join("\n");

  const title = `Allow tool: ${tool}`;
  const options: PromptOption[] = [
    {
      label: "Approve",
      description: shown.join(ROW_BREAK),
      keys: approve.pointed ? ["Enter"] : ["Up", "Enter"],
      keyLabel: approve.pointed ? POINTER_BADGE : "",
    },
    // Down clamps on the last row, so this lands on Deny from either row. See the header.
    { label: "Deny", keys: ["Down", "Enter"], keyLabel: deny.pointed ? POINTER_BADGE : "" },
    // The footer's own way out, in its own words (ADR 0058 point 5).
    { label: capitalise(footer.escapeVerb), keys: ["Escape"], keyLabel: "Esc" },
  ];
  const model: PromptModel = {
    question: [title, ...shown].join("\n"),
    caption: title,
    options,
    family: "permission",
    signature,
    coreSignature,
  };
  return { model, startLine: approveAt };
}

/** The model alone (or null), the thin matcher tests assert on. */
export function detectApproval(lines: StyledLine[]): PromptModel | null {
  return detectApprovalRegion(lines)?.model ?? null;
}

/** A body row's text: the left side and a closing right side off, trailing padding off, leading space
 *  kept. Anything past the right side stays, so the card never shows less of a row than the screen. */
function bodyText(row: string): string {
  return BODY_ROW.exec(row)![1]!.replace(/\s+$/, "");
}

/**
 * The rows the card shows, or null when the body is not a shape this grammar was built against. The
 * card shows every row: nothing is elided, and a write with more than MAX_CONTENT_ROWS rows declines.
 */
function summarise(tool: string, body: string[]): string[] | null {
  if (OMP_ELISION.test(body.join("").replace(/\s+/g, ""))) return null;
  if (body.some((row) => row === SAFETY_SECTION)) return null;
  if (body.some((row) => INVISIBLE.test(row) || hasControl(row))) return null;
  const first = body[0]!.startsWith("Reason: ") ? 1 : 0;
  if (first >= body.length) return null;

  if (tool === "bash") {
    // Every row from `Command:` on is the command, wrapped or multi-line. Shown whole.
    return body[first]!.startsWith("Command: ") ? body : null;
  }

  // `write`: `Path:` (its wrapped rows too), then the first row reading exactly `Content:`.
  if (!body[first]!.startsWith("Path: ")) return null;
  const contentAt = body.indexOf("Content:", first + 1);
  if (contentAt < 0) return null;
  const content = body.slice(contentAt + 1);
  return content.length <= MAX_CONTENT_ROWS ? body : null;
}

/** An option row: the pointer column (the preset's pointer or a space), a space and the label. */
function readOption(row: string, preset: Preset): { label: string; pointed: boolean } | null {
  const inner = BOX_ROW.exec(row)?.[1]?.replace(/\s+$/, "");
  if (inner === undefined) return null;
  const pointed = inner.startsWith(` ${preset.pointer} `);
  if (!pointed && !inner.startsWith("   ")) return null;
  const label = inner.slice(pointed ? 2 + preset.pointer.length : 3);
  return /^\S/.test(label) ? { label, pointed } : null;
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
