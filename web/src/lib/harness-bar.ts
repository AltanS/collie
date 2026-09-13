import { commandsFor } from "@/lib/agent-commands";
import { canonicalAgent, rowsFor } from "@/lib/operator-scope";
import type { OperatorCommand } from "@/lib/types";

// The harness bar's table: which of the running agent's own slash commands get a 44px button above
// the key rail. One row per harness, four or five buttons, and nothing derived from the screen.
//
// THE BAR IS A VIEW, NEVER A SECOND CATALOG. Every `command` spelled here is a row that already
// exists in `agent-commands.ts`, which stays the one place a slash command is written down; this
// file only chooses which of those rows are worth a thumb. A unit test looks every command up in
// `commandsFor(agent)`, so a button for a command the catalog does not have is a failing suite
// rather than a shipped button that does nothing. Adding a harness means adding to the catalog
// first and to this table second, never the other way round.
//
// Pure on purpose: no React import, no `t()` call, no DOM. The component resolves the labels.

/** Where a capture lives, relative to the repo root. Proof a command exists and behaves. */
const PANES = "web/src/fixtures/panes";

/**
 * One button on the bar. Every one of them sends its `command` as it stands, on one tap.
 *
 * **NOTHING HERE OFFERS ARGUMENTS.** An earlier round opened a bottom sheet of model aliases and
 * effort levels before sending, and it was wrong twice over: Collie would have to track a list the
 * harness owns and changes without telling us, and the harness paints its OWN picker in the mirror
 * the moment the bare command lands. So the button sends `/model`, and Claude's picker takes the
 * screen from there. One tap, no list of ours to go stale.
 */
export interface HarnessBarItem {
  /** Stable. Keys the echo, names the i18n label, and picks the button's icon in the component. */
  id: string;
  /**
   * The button's text. **A label that starts with `harnessBar.` is an i18n key and is translated at
   * render; anything else is literal text and is printed as it stands.** Shipped rows carry the key
   * `harnessBar.<id>`; an operator's `bar_label` carries itself. The split is here rather than in
   * the component because the reason for it is per row: an operator's own words are a thing we must
   * not reword.
   */
  label: string;
  /** Sent as it stands, then submitted. */
  command: string;
  /** Two-tap, through `usePendingConfirm`. Inherited as a floor from the shipped catalog. */
  confirm?: boolean;
  /**
   * Repo-relative path of a capture that proves this row: the command exists in that harness, and it
   * behaves the way the button assumes. Read only by the invariant test, never shown in the UI. A
   * row whose capture is missing ships COMMENTED OUT with the path in the comment, so it is written
   * once and enabled later without being redesigned.
   */
  evidence?: string;
  /** True for a row the operator typed. It vouches for its own command, so it carries no evidence. */
  operator?: boolean;
}

/**
 * The harnesses whose catalogs are sourced from CAPTURES rather than docs (`agent-commands.ts`'s omp
 * section states the rule). Every bar row for one of these must name a capture, because there is no
 * published page to check it against.
 */
export const CAPTURE_SOURCED: readonly string[] = ["omp"];

// ── Claude Code ──────────────────────────────────────────────────────────────
// Model, Effort, Compact, Resume — the four Altan drives Claude Code with from the phone. Each one
// sends its bare command and Claude's own picker comes up in the mirror.
//
// Model keeps its capture even though it now carries no argument. `claude--model-alias.txt` is a
// live pane where the command was typed and Claude answered "Set model to Sonnet 5 and saved as
// your default for new sessions" — which is this row's claim, that `/model` reaches Claude Code's
// model picker at all, proved on a real pane rather than inferred from a page.
const CLAUDE: readonly HarnessBarItem[] = [
  {
    id: "model",
    label: "harnessBar.model",
    command: "/model",
    evidence: `${PANES}/claude--model-alias.txt`,
  },
  // Bare, for the same reason Model is bare: the levels are the harness's list, not ours, and
  // `/effort` prints them itself.
  { id: "effort", label: "harnessBar.effort", command: "/effort" },
  { id: "compact", label: "harnessBar.compact", command: "/compact" },
  // Bare, which the catalog says opens the picker in the mirror.
  { id: "resume", label: "harnessBar.resume", command: "/resume" },
];

// ── Codex ────────────────────────────────────────────────────────────────────
// No Effort button, and that is the harness's own shape rather than an omission: Codex's `/model`
// picker sets the model AND the reasoning effort, so the one button reaches both dials.
const CODEX: readonly HarnessBarItem[] = [
  { id: "model", label: "harnessBar.model", command: "/model" },
  { id: "compact", label: "harnessBar.compact", command: "/compact" },
  { id: "resume", label: "harnessBar.resume", command: "/resume" },
];

// ── pi ───────────────────────────────────────────────────────────────────────
// No Effort button, because pi has no effort or thinking command: its thinking level lives inside
// `/settings`, a modal the phone would then have to drive with the keys pad. `/settings` is
// deliberately off the bar for that reason, and `/session` is off it because it prints stats rather
// than opening a picker. Every row here is in pi's own doc-sourced catalog, so none needs evidence.
const PI: readonly HarnessBarItem[] = [
  { id: "model", label: "harnessBar.model", command: "/model" },
  { id: "compact", label: "harnessBar.compact", command: "/compact" },
  { id: "tree", label: "harnessBar.tree", command: "/tree" },
  { id: "resume", label: "harnessBar.resume", command: "/resume" },
];

// ── omp ──────────────────────────────────────────────────────────────────────
// Capture-sourced, so every row names a capture. Tree shipped commented out because omp being a pi
// fork is not evidence; `omp--tree.txt` is. `/tree` was run on a live omp v18.1.19 pane and painted a
// `Session Tree` picker, which is also what puts Tree on the bar rather than in the palette alone.
const OMP: readonly HarnessBarItem[] = [
  {
    id: "model",
    label: "harnessBar.model",
    command: "/model",
    evidence: `${PANES}/omp--menu-model.txt`,
  },
  {
    id: "compact",
    label: "harnessBar.compact",
    command: "/compact",
    evidence: `${PANES}/omp--slash-palette.txt`,
  },
  {
    id: "tree",
    label: "harnessBar.tree",
    command: "/tree",
    evidence: `${PANES}/omp--tree.txt`,
  },
  {
    id: "resume",
    label: "harnessBar.resume",
    command: "/resume",
    evidence: `${PANES}/omp--menu-resume.txt`,
  },
];

// A Map for the same reason the command catalog uses one: the key tested against it is Herdr's
// agent string, so an object lookup would answer for inherited names that ship no bar at all.
const BARS = new Map<string, readonly HarnessBarItem[]>([
  ["claude", CLAUDE],
  ["codex", CODEX],
  ["pi", PI],
  ["omp", OMP],
]);

/** The agent names a shipped bar is filed under — pinned in the tests. */
export const BAR_AGENTS: readonly string[] = [...BARS.keys()];

/**
 * The bar for a Herdr-detected agent — the operator's own `bar = true` rows if any of them address
 * this pane, otherwise the shipped table. Returns `[]` for every other agent (grok, opencode, agy,
 * antigravity, a bare shell, a pane with no agent at all) and the row does not render.
 *
 * **THE REPLACEMENT RULE IS PER SURFACE.** ADR 0018 says that if any operator row addresses a pane,
 * the operator's rows ARE the catalog for that pane. This applies that rule to the BAR alone: the
 * subset it replaces-or-falls-back over is the rows carrying `bar = true`, so one bar row never
 * blanks the Agent palette, which is the opposite of what the operator typed. `commandsFor` is
 * untouched and ADR 0018 keeps holding exactly as written. ADR 0043 records the split.
 *
 * The scope ladder runs FIRST, over every row, and the `bar` filter runs on its answer. That way a
 * narrower `bar = false` row correcting a wider `bar = true` one takes the command off the bar,
 * instead of both rows surviving into two different answers.
 */
export function barFor(
  agent: string | undefined | null,
  mine: readonly OperatorCommand[] = [],
): readonly HarnessBarItem[] {
  const aimed = rowsFor(mine, agent, (row) => row.command).filter((row) => row.bar === true);
  if (aimed.length === 0) return shippedBar(agent);
  // `dangerous` is inherited as a FLOOR: a bar row naming a shipped dangerous command keeps its
  // two-tap confirm, and the operator's own `confirm = false` cannot lift it — the same direction
  // rule 3 in agent-commands.ts applies to the palette.
  const shippedDanger = new Map(commandsFor(agent).map((c) => [c.command, c.dangerous] as const));
  // There is NO CAP. Ten rows scroll sideways exactly the way five do, so the bar does not truncate
  // the list, does not wrap to a second line, and does not refuse the eleventh row.
  return aimed.map((row) => ({
    id: `op:${row.command}`,
    label: row.barLabel ?? row.command.slice(1),
    command: row.command,
    confirm: (shippedDanger.get(row.command) ?? false) || row.confirm === true,
    operator: true,
  }));
}

function shippedBar(agent: string | undefined | null): readonly HarnessBarItem[] {
  if (!agent) return [];
  // Canonicalised through the same ladder the command catalog uses, so `claude-code` and `omp-2`
  // reach the bar their catalog is filed under rather than falling off it.
  return BARS.get(canonicalAgent(agent.toLowerCase().trim())) ?? [];
}
