// Kiro's startup trust dialog owns the keyboard before the chat composer exists. Its path, both
// warnings and revocation note must be complete before a native choice is offered. Captured keys
// and layouts: WORKSPACE_TRUST_NOTES.md (kiro-cli 2.33.0).

import { lastNonBlankIndex, trimTrailingBlank, type StyledLine } from "../../blocks";
import { hasHiddenCharacter, MAX_REGION_CHARS } from "../bound-region";
import { pointerWalk } from "../menu-hints";
import type { PromptModel } from "../prompt-model";
import { frameRows } from "./markers";

export interface WorkspaceTrustRegion {
  model: PromptModel;
  startLine: number;
}

const TITLE = " Trust this workspace?";
const RULE = /^ ─{20,}$/;
const WARNING = "This folder can contain hooks, agents, MCP servers and workflows that run commands on your machine. Only trust folders you know.";
const ACCESS = "Trusting lets Kiro use this workspace's configuration. Kiro will be able to read, edit, and execute files here.";
const FOOTER = "esc to exit · ↑↓ to navigate · ↵ to select";
const REVOKE = "Revoke later by removing workspaceTrusted from";
const LABELS = ["Trust, continue", "Don't trust, exit"];
const MAX_ROWS = 80;

/** Non-empty paragraphs, preserving each row's position for the subject and pointer binding. */
function paragraphs(rows: string[], from: number, to: number): number[][] {
  const groups: number[][] = [];
  let group: number[] = [];
  for (let i = from; i <= to; i++) {
    if (rows[i] === "") {
      if (group.length > 0) groups.push(group);
      group = [];
    } else group.push(i);
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

function words(rows: string[], group: number[]): string {
  return group.map((i) => rows[i]!.slice(1)).join(" ");
}

/** The fixed note wraps by words, but the path under it can wrap mid-word. */
function completeRevocation(rows: string[], group: number[]): boolean {
  for (let count = 1; count < group.length; count++) {
    if (words(rows, group.slice(0, count)) !== REVOKE) continue;
    const path = group.slice(count).map((i) => rows[i]!.slice(1)).join("");
    return /^\/.+\/workspace-roots\/[0-9a-f]{16}\/permissions\.yaml$/.test(path);
  }
  // Wide panes keep the whole note on one row.
  return new RegExp(`^${REVOKE} /.+/workspace-roots/[0-9a-f]{16}/permissions\\.yaml$`).test(words(rows, group));
}

/** The captured Unix-path startup prompt at the tail; incomplete, quoted and unknown variants stay raw. */
export function detectWorkspaceTrust(lines: StyledLine[]): WorkspaceTrustRegion | null {
  const rows = frameRows(lines);
  const end = lastNonBlankIndex(rows);
  const title = rows.lastIndexOf(TITLE, end);
  const startLine = title - 1;
  if (title < 1 || end - startLine > MAX_ROWS || !RULE.test(rows[startLine] ?? "")) return null;
  const rule = rows[startLine]!;
  if (rows[title + 1] !== rule) return null;
  const bottom = rows.indexOf(rule, title + 2);
  if (bottom < 0) return null;
  const region = rows.slice(startLine, end + 1);
  const signature = region.join("\n");
  if (signature.length > MAX_REGION_CHARS || region.some((row) => hasHiddenCharacter(row) || row.includes("…"))) return null;
  // Only the option rows are indented further. A quoted dialog or an unexpected body row declines.
  if (rows.slice(title + 2, bottom).some((row) => row !== "" && !/^ \S/.test(row) && !/^   \S/.test(row))) return null;

  const body = paragraphs(rows, title + 2, bottom - 1);
  if (body.length !== 4) return null;
  const path = body[0]!;
  const warning = body[1]!;
  const access = body[2]!;
  const selection = body[3]!;
  if (path.some((i) => !/^ \S/.test(rows[i]!)) || !rows[path[0]!]!.startsWith(" /")) return null;
  if (words(rows, warning) !== WARNING || words(rows, access) !== ACCESS || selection.length !== 2) return null;
  let pointed = -1;
  for (let i = 0; i < LABELS.length; i++) {
    const row = rows[selection[i]!]!;
    if (row === ` ❯ ${LABELS[i]}`) {
      if (pointed >= 0) return null;
      pointed = i;
    } else if (row !== `   ${LABELS[i]}`) return null;
  }
  if (pointed < 0 || selection[1] !== bottom - 1 || rows[selection[0]! - 1] !== "") return null;

  const tail = paragraphs(rows, bottom + 1, end);
  if (tail.length !== 2) return null;
  const footer = tail[0]!;
  const revoke = tail[1]!;
  if (rows.slice(bottom + 1, end + 1).some((row) => row !== "" && !/^ \S/.test(row))) return null;
  if (words(rows, footer) !== FOOTER || !completeRevocation(rows, revoke)) return null;

  const core = [...region];
  core[selection[pointed]! - startLine] = `   ${LABELS[pointed]}`;
  return {
    startLine,
    model: {
      family: "trust",
      question: TITLE.trim(),
      subject: trimTrailingBlank(lines.slice(title + 2, selection[0]!)),
      options: LABELS.map((label, i) => ({ label, keys: pointerWalk(pointed, i), keyLabel: i === pointed ? "❯" : "" })),
      // Both real rows are exposed, and live Up/Down stop at the ends (WORKSPACE_TRUST_NOTES.md).
      clampedEnds: true,
      signature,
      coreSignature: core.join("\n"),
    },
  };
}
