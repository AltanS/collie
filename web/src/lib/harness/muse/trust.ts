// Trust detection — the grammar that recognises Muse's pre-session workspace-trust dialog and
// lifts it into a `PromptModel`.
//
//     Do you trust this workspace?
//     Workspace: /private/tmp/collie-muse-sandbox
//
//     Trusting allows project-local skills, rules, hooks, and plugin config to load before the model
//     runs.
//     Only trust this workspace when you trust its contents.
//
//
//
//     > 1  Trust and continue
//       2  Quit
//
//     Use Up/Down or 1/2, then Enter. Esc quits.
//
// Everything here is a PURE function over `StyledLine[]`, driven entirely by the fixture corpus
// (web/src/fixtures/panes/muse--*.txt). It never touches a pane or the network. Trust is pre-session
// — no composer, no rules, no statusline — so the tail invariant is simply that the footer is the
// buffer's last non-blank row. A trust screen that has scrolled up has content below it and bails.
//
// The options take TWO spaces after the digit and NO period (`1  Trust…`) — unlike every other Muse
// dialog, and the reason this grammar has its own option parser rather than sharing the numbered
// one: the `N.` form must never match here, and the `N  Label` form must never match there.

import { lineText, type StyledLine } from "../../blocks";
import type { PromptModel, PromptOption } from "../prompt-model";
import {
  lastNonBlankIndex,
  menuRowsContiguous,
  parseTrustOption,
  regionSignature,
  rstrip,
  trailingMenuRows,
} from "./markers";

// The question is Muse's fixed string — matched EXACTLY. A looser match would risk lifting a
// differently-worded trust variant whose keys were never measured, and option 1 here trusts a
// workspace (loads its skills/rules/hooks): the highest-stakes digit in the whole adapter.
const TRUST_QUESTION = "Do you trust this workspace?";

// The footer lead, matched as a prefix over the footer rows joined with a space (wrap-tolerant).
const FOOTER_LEAD = "Use Up/Down or";

// Footer rows (the bar is short; two rows cover narrow panes).
const MAX_FOOTER_ROWS = 2;
// Options live within a couple dozen lines of the footer.
const OPTION_SCAN_WINDOW = 24;

/**
 * The full detection result buildBlocks needs: the model PLUS `startLine`, the index of the first
 * option row — the menu region is [`startLine` … tail], which the renderer replaces with buttons.
 * Everything above `startLine` (question, workspace, explainer) stays raw, so no context is lost
 * and the question isn't shown twice (the prompt renderer captions by family, never repeats it).
 */
export interface TrustRegion {
  model: PromptModel;
  startLine: number;
}

/**
 * Detect the workspace-trust dialog at the buffer's tail. Returns the model + its start line, or
 * null when the tail isn't one. Pure; the caller owns pane access.
 */
export function detectTrustRegion(lines: StyledLine[]): TrustRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));

  // 1. The footer is the last non-blank row (up to MAX_FOOTER_ROWS joined for narrow-pane wraps).
  const fi = lastNonBlankIndex(texts);
  if (fi < 0) return null;
  let footerStart = fi;
  while (
    footerStart - 1 >= 0 &&
    texts[footerStart - 1]!.trim() !== "" &&
    fi - (footerStart - 1) < MAX_FOOTER_ROWS
  ) {
    footerStart--;
  }
  if (footerStart - 1 >= 0 && texts[footerStart - 1]!.trim() !== "") return null;
  const footer = texts
    .slice(footerStart, fi + 1)
    .map((t) => t.trim())
    .join(" ");
  if (!footer.startsWith(FOOTER_LEAD)) return null;

  // 2. The period-less option run just above the footer.
  const from = Math.max(0, footerStart - OPTION_SCAN_WINDOW);
  const rows: { index: number; n: number; label: string }[] = [];
  for (let i = from; i < footerStart; i++) {
    const parsed = parseTrustOption(texts[i]!);
    if (parsed) rows.push({ index: i, n: parsed.n, label: parsed.label });
  }
  const menu = trailingMenuRows(rows);
  if (menu.length < 2) return null; // ≥2 rows numbered 1,2,…,m — else not a trust tail.
  // A menu numbered past 9 would need the two-key digit ("10"), which Herdr's send_keys rejects —
  // so up-levelling it would emit an unsendable keystroke plan. Bail to raw + the keys pad.
  if (menu.length > 9) return null;
  // Gapless rows only — a transcript numbered list must never fuse into the run (markers.ts).
  if (!menuRowsContiguous(menu)) return null;
  const firstOpt = menu[0]!.index;

  // 3. The exact question above the options, with a `Workspace:` subject row between. The
  //    subject proves WHICH workspace this trusts — without it (a variant shape) there is no lift.
  //    Nearest exact match upward (bounded): the subject spans several blank-separated blocks
  //    (workspace row, explainer), so a shape-walk would land mid-subject instead of on the question.
  const QUESTION_SCAN_LIMIT = 12;
  let questionAt = -1;
  const top = Math.max(0, firstOpt - QUESTION_SCAN_LIMIT);
  for (let i = firstOpt - 1; i >= top; i--) {
    if (texts[i]!.trim() === TRUST_QUESTION) {
      questionAt = i;
      break;
    }
  }
  if (questionAt < 0) return null;
  const between = texts
    .slice(questionAt + 1, firstOpt)
    .map((t) => t.trim())
    .filter((t) => t !== "");
  if (!between.some((t) => t.startsWith("Workspace:"))) return null;

  // 4. Build the options. The digit alone submits (family `trust`: probed on the live dialog, `1`
  //    trusted with no Enter — a trailing Enter would leak into the starting session).
  const options: PromptOption[] = menu.map((row) => ({ label: row.label, keys: [String(row.n)] }));

  // The signature runs question → footer: contiguous literal rows the bridge can bind a write to.
  // No timers anywhere on this screen, so no exclusion is needed — and no transcript lookback above
  // the question either (same successive-identical tradeoff as the other Muse grammars, stated on
  // the adapter).
  const signature = regionSignature(texts, questionAt, fi);
  const coreSignature = texts
    .slice(questionAt, fi + 1)
    .map((t) => t.replaceAll(">", " "))
    .join("\n");
  return { model: { question: TRUST_QUESTION, options, family: "trust", signature, coreSignature }, startLine: firstOpt };
}

/**
 * Detect the workspace-trust dialog at the tail of `lines`, returning just the model (or null). The
 * thin public matcher — used by the race guard to re-derive from a fresh buffer and by tests.
 * buildBlocks uses {@link detectTrustRegion} for the render boundary.
 */
export function detectTrust(lines: StyledLine[]): PromptModel | null {
  return detectTrustRegion(lines)?.model ?? null;
}
