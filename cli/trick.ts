import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { redactText } from "../bridge/redact.ts";
import { GROUP_CAPACITY_WORDS, sizeWords } from "../bridge/tricks/card-group.ts";
import { proposalCardCount, type ProposalCardCount } from "../bridge/tricks/proposal-card.ts";
import type { ProposedFile } from "../bridge/tricks/propose-wire.ts";
import { approvedDirOf, approveFolder, pruneCopies, verifyCopy } from "../bridge/tricks/approved.ts";
import { codeShowsWhole } from "../bridge/tricks/code-view.ts";
import { CONFIG_FILE, diskTrickFs, trickCodeHash, walkTrickCode } from "../bridge/tricks/code-hash.ts";
import { officialStanding, shippedOfficialList } from "../bridge/tricks/official.ts";
import { originRepoName, originShort, proposalShort } from "../bridge/tricks/origin.ts";
import {
  HELPER_FILE,
  HELPER_VERSION,
  helperVersion,
  looksBinary,
  RUNS_MAX,
  runsLines,
  scanTrickFolder,
  TRICK_HELPER,
  trickWarnings,
  warningLines,
  WARNINGS_HONESTY,
  type CheckWarning,
  type RunsLine,
} from "../bridge/tricks/scan.ts";
import { createTrickScanner, readManifestFile, readSmallFile, type FoundTrick } from "../bridge/tricks/discover.ts";
import { isBaseEnvName, neverReason, scrubEnv } from "../bridge/tricks/env.ts";
import { MANIFEST_FILE, tricksConfigDir, switchesPath } from "../bridge/tricks/paths.ts";
import { outcomeProblem, runProgram, runtimeScript, windowsRunProblem, type RunOutcome } from "../bridge/tricks/run.ts";
import { isChanged } from "../bridge/tricks/service.ts";
import { parseSwitches, updateSwitches, withEntry, withSwitch } from "../bridge/tricks/switches.ts";
import type { CrewFetch } from "../bridge/crew/peer-client.ts";
import { deriveMode } from "../bridge/crew/mode.ts";
import { enrollmentOf, parseTrustStore, trustStorePath } from "../bridge/crew/trust-store.ts";
import { asJsonBoolean, asJsonObject, asJsonString, parseJson, type JsonValue } from "../web/src/lib/json.ts";
import { FACTS } from "../web/src/lib/tricks/fixtures/index.ts";
import {
  AGENT_VIEW_PLACE,
  AGENT_VIEW_TAP_WORDS,
  AGENT_VIEW_WORDS,
  ACCESS_LINES,
  DECIDES_REPLY_WORDS,
  DRAFTS_SESSION_LINE,
  isHostName,
  isTrickId,
  parseFacts,
  RULES_NEVER_AUTO,
  RULES_WORDS,
  inputsSentence,
  parseTrickDocumentText,
  TRICK_CONTRACT_DEFAULT,
  type FactsTrigger,
  type ParsedTrickDocument,
  type TrickFacts,
  type TrickDecision,
  type TrickManifest,
  type OfficialState,
  type TricksRunsOn,
  type Refusal,
  TRICKS_OFF_LINE,
  TRICKS_WINDOWS_LINE,
  TRICKS_WINDOWS_SHELL_LINE,
  tricksGated,
} from "../web/src/lib/tricks/schema.ts";
import { readTricksFeature } from "../bridge/tricks/feature-switch.ts";
import { readEnvMarkers } from "./beacon.ts";
import { namedPictureWarnings, readTrickFolder } from "./trick-folder.ts";
import { paneNotProvenShell, type PaneKind } from "./walky.ts";
import type { CliContext } from "./context.ts";
import { hillWordingWarnings } from "./hill-rules.ts";
import { EXIT, type Io } from "./io.ts";
import { identityHeader, readOwnSnapshot } from "./snapshot-read.ts";
import type { Files } from "./sys.ts";
import { SKILL_BYTES_MAX } from "../web/src/lib/tricks/limits.ts";

// `collie trick` (M94 slice 01): the machine's half of Collie tricks. A trick is added on the machine and
// switched on from here (or, later, the phone); the bridge runs it.
//
//   list              every trick folder, its switch, its origin and what the running bridge says of it;
//                     `--official` prints the official list this release carries and each entry's state
//   add [<source>]    copy a trick from a git repository into the tricks folder, OFF (cli/trick-add.ts);
//                     with no source, list the tricks of the official repository
//   update <id>       fetch a trick added with `add` again and replace its code, keeping config.toml
//   remove <id>       delete a trick folder that is off, its state folder and its approved copies
//   on <id> / off <id>  write the switch (`<stateDir>/tricks/switches.json`); the bridge rereads it. On
//                     approves the code as it is now: it copies the folder into
//                     `<configDir>/tricks/.collie-approved/<id>/<hash16>/` and stores the copy's hash, and the
//                     bridge runs that copy, so an edit of the folder never stops the trick: the new
//                     version waits for a yes. On prints the check scan's warnings, and still switches
//                     on. It refuses in a pane the running bridge does not prove a shell (a speed
//                     bump, not a wall: see cmdTrickSwitch)
//   auto <id> on|off  "take changes without asking": a new version whose powers did not move and
//                     that does nothing new (no new warning kind) is approved on its own; else it waits
//   check <folder>    the static check: the manifest, its places, the command lines and the warnings of
//                     every source file in the folder (a grep, not a proof). `--run` also runs the
//                     program once against fixture facts, with the bridge's environment rule, and
//                     parses what it prints
//   dev <folder>      `check --run` made friendly (cli/trick-dev.ts): one run, a short summary of each
//                     part, Decision and refusal; `--tap`, `--json`, `--watch`
//   init <id>         a new folder with `trick.toml`, a TypeScript program, the helper `trick.ts`, a
//                     `config.toml` and an `AGENTS.md`; `--sh` writes the shell sample instead. In an
//                     agent's pane, or with `--dir <folder>`, the folder is a DRAFT outside the tricks folder
//   helper <id>       rewrite `trick.ts` in a trick folder with the helper this Collie carries
//   skill [<id>]      what an agent reads: the `SKILL.md` of the approved copy of a trick that is ON (what
//                     the trick that runs asks of the agent), or with no id the brief for writing a trick
//   guide             how to write a trick and hand it over, plain text from the real constants (cli/trick-guide.ts)
//   propose <folder>  hand a trick to the person: a card of Collie's own on the lead, inert until the yes
//                     (cli/trick-propose.ts, bridge/tricks/proposals.ts); allowed in an agent's pane
//
// `check` exits 0 (clean, or only "later" notes), 1 (a refusal or a failed run) or 2 (usage: no
// folder, or not a folder), like `config check`. `--json` prints one report document instead.

export const TRICK_SUBCOMMANDS = ["list", "add", "update", "remove", "on", "off", "auto", "check", "dev", "init", "helper", "skill", "guide", "propose", "view"] as const;

export interface TrickDeps {
  ctx: Pick<CliContext, "configDir" | "stateDir" | "env" | "port">;
  io: Io;
  files: Pick<Files, "read" | "exists" | "entryType">;
  fetch: CrewFetch;
  now: () => number;
  /** What the local bridge says of the pane this runs in (`askPaneKind`, cli/walky.ts). None: not asked, so allowed. */
  paneKind?: () => Promise<PaneKind>;
  /** This machine's platform, for the Windows gate (`refuseTricksOnWindows`). Absent: no gate. */
  platform?: NodeJS.Platform;
  /** The working folder `init` writes a draft into. Absent: the process's own. A seam for tests. */
  cwd?: string;
}

/**
 * The Windows gate of the verbs that switch on, add or open a trick (bridge/tricks/service.ts `gated` is the
 * bridge's side): before any argument is read, a Windows machine says TRICKS_WINDOWS_LINE. True when it
 * refused; the caller returns `EXIT.FAIL`, as the crew verbs do for their own Windows refusal.
 */
export function refuseTricksOnWindows(deps: { readonly platform?: NodeJS.Platform | undefined; readonly io: Io }): boolean {
  if (!tricksGated(deps.platform)) return false;
  deps.io.err(`error: ${TRICKS_WINDOWS_LINE}`);
  return true;
}

/**
 * The refusal of the verbs that bring code in or teach an agent while tricks as a whole are switched off on
 * this machine (bridge/tricks/feature-switch.ts; no file is off): one sentence, and where to switch them on.
 * True when it refused; the caller returns `EXIT.FAIL`. `trick check --run` and `trick dev` do not ask: they
 * are a developer's tools, run once in their own terminal on a folder they name, and nothing reaches a phone.
 */
export function refuseWhileTricksOff(deps: { readonly ctx: Pick<CliContext, "stateDir">; readonly io: Io }): boolean {
  if (readTricksFeature(deps.ctx.stateDir).on) return false;
  deps.io.err(`error: ${TRICKS_OFF_LINE}`);
  return true;
}

// ── list ─────────────────────────────────────────────────────────────────────

/** One trick as the running bridge lists it, read leniently from `GET /api/tricks`. */
interface BridgeTrick {
  on?: boolean;
  /** The bridge holds a new version waiting for a yes. */
  pending?: boolean;
  state?: string;
  error?: string;
  lastRunAt?: string;
}

/** What `trick list` reads of the bridge's `GET /api/tricks`. */
interface BridgeTricks {
  tricks: Map<string, BridgeTrick>;
  path?: string;
  /** Set when this bridge runs no tricks because its crew's lead does. */
  runsOn?: TricksRunsOn;
}

/** The bridge's answer to `GET /api/tricks`, or null when it said nothing usable. */
async function bridgeTricks(deps: Pick<TrickDeps, "ctx" | "files" | "fetch">): Promise<BridgeTricks | null> {
  const asked = await readOwnSnapshot(
    { ctx: deps.ctx, files: deps.files, fetch: deps.fetch },
    { path: "/api/tricks", extraHeaders: identityHeader(deps) },
  );
  if (asked.kind !== "body") return null;
  const doc = asJsonObject(parseJson(asked.text));
  const raw: JsonValue | undefined = doc?.tricks;
  const list = Array.isArray(raw) ? raw : undefined;
  if (doc === undefined || list === undefined) return null;
  const tricks = new Map<string, BridgeTrick>();
  for (const value of list) {
    const m = asJsonObject(value);
    const id = asJsonString(m?.id);
    if (m === undefined || id === undefined) continue;
    const entry: BridgeTrick = {};
    const on = asJsonBoolean(m.on);
    if (on !== undefined) entry.on = on;
    if (asJsonObject(m.pending) !== undefined) entry.pending = true;
    for (const key of ["state", "error", "lastRunAt"] as const) {
      const text = asJsonString(m[key]);
      if (text !== undefined) entry[key] = text;
    }
    tricks.set(id, entry);
  }
  const out: BridgeTricks = { tricks };
  const path = asJsonString(doc.path);
  if (path !== undefined) out.path = path;
  const runsOn = asJsonObject(doc.runsOn);
  if (runsOn !== undefined) {
    const lead = asJsonString(runsOn.lead);
    out.runsOn = lead !== undefined && isHostName(lead) ? { lead } : {};
  }
  return out;
}

/** The line `trick list` prints on a machine whose crew's lead runs the tricks (Settings → Tricks says the same). */
export function runsOnText(runsOn: TricksRunsOn): string {
  const lead = runsOn.lead === undefined ? "" : ` (${runsOn.lead})`;
  return `Tricks run on the lead of this crew${lead}. This machine runs none.`;
}

/** The trick folders on disk, as the bridge would see them. */
async function foundTricks(deps: Pick<TrickDeps, "ctx">): Promise<{ exists: boolean; tricks: FoundTrick[] }> {
  return await createTrickScanner(tricksConfigDir(deps.ctx.configDir)).scan();
}

function switchesOf(deps: Pick<TrickDeps, "ctx" | "files">): ReturnType<typeof parseSwitches> {
  return parseSwitches(deps.files.read(switchesPath(deps.ctx.stateDir)));
}

/** One row of `trick list`. A type, so a row is a JSON object for the doctor's `data`. */
export type TrickListRow = {
  id: string;
  name: string;
  on: boolean;
  state: string;
  lastRunAt: string | null;
  error: string | null;
  /** Whether the folder holds a regular file `SKILL.md`: what `collie trick skill <id>` would print. */
  skill: boolean;
  /** Where `collie trick add` took it from, short (`owner/repo/legs@abc1234`), or null for a folder made here. */
  origin: string | null;
  /** "Take changes without asking" (`collie trick auto`). */
  auto: boolean;
  /** On, and the folder no longer hashes to the version approved: a new version waits for a yes. */
  pending: boolean;
};

/** What `trick list` and the doctor row read: the folders, the bridge's word, its runner's PATH. */
export interface TrickList {
  exists: boolean;
  rows: TrickListRow[];
  bridge: boolean;
  path?: string;
  /** Set when the bridge runs no tricks because its crew's lead does. */
  runsOn?: TricksRunsOn;
}

/** The rows of `trick list`: the folders, the switch file, and the bridge's word where it has one. */
export async function trickListRows(deps: Pick<TrickDeps, "ctx" | "files" | "fetch">): Promise<TrickList> {
  const found = await foundTricks(deps);
  const { switches } = switchesOf(deps);
  const bridge = found.exists ? await bridgeTricks(deps) : null;
  const skills = await Promise.all(found.tricks.map(async (m) => (await diskTrickFs.lstat(join(m.dir, SKILL_FILE)))?.kind === "file"));
  const rows = found.tricks.map((m, i): TrickListRow => {
    const entry = switches.on.get(m.id);
    const on = entry !== undefined;
    const said = bridge?.tricks.get(m.id);
    const local = m.manifest === undefined ? "skipped" : on ? "on, not seen by the bridge" : "off";
    const error = said?.error ?? (m.manifest === undefined ? (m.refusals[0]?.reason ?? null) : null);
    return {
      id: m.id,
      name: m.manifest?.name ?? m.id,
      on,
      state: said?.state ?? local,
      lastRunAt: said?.lastRunAt ?? null,
      error,
      skill: skills[i] === true,
      origin: m.origin !== undefined ? originShort(m.origin) : m.proposal !== undefined ? proposalShort(m.proposal) : null,
      auto: entry?.auto === true,
      pending: said?.pending ?? (on && isChanged(entry, m)),
    };
  });
  const out: TrickList = { exists: found.exists, rows, bridge: bridge !== null };
  if (bridge?.path !== undefined) out.path = bridge.path;
  if (bridge?.runsOn !== undefined) out.runsOn = bridge.runsOn;
  return out;
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  ").trimEnd());
}

/** How `trick list --official` names an entry's state on this machine. */
const OFFICIAL_STATE_TEXT = {
  absent: "not added",
  added: "added",
  update: "newer version in this Collie",
  taken: "taken: another trick has this id",
} as const satisfies Record<OfficialState, string>;

/** The STATE column: a taken folder from the list's repository says which kind it is. */
function officialStateText(row: { state: OfficialState; changed?: true; unlisted?: true }): string {
  if (row.changed === true) return "taken: its files were edited, update it with collie trick update";
  if (row.unlisted === true) return "taken: from the repository, not from the official list";
  return OFFICIAL_STATE_TEXT[row.state];
}

/**
 * `collie trick list --official`: the official list this binary carries (bridge/tricks/official.ts), each
 * entry's state on this machine. Read-only: it reads the list from the binary and the tricks folder, and
 * asks the running bridge only whether its crew's lead runs the tricks. It fetches nothing; an add from the
 * list is a tap on the phone (Settings, Tricks, Official tricks), never a verb here.
 */
async function cmdTrickListOfficial(deps: TrickDeps, json: boolean): Promise<number> {
  const list = shippedOfficialList();
  if (!list.ok) {
    deps.io.err(`error: this Collie's official list is refused: ${list.reason}`);
    return EXIT.FAIL;
  }
  const standings = await Promise.all(list.entries.map(async (e) => await officialStanding(deps.ctx.configDir, e)));
  const rows = list.entries.map((e, i) => {
    const standing = standings[i];
    const row = { id: e.id, name: e.name, description: e.description, repo: e.repo, commit: e.commit, state: standing?.state ?? "absent" };
    // A taken folder from the list's repository: not a version of the list, or one whose files were edited.
    if (standing?.changed === true) return { ...row, changed: true as const };
    if (standing?.unlisted === true) return { ...row, unlisted: true as const };
    return row;
  });
  const runsOn = (await bridgeTricks(deps))?.runsOn;
  if (json) {
    const doc = { official: rows };
    deps.io.out(JSON.stringify(runsOn === undefined ? doc : { ...doc, runsOn }, null, 2));
    return EXIT.OK;
  }
  if (rows.length === 0) {
    deps.io.out("This Collie carries no tricks on its official list.");
    return EXIT.OK;
  }
  const lines = table([["ID", "NAME", "COMMIT", "STATE", "WHAT IT DOES"], ...rows.map((r) => [r.id, r.name, r.commit.slice(0, 7), officialStateText(r), r.description])]);
  for (const line of lines) deps.io.out(line);
  if (runsOn !== undefined) deps.io.out(runsOnText(runsOn));
  deps.io.out(`From ${originRepoName(list.entries[0]?.repo ?? "")}, at the commits this Collie release names. Add one on the phone: Settings, Tricks, Official tricks.`);
  return EXIT.OK;
}

export async function cmdTrickList(deps: TrickDeps, args: readonly string[]): Promise<number> {
  const json = args.includes("--json");
  if (args.includes("--official")) return await cmdTrickListOfficial(deps, json);
  const { exists, rows, bridge, runsOn } = await trickListRows(deps);
  if (json) {
    const doc = { folder: tricksConfigDir(deps.ctx.configDir), exists, bridge, tricks: rows };
    deps.io.out(JSON.stringify(runsOn === undefined ? doc : { ...doc, runsOn }, null, 2));
    return EXIT.OK;
  }
  if (!exists || rows.length === 0) {
    deps.io.out(`No tricks in ${tricksConfigDir(deps.ctx.configDir)}. Make one: collie trick init <id>, or add one: collie trick add`);
    return EXIT.OK;
  }
  const lines = table([
    ["ID", "NAME", "SWITCH", "AUTO", "SKILL", "ORIGIN", "VERSION", "STATE", "LAST RUN", "LAST ERROR"],
    ...rows.map((r) => [r.id, r.name, r.on ? "on" : "off", r.auto ? "on" : "-", r.skill ? "yes" : "-", r.origin ?? "-", r.pending ? "NEW" : "-", r.state, r.lastRunAt ?? "-", r.error ?? "-"]),
  ]);
  for (const line of lines) deps.io.out(line);
  if (runsOn !== undefined) deps.io.out(runsOnText(runsOn));
  // Each SWITCH above is the trick's own; while tricks as a whole are off, none of them runs.
  if (!readTricksFeature(deps.ctx.stateDir).on) deps.io.out(TRICKS_OFF_LINE);
  if (rows.some((r) => r.pending)) deps.io.out("NEW: a new version waits for your yes. Approve it in Settings, Tricks, on the phone, or with collie trick on <id>.");
  if (!bridge) deps.io.out("(the bridge did not answer: state and last run are from the files only)");
  if (rows.some((r) => r.skill && r.on)) deps.io.out("An agent reads what a trick asks of it with: collie trick skill <id>");
  return EXIT.OK;
}

// ── skill ────────────────────────────────────────────────────────────────────

/** The file in a trick folder that says what the trick asks of an agent. */
export const SKILL_FILE = "SKILL.md";
// The most `collie trick skill <id>` reads and prints lives in `web/src/lib/tricks/limits.ts`, so the
// reference page names the same number. A larger file is refused, never cut.
export { SKILL_BYTES_MAX };

/** The brief `collie trick skill` prints with no id: for an agent that wants to write a trick. */
export const TRICK_WRITE_BRIEF = [
  "A trick is a folder with a trick.toml and a program. The phone draws what the program prints.",
  "To write one:",
  "  1. Run `collie trick init <id>`. In your pane it makes ./<id>/ in your current folder, with a sample program and an AGENTS.md. That folder is your draft.",
  "  2. Read ./<id>/AGENTS.md. It says what the program gets, what it may print, and the limits.",
  "  3. Write the trick. `collie trick dev ./<id>` runs it once and says what the phone would get; `--watch` runs it on each change.",
  "     Then run `collie trick check --run ./<id>`. It reads the folder, runs the program once and greps it.",
  "  4. Fix what it reports, and run it again until it is clean.",
  "The draft lives in your own work folder. Nothing is added to this machine's tricks before the person's yes.",
  "Never switch it on yourself: `collie trick on <id>` is the person's approval of the code, and it refuses inside an agent's pane.",
  "To hand it to the person, run `collie trick propose ./<id>`: they see your code on a card in this session on the phone and in Settings, Tricks, and nothing runs before their yes. `collie trick guide` says more.",
  "To teach other agents what the trick asks of them, add a SKILL.md to the folder. `collie trick skill <id>` prints it while the trick is on. SKILL.md is part of the trick's code: the trick runs the copy a person approved, so an edit waits for their yes before agents read it.",
] as const;

/** One refusal of `trick skill <id>`: a plain line, and why it is a failure. */
function skillRefusal(deps: Pick<TrickDeps, "io">, line: string): number {
  deps.io.err(line);
  return EXIT.FAIL;
}

/**
 * `collie trick skill [<id>]`. With an id: the `SKILL.md` of the trick's APPROVED COPY (bridge/tricks/
 * approved.ts), only when the trick is ON, the copy exists and still hashes to the version approved, and its
 * manifest parses. So an agent reads what the trick that runs asks of it, never an edit that waits for a
 * yes, and a trick that is off asks an agent nothing. The file is read the hardened way: `lstat`, a regular
 * file only, at most {@link SKILL_BYTES_MAX} bytes, then through the secret mask.
 */
export async function cmdTrickSkill(deps: TrickDeps, args: readonly string[]): Promise<number> {
  const id = args.find((a) => !a.startsWith("-"));
  if (id === undefined) {
    for (const line of TRICK_WRITE_BRIEF) deps.io.out(line);
    return EXIT.OK;
  }
  if (!isTrickId(id)) {
    deps.io.err("usage: collie trick skill [<id>]   (an id is 1 to 32 of a-z, 0-9 and -)");
    return EXIT.USAGE;
  }
  // Switched off as a whole, no trick teaches an agent anything (no agent view's rules are handed out).
  if (refuseWhileTricksOff(deps)) return EXIT.FAIL;
  const found = (await foundTricks(deps)).tricks.find((t) => t.id === id);
  if (found === undefined) return skillRefusal(deps, `no such trick: ${id}`);
  const entry = switchesOf(deps).switches.on.get(id);
  if (entry === undefined) return skillRefusal(deps, `${id} is off, so it teaches nothing`);
  const copy = approvedDirOf(deps.ctx.configDir, id, entry);
  if (copy === null || entry.hash === null) return skillRefusal(deps, `${id} has no approved version yet, so it teaches nothing until a person approves one`);
  const check = await verifyCopy(copy, entry.hash);
  if (!check.ok && check.missing) return skillRefusal(deps, `${id} has no approved copy on this machine yet; the bridge makes it when it next looks, so try again in a moment`);
  if (!check.ok) return skillRefusal(deps, `the approved copy of ${id} changed on disk, so it teaches nothing until a person approves it again`);
  if ((await readManifestFile(diskTrickFs, copy, id)).manifest === undefined) return skillRefusal(deps, `${id} has a manifest that does not parse, so it teaches nothing`);
  const path = join(copy, SKILL_FILE);
  const st = await diskTrickFs.lstat(path);
  if (st === null) return skillRefusal(deps, `${id} has no ${SKILL_FILE}`);
  if (st.kind !== "file") return skillRefusal(deps, `${id} has no ${SKILL_FILE} (it is not a regular file)`);
  if (st.size > SKILL_BYTES_MAX) return skillRefusal(deps, `${id} has a ${SKILL_FILE} larger than ${String(SKILL_BYTES_MAX / 1024)} KiB, so it is not read`);
  const bytes = await diskTrickFs.read(path, SKILL_BYTES_MAX + 1);
  if (bytes === null) return skillRefusal(deps, `${id} has a ${SKILL_FILE} that cannot be read`);
  if (bytes.length > SKILL_BYTES_MAX) return skillRefusal(deps, `${id} has a ${SKILL_FILE} larger than ${String(SKILL_BYTES_MAX / 1024)} KiB, so it is not read`);
  if (looksBinary(new TextDecoder().decode(bytes))) return skillRefusal(deps, `${id} has a ${SKILL_FILE} that is not text`);
  deps.io.out(redactText(new TextDecoder().decode(bytes)).replace(/\n+$/u, ""));
  return EXIT.OK;
}

// ── on / off / auto ──────────────────────────────────────────────────────────

/**
 * The line `collie trick on` refuses with inside an agent's pane. A SPEED BUMP, NOT A WALL, that fails closed:
 * a pane with markers (`readEnvMarkers`, cli/beacon.ts) passes only when the local bridge proves it a shell
 * (`paneNotProvenShell`, cli/walky.ts). A shell pane in the multiplexer is a person's terminal and may
 * approve. An agent pane, no bridge, a bridge that does not know the pane, a bridge before the question and
 * a check that fails all refuse: a person then opens a terminal. An agent should ask, not approve its own code,
 * but a process that strips the markers, or writes the switch file itself, gets past any check here. The
 * user account is the real boundary.
 */
export function agentPaneRefusal(id: string): string[] {
  return [
    "error: collie trick on is a person's yes to the code, and this runs in a pane where an agent works.",
    `An agent does not approve its own trick. Tell your operator that ${id} is ready to switch on.`,
    `A person approves it on the phone (Settings, Tricks), or runs collie trick on ${id} in a shell pane or a terminal.`,
  ];
}

/** Whether the bridge says this pane runs an agent. Outside a pane, or with no answer, it is not: only the draft decision of `trick init` reads it. */
async function inAgentPane(deps: TrickDeps): Promise<boolean> {
  if (readEnvMarkers(deps.ctx.env).length === 0 || deps.paneKind === undefined) return false;
  return (await deps.paneKind().catch(() => "unknown" as const)) === "agent";
}

/**
 * Whether a verb that is a person's yes (`trick on`, `trick auto on`) refuses in this pane: it fails closed,
 * so a pane with markers passes only when the bridge proves it a shell (`paneNotProvenShell`).
 */
async function refusedInPane(deps: TrickDeps): Promise<boolean> {
  return await paneNotProvenShell(deps.ctx.env, deps.paneKind);
}

/** The one line `collie trick on` prints when a person switched on code the phone cannot show whole (A5). */
export const SWITCHED_ON_NOT_WHOLE = "The phone cannot show all of this trick's code. You switched it on at this machine.";

export async function cmdTrickSwitch(deps: TrickDeps, args: readonly string[], on: boolean): Promise<number> {
  // Off still writes on Windows: a person can always turn a trick off.
  if (on && refuseTricksOnWindows(deps)) return EXIT.FAIL;
  const verb = on ? "on" : "off";
  const id = args.find((a) => !a.startsWith("-"));
  if (id === undefined || !isTrickId(id)) {
    deps.io.err(`usage: collie trick ${verb} <id>   (an id is 1 to 32 of a-z, 0-9 and -)`);
    return EXIT.USAGE;
  }
  const dir = join(tricksConfigDir(deps.ctx.configDir), id);
  const { switches, problem } = switchesOf(deps);
  if (problem !== null) deps.io.err(`warn: ${problem}; it is written again now`);
  if (!on) {
    if (!switches.on.has(id)) {
      deps.io.out(`${id} is already off.`);
      return EXIT.OK;
    }
    const written = await updateSwitches(deps.ctx.stateDir, (now) => withSwitch(now, id, false, new Date(deps.now()).toISOString()));
    await pruneCopies(deps.ctx.configDir, written, { now: Date.now() });
    deps.io.out(`${id} is off. The bridge stops running it and its parts go from the phone.`);
    return EXIT.OK;
  }
  if (await refusedInPane(deps)) {
    for (const line of agentPaneRefusal(id)) deps.io.err(line);
    return EXIT.REFUSED;
  }
  if (deps.files.entryType(dir) !== "directory") {
    deps.io.err(`error: there is no trick folder ${dir}. Make one: collie trick init ${id}`);
    return EXIT.FAIL;
  }
  const read = await readManifestFile(diskTrickFs, dir, id);
  if (read.manifest === undefined) {
    for (const r of read.refusals) deps.io.err(`error: ${MANIFEST_FILE}${r.path} ${r.reason}`);
    deps.io.err(`error: ${id} stays off until its manifest is fixed. Check it: collie trick check ${dir}`);
    return EXIT.FAIL;
  }
  // Fault d: on Windows a shell run line stays off, with the one sentence (behind the gate above today).
  const shell = windowsRunProblem(read.manifest.run, deps.platform);
  if (shell !== null) {
    deps.io.err(`error: ${shell}`);
    deps.io.err(`error: ${id} stays off.`);
    return EXIT.FAIL;
  }
  const code = await trickCodeHash(dir);
  if (!code.ok) {
    deps.io.err(`error: ${code.reason}`);
    deps.io.err(`error: ${id} stays off.`);
    return EXIT.FAIL;
  }
  const held = switches.on.get(id);
  const heldCopy = approvedDirOf(deps.ctx.configDir, id, held);
  if (held?.hash === code.hash && heldCopy !== null && (await verifyCopy(heldCopy, code.hash)).ok) {
    deps.io.out(`${id} is already on, with this code approved (sha256 ${code.hash}).`);
    return EXIT.OK;
  }
  // A5: the phone's switch refuses code it cannot show whole and as it is (a key, a hidden character, a file over
  // its size, a file that is not text). A person at this machine may still switch it on, in a plain terminal or in a
  // pane the bridge proves a shell: an agent's pane was refused above, and never gets here. The verb says so in one
  // line (the lead, 2026-11-18). Any other refusal of the check (a folder that moved) still stops the verb.
  const whole = await codeShowsWhole({ dir, hash: code.hash }, id);
  if (!whole.ok && whole.code !== "not-whole") {
    deps.io.err(`error: ${whole.message}`);
    return EXIT.FAIL;
  }
  // The copy is what is approved: its hash, and the warnings of its code, read at the moment of consent.
  // The copy must be the code hashed above (review 8 V-N1): a folder that moved in between is refused.
  const approved = await approveFolder({ stateDir: deps.ctx.stateDir, configDir: deps.ctx.configDir, id, by: "cli", at: new Date(deps.now()).toISOString(), expect: code.hash });
  if (!approved.ok) {
    deps.io.err(`error: ${approved.reason}`);
    deps.io.err(`error: ${id} stays as it was.`);
    return EXIT.FAIL;
  }
  const warnings = await trickWarnings(approved.dir, approved.manifest ?? read.manifest);
  if (warnings.length > 0) {
    for (const line of warningLines(warnings)) deps.io.out(line);
    deps.io.out(WARNINGS_HONESTY);
  }
  deps.io.out(`${id} is on. The bridge picks it up within seconds; its timer runs while a phone watches.`);
  if (!whole.ok) deps.io.out(SWITCHED_ON_NOT_WHOLE);
  // Its own switch is written; tricks as a whole decide whether it runs at all.
  if (!readTricksFeature(deps.ctx.stateDir).on) deps.io.out("Tricks are switched off on this machine, so it runs only after collie tricks on.");
  deps.io.out(`Approved the code of ${id} as it is now: sha256 ${approved.hash}. The bridge runs this copy; an edit of the folder waits for your yes.`);
  // Agent instructions are approved with the code: name the bytes, and where to read them.
  const rules = approved.manifest;
  if (rules?.rules !== undefined && rules.rulesSha256 !== undefined) {
    deps.io.out(`It gives your agents instructions: ${rules.rules}, sha256 ${rules.rulesSha256}.`);
    deps.io.out(`Read them before an agent view uses them: ${join(approved.dir, rules.rules)}`);
  }
  return EXIT.OK;
}

/**
 * Whether the trick's folder or its approved copy names `rules`. Read loosely on purpose: a manifest that
 * names them but does not parse, or a rules file that breaks the rule, still counts.
 */
async function givesRules(deps: TrickDeps, id: string): Promise<boolean> {
  const dirs = [join(tricksConfigDir(deps.ctx.configDir), id)];
  const copy = approvedDirOf(deps.ctx.configDir, id, switchesOf(deps).switches.on.get(id));
  if (copy !== null) dirs.push(copy);
  for (const dir of dirs) {
    const read = await readSmallFile(diskTrickFs, dir, MANIFEST_FILE);
    if (read.kind !== "bytes") continue;
    try {
      // SAFETY: `Bun.TOML.parse` answers with a parsed document; only two keys are read, each checked.
      const doc = asJsonObject(Bun.TOML.parse(new TextDecoder().decode(read.bytes)) as JsonValue);
      const places = doc?.places;
      if (doc?.rules !== undefined || (Array.isArray(places) && places.includes(AGENT_VIEW_PLACE))) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** `collie trick auto <id> on|off`: "take changes without asking" for one trick that is on. */
export async function cmdTrickAuto(deps: TrickDeps, args: readonly string[]): Promise<number> {
  const [id, word, ...rest] = args;
  if (id === undefined || !isTrickId(id) || (word !== "on" && word !== "off") || rest.length > 0) {
    deps.io.err("usage: collie trick auto <id> on|off   (take a new version whose powers did not change without asking)");
    return EXIT.USAGE;
  }
  if (word === "on" && (await refusedInPane(deps))) {
    for (const line of agentPaneRefusal(id)) deps.io.err(line);
    return EXIT.REFUSED;
  }
  const auto = word === "on";
  // A trick that gives agents instructions never takes a change without asking: its folder or its
  // approved copy names `rules` (contract 2).
  if (auto && (await givesRules(deps, id))) {
    deps.io.err(`error: ${RULES_NEVER_AUTO}`);
    deps.io.err(`error: ${id} keeps asking.`);
    return EXIT.REFUSED;
  }
  const written = await updateSwitches(deps.ctx.stateDir, (now) => {
    const held = now.on.get(id);
    return held === undefined ? now : withEntry(now, id, { ...held, auto });
  });
  if (!written.on.has(id)) {
    deps.io.err(`error: ${id} is off. Switch it on first: collie trick on ${id}`);
    return EXIT.FAIL;
  }
  deps.io.out(
    auto
      ? `${id} takes a new version on its own when its powers (environment names, places) did not change and it does nothing new. A change of powers, or something new such as reaching the network, still waits for your yes.`
      : `${id} asks again: every new version waits for your yes.`,
  );
  return EXIT.OK;
}

// ── check ────────────────────────────────────────────────────────────────────

/** What `check` says on the run line of a trick that is only an agent view. */
export const NO_PROGRAM_NOTE = "none: this trick is an agent view and has no program, so nothing runs.";

/** The soft note `check` gives for a manifest with no `about`. Never fails the check. */
export const ABOUT_NOTE = "Add an `about` text so a person can read what this trick does before they switch it on.";

/** One environment name the manifest lists, and whether the bridge passes it. */
export interface CheckEnvName {
  name: string;
  passed: boolean;
  reason?: string;
}

/** What `check` found. `--json` prints this object. */
export interface TrickCheckReport {
  folder: string;
  id: string;
  manifest?: TrickManifest;
  /** The manifest's refusals, "later" ones included. */
  refusals: Refusal[];
  /** Problems that are not a refusal of a field: a missing or binary program, a folder past the cap. */
  problems: string[];
  /** The program files the `run` line names, inside the folder. */
  files: string[];
  runs: RunsLine[];
  /** What a grep of every code file in the folder flags. */
  warnings: CheckWarning[];
  /** The files the grep skips: docs, data, tests and fixtures, and a `trick.ts` that is a helper this Collie ships. */
  notScanned: string[];
  /** What `trick.ts` is, when it names itself a helper: a version this Collie ships (`current` when the newest), or a modified one. */
  helper?: { version: number; current: boolean; modified: boolean };
  /** The names `env` lists, past the base allow-list. */
  env: CheckEnvName[];
  /** What the trick's `inputs` read, the sentence the version card and Settings show. Absent when it lists none. */
  reads?: string;
  /** The code hash `collie trick on` would approve. */
  codeHash?: string;
  /** The cards the trick shows on as a proposal (crew slice 8), or why it cannot be proposed. Never fails the check. */
  cards?: ProposalCardCount;
  run?: {
    outcome: RunOutcome["kind"];
    ms: number;
    problem: string | null;
    parts: string[];
    refusals: Refusal[];
    /** What the tolerant read left out (`dropped`) or ignored (`ignored`). Never fails the check. */
    notes: Refusal[];
    /** The soft wording warnings of each Decision (`hillWordingWarnings`), by its key. Never fails the check. */
    wording: { key: string; text: string }[];
    /** The soft note that a tap on the trick's tile shows nothing new ({@link TAP_SHOWS_NOTHING}), or absent. Never fails the check. */
    tapNote?: string;
    /** One warning for each `media/` or `captures/` file the output names that a proposal would not bring (trick-folder.ts `namedPictureWarnings`). Never fails the check. */
    pictures: string[];
    stderr: string;
  };
}

/** The files inside `folder` that the `run` line names, by its whitespace-split words. */
/** The program files a `run` line names, and the `./` words that name nothing. */
export interface ProgramFiles {
  files: string[];
  missing: string[];
}

export function programFiles(run: string, folder: string, files: Pick<Files, "entryType">): ProgramFiles {
  const out: string[] = [];
  const missing: string[] = [];
  for (const raw of run.split(/\s+/)) {
    const word = raw.replace(/^["']|["']$/g, "");
    if (word === "" || word.startsWith("-")) continue;
    const looksLocal = word.startsWith("./") || word.startsWith("../") || /\.(?:sh|bash|ts|js|mjs|cjs|py|rb|pl)$/.test(word);
    if (!looksLocal) continue;
    const full = isAbsolute(word) ? word : resolve(folder, word);
    const kind = files.entryType(full);
    if (kind === "file") {
      if (!out.includes(full)) out.push(full);
      continue;
    }
    if (word.startsWith("./")) missing.push(word);
  }
  return { files: out, missing };
}

/** The names `env` lists, each with whether the bridge passes it. */
export function envNames(manifest: TrickManifest): CheckEnvName[] {
  return (manifest.env ?? []).map((name): CheckEnvName => {
    const never = neverReason(name);
    if (never !== null) return { name, passed: false, reason: `never passed: ${never}` };
    return isBaseEnvName(name) ? { name, passed: true, reason: "passed to every trick anyway" } : { name, passed: true };
  });
}

/** Whether this machine leads a crew, as the trust store on disk says (cli/serve.ts `crewModeOnDisk`): a trick's `inputs` then read every machine. */
export function leadsCrewOnDisk(deps: { ctx: Pick<CliContext, "stateDir">; files: Pick<Files, "read"> }): boolean {
  const raw = deps.files.read(trustStorePath(deps.ctx.stateDir));
  return deriveMode(enrollmentOf(raw === null ? null : parseTrustStore(raw))).mode === "lead";
}

/** The static half of `check`. Reads only. `crew` says the machine leads a crew, for the `reads` sentence. */
export async function checkStatic(folder: string, files: Pick<Files, "read" | "entryType">, opts: { crew?: boolean; platform?: NodeJS.Platform } = {}): Promise<TrickCheckReport> {
  const id = basename(folder);
  const read = await readManifestFile(diskTrickFs, folder, id);
  const report: TrickCheckReport = { folder, id, refusals: read.refusals, problems: [], files: [], runs: [], warnings: [], notScanned: [], env: [] };
  if (read.manifest === undefined) return report;
  report.manifest = read.manifest;
  report.env = envNames(read.manifest);
  const globs = read.manifest.inputs ?? [];
  if (globs.length > 0) report.reads = inputsSentence(globs, opts.crew === true);
  // Fault d: on Windows only the script form runs. A shell line is a problem, so the check fails.
  const shell = windowsRunProblem(read.manifest.run, opts.platform);
  if (shell !== null) report.problems.push(shell);
  // A trick that is only an agent view has no run line, so no program file to read.
  const runText = read.manifest.run ?? "";
  const named = programFiles(runText, folder, files);
  report.files = named.files;
  for (const word of named.missing) report.problems.push(`The run line names ${word}, which is not in the folder.`);
  const script = runtimeScript(runText);
  if (script !== null && named.files.length === 0 && !named.missing.includes(runText)) report.problems.push(`The run line names ${script}, which is not in the folder.`);
  for (const file of named.files) {
    const text = files.read(file);
    if (text === null) {
      report.problems.push(`${basename(file)} cannot be read.`);
      continue;
    }
    if (looksBinary(text)) report.problems.push(`${basename(file)} is a compiled program. A trick's program is source a person can read.`);
  }
  const walk = await walkTrickCode(diskTrickFs, folder);
  if (!walk.ok) {
    report.problems.push(walk.reason);
    return report;
  }
  const code = await trickCodeHash(folder);
  if (code.ok) report.codeHash = code.hash;
  // The helper, the sources and the warnings are the shared scan's (bridge/tricks/scan.ts), so `check`,
  // `on` and the row in Settings say the same.
  const scanned = await scanTrickFolder(folder, read.manifest, walk.entries);
  if (scanned.helper !== undefined) report.helper = scanned.helper;
  report.notScanned = scanned.notScanned;
  // A run line that names no file of the folder IS the command (`run = "darius due --json"`): list it.
  const runLine = named.files.length === 0 && read.manifest.run !== undefined ? [{ file: MANIFEST_FILE, text: `run = ${read.manifest.run}`, shell: true }] : [];
  report.runs = runsLines([...scanned.sources, ...runLine]).slice(0, RUNS_MAX);
  report.warnings = scanned.warnings;
  return report;
}

/**
 * The facts of a `--run`: the schema's timer facts, or `base` (`trick dev --facts`), with this folder and
 * the state folder, and `trigger` in place of the facts' own when one is given.
 */
export function checkFacts(manifest: TrickManifest, folder: string, state: string, trigger?: FactsTrigger, base?: TrickFacts): TrickFacts {
  const parsed = base === undefined ? parseFacts(FACTS.timer) : { facts: base };
  if (parsed.facts === undefined) throw new Error("the fixture facts do not parse");
  // The contract is the manifest's, as the bridge's facts carry it (facts.ts `buildFacts`).
  const facts: TrickFacts = { ...parsed.facts, contract: manifest.contract, trick: { id: manifest.id, dir: folder, state } };
  if (trigger !== undefined) facts.trigger = trigger;
  return facts;
}

/** One run against fixture facts, as the bridge runs one: how it ended, and what the parser made of it. */
export interface FixtureRun {
  outcome: RunOutcome;
  /** The masked line of a run that failed, or null. */
  problem: string | null;
  /** The bytes of stdout the parser read. */
  stdoutBytes: number;
  /** The parse of a run that exited 0, else null. */
  parsed: ParsedTrickDocument | null;
  /** Whether the document has a `decisions` key: absent means "leave them as they are". */
  decisionsListed: boolean;
}

/** What a fixture run may change: the trigger, the facts (`trick dev --facts`), a state folder to keep (`--state`). */
export interface FixtureOptions {
  trigger?: FactsTrigger;
  facts?: TrickFacts;
  /** A state folder to use and keep. Without one, the run gets a scratch folder that is removed after it. */
  state?: string;
}

/**
 * Run a trick's program once against fixture facts and parse what it prints, with the bridge's own
 * rules: the environment scrub, the launch rule of run.ts, the caps, the parser against the manifest's
 * places. The one run path `check --run` and `trick dev` share. The state folder is a scratch folder
 * unless `opts.state` names one, so a check never writes the bridge's own state. Unlike a bridge run,
 * the test hooks (`TRICK_*` variables of `env`) pass the scrub.
 */
export async function runAgainstFixture(manifest: TrickManifest, folder: string, env: CliContext["env"], opts: FixtureOptions = {}): Promise<FixtureRun> {
  // A trick that is only an agent view has no program: nothing starts, as on the bridge.
  if (manifest.run === undefined) return { outcome: { kind: "spawn-failed", message: NO_PROGRAM_NOTE, ms: 0 }, problem: NO_PROGRAM_NOTE, stdoutBytes: 0, parsed: null, decisionsListed: false };
  const command = manifest.run;
  const kept = opts.state !== undefined;
  const state = opts.state ?? (await mkdtemp(join(tmpdir(), `collie-trick-check-${manifest.id}-`)));
  if (kept) await mkdir(state, { recursive: true, mode: 0o700 });
  try {
    const outcome = await runProgram({
      command,
      cwd: folder,
      env: scrubEnv(env, manifest.env ?? [], { testHooks: true }),
      stdin: JSON.stringify(checkFacts(manifest, folder, state, opts.trigger, opts.facts)),
    });
    const problem = outcomeProblem(outcome, 400);
    if (problem !== null || outcome.kind !== "exited") return { outcome, problem, stdoutBytes: 0, parsed: null, decisionsListed: false };
    const parsed = parseTrickDocumentText(outcome.stdout, { declared: manifest.places, contract: manifest.contract, decidesReply: manifest.decides === "reply", draftsSession: manifest.drafts === "session" });
    const decisionsListed = asJsonObject(parseJson(outcome.stdout))?.decisions !== undefined;
    return { outcome, problem, stdoutBytes: new TextEncoder().encode(outcome.stdout).length, parsed, decisionsListed };
  } finally {
    if (!kept) await rm(state, { recursive: true, force: true });
  }
}

/** The soft wording warnings of a run's Decisions, by key: what `collie hill post` says on stderr for a post. */
export function decisionWording(decisions: readonly TrickDecision[]): { key: string; text: string }[] {
  return decisions.flatMap((d) => hillWordingWarnings(d).map((text) => ({ key: d.key, text })));
}

/** The soft note of `check --run` on a trick whose tile a tap leaves as it was. */
export const TAP_SHOWS_NOTHING = "A tap on this trick's tile shows nothing new. Give it a session page, or make the tap change what the tile says.";

/** The places a person taps a trick on: its tile, its belt mark, its status chip, its tab. */
const TAPPED_PLACES: ReadonlySet<string> = new Set(["belt", "status", "dashboard", "tabbar"]);
/** The most belt intents the tap note runs the program for. */
const TAP_NOTE_RUNS = 3;

/**
 * Whether a tap on the trick's tile shows nothing new: it draws a part a person taps, it has no session
 * page for the tap to open, and no tap the run offers (a belt mark's intent) changes what it prints. Each
 * intent is one more fixture run, at most {@link TAP_NOTE_RUNS}; a run that fails counts as a change, so
 * the note stays quiet when unsure.
 */
async function tapShowsNothing(manifest: TrickManifest, folder: string, env: CliContext["env"], parsed: ParsedTrickDocument): Promise<boolean> {
  if (manifest.places.includes("session")) return false;
  if (!parsed.parts.some((p) => TAPPED_PLACES.has(p.place))) return false;
  const shown = JSON.stringify(parsed.parts);
  const taps = parsed.parts.flatMap((p) => (p.place === "belt" && p.part.mark.intent !== undefined ? [{ node: p.part.id, intent: p.part.mark.intent }] : [])).slice(0, TAP_NOTE_RUNS);
  for (const tap of taps) {
    const after = await runAgainstFixture(manifest, folder, env, { trigger: { kind: "tap", rid: randomUUID(), node: tap.node, intent: tap.intent } });
    if (after.parsed === null || JSON.stringify(after.parsed.parts) !== shown) return false;
  }
  return true;
}

/** Run the program once against fixture facts and parse its output, as the bridge would. */
export async function checkRun(report: TrickCheckReport, env: CliContext["env"]): Promise<void> {
  const manifest = report.manifest;
  // No program to run: `--run` checks what `check` checks, and says so on the run line.
  if (manifest === undefined || manifest.run === undefined) return;
  const ran = await runAgainstFixture(manifest, report.folder, env);
  const { outcome, problem } = ran;
  const stderr = outcome.kind === "spawn-failed" ? "" : outcome.stderr;
  const run: NonNullable<TrickCheckReport["run"]> = { outcome: outcome.kind, ms: outcome.ms, problem, parts: [], refusals: [], notes: [], wording: [], pictures: [], stderr };
  if (ran.parsed !== null) {
    run.parts = ran.parsed.parts.map((p) => `${p.part.at} ${p.part.id}`);
    run.refusals = ran.parsed.refusals;
    run.notes = ran.parsed.notes;
    run.wording = decisionWording(ran.parsed.decisions);
    run.pictures = await namedPictureWarnings(report.folder, ran.parsed);
    if (problem === null && run.refusals.length === 0 && (await tapShowsNothing(manifest, report.folder, env, ran.parsed))) run.tapNote = TAP_SHOWS_NOTHING;
  }
  report.run = run;
}

/** Whether a report fails: a refusal that is not "later", a problem, or a run that failed or was refused. Warnings never fail it. */
export function reportFails(report: TrickCheckReport): boolean {
  if (report.manifest === undefined) return true;
  if (report.refusals.some((r) => r.code !== "later") || report.problems.length > 0) return true;
  const run = report.run;
  return run !== undefined && (run.problem !== null || run.refusals.length > 0);
}

/** "This trick shows as 3 cards." */
export function cardsCheckWords(count: number): string {
  return count === 1 ? "This trick shows as 1 card." : `This trick shows as ${String(count)} cards.`;
}

function printReport(deps: Pick<TrickDeps, "io">, report: TrickCheckReport): void {
  const { io } = deps;
  const m = report.manifest;
  io.out(m === undefined ? `trick ${report.id} in ${report.folder}` : `trick ${m.id} (${m.name}) in ${report.folder}`);
  if (m !== undefined) {
    io.out(`  places: ${[...m.places, ...(m.agentView === true ? [AGENT_VIEW_PLACE] : [])].join(", ")}`);
    io.out(`  every:  ${m.every ?? "none (runs at start and on taps)"}`);
    io.out(`  run:    ${m.run ?? NO_PROGRAM_NOTE}`);
    // Contract 2: the rights of an agent view, in the words the person reads.
    if (m.agentView === true) {
      io.out(`  view:   ${AGENT_VIEW_WORDS}`);
      io.out(`          ${AGENT_VIEW_TAP_WORDS}`);
    }
    if (m.rules !== undefined) io.out(`  rules:  ${m.rules}. ${RULES_WORDS}`);
    if (m.decides === "reply") io.out(`  decides: reply. ${DECIDES_REPLY_WORDS}`);
    if (m.drafts === "session") io.out(`  drafts: session. ${DRAFTS_SESSION_LINE}`);
    if (m.access !== undefined) io.out(`  access: ${m.access}. ${ACCESS_LINES[m.access]}`);
  }
  if (report.env.length > 0) {
    const names = report.env.map((e) => (e.reason === undefined ? e.name : `${e.name} (${e.reason})`));
    io.out(`  env:    ${names.join(", ")}`);
  }
  if (m !== undefined && m.about === undefined) io.out(`  note: ${ABOUT_NOTE}`);
  if (report.reads !== undefined) io.out(`  reads:  ${report.reads} The files are data for the program, never code.`);
  if (report.codeHash !== undefined) io.out(`  code:   sha256 ${report.codeHash} (what \`collie trick on\` approves)`);
  const h = report.helper;
  if (h !== undefined && h.modified) io.out(`  helper: ${HELPER_FILE} is a modified helper (its first line says v${String(h.version)}), so it is checked as the trick's own code.`);
  else if (h !== undefined && h.current) io.out(`  helper: ${HELPER_FILE} is collie trick helper v${String(h.version)}, Collie's own code, not checked line by line`);
  else if (h !== undefined) io.out(`  note: ${helperOlderNote(h.version, report.folder)}`);
  const others = report.notScanned.filter((f) => f !== HELPER_FILE);
  if (others.length > 0) io.out(`  not grepped (docs, data, tests): ${others.slice(0, 8).join(", ")}${others.length > 8 ? ` and ${String(others.length - 8)} more` : ""}`);
  if (report.runs.length > 0) {
    io.out("  runs:");
    for (const r of report.runs) io.out(`    ${r.file}:${r.line}  ${r.text}`);
  }
  for (const line of warningLines(report.warnings)) io.out(`  ${line}`);
  if (report.warnings.length > 0) io.out("  (the warnings come from a grep, not a proof: a program can do any of this in a way no pattern sees, and the trick runs with your full rights)");
  for (const r of report.refusals) {
    const line = `${MANIFEST_FILE}${r.path === "" ? "" : ` ${r.path}`}: ${r.reason}`;
    if (r.code === "later") io.out(`  note: ${line}`);
    else io.err(`error: ${line}`);
  }
  for (const p of report.problems) io.err(`error: ${p}`);
  const run = report.run;
  if (run !== undefined) {
    io.out(`  ran in ${run.ms} ms: ${run.problem ?? "exit 0"}`);
    if (run.parts.length > 0) io.out(`  parts: ${run.parts.join(", ")}`);
    for (const r of run.refusals) io.err(`error: output ${r.path === "" ? "" : `${r.path} `}${r.reason}`);
    // Notes never fail the check: a node or a part this Collie leaves out, a key it ignores.
    for (const n of run.notes) io.out(`  note: output ${n.path === "" ? "" : `${n.path} `}${n.reason}`);
    // Soft too: how a Decision is worded is the author's call (HILL_WRITING).
    for (const w of run.wording) io.out(`  warn: decision ${w.key}: ${w.text}`);
    for (const line of run.pictures) io.out(`  warn: ${line}`);
    if (run.tapNote !== undefined) io.out(`  note: ${run.tapNote}`);
    if (run.problem !== null && run.stderr.trim() !== "") {
      io.err("  stderr:");
      for (const line of run.stderr.trimEnd().split(/\r?\n/).slice(-10)) io.err(`    ${line}`);
    }
  }
  const cards = report.cards;
  if (cards !== undefined) {
    if (cards.ok) io.out(`  cards:  ${cardsCheckWords(cards.cards)} ${GROUP_CAPACITY_WORDS}`);
    else io.err(`error: propose: ${cards.error}`);
  }
  if (reportFails(report)) io.out("Refused. Fix the errors above, then check again.");
  else io.out(cards !== undefined && !cards.ok ? "ok: it runs on this machine, but it cannot be proposed." : "ok: no problems.");
}

/** The one sentence for a `trick.ts` that is a helper an older Collie shipped, byte for byte: Collie's own code, not counted. */
export function helperOlderNote(version: number, where: string): string {
  return `${HELPER_FILE} is the helper from an older Collie (v${String(version)}). Run \`collie trick helper ${where}\` to update it.`;
}

/** The refusal of a `trick.ts` that says helper vN but whose text matches none Collie shipped, so it counts as the trick's own code. */
export function helperEditedRefusal(version: number, bytes: number, where: string): string {
  return `${HELPER_FILE} says helper v${String(version)} but its text differs from that helper, so it counts as your own code (${sizeWords(bytes)}). Run \`collie trick helper ${where}\` to restore it, or remove the version line.`;
}

/**
 * The cards of a trick folder as a proposal. A refusal for size is explained when a hand-edited helper is the
 * cause: the same files without that `trick.ts` fit. Any other refusal, and a count that fits, stay as they are.
 * `where` is the folder as the person named it, for the verb the sentence offers.
 */
export function proposalCards(report: TrickCheckReport, files: readonly (Pick<ProposedFile, "rel" | "bytes"> & { executable?: boolean })[], crew: boolean, where: string): ProposalCardCount {
  const manifest = report.manifest;
  if (manifest === undefined) throw new Error("proposalCards needs a manifest");
  const warnings = [...new Set(report.warnings.map((w) => w.kind))];
  const cards = proposalCardCount({ manifest, files, warnings, crew });
  if (cards.ok || report.helper?.modified !== true || (cards.code !== "too_large" && cards.code !== "card_too_large")) return cards;
  const helper = files.find((file) => file.rel === HELPER_FILE);
  if (helper === undefined) return cards;
  const without = proposalCardCount({ manifest, files: files.filter((file) => file !== helper), warnings, crew });
  return without.ok ? { ...cards, error: helperEditedRefusal(report.helper.version, helper.bytes.byteLength, where) } : cards;
}

/** The cards of the folder as a proposal, read as `collie trick propose` reads it. A folder it cannot read counts nothing: propose says why. */
async function countCards(report: TrickCheckReport, crew: boolean, where: string): Promise<void> {
  if (report.manifest === undefined) return;
  const read = await readTrickFolder(report.folder);
  if (!read.ok) return;
  report.cards = proposalCards(report, [...read.files, ...read.pictures], crew, where);
}

export async function cmdTrickCheck(deps: TrickDeps, args: readonly string[]): Promise<number> {
  const json = args.includes("--json");
  const run = args.includes("--run");
  const named = args.find((a) => !a.startsWith("-"));
  if (named === undefined) {
    deps.io.err("usage: collie trick check [--run] [--json] <folder>");
    return EXIT.USAGE;
  }
  const folder = resolve(named);
  if (deps.files.entryType(folder) !== "directory") {
    deps.io.err(`error: ${named} is not a folder.`);
    return EXIT.USAGE;
  }
  const crew = leadsCrewOnDisk(deps);
  const report = await checkStatic(folder, deps.files, { crew, platform: deps.platform });
  if (run && report.manifest !== undefined && report.problems.length === 0) await checkRun(report, deps.ctx.env);
  await countCards(report, crew, named);
  if (json) deps.io.out(JSON.stringify(report, null, 2));
  else printReport(deps, report);
  return reportFails(report) ? EXIT.FAIL : EXIT.OK;
}

// ── init ─────────────────────────────────────────────────────────────────────

// The two forms `init` writes (a TypeScript program with the helper, the default, or `--sh`) and the
// AGENTS.md it writes live in bridge/tricks/agents-notes.ts, where a proposal card reads them too.
import { sampleAgents, type InitForm } from "../bridge/tricks/agents-notes.ts";
export { sampleAgents, type InitForm };

/** The sample manifest `init` writes. */
export function sampleManifest(id: string, form: InitForm = "ts"): string {
  const ts = form === "ts";
  return [
    `# Collie trick "${id}". Check it with: collie trick check --run <this folder>`,
    `id = "${id}"`,
    `name = "${id}"`,
    ts ? `run = "program.ts"` : `run = "./program.sh"`,
    `every = "30s"`,
    `icon = "plug"`,
    ts ? `places = ["status", "dashboard", "session"]` : `places = ["belt"]`,
    `# The trick contract this trick is written for. A Collie that does not know it refuses the trick.`,
    `contract = ${String(TRICK_CONTRACT_DEFAULT)}`,
    "",
  ].join("\n");
}

/** The sample `config.toml` of a TypeScript trick: settings the program reads as `t.config`. */
export function sampleConfig(id: string): string {
  return [`# Settings of the trick "${id}", read by the program as t.config. Not part of the code hash: edit freely.`, "rows = 8", ""].join("\n");
}

/** The sample program of a TypeScript trick: a status chip, a Dashboard tile, a session with rows, and a Decision to start from. */
export function sampleProgram(id: string): string {
  return `// The Collie trick "${id}". Collie runs this file with the facts on stdin and draws what it prints.
// Try it: collie trick dev .    The helper's API is in trick.ts.
import { run, v } from "./trick.ts";

run((t) => {
  const sessions = t.facts.sessions;
  const busy = sessions.filter((s) => s.status === "working").length;
  const rows = Number(t.config.rows ?? 8);

  t.status({ text: \`\${busy} busy\`, icon: "plug", tone: busy > 0 ? "accent" : "muted" });
  t.dashboard({ label: t.facts.trick.id.slice(0, 16), icon: "plug", badge: sessions.length });
  t.session({
    subtitle: \`\${sessions.length} sessions on \${t.facts.host}\`,
    view: [v.list(sessions.slice(0, rows).map((s) => v.row((s.name ?? s.paneId).slice(0, 60), { end: s.status })))],
  });

  // Ask the person on the Hill. The answer comes back as a tap: t.tap.decision is the key, t.tap.intent the option.
  // t.decide({
  //   key: "tidy",
  //   title: "Close the idle sessions?",
  //   summary: \`\${sessions.length - busy} sessions are idle.\`,
  //   options: [{ intent: "close", label: "Close them" }, { intent: "keep", label: "Keep them" }],
  //   recommends: { intent: "keep", why: "Nothing is in the way yet." },
  // });
});
`;
}

/** The shell sample: it counts the sessions in the facts and prints one belt mark. */
export const SAMPLE_SHELL_PROGRAM = `#!/bin/sh
# A Collie trick program. Collie runs it with the facts on stdin (one JSON document) and reads one JSON
# document from stdout. This one counts the sessions and prints one mark at the end of the Belt.
facts=$(cat)
n=$(printf '%s' "$facts" | grep -o '"paneId"' | wc -l | tr -d ' ')
printf '{"v":${String(TRICK_CONTRACT_DEFAULT)},"parts":[{"at":"belt","id":"belt","mark":{"icon":"plug","label":"%s","tone":"plain"}}]}\\n' "$n"
`;


/** The usage line of `init`. */
export const TRICK_INIT_USAGE = "usage: collie trick init [--sh] [--dir <folder>] <id>   (an id is 1 to 32 of a-z, 0-9 and -; in an agent's pane the draft goes to ./<id>)";

/** `p` through any links, or as resolved when it does not exist. */
function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Whether `path` is `root` or inside it. Both are resolved through links when they exist. */
function isInside(path: string, root: string): boolean {
  const rel = relative(realOrResolved(root), realOrResolved(path));
  return rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
}

/** A path as a command line names it: `./x` for a bare relative path, quoted when it holds a space. */
function shownPath(path: string): string {
  const named = isAbsolute(path) || path.startsWith(".") ? path : `./${path}`;
  return /\s/u.test(named) ? JSON.stringify(named) : named;
}

/** What `init` takes: the form, the id, and `--dir <folder>` (or `--dir=<folder>`). Null: a usage error. */
function parseInit(args: readonly string[]): { form: InitForm; id: string; dir: string | null } | null {
  let form: InitForm = "ts";
  let dir: string | null = null;
  const ids: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--sh") form = "sh";
    else if (arg === "--dir") {
      const value = args[i + 1];
      if (value === undefined || value === "" || value.startsWith("-")) return null;
      dir = value;
      i += 1;
    } else if (arg.startsWith("--dir=") && arg.length > "--dir=".length) dir = arg.slice("--dir=".length);
    else if (arg.startsWith("-")) continue;
    else ids.push(arg);
  }
  const id = ids[0];
  if (id === undefined || !isTrickId(id)) return null;
  return { form, id, dir };
}

/** Whether `dir` holds anything, or is not a folder at all. A missing folder is empty. */
async function holdsSomething(dir: string, files: Pick<Files, "entryType">): Promise<boolean> {
  const kind = files.entryType(dir);
  if (kind === null) return false;
  return kind !== "directory" || (await readdir(dir)).length > 0;
}

/**
 * `collie trick init [--sh] [--dir <folder>] <id>`. A trick that an agent writes is a DRAFT until a person says
 * yes, so in an agent's pane the scaffold goes to `./<id>` in the working folder, never the tricks folder: a
 * folder there is "added on this machine" and `propose` refuses it. `--dir` does the same for any caller.
 * Outside an agent's pane and without `--dir`, the scaffold goes to the tricks folder, as it always did.
 */
export async function cmdTrickInit(deps: TrickDeps, args: readonly string[]): Promise<number> {
  const parsed = parseInit(args);
  if (parsed === null) {
    deps.io.err(TRICK_INIT_USAGE);
    return EXIT.USAGE;
  }
  const { form, id } = parsed;
  // Fault d: the shell sample cannot run on Windows, so init does not write it there.
  if (form === "sh" && deps.platform === "win32") {
    deps.io.err(`error: ${TRICKS_WINDOWS_SHELL_LINE}`);
    deps.io.err(`Make the TypeScript form instead: collie trick init ${id}`);
    return EXIT.FAIL;
  }
  const root = tricksConfigDir(deps.ctx.configDir);
  const draft = parsed.dir !== null || (await inAgentPane(deps));
  const cwd = deps.cwd ?? process.cwd();
  const base = parsed.dir === null ? cwd : resolve(cwd, parsed.dir);
  const dir = draft ? join(base, id) : join(root, id);
  if (draft && isInside(base, root)) {
    deps.io.err(`error: ${base} is inside Collie's tricks folder, and a draft never lives there.`);
    deps.io.err("Change to your own work folder, or name one with --dir <folder>, then run init again.");
    return EXIT.FAIL;
  }
  if (!draft && deps.files.exists(dir)) {
    deps.io.err(`error: ${dir} exists already. init makes a new folder and never writes into one.`);
    return EXIT.FAIL;
  }
  if (draft && (await holdsSomething(dir, deps.files))) {
    deps.io.err(`error: ${dir} exists and is not empty. init makes a new folder and never writes into one that holds files.`);
    return EXIT.FAIL;
  }
  // The tricks folder sits in the config folder beside `.env`, owner only like it. A draft is the author's own folder.
  if (draft) await mkdir(dir, { recursive: true });
  else {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(dir, { mode: 0o700 });
  }
  await writeFile(join(dir, MANIFEST_FILE), sampleManifest(id, form));
  await writeFile(join(dir, "AGENTS.md"), sampleAgents(id, form, draft));
  const made = form === "sh" ? "trick.toml, program.sh and AGENTS.md" : "trick.toml, program.ts, trick.ts (the helper), config.toml and AGENTS.md";
  if (form === "sh") await writeFile(join(dir, "program.sh"), SAMPLE_SHELL_PROGRAM, { mode: 0o755 });
  else {
    await writeFile(join(dir, "program.ts"), sampleProgram(id));
    await writeFile(join(dir, HELPER_FILE), TRICK_HELPER);
    await writeFile(join(dir, CONFIG_FILE), sampleConfig(id));
  }
  if (!draft) {
    deps.io.out(`Made ${dir} with ${made}. The trick is off.`);
    deps.io.out(`Try it: collie trick dev ${dir}`);
    deps.io.out(`Check it: collie trick check --run ${dir}`);
    deps.io.out(`Switch it on: collie trick on ${id}`);
    return EXIT.OK;
  }
  const shown = shownPath(parsed.dir === null ? id : join(parsed.dir, id));
  deps.io.out(`Made your draft ${shown} with ${made}. It is outside the tricks folder: nothing is added to this machine's tricks before the person's yes.`);
  deps.io.out(`Try it: collie trick dev ${shown}`);
  deps.io.out(`Check it: collie trick check --run ${shown}`);
  deps.io.out(`Hand it to the person: collie trick propose ${shown}`);
  return EXIT.OK;
}

// ── helper ───────────────────────────────────────────────────────────────────

/**
 * `collie trick helper <id|folder>`: write the helper this Collie carries into an existing trick folder,
 * over the old `trick.ts`. The helper is part of the trick's code, so a trick that is on keeps running its
 * approved copy and the new version waits for a person's yes; the verb says so, and approves nothing itself.
 */
export async function cmdTrickHelper(deps: TrickDeps, args: readonly string[]): Promise<number> {
  const named = args.find((a) => !a.startsWith("-"));
  if (named === undefined) {
    deps.io.err("usage: collie trick helper <id|folder>   (rewrites trick.ts with the helper this Collie carries)");
    return EXIT.USAGE;
  }
  const dir = isTrickId(named) && !named.includes(".") ? join(tricksConfigDir(deps.ctx.configDir), named) : resolve(named);
  if (deps.files.entryType(dir) !== "directory") {
    deps.io.err(`error: there is no trick folder ${dir}.`);
    return EXIT.FAIL;
  }
  const path = join(dir, HELPER_FILE);
  const kind = deps.files.entryType(path);
  if (kind !== null && kind !== "file") {
    deps.io.err(`error: ${path} is not a regular file, so it is left alone.`);
    return EXIT.FAIL;
  }
  const held = kind === "file" ? deps.files.read(path) : null;
  if (held === TRICK_HELPER) {
    deps.io.out(`${path} is the current helper (v${String(HELPER_VERSION)}). Nothing changed.`);
    return EXIT.OK;
  }
  const was = held === null ? "none" : helperVersion(held) === null ? "a file that is not the helper" : `v${String(helperVersion(held))}`;
  await writeFile(path, TRICK_HELPER);
  deps.io.out(`Wrote ${path}: collie trick helper v${String(HELPER_VERSION)} (it was ${was}).`);
  const id = basename(dir);
  if (switchesOf(deps).switches.on.has(id)) deps.io.out(`The trick's code changed. ${id} keeps running the version you approved; the new one waits for your yes: collie trick on ${id}`);
  else deps.io.out(`The trick's code changed. Check it: collie trick check --run ${dir}`);
  return EXIT.OK;
}

// ── the bare verb ────────────────────────────────────────────────────────────

export function cmdTrick(deps: Pick<TrickDeps, "io">, args: readonly string[]): number {
  const sub = args[0];
  if (sub !== undefined) deps.io.err(`error: unknown trick subcommand "${sub}"`);
  deps.io.err(`usage: collie trick <${TRICK_SUBCOMMANDS.join("|")}> ...`);
  return EXIT.USAGE;
}
