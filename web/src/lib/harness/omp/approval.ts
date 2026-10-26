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
// 0009), and no digit is invented. Both buttons are ADR 0055's plain walk from the pointed row,
// `pointerWalk(pointedAt, i)`: `Approve` is `Enter` when the pointer is on it and `Up`, `Enter` when
// it is on Deny; `Deny` is `Enter` when the pointer is on it and `Down`, `Enter` when it is on
// Approve. The action layer splits the plan (ADR 0080): it sends the arrows bound to the tapped
// screen, reads the pointer back, and sends `Enter` only bound to a fresh read that shows the pointer
// on the tapped row. A pointer that moved at the desk makes the tap send nothing, never a different
// choice. omp's list clamps at its ends (`HookSelectorComponent.handleInput` calls
// `MenuSelection.move(delta, false)`; the live Deny-on-Deny probe of 2026-10-02 showed it), and the
// model declares that as `clampedEnds`. That fact is load-bearing again, as a declared fact the
// action layer consumes and not as a plan: the plans above stay the plain walk, and the commit batch
// is the action layer's. `Approve` is the first row and `Deny` the last, so the commit goes out as
// `Up, Enter` and `Enter` is never bare on an edge: a desk arrow landing in the gap between the
// bridge's re-read and its send cannot turn a Deny tap into an approval, nor an Approve tap into a
// denial that the user did not ask for (ADR 0078's guarantee, restored by ADR 0080 point 6).
// `Cancel` sends `Escape` and is no row of the list. The card's last row
// is the footer's way out in its own words (`Cancel`), sending `Escape`, which omp also reports to
// the agent as a denial.
//
// WHAT THE CARD SHOWS, so nobody approves blind. The caption is the title (`Allow tool: bash`, the
// tool's name). The Approve button's description is the body, row by row, rows joined by ` ↵ ` so a
// newline in a command is never read as a space; that overstates a soft wrap as a break, which is the
// safe direction. The `question` (the card's accessible name) is the title and the same rows. Nothing
// is ever shortened or hidden: a bash body is shown whole, and so is a `write` body, up to
// MAX_CONTENT_ROWS rows of content, past which the screen declines to the raw mirror. omp itself
// shortens every field to 2000 characters (`truncateForPrompt`), and a field it shortened declines
// below. The card starts at the box's title row, so the box is not also painted in the raw mirror above it.
//
// FAIL CLOSED (the first shape; the second shape's evidence is in its own header above). Every piece below is required, and any one missing returns null, which leaves the raw
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
//     the two with captured bodies, or `goal` (omp 18.6.1) with NO body at all: see BODYLESS_TOOLS. Their body must have the captured shape (an optional `Reason:` row,
//     then `Command:`; or `Path:`, then a row reading `Content:`);
//   * the body carries neither omp's own elision mark (`[…Nch elided…]`, so omp hid part of the
//     subject from the terminal too) nor a `Provider safety checks:` section (uncaptured), nor a
//     control, zero-width or bidi character, which can make the card read differently from the command;
//   * a region short enough for the bridge to bind (32000 characters, as resume.ts and ask.ts).
//
// THE SECOND SHAPE, omp 18.12.6 (2026-10-25, `omp--v18-12-6-approval-bash--w120.txt`; pi-tui
// `overlays/approval-dialog.ts` over `chrome/overlay-box.ts`, read in the published 18.12.6 package).
// omp rebuilt the dialog on its overlay panel. The blank spacer rows are gone, the choices moved under
// the body, a divider row (`├─…─┤`) sits over the footer, and a session row joined the list:
//
//     ╭─ Allow tool: bash ─────────────────────────────────╮     the title
//     │ Command: echo gang-test                            │     the body: ONE summary row per detail
//     │ ❯ Approve                                          │     the pointed row: pointer, space, label
//     │   Approve bash for this session                    │     only when the call may be granted
//     │   Deny                                             │
//     ├────────────────────────────────────────────────────┤
//     │ ↑/↓ choose · ⏎ select · Ctrl+⏎/Ctrl+Q approve · ⎋ deny · Ctrl+O details · type to deny and steer │
//     ╰────────────────────────────────────────────────────╯
//      ⠙ 4s > ◒ Haiku 4.5 > … ▶──6%───┃─────200K─               the band: the status row and the empty prompt
//     ╰─                                                          row of the composer, which this dialog does not replace
//
// What differs from the first shape, each read off the source and the capture:
//   * THE BODY IS A SUMMARY, not the call. `showCollabAwareApproval` hands the dialog the COMPACT prompt:
//     each detail cut to its first line and joined by ` · `, a ` …` after it when a detail had more lines
//     (`approvalSummary`), and every row then clipped to the box with a `…` (`truncateToWidth`). A body
//     row that ends in `…` therefore may hide part of the command, and the card declines it: someone
//     approves from the card, so it never shows less than it claims. Ctrl+O swaps the full prompt in on
//     the desk. Only `bash` is lifted here: its summary row is `Command: <command>` and nothing else
//     (`tools/bash.ts` `formatApprovalDetails`). A `write` summary would hide its content behind
//     `Content: <first row> …`, always, and no 18.12.6 capture holds one.
//   * THE LIST WRAPS. `#moveChoice` is `(choice + delta + count) % count`, so Up on the first row lands on
//     Deny and Down on the last on Approve. The model does NOT declare `clampedEnds`: the first shape's
//     commit batch `Up, Enter` would DENY here. A walk-class commit is a bare `Enter` on a verified read.
//   * DENY IS ESCAPE. Because the list wraps, no walk-and-Enter plan from the Deny row is safe against a
//     desk arrow in the gap between the bridge's read and its send: `Down, Enter` on Deny would approve.
//     `⎋ deny` is named by the footer and denies from any row (`matchesSelectCancel` is checked before
//     the arrows), so the Deny button is `Escape`, not a walk. ADR 0078's guarantee (a Deny tap never
//     lands on Approve) holds for the second shape by that choice. There is no separate Cancel button:
//     it would be the same key.
//   * THE SESSION ROW, `Approve <tool> for this session`, grants every later call of that tool for the
//     rest of the session (`sessionApprovalScope`). It is a button like the others and keeps the screen's
//     own words, in the position the screen gives it, between Approve and Deny. Tapping it walks one row.
//   * THE FOOTER is one exact string (the keycaps follow the install's keybindings and symbol preset, so
//     anything else is another dialect and declines), and no row under the box except the composer's own
//     band and empty prompt row. A draft in the composer relabels the Deny row `Deny and send message`
//     and moves the pointer onto it; that label is no row this grammar knows, so the screen declines.
//   * Only the `unicode` preset is captured. `❯` is the pointer and the footer carries the glyph keycaps.
//
// THE SUMMARY TOOLS (`task`, 18.12.6). A subagent call's compact row is a summary by design, never the
// whole call, so it is lifted with the clipped row as the screen shows it (see SUMMARY_TOOLS).
//
// Not read, and so declined: the `always-ask-cached` grants (`Remember across sessions`, `Approve
// Directory: …`, `Approve Once`), a title with a countdown, the PgUp/PgDn scroll hint of an overflowing
// body, a `write` or any other tool, and the nerd preset.
//
// Pure functions over `StyledLine[]`, tail-anchored like every other grammar.

import type { StyledLine } from "../../blocks";
import { hasHiddenCharacter, MAX_REGION_CHARS } from "../bound-region";
import { pointerWalk } from "../menu-hints";
import type { PromptModel, PromptOption } from "../prompt-model";
import { isBlank, lineText, rstrip } from "./markers";
import { readOmpHintList } from "./modal";

export interface ApprovalRegion {
  model: PromptModel;
  /** Index of the title row: the card replaces [`startLine` … the tail]. The card prints the title and
   *  every body row itself (`question`), so the mirror above ends where the box begins. */
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

/** The two tools whose approval body is captured, and so the only two lifted with a body. */
const LIFTED_TOOLS = new Set(["bash", "write"]);

/**
 * The tools lifted with NO body (omp 18.6.1, `omp--v18-6-1-approval-goal--w120.txt`). `goal` has no
 * `formatApprovalDetails`, so `approvalDetails` returns nothing and the box is the title, the spacer, a
 * second blank row and the choices. omp's source (`goals/tools/goal-tool.ts`) says why it asks: "Goal ops
 * touch only session state; the rest change the goal, so `always-ask` still prompts". The card names the
 * tool and nothing else, because the screen shows nothing else; the transcript row above (`⏳ Goal: …`)
 * says which op the model called. A bodyless tool lifts only with exactly that empty body: a `Reason:`
 * row, or any other row, declines.
 */
const BODYLESS_TOOLS = new Set(["goal"]);

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

/**
 * Detect omp's tool-approval dialog at the tail of `lines`, in either shape (see the header): the
 * blank-row box of omp 18.1 to 18.6 or the divided panel of omp 18.12. Returns a `prompt-select` model
 * and the index of the title row; null when any piece of evidence is missing. The two never share a
 * tail (the first needs a blank row over its footer, the second a divider), so the order is free.
 */
export function detectApprovalRegion(lines: StyledLine[]): ApprovalRegion | null {
  return detectBlankRowApproval(lines) ?? detectDividedApproval(lines);
}

/**
 * The first shape: `Approve` and `Deny` between blank rows, a footer under another, options as the
 * footer's way out. Returns a `prompt-select` model whose options are `Approve`, `Deny` and the
 * footer's own way out, and the index of the title row.
 */
function detectBlankRowApproval(lines: StyledLine[]): ApprovalRegion | null {
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
  if (bottom !== end && !(preset.strip && looksLikeUsageStrip(texts[end]!))) return null;
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
  const bodyless = BODYLESS_TOOLS.has(tool);
  if (!bodyless && !LIFTED_TOOLS.has(tool)) return null;
  // The spacer omp draws under the title, then at least one body row; a bodyless tool has none, and the
  // blank row over its choices follows the spacer directly.
  if (!BLANK_ROW.test(texts[titleAt + 1]!)) return null;
  if (bodyless ? titleAt + 2 !== bottom - 6 : titleAt + 2 > bottom - 7) return null;
  const bodyRows = texts.slice(titleAt + 2, bottom - 6);
  // A row that ends in `…` with no right border may be a row omp clipped, which wrapped overflow would
  // not look like. The card cannot tell the two apart, so it declines.
  if (bodyRows.some((row) => !row.endsWith("│") && row.endsWith("…"))) return null;
  const body = bodyRows.map(bodyText);
  if (!bodyless && body[0]!.length === 0) return null;
  const shown = bodyless ? [] : summarise(tool, body);
  if (shown === null) return null;

  // 4. The signature is the region verbatim, title through the bottom border, trailing padding off.
  //    It carries the pointer column and every body row, so a pointer moved between the render and
  //    the tap, or a different call with the same tool, refuses the tap (ADR 0055 point 6). The usage
  //    strip under the border is not in it: it ticks.
  const region = texts.slice(titleAt, bottom + 1);
  const signature = region.join("\n");
  if (signature.length > MAX_REGION_CHARS) return null;
  const pointedAt = approve.pointed ? 0 : 1;
  const pointedRow = approveAt + pointedAt;
  const coreSignature = region
    .map((row, i) => (titleAt + i === pointedRow ? row.replace(preset.pointer, " ") : row))
    .join("\n");

  const title = `Allow tool: ${tool}`;
  const approveOption: PromptOption = { label: "Approve", keys: pointerWalk(pointedAt, 0), keyLabel: approve.pointed ? POINTER_BADGE : "" };
  // A bodyless tool shows no subject: the Approve button carries no description.
  if (shown.length > 0) approveOption.description = shown.join(ROW_BREAK);
  const options: PromptOption[] = [
    approveOption,
    // The plain walk, like Approve: the verified commit of ADR 0080 plus `clampedEnds` is the safety argument. See the header.
    { label: "Deny", keys: pointerWalk(pointedAt, 1), keyLabel: deny.pointed ? POINTER_BADGE : "" },
    // The footer's own way out, in its own words (ADR 0058 point 5).
    { label: capitalise(footer.escapeVerb), keys: ["Escape"], keyLabel: "Esc" },
  ];
  const model: PromptModel = {
    question: [title, ...shown].join("\n"),
    caption: title,
    options,
    family: "permission",
    // omp 18.4.10 clamps at both ends (see the header); two rows, both visible, no hidden row.
    clampedEnds: true,
    signature,
    coreSignature,
  };
  return { model, startLine: titleAt };
}

// ── The second shape: omp 18.12.6 ────────────────────────────────────────────────────────────────

/** The footer of the divided panel, exactly, as the `unicode` preset prints it (see the header). */
const DIVIDED_FOOTER = "↑/↓ choose · ⏎ select · Ctrl+⏎/Ctrl+Q approve · ⎋ deny · Ctrl+O details · type to deny and steer";
/** The pointer of the `unicode` preset, then the one space omp puts before the label. */
const DIVIDED_POINTER = "❯ ";
/** The divider over the footer. */
const DIVIDER = /^├─+┤$/;
/** The tool whose summary row is captured as the command itself: the divided shape lifts it whole. */
const DIVIDED_TOOLS = new Set(["bash"]);
/**
 * The tools the divided shape lifts with a SUMMARY row that omp always shortens (omp 18.12.6,
 * `omp--v18-12-6-approval-task--w120.txt`): `task` starts a subagent, and its compact prompt
 * (`approvalSummary`) joins the first line of each detail (`Agent:`, `Name:`, `Task:`, `Context:`,
 * `Batch agents:`) with ` · ` and clips the row to the box with a `…`. The full prompt is on the desk
 * under Ctrl+O. Unlike a command, the row was never the whole call, so a trailing `…` says nothing a
 * second time: the card shows the row verbatim, mark and all, and claims no more than the screen does.
 */
const SUMMARY_TOOLS = new Set(["task"]);
/** The details of a `task` call, as the first words of its summary row (`TaskTool.formatApprovalDetails`). */
const TASK_SUMMARY_ROW = /^(?:Agent|Name|Task|Context|Batch agents): \S/;
/** A body is at most `Reason: …` and `Command: …`: one compact row per detail. */
const MAX_DIVIDED_BODY_ROWS = 2;
/** The session row's label: `Approve ${sessionSubject} for this session`, the subject being the tool. */
const SESSION_LABEL = /^Approve (\S+) for this session$/;
/** The composer's band under the dialog: the status row (spinner and time, or π, then segments, then the
 *  `▶` or U+E0B0 cap and the rule) and the empty prompt row. The same row `omp.json` reads as the top
 *  of the composer; a dialog never replaces it, so a shell prompt under a stale box is not one. */
const BAND_ROW = /^(?:\u{E0B6} |\s?)(?:π|\u{F0D57}|[⠀-⣿]\s+\d+[smh])\s.*(?:▶|\u{E0B0})─.*$/u;
const EMPTY_PROMPT_ROW = /^╰─$/;

interface DividedChoice {
  label: string;
  pointed: boolean;
}

/** A choice row of the divided panel: `│ ` then the pointer and a space, or two spaces, then the label. */
function readDividedChoice(row: string): DividedChoice | null {
  const inner = BOX_ROW.exec(row)?.[1]?.replace(/\s+$/, "");
  if (inner === undefined) return null;
  const pointed = inner.startsWith(DIVIDED_POINTER);
  if (!pointed && !inner.startsWith("  ")) return null;
  const label = inner.slice(2);
  return /^\S/.test(label) ? { label, pointed } : null;
}

/**
 * The divided panel (omp 18.12.6). Fail closed, as the first shape: the border is the last non-blank
 * row, or sits over exactly the composer's band and empty prompt row; above it the footer (one exact
 * string), the divider, then the choices `Approve`, optionally `Approve <tool> for this session`, and
 * `Deny` with exactly one pointer; above them one or two body rows (free text like the first shape's, the
 * right side not required, every byte of it in the signature) and the title. The card is
 * `Approve`, the session row when there is one, and `Deny` as Escape; no `clampedEnds` (the list wraps).
 */
function detectDividedApproval(lines: StyledLine[]): ApprovalRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));

  // 1. The tail: the bottom border, or the border over the composer's band and its empty prompt row.
  let end = texts.length - 1;
  while (end >= 0 && isBlank(texts[end]!)) end--;
  if (end < 0) return null;
  let bottom = end;
  if (EMPTY_PROMPT_ROW.test(texts[end]!)) {
    if (end < 1 || !BAND_ROW.test(texts[end - 1]!)) return null;
    bottom = end - 2;
  }
  // Title, one body row, two choices, the divider, the footer and the border at the least.
  if (bottom < 6 || !BOTTOM.test(texts[bottom]!)) return null;

  // 2. The footer and the divider over it.
  const footerRow = BOX_ROW.exec(texts[bottom - 1]!);
  if (footerRow === null || footerRow[1]!.trim() !== DIVIDED_FOOTER) return null;
  if (!DIVIDER.test(texts[bottom - 2]!)) return null;

  // 3. The choices, read up from the divider: Deny last, then `Approve`, with the session row between
  //    them when it is there.
  const deny = readDividedChoice(texts[bottom - 3]!);
  if (deny?.label !== "Deny") return null;
  const middle = readDividedChoice(texts[bottom - 4]!);
  if (middle === null) return null;
  let choices: DividedChoice[];
  let sessionTool: string | null = null;
  if (middle.label === "Approve") {
    choices = [middle, deny];
  } else {
    sessionTool = SESSION_LABEL.exec(middle.label)?.[1] ?? null;
    const approve = readDividedChoice(texts[bottom - 5]!);
    if (sessionTool === null || approve?.label !== "Approve") return null;
    choices = [approve, middle, deny];
  }
  if (choices.filter((c) => c.pointed).length !== 1) return null;
  const choicesAt = bottom - 2 - choices.length;

  // 4. The body, up to the title: one or two rows, each boxed with its right side.
  let titleAt = choicesAt - 1;
  while (titleAt >= 0 && !TITLE.test(texts[titleAt]!)) {
    if (choicesAt - titleAt > MAX_DIVIDED_BODY_ROWS || !BODY_ROW.test(texts[titleAt]!)) return null;
    titleAt--;
  }
  if (titleAt < 0 || titleAt === choicesAt - 1) return null;
  const tool = TITLE.exec(texts[titleAt]!)![1]!;
  if (!DIVIDED_TOOLS.has(tool) && !SUMMARY_TOOLS.has(tool)) return null;
  if (sessionTool !== null && sessionTool !== tool) return null;
  const body = texts.slice(titleAt + 1, choicesAt).map(bodyText);
  const shown = SUMMARY_TOOLS.has(tool) ? summariseSummaryTool(body) : summariseDivided(body);
  if (shown === null) return null;

  // 5. The signature, as the first shape's: the region verbatim, title through the border. The band
  //    under it is the composer's and ticks.
  const region = texts.slice(titleAt, bottom + 1);
  const signature = region.join("\n");
  if (signature.length > MAX_REGION_CHARS) return null;
  const pointedAt = choices.findIndex((c) => c.pointed);
  const pointedRow = choicesAt + pointedAt;
  const coreSignature = region
    .map((row, i) => (titleAt + i === pointedRow ? row.replace(DIVIDED_POINTER, "  ") : row))
    .join("\n");

  const title = `Allow tool: ${tool}`;
  const badge = (i: number): string => (i === pointedAt ? POINTER_BADGE : "");
  const options: PromptOption[] = [
    {
      label: "Approve",
      description: shown.join(ROW_BREAK),
      keys: pointerWalk(pointedAt, 0),
      keyLabel: badge(0),
    },
  ];
  if (sessionTool !== null) {
    options.push({ label: choices[1]!.label, keys: pointerWalk(pointedAt, 1), keyLabel: badge(1) });
  }
  // Deny is the footer's own `⎋ deny`, not a walk: the list wraps, and Escape denies from any row.
  options.push({ label: "Deny", keys: ["Escape"], keyLabel: "Esc" });
  const model: PromptModel = {
    question: [title, ...shown].join("\n"),
    caption: title,
    options,
    family: "permission",
    signature,
    coreSignature,
  };
  return { model, startLine: titleAt };
}

/**
 * The compact body of the divided panel: an optional `Reason: …` row, then `Command: …`. A row that ends
 * in `…` may be one omp cut to the box, or a command with more lines (`approvalSummary`'s ` …`), so the
 * card declines it rather than show less than the call. Same refusals as the first shape's body.
 */
function summariseDivided(body: string[]): string[] | null {
  if (body.length === 0 || body.length > MAX_DIVIDED_BODY_ROWS) return null;
  if (body.some((row) => row.length === 0 || row.endsWith("…"))) return null;
  if (OMP_ELISION.test(body.join("").replace(/\s+/g, ""))) return null;
  if (body.some(hasHiddenCharacter)) return null;
  const first = body[0]!.startsWith("Reason: ") ? 1 : 0;
  if (body.length !== first + 1) return null;
  return body[first]!.startsWith("Command: ") ? body : null;
}

/**
 * The compact body of a summary tool (see SUMMARY_TOOLS): an optional `Reason: …` row, then the one
 * summary row. It may end in omp's `…`; it carries neither omp's elision mark nor a hidden character.
 */
function summariseSummaryTool(body: string[]): string[] | null {
  if (body.length === 0 || body.length > MAX_DIVIDED_BODY_ROWS) return null;
  if (body.some((row) => row.length === 0)) return null;
  if (OMP_ELISION.test(body.join("").replace(/\s+/g, ""))) return null;
  if (body.some(hasHiddenCharacter)) return null;
  const first = body[0]!.startsWith("Reason: ") ? 1 : 0;
  if (body.length !== first + 1) return null;
  return TASK_SUMMARY_ROW.test(body[first]!) ? body : null;
}

/** Whether a lifted approval dialog owns the keyboard of this screen, in either shape. */
export function approvalOwnsKeyboard(lines: StyledLine[]): boolean {
  return detectApprovalRegion(lines) !== null;
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
  if (body.some(hasHiddenCharacter)) return null;
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

/** The operator's usage strip as the 18.1.17 captures print it: many ` · ` separated segments. A shell
 *  prompt, a path or one line of output is not one, and `Up`, `Enter` into a shell runs history. */
function looksLikeUsageStrip(row: string): boolean {
  return (row.match(/ · /g)?.length ?? 0) >= 3;
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
