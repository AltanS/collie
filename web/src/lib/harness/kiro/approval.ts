import { type StyledLine } from "../../blocks";
import { pointerWalk } from "../menu-hints";
import { type PromptModel } from "../prompt-model";
import { readFilePreview } from "./file-preview";
import { frameRows, isDivider, readPanelTail } from "./frame";

/** A complete captured approval panel and its first row in the terminal buffer. */
export interface ApprovalRegion {
  model: PromptModel;
  startLine: number;
}

const NORMAL_FOOTER = " esc to close · ↑↓ to navigate · ↵ to select · Tab to edit";
const TRUST_FOOTER = " esc to close · Enter to see more options";
// Shell panels always offer Always allow. Write and replace panels offer it too unless the agent
// was started with tools untrusted (`--trust-tools=''`), as the earlier file captures were. A read
// panel has been captured only without it.
const TRUST_LABELS = ["Allow", "Always allow", "Deny", "Always deny"];
const NO_TRUST_LABELS = ["Allow", "Deny", "Always deny"];
const MAX_BODY_ROWS = 30;
const MAX_REGION_CHARS = 32_000;

// The native card must show the entire subject. Controls and shortened previews can hide a
// changed request even though its displayed path or title looks unchanged.
function unsafeBody(row: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u.test(row) ||
    row.includes("…") || row.includes("...");
}

interface Selection {
  start: number;
  pointed: number;
  labels: string[];
}

function readSelection(rows: string[], divider: number): Selection | null {
  for (const labels of [TRUST_LABELS, NO_TRUST_LABELS]) {
    const start = divider - labels.length;
    let pointed = -1;
    let complete = rows[start - 1] === "";
    for (let i = 0; i < labels.length; i++) {
      const row = rows[start + i] ?? "";
      if (row === ` ❯ ${labels[i]}`) {
        if (pointed >= 0) complete = false;
        pointed = i;
      } else if (row !== `   ${labels[i]}`) complete = false;
    }
    if (complete && pointed >= 0) return { start, pointed, labels };
  }
  return null;
}

/** Detect captured V3 shell and complete filesystem approvals. MCP input previews omit fields, so MCP, unknown menus and edit/trust pages stay raw. */
export function detectApprovalRegion(lines: StyledLine[]): ApprovalRegion | null {
  const rows = frameRows(lines);
  const tail = readPanelTail(rows);
  if (tail === null || tail.footer.length !== 1 || tail.divider < 7) return null;
  const footer = tail.footer[0];
  if (footer !== NORMAL_FOOTER && footer !== TRUST_FOOTER) return null;
  const selection = readSelection(rows, tail.divider);
  if (selection === null) return null;
  const { start: optionStart, pointed, labels } = selection;
  const trustPointed = labels[pointed] === "Always allow";
  // The trust row changes the footer before Enter opens its page. Do not combine torn states.
  if (trustPointed !== (footer === TRUST_FOOTER)) return null;

  let panelTop = optionStart - 2;
  while (panelTop >= 0 && !isDivider(rows[panelTop] ?? "")) {
    if (optionStart - panelTop > MAX_BODY_ROWS + 4) return null;
    panelTop--;
  }
  if (panelTop < 0 || rows[panelTop] !== rows[tail.divider]) return null;
  const title = rows[panelTop + 1] ?? "";
  if (!/^ .+ requires approval$/.test(title) || title.includes(" · ") || unsafeBody(title)) return null;
  const bodyStart = panelTop + 2;
  const body = rows.slice(bodyStart, optionStart - 1);
  if (body.length === 0 || body.length > MAX_BODY_ROWS || body.some((row) => !/^ \S/.test(row) || unsafeBody(row))) return null;
  const capability = /^ (shell|fs_read|fs_write) → \S/.exec(body[0] ?? "")?.[1];
  if (capability === undefined || body.slice(1).some((row) => / → /.test(row))) return null;

  let startLine = panelTop;
  let subject = lines.slice(bodyStart, optionStart - 1);
  if (capability === "shell") {
    if (labels !== TRUST_LABELS) return null;
  } else {
    if (capability === "fs_read" && labels !== NO_TRUST_LABELS) return null;
    if (capability === "fs_read" && title !== " Read File requires approval") return null;
    if (capability === "fs_write" && title !== " Write File requires approval" && title !== " Replace in File requires approval") return null;
    // The permission body names only the path. Bind the pending tool's range or full diff too:
    // a successor edit of the same file otherwise has the very same permission panel.
    const preview = readFilePreview(rows, panelTop, capability);
    if (preview === null || rows.slice(preview.start, preview.end + 1).some(unsafeBody)) return null;
    startLine = preview.start;
    subject = [...lines.slice(preview.start, preview.end + 1), ...subject];
  }

  const region = rows.slice(startLine, tail.end + 1);
  const signature = region.join("\n");
  if (signature.length > MAX_REGION_CHARS) return null;
  const core = [...region];
  const pointerRow = optionStart + pointed - startLine;
  core[pointerRow] = (core[pointerRow] ?? "").replace("❯", " ");
  // Only the two captured pointer-driven footer spellings are interchangeable. All request
  // text, pending preview rows and persistent options remain in walk identity.
  core[core.length - 1] = " esc to close";
  const denyIndex = labels.indexOf("Deny");

  return {
    startLine,
    model: {
      family: "permission",
      question: title.trim(),
      subject,
      options: [
        { label: "Allow", keys: pointerWalk(pointed, 0), keyLabel: pointed === 0 ? "❯" : "" },
        { label: "Deny", keys: pointerWalk(pointed, denyIndex), keyLabel: pointed === denyIndex ? "❯" : "" },
        { label: "Close", keys: ["Escape"], keyLabel: "Esc" },
      ],
      // Always deny is still a real row below the last offered button. Do not declare that
      // Deny is the menu's endpoint or let the shared action layer authorize an extra arrow.
      signature,
      coreSignature: core.join("\n"),
    },
  };
}
