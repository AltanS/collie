// Approval detection — the grammar that recognises Muse's approval dialogs sitting directly
// above the composer tail chrome and lifts them into a `PromptModel` the UI renders as native
// buttons. Two variants share the numbered-options tail; each pins its own question + subject:
//
//     Would you like to run the following command?
//
//       $ ls -la /private/tmp/collie-muse-sandbox
//       Stage 1/1
//       Current argv: ["ls","-la","/private/tmp/collie-muse-sandbox"]
//
//     › 1. Allow this stage once (y)
//       2. Always allow in this workspace: ls ... (p)
//       3. Abort the entire command (esc)
//     ────… (bottom rule)
//       <statusline>
//
//     Would you like to allow this network access?
//
//       network: www.gt:443 https
//       full URL: https://www.gt/sitio/faq.php#faq-47
//
//     › 1. Yes, proceed (y)
//       2. Yes, don't ask again this session (p)  www.gt:443 (https)
//       3. Always allow this network destination  www.gt:443 (https)
//       4. No, and tell Muse Code what to do differently (esc)
//     ────… (bottom rule)
//       <statusline>
//
// Everything here is a PURE function over `StyledLine[]`, driven entirely by the fixture corpus
// (web/src/fixtures/panes/muse--*.txt). It never touches a pane or the network. The tail invariant
// is the backbone: the options must sit directly above the bottom rule, so an approval that has
// scrolled up (with transcript below it) simply doesn't match — the false-positive guard.
//
// Only the COMMAND and NETWORK shapes above are lifted (DIALOG_NOTES.md, scope): file/peer
// approval variants ride along only when a capture shows them sharing it. Anything else answers
// null and stays raw.

import { lineText, type StyledLine } from "../../blocks";
import type { PromptModel, PromptOption } from "../prompt-model";
import {
  locateTail,
  menuRowsContiguous,
  parseNumberedOption,
  regionSignature,
  rstrip,
  trailingMenuRows,
} from "./markers";

// Each question is Muse's fixed string for its approval kind — matched EXACTLY, not as a
// prefix. A looser match would risk lifting an unprobed approval KIND (file? peer?) whose keys
// were never measured, and a wrong digit there approves a real side effect.
const APPROVAL_COMMAND_QUESTION = "Would you like to run the following command?";
const APPROVAL_NETWORK_QUESTION = "Would you like to allow this network access?";

// The command-approval subject, in order between question and options: the shell line, the
// stage counter, the parsed argv. All three are required — together they are what makes this a
// command approval rather than some other dialog that happens to share the question.
const SUBJECT_DOLLAR = /^\s*\$\s+\S/;
const SUBJECT_STAGE = /^\s*Stage \d+\/\d+\s*$/;
const SUBJECT_ARGV = /^\s*Current argv:/;

// The network-approval subject, in order: the destination + scheme, the full URL. Both required,
// for the same reason as the command triple.
const SUBJECT_NETWORK = /^\s*network:\s+\S/;
const SUBJECT_FULL_URL = /^\s*full URL:\s+\S/;

// Options live within a couple dozen lines of the tail; scanning a bounded window keeps a stray
// "N." far up in scrollback history from ever being mistaken for a menu row.
const OPTION_SCAN_WINDOW = 24;

/**
 * The full detection result buildBlocks needs: the model PLUS `startLine`, the index of the first
 * option row — the menu region is [`startLine` … tail], which the renderer replaces with buttons.
 * Everything above `startLine` (the question and the subject) stays raw, so no context is lost and
 * the question isn't shown twice (the prompt renderer captions by family, never repeats it).
 */
export interface ApprovalRegion {
  model: PromptModel;
  startLine: number;
}

/**
 * Detect a command- or network-approval dialog above the tail chrome. Returns the model + its
 * start line, or null when the tail isn't one. Pure; the caller owns pane access.
 */
export function detectApprovalRegion(lines: StyledLine[]): ApprovalRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));

  // 1. Tail chrome: bottom rule + statusline at the buffer end. The options must sit directly above
  //    the rule — a menu that has scrolled up has transcript below it, so it bails here (the
  //    false-positive gate). The box is NOT required: a live approval replaces it.
  const tail = locateTail(lines);
  if (tail === null) return null;
  let last = tail.rule - 1;
  while (last >= 0 && texts[last]!.trim() === "") last--;
  if (last < 0) return null;

  // 2. Numbered option rows in the window above the rule. The menu is the trailing 1,2,…,m run of
  //    them; scattered "N." lines from the dialog body sit above it and drop out.
  const from = Math.max(0, last - OPTION_SCAN_WINDOW);
  const rows: { index: number; n: number; label: string }[] = [];
  for (let i = from; i <= last; i++) {
    const parsed = parseNumberedOption(texts[i]!);
    if (parsed) rows.push({ index: i, n: parsed.n, label: parsed.label });
  }
  const menu = trailingMenuRows(rows);
  if (menu.length < 2) return null; // ≥2 rows numbered 1,2,…,m — else not an approval tail.
  // A menu numbered past 9 would need the two-key digit ("10"), which Herdr's send_keys rejects —
  // so up-levelling it would emit an unsendable keystroke plan. Bail to raw + the keys pad.
  if (menu.length > 9) return null;
  // Gapless rows only — a transcript numbered list must never fuse into the run (markers.ts).
  if (!menuRowsContiguous(menu)) return null;
  const firstOpt = menu[0]!.index;
  const lastOpt = menu[menu.length - 1]!.index;
  if (lastOpt !== last) return null; // the run must END at the rule — nothing may sit between.

  // 3. The exact question above the first option (blanks tolerated, nothing else).
  let qi = firstOpt - 1;
  while (qi >= 0 && texts[qi]!.trim() === "") qi--;
  // The subject sits between question and options — walk past it to the question. Subject rows are
  // validated in step 4; here only the SHAPE matters (non-blank, non-option rows).
  let qj = qi;
  while (qj >= 0 && texts[qj]!.trim() !== "" && !parseNumberedOption(texts[qj]!)) qj--;
  while (qj >= 0 && texts[qj]!.trim() === "") qj--;
  if (qj < 0) return null;
  const question = texts[qj]!.trim();
  const isCommand = question === APPROVAL_COMMAND_QUESTION;
  const isNetwork = question === APPROVAL_NETWORK_QUESTION;
  if (!isCommand && !isNetwork) return null;
  const questionAt = qj;

  // 4. The subject, in order, between question and options — the triple for a command approval,
  //    the destination pair for a network one.
  const subject = texts.slice(questionAt + 1, firstOpt).filter((t) => t.trim() !== "");
  if (isCommand) {
    const dollar = subject.findIndex((t) => SUBJECT_DOLLAR.test(t));
    const stage = subject.findIndex((t) => SUBJECT_STAGE.test(t));
    const argv = subject.findIndex((t) => SUBJECT_ARGV.test(t));
    if (dollar < 0 || stage < 0 || argv < 0 || !(dollar < stage && stage < argv)) return null;
  } else {
    const network = subject.findIndex((t) => SUBJECT_NETWORK.test(t));
    const url = subject.findIndex((t) => SUBJECT_FULL_URL.test(t));
    if (network < 0 || url < 0 || !(network < url)) return null;
  }

  // 5. Build the options. Labels keep their parenthesised shortcut hints — terminal-honest text, and
  //    the digit alone is the whole recipe (family `permission`: probed on both live variants, `1`
  //    approved with no Enter — a trailing Enter would leak into whatever renders next). Network
  //    labels keep the trailing scope (`www.gt:443 (https)`) for the same reason: it names what
  //    the digit blesses.
  const options: PromptOption[] = menu.map((row) => ({ label: row.label, keys: [String(row.n)] }));

  // The signature runs question → last option: contiguous literal rows the bridge can bind a write
  // to. No transcript lookback above the question — the rows up there carry live spinner timers
  // (`Calling tools (39s)`), which would churn the signature every second and 409 every tap. The
  // accepted cost is stated on the adapter: two consecutive byte-identical approvals share one
  // signature, so a tap on the first may land on the second — the same command the user consented to.
  const signature = regionSignature(texts, questionAt, lastOpt);
  const coreSignature = texts
    .slice(questionAt, lastOpt + 1)
    .map((t) => t.replaceAll("›", " "))
    .join("\n");
  return {
    model: { question, options, family: "permission", signature, coreSignature },
    startLine: firstOpt,
  };
}

/**
 * Detect an approval dialog at the tail of `lines`, returning just the model (or null). The
 * thin public matcher — used by the race guard to re-derive from a fresh buffer and by tests.
 * buildBlocks uses {@link detectApprovalRegion} for the render boundary.
 */
export function detectApproval(lines: StyledLine[]): PromptModel | null {
  return detectApprovalRegion(lines)?.model ?? null;
}
