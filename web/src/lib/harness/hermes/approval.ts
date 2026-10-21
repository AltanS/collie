// Hermes's dangerous-command approval (the input prompt reads `⚠ ❯`), lifted into a `prompt-select`
// whose buttons send the choice's digit. Read from `_get_approval_display_fragments`
// (hermes_cli/cli_tui_mixin.py, Hermes v0.22.2) and the hermes--approval-* captures; the recipe is in
// APPROVAL_NOTES.md:
//
//     ╭────────────────────────────────────────────────╮   no title in the border
//     │ ⚠️  Dangerous Command                          │   `approval_title`
//     │                                                │   (the blank rows go in a short terminal)
//     │ rm -rf /tmp/collie-hermes-lab/scratch-dir      │   the command, wrapped
//     │                                                │
//     │ ❯ 1. Allow once                                │   the choices, `❯` on the selected one
//     │   2. Allow for this session                    │
//     │   3. Add to permanent allowlist                │
//     │   4. Deny                                      │
//     │   5. Show full command                         │   only for a long command
//     │                                                │
//     │ delete in root path                            │   why Hermes flagged it
//     ╰────────────────────────────────────────────────╯
//
// A DIGIT CONFIRMS AT ONCE (`_tui_make_approval_number_handler` → `_handle_approval_selection`),
// live-probed. The buttons are CLASSIFIED by label, the way grok's and codex's are: the one-shot
// "Allow once" and "Deny" become buttons, and so does "Show full command", which only redraws the
// panel. The two rows that change Hermes's standing policy, "Allow for this session" and "Add to
// permanent allowlist", are never buttons. A row with any other label refuses the whole panel.
//
// THE COMMAND MUST BE ON THE CARD WHOLE. Hermes cuts a long command to three rows and adds
// `… (choose Show full command)`. While it is cut, the card offers "Show full command" and "Deny"
// and NOT "Allow once": nobody approves a command from the phone they could not read. Once shown in
// full the row is gone and so is the choice. A command cut because the terminal is too short
// (`… (command truncated — …)`) cannot be shown whole at all, and the panel stays raw.
//
// Pure; no pane access.

import type { StyledLine } from "../../blocks";
import type { PromptModel, PromptOption } from "../prompt-model";
import { tailLinesFor } from "../../tail-lines";
import { locateInput } from "./chrome";
import { panelAboveInput, type HermesDialogRegion } from "./clarify";
import { APPROVAL_HINT, panelInterior, panelSubject, rowTexts } from "./markers";

const BORDER_TOP = /^╭─+╮$/;
const TITLE = "⚠️  Dangerous Command";
const CHOICE = /^([❯ ]) (\d)\. (\S[\s\S]*)$/;

// `_APPROVAL_CHOICE_KEYS` → `approval_*` in locales/en.yaml.
const ONCE = "Allow once";
const SESSION = "Allow for this session";
const ALWAYS = "Add to permanent allowlist";
const DENY = "Deny";
const VIEW = "Show full command";
const KNOWN = new Set([ONCE, SESSION, ALWAYS, DENY, VIEW]);

// `approval_choose_full` with the view label, and `approval_command_truncated`, each matched on its
// first row: a panel narrower than the notice (inner width 24 to 27) wraps it onto two.
const CUT_VIEWABLE = /^… \(choose /;
const CUT_FOR_GOOD = /^… \(command truncated\b/;

/** The approval panel at the tail as a `prompt-select`, or null. */
export function detectApprovalRegion(lines: StyledLine[]): HermesDialogRegion | null {
  const frame = locateInput(lines);
  if (frame === null || frame.state !== "approval") return null;
  const span = panelAboveInput(lines, frame, APPROVAL_HINT);
  if (span === null) return null;
  const texts = rowTexts(lines);
  if (!BORDER_TOP.test(texts[span.top]!)) return null;

  const body: string[] = [];
  for (let i = span.top + 1; i < span.bottom; i++) {
    const row = panelInterior(texts[i]!);
    if (row === null) return null;
    body.push(row);
  }
  if (body[0] !== TITLE) return null;

  // The choices: the one run of rows numbered 1..n, every label one Hermes prints.
  const first = body.findIndex((row) => CHOICE.exec(row)?.[2] === "1");
  if (first < 0) return null;
  const choices: { digit: string; label: string; pointed: boolean; at: number }[] = [];
  for (let i = first; i < body.length; i++) {
    const m = CHOICE.exec(body[i]!);
    if (m === null || m[2] !== String(choices.length + 1)) break;
    choices.push({ digit: m[2]!, label: m[3]!.trim(), pointed: m[1] === "❯", at: i });
  }
  if (choices.some((c) => !KNOWN.has(c.label))) return null;
  if (choices.filter((c) => c.pointed).length !== 1) return null;
  // A later row numbered like a choice is a layout this grammar has not seen.
  if (body.slice(first + choices.length).some((row) => CHOICE.test(row))) return null;
  const once = choices.find((c) => c.label === ONCE);
  const deny = choices.find((c) => c.label === DENY);
  if (once === undefined || deny === undefined) return null;

  // The command: every row between the title and the choices, padding blanks aside. The
  // description: every row after them.
  const command = body.slice(1, first).filter((row) => row !== "");
  if (command.length === 0 || command.some((row) => CUT_FOR_GOOD.test(row))) return null;
  const cut = command.some((row) => CUT_VIEWABLE.test(row));
  const view = choices.find((c) => c.label === VIEW);
  if (cut && view === undefined) return null;

  const tail = tailLinesFor(span.rowsBelow);
  if (tail === null) return null;

  const options: PromptOption[] = [];
  if (!cut) options.push({ label: once.label, keys: [once.digit] });
  if (view !== undefined) options.push({ label: view.label, keys: [view.digit] });
  options.push({ label: deny.label, keys: [deny.digit] });

  const panelRows = texts.slice(span.top, span.bottom + 1);
  const pointer = choices.find((c) => c.pointed)!.at + 1;
  const model: PromptModel = {
    question: TITLE.replace(/^⚠️\s+/, ""),
    options,
    family: "permission",
    signature: panelRows.join("\n"),
    // The pointer is the one glyph a digit tap does not need to agree on; blank it for identity.
    coreSignature: panelRows.map((t, i) => (i === pointer ? t.replace("❯", " ") : t)).join("\n"),
    // What is being approved, on the card itself: the command and Hermes's reason, between the title
    // and the choices and after them. Display only; `signature` covers these rows.
    subject: panelSubject([
      ...lines.slice(span.top + 2, span.top + 1 + first),
      ...lines.slice(span.top + 1 + first + choices.length, span.bottom),
    ]),
  };
  if (tail !== undefined) model.bindTail = tail;
  return { model, startLine: span.top };
}
