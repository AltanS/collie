import { KNOWN_HARNESS_NAMES } from "../bridge/journal/registry.ts";
import { resolveJournalRoots } from "../bridge/config.ts";
import type { CliContext } from "./context.ts";
import { bad, ok, skipped, warn, type Finding } from "./finding.ts";
import type { Exec, Files } from "./sys.ts";

// ── Why the History link is not there (issue #137) ───────────────────────────
//
// "Show entire history" and the pane's history icon key on ONE boolean the browser is handed:
// `hasSession`. The bridge sets it (`bridge/types.ts` § `toPaneWire`) only when BOTH hold — the pane
// record carries a session ref, and the agent has a journal adapter (`bridge/journal/registry.ts`).
//
// The session ref reaches Herdr from ONE place: the agent-side hook `herdr integration install
// <agent>` writes. That hook exits silently when its environment is not what it expects, and it
// loads at the agent's SESSION START — so installing it under a running agent changes nothing until
// that agent is restarted. Miss any of it and the pane looks perfectly normal while both affordances
// simply are not drawn, with nothing anywhere saying why. `/api/pane/:id/history` is not consulted
// for the hide, so its own `no-log` / `disabled` reasons never get a chance to explain themselves.
//
// This section walks that chain in order — versions, the integration per agent, the interpreter the
// hook needs, what the running bridge actually reports per pane, and where a journal would be read
// from — and every ✗ names the verb that fixes it.
//
// IT STAYS A READ, like everything else in `collie doctor`: `herdr --version`, `herdr integration
// status`, one `which`, one GET of this bridge's own `/api/snapshot`, and `exists`/`list` on the
// journal roots. It installs nothing and restarts nothing.

/** Which agents this section reports on: the ones this build could actually read a journal for. */
export const JOURNAL_AGENTS: readonly string[] = KNOWN_HARNESS_NAMES;

// ── `herdr integration status` ───────────────────────────────────────────────

/** What Herdr says about one agent's hook: current, stale, absent, or a word we don't know. */
export type IntegrationState = "installed" | "outdated" | "missing" | "unknown";

/** One `<agent>: <state> (<path>)` line, parsed. `note` is the state verbatim, path and all. */
export interface IntegrationLine {
  readonly agent: string;
  readonly state: IntegrationState;
  readonly note: string;
}

/**
 * Parse `herdr integration status`.
 *
 * The grammar is one `<agent>: <state>` line per agent, where `<state>` is free text Herdr may
 * extend — `installed`, `not installed (<path>)`, `outdated (v4 < v8) (<path>)`. Only the first word
 * or two are classified and the rest is carried through verbatim, so a state this build has never
 * seen reads `unknown` and is REPORTED rather than silently counted as healthy. Anything that is not
 * an `<agent>: <rest>` line at all is skipped: Herdr is free to print a header.
 */
export function parseIntegrationStatus(text: string): IntegrationLine[] {
  const lines: IntegrationLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const agent = line.slice(0, colon).trim();
    const note = line.slice(colon + 1).trim();
    if (agent === "" || note === "" || agent.includes(" ")) continue;
    lines.push({ agent, state: classifyIntegration(note), note });
  }
  return lines;
}

function classifyIntegration(note: string): IntegrationState {
  const lower = note.toLowerCase();
  if (lower.startsWith("not installed")) return "missing";
  if (lower.startsWith("outdated")) return "outdated";
  if (lower.startsWith("installed") || lower.startsWith("up to date") || lower.startsWith("current")) {
    return "installed";
  }
  return "unknown";
}

// ── The snapshot, as this section reads it ───────────────────────────────────

/** The two pane fields this section asks about, plus the id that names the pane. */
export interface SnapshotPane {
  readonly paneId: string;
  readonly agent: string;
  readonly hasSession: boolean;
}

/** What one agent pane's `hasSession` means for its History link. */
export interface PaneVerdict {
  readonly pane: SnapshotPane;
  /** True when this build has a journal adapter for the pane's agent — the other half of the flag. */
  readonly journalled: boolean;
}

/** The wire shape, every field optional: an answer that disagrees must degrade, never be trusted. */
interface SnapshotWire {
  bridge?: string;
  agents?: { paneId?: string; agent?: string; kind?: string; hasSession?: boolean }[];
}

/**
 * The agent panes in a `/api/snapshot` body, or `null` when the body is not one.
 *
 * Only `kind: "agent"` panes are kept — a shell pane has no session to report and would make every
 * healthy machine look half-broken. `hasSession` is absent rather than false on the wire, which is
 * exactly the state this whole section is about, so it normalises to `false` here.
 */
export function parseSnapshotPanes(text: string): SnapshotPane[] | null {
  let parsed: SnapshotWire;
  try {
    // SAFETY: the shape `bridge/server.ts` serialises for `/api/snapshot`. Every field is declared
    // optional and every read below goes through `?.`/`??`, so a body that disagrees yields an empty
    // pane list — which the caller reports as "nothing to check", never as a pass.
    parsed = JSON.parse(text.trim() === "" ? "{}" : text) as SnapshotWire;
  } catch {
    return null;
  }
  const panes: SnapshotPane[] = [];
  for (const pane of parsed.agents ?? []) {
    if (pane.kind !== "agent") continue;
    const paneId = pane.paneId ?? "";
    const agent = pane.agent ?? "";
    if (paneId === "" || agent === "") continue;
    panes.push({ paneId, agent, hasSession: pane.hasSession === true });
  }
  return panes;
}

/** Pair each pane with whether this build could read a journal for its agent. */
export function paneVerdicts(
  panes: readonly SnapshotPane[],
  journalAgents: readonly string[] = JOURNAL_AGENTS,
): PaneVerdict[] {
  const known = new Set(journalAgents);
  return panes.map((pane) => ({ pane, journalled: known.has(pane.agent) }));
}

/** The panes that would hide their History link silently: a journalled agent with no session ref. */
export const silentPanes = (verdicts: readonly PaneVerdict[]): PaneVerdict[] =>
  verdicts.filter((v) => v.journalled && !v.pane.hasSession);

// ── Journal roots ────────────────────────────────────────────────────────────

/** One resolved journal root, and what the user running `doctor` can see of it. */
export interface RootReading {
  readonly agent: string;
  readonly path: string;
  readonly exists: boolean;
  /** Entries this user can list under it. `0` on a directory that is empty OR not readable by them. */
  readonly entries: number;
}

/** Every harness's roots, resolved the way the bridge resolves them, and probed as reads. */
export function readJournalRoots(
  env: Record<string, string | undefined>,
  home: string,
  files: Pick<Files, "exists" | "list">,
): RootReading[] {
  const roots = resolveJournalRoots(env, home);
  const readings: RootReading[] = [];
  for (const [agent, paths] of Object.entries(roots)) {
    for (const path of paths) {
      readings.push({ agent, path, exists: files.exists(path), entries: files.list(path).length });
    }
  }
  return readings;
}

// ── The findings ─────────────────────────────────────────────────────────────

/** What this section reaches: the context, the two system seams, and one GET of our own snapshot. */
export interface HistoryDeps {
  readonly ctx: CliContext;
  readonly exec: Pick<Exec, "which" | "capture">;
  readonly files: Pick<Files, "exists" | "list">;
  /** The bridge's own `/api/snapshot`, as text — `null` when nothing answered there. */
  readonly snapshot: () => Promise<string | null>;
}

const INSTALL_NOTE = "then start a new session of that agent in the pane (hooks load at session start)";

/** Every line of the history section, in the order an operator would walk the chain. */
export async function historyFindings(deps: HistoryDeps): Promise<Finding[]> {
  const herdr = herdrVersion(deps);
  const status = integrationStatus(deps);
  const body = await deps.snapshot();
  const panes = body === null ? null : parseSnapshotPanes(body);
  const verdicts = panes === null ? null : paneVerdicts(panes);
  return [
    herdr,
    ...JOURNAL_AGENTS.map((agent) => integration(agent, status, verdicts)),
    python(deps),
    sessions(verdicts, body !== null),
    journalRoots(deps),
  ];
}

/** `herdr --version` — the build whose `integration` verb writes every hook below. */
function herdrVersion(deps: HistoryDeps): Finding {
  const check = "herdr-version";
  const asked = deps.exec.capture("herdr", ["--version"]);
  if (!asked.found) {
    return bad(
      check,
      "no `herdr` on this host — it owns both the socket the bridge reads and the agent hooks that" +
        " report a session, so no pane can ever offer its history",
      "install Herdr, then `collie doctor` again",
    );
  }
  if (asked.code !== 0) {
    return warn(
      check,
      `\`herdr --version\` exited ${String(asked.code)} — this build cannot be named`,
      "run `herdr --version` by hand and fix what it says",
    );
  }
  const version = firstLine(asked.stdout);
  return ok(check, version === "" ? "herdr answered without naming a version" : version);
}

/** `herdr integration status`, read once and handed to every per-agent line. */
function integrationStatus(deps: HistoryDeps): Map<string, IntegrationLine> | null {
  const asked = deps.exec.capture("herdr", ["integration", "status"]);
  if (!asked.found || asked.code !== 0) return null;
  return new Map(parseIntegrationStatus(asked.stdout).map((line) => [line.agent, line]));
}

/**
 * One agent's hook: `integration-<agent>`.
 *
 * **The severity comes from the panes, not from the state alone.** A `not installed` grok on a
 * machine that has never run grok is not a fault, and a red line for it would teach an operator to
 * skim past the one that means something — the reasoning `beacon-hooks-claude` already follows. So a
 * missing hook is an ERROR exactly when a pane of that agent is running here and reporting no
 * session, and otherwise it is reported for what it is: nothing needs it yet.
 */
function integration(
  agent: string,
  status: Map<string, IntegrationLine> | null,
  verdicts: readonly PaneVerdict[] | null,
): Finding {
  const check = `integration-${agent}`;
  const install = `\`herdr integration install ${agent}\`, ${INSTALL_NOTE}`;
  if (status === null) {
    return skipped(
      check,
      "`herdr integration status` did not answer, so this agent's hook cannot be read",
      `run it by hand; if it names ${agent} as missing or outdated, ${install}`,
    );
  }
  const line = status.get(agent);
  if (line === undefined) {
    return skipped(
      check,
      `this Herdr build does not list ${agent} — Collie can read its journal, Herdr has no hook for it`,
      `upgrade Herdr (\`herdr --version\` names this build), or read that pane's history from the agent's own log`,
    );
  }
  const affected = (verdicts ?? []).filter((v) => v.pane.agent === agent && !v.pane.hasSession);
  const running = affected.map((v) => v.pane.paneId).join(", ");
  if (line.state === "installed") {
    return affected.length === 0
      ? ok(check, "installed and current")
      : warn(
          check,
          `installed and current, and ${String(affected.length)} ${agent} pane(s) still report no` +
            ` session (${running}) — those sessions started before the hook did`,
          `restart ${agent} in ${running}; \`herdr integration status\` confirms the hook is current`,
        );
  }
  if (line.state === "unknown") {
    return warn(
      check,
      `Herdr reports "${line.note}", which this build does not recognise`,
      `read \`herdr integration status\` yourself; ${install} if it is not current`,
    );
  }
  const what =
    line.state === "outdated"
      ? `the hook is out of date — ${line.note}`
      : `no hook is installed — ${line.note}`;
  if (affected.length > 0) {
    return bad(
      check,
      `${what}; ${String(affected.length)} ${agent} pane(s) report no session (${running}), so their` +
        " History link and icon are hidden with no explanation",
      install,
    );
  }
  // Nothing of this agent's is hidden right now, so the tier is about the hook alone. An ABSENT hook
  // on an agent this host does not run is not a fault — a red or yellow line for it teaches an
  // operator to skim past the one that means something — while a STALE one is ours and out of date,
  // which is a warning wherever it sits (`beacon-hooks-claude`'s own reading).
  const idle = `no ${agent} pane is missing a session right now, so nothing is hidden yet`;
  return line.state === "missing"
    ? ok(check, `${what}; ${idle} — nothing here needs it`)
    : warn(check, `${what}; ${idle}`, install);
}

/** The interpreter every shell-flavoured Herdr hook shells out to. Without it the hook exits silent. */
function python(deps: HistoryDeps): Finding {
  const check = "hook-python3";
  const found = deps.exec.which("python3");
  if (found === null) {
    return bad(
      check,
      "no `python3` on PATH — Herdr's agent hooks need it, and without it they exit silently, so no" +
        " agent ever reports a session",
      "install `python3` — the PATH the AGENT runs with must find it, not this shell's alone",
    );
  }
  return ok(check, found);
}

/**
 * `agent-sessions` — what the running bridge actually hands the browser, per pane.
 *
 * This is the finding that closes the loop: everything above is configuration, and this is the
 * observed consequence. A journalled agent pane without `hasSession` is precisely the pane whose
 * History link the phone will not draw.
 */
function sessions(verdicts: readonly PaneVerdict[] | null, answered: boolean): Finding {
  const check = "agent-sessions";
  if (verdicts === null) {
    return skipped(
      check,
      answered
        ? "the bridge answered `/api/snapshot` with something that is not a snapshot"
        : "the bridge did not answer `/api/snapshot`, so no pane can be checked",
      "`collie status`, then `collie start` if it is down; re-run `collie doctor` once it answers",
    );
  }
  if (verdicts.length === 0) return skipped(check, "the bridge reports no agent panes", "start an agent in a pane, then re-run `collie doctor`");
  const silent = silentPanes(verdicts);
  const journalled = verdicts.filter((v) => v.journalled).length;
  const summary =
    `${String(verdicts.length)} agent pane(s), ${String(journalled)} of them on an agent this build can` +
    " read a journal for";
  if (silent.length === 0) return ok(check, `${summary} — every one of those reports a session`);
  const named = silent.map((v) => `${v.pane.paneId} (${v.pane.agent})`).join(", ");
  return bad(
    check,
    `${summary}; ${String(silent.length)} report NO session: ${named} — their History link and icon are` +
      " hidden, and the pane looks otherwise normal",
    `\`herdr integration install <agent>\` for each agent named above (the \`integration-…\` lines say which),` +
      ` ${INSTALL_NOTE}`,
  );
}

/**
 * `journal-roots` — `COLLIE_TRANSCRIPT`, and whether a journal could be read at all.
 *
 * **The home in every path below is the home of whoever ran this verb**, and the bridge resolves its
 * own. A bridge running as another user reads that user's `~/.claude/projects`, so a root that reads
 * fine here can still be unreadable there — which is why the pass says so rather than claiming more.
 */
function journalRoots(deps: HistoryDeps): Finding {
  const check = "journal-roots";
  const whose = `resolved from ${deps.ctx.home}; the BRIDGE resolves them from ITS OWN user's home`;
  if (!envOn(deps.ctx.env.COLLIE_TRANSCRIPT)) {
    return warn(
      check,
      "COLLIE_TRANSCRIPT is off — the bridge reads no journal at all, so no pane offers a history" +
        " however well its hooks are installed",
      `remove COLLIE_TRANSCRIPT (or set it to 1) in ${deps.ctx.configDir}/.env, then \`collie restart\``,
    );
  }
  const readings = readJournalRoots(deps.ctx.env, deps.ctx.home, deps.files);
  const present = readings.filter((r) => r.exists);
  if (present.length === 0) {
    return warn(
      check,
      `COLLIE_TRANSCRIPT is on, and none of the ${String(readings.length)} journal roots is there (${whose})`,
      "run an agent once so it writes its log, or point COLLIE_TRANSCRIPT_ROOT at the tree it uses," +
        " then `collie restart`",
    );
  }
  const blind = present.filter((r) => r.entries === 0).map((r) => r.path);
  const detail =
    `${String(present.length)} of ${String(readings.length)} roots present — ` +
    `${present.map((r) => `${r.agent}: ${r.path}`).join(", ")} (${whose})`;
  if (blind.length === 0) return ok(check, detail);
  return warn(
    check,
    `${detail}; you can list no entries under ${blind.join(", ")} — empty, or not readable by you`,
    "check that the user the bridge runs as owns those trees (`ls -ld` on each)",
  );
}

/** `COLLIE_TRANSCRIPT` as `bridge/config.ts` reads it: unset is ON, and only the off words turn it off. */
const envOn = (raw: string | undefined): boolean =>
  raw === undefined || raw.trim() === "" || !["off", "0", "false", "no"].includes(raw.trim().toLowerCase());

/** The first non-empty line of a tool's answer — a doctor line is one line. */
function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
}
