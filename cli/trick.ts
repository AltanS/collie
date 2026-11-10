import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { redactText } from "../bridge/redact.ts";
import { approvedDirOf, approveFolder, pruneCopies, verifyCopy } from "../bridge/tricks/approved.ts";
import { CONFIG_FILE, diskTrickFs, trickCodeHash, walkTrickCode } from "../bridge/tricks/code-hash.ts";
import { originShort } from "../bridge/tricks/origin.ts";
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
import { createTrickScanner, readManifestFile, type FoundTrick } from "../bridge/tricks/discover.ts";
import { isBaseEnvName, neverReason, scrubEnv } from "../bridge/tricks/env.ts";
import { MANIFEST_FILE, tricksConfigDir, switchesPath } from "../bridge/tricks/paths.ts";
import { outcomeProblem, runProgram, runtimeScript, type RunOutcome } from "../bridge/tricks/run.ts";
import { isChanged } from "../bridge/tricks/service.ts";
import { parseSwitches, updateSwitches, withEntry, withSwitch } from "../bridge/tricks/switches.ts";
import type { CrewFetch } from "../bridge/crew/peer-client.ts";
import { asJsonBoolean, asJsonObject, asJsonString, parseJson, type JsonValue } from "../web/src/lib/json.ts";
import { FACTS } from "../web/src/lib/tricks/fixtures/index.ts";
import {
  isTrickId,
  parseFacts,
  parseTrickDocumentText,
  TRICK_CONTRACT,
  type FactsTrigger,
  type ParsedTrickDocument,
  type TrickFacts,
  type TrickDecision,
  type TrickManifest,
  type Refusal,
} from "../web/src/lib/tricks/schema.ts";
import { readEnvMarkers } from "./beacon.ts";
import type { CliContext } from "./context.ts";
import { hillWordingWarnings, HILL_WRITING } from "./hill-rules.ts";
import { EXIT, type Io } from "./io.ts";
import { identityHeader, readOwnSnapshot } from "./snapshot-read.ts";
import type { Files } from "./sys.ts";

// `collie trick` (M94 slice 01): the machine's half of Collie tricks. A trick is added on the machine and
// switched on from here (or, later, the phone); the bridge runs it.
//
//   list              every trick folder, its switch, its origin and what the running bridge says of it
//   add [<source>]    copy a trick from a git repository into the tricks folder, OFF (cli/trick-add.ts);
//                     with no source, list the tricks of the official repository
//   update <id>       fetch a trick added with `add` again and replace its code, keeping config.toml
//   remove <id>       delete a trick folder that is off, its state folder and its approved copies
//   on <id> / off <id>  write the switch (`<stateDir>/tricks/switches.json`); the bridge rereads it. On
//                     approves the code as it is now: it copies the folder into
//                     `<configDir>/tricks/.collie-approved/<id>/<hash16>/` and stores the copy's hash, and the
//                     bridge runs that copy, so an edit of the folder never stops the trick: the new
//                     version waits for a yes. On prints the check scan's warnings, and still switches
//                     on. It refuses inside a multiplexer pane, where Collie takes the caller for an
//                     agent (a speed bump, not a wall: see cmdTrickSwitch)
//   auto <id> on|off  "take changes without asking": a new version whose powers did not move is
//                     approved on its own; a change of powers always waits
//   check <folder>    the static check: the manifest, its places, the command lines and the warnings of
//                     every source file in the folder (a grep, not a proof). `--run` also runs the
//                     program once against fixture facts, with the bridge's environment rule, and
//                     parses what it prints
//   dev <folder>      `check --run` made friendly (cli/trick-dev.ts): one run, a short summary of each
//                     part, Decision and refusal; `--tap`, `--json`, `--watch`
//   init <id>         a new folder with `trick.toml`, a TypeScript program, the helper `trick.ts`, a
//                     `config.toml` and an `AGENTS.md`; `--sh` writes the shell sample instead
//   helper <id>       rewrite `trick.ts` in a trick folder with the helper this Collie carries
//   skill [<id>]      what an agent reads: the `SKILL.md` of the approved copy of a trick that is ON (what
//                     the trick that runs asks of the agent), or with no id the brief for writing a trick
//
// `check` exits 0 (clean, or only "later" notes), 1 (a refusal or a failed run) or 2 (usage: no
// folder, or not a folder), like `config check`. `--json` prints one report document instead.

export const TRICK_SUBCOMMANDS = ["list", "add", "update", "remove", "on", "off", "auto", "check", "dev", "init", "helper", "skill"] as const;

export interface TrickDeps {
  ctx: Pick<CliContext, "configDir" | "stateDir" | "env" | "port">;
  io: Io;
  files: Pick<Files, "read" | "exists" | "entryType">;
  fetch: CrewFetch;
  now: () => number;
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

/** The bridge's answer to `GET /api/tricks`, or null when it said nothing usable. */
async function bridgeTricks(deps: Pick<TrickDeps, "ctx" | "files" | "fetch">): Promise<{ tricks: Map<string, BridgeTrick>; path?: string } | null> {
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
  const path = asJsonString(doc.path);
  return path === undefined ? { tricks } : { tricks, path };
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
      origin: m.origin === undefined ? null : originShort(m.origin),
      auto: entry?.auto === true,
      pending: said?.pending ?? (on && isChanged(entry, m)),
    };
  });
  const out: TrickList = { exists: found.exists, rows, bridge: bridge !== null };
  if (bridge?.path !== undefined) out.path = bridge.path;
  return out;
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  ").trimEnd());
}

export async function cmdTrickList(deps: TrickDeps, args: readonly string[]): Promise<number> {
  const json = args.includes("--json");
  const { exists, rows, bridge } = await trickListRows(deps);
  if (json) {
    deps.io.out(JSON.stringify({ folder: tricksConfigDir(deps.ctx.configDir), exists, bridge, tricks: rows }, null, 2));
    return EXIT.OK;
  }
  if (!exists || rows.length === 0) {
    deps.io.out(`No tricks in ${tricksConfigDir(deps.ctx.configDir)}. Make one: collie trick init <id>, or add one: collie trick add`);
    return EXIT.OK;
  }
  const lines = table([
    ["ID", "NAME", "SWITCH", "AUTO", "SKILL", "ORIGIN", "STATE", "LAST RUN", "LAST ERROR"],
    ...rows.map((r) => [r.id, r.name, r.on ? "on" : "off", r.auto ? "on" : "-", r.skill ? "yes" : "-", r.origin ?? "-", r.pending ? `${r.state}, new version waits` : r.state, r.lastRunAt ?? "-", r.error ?? "-"]),
  ]);
  for (const line of lines) deps.io.out(line);
  if (rows.some((r) => r.pending)) deps.io.out("A new version waits for your yes: approve it on the phone, or with collie trick on <id>.");
  if (!bridge) deps.io.out("(the bridge did not answer: state and last run are from the files only)");
  if (rows.some((r) => r.skill && r.on)) deps.io.out("An agent reads what a trick asks of it with: collie trick skill <id>");
  return EXIT.OK;
}

// ── skill ────────────────────────────────────────────────────────────────────

/** The file in a trick folder that says what the trick asks of an agent. */
export const SKILL_FILE = "SKILL.md";
/** The most `collie trick skill <id>` reads and prints. A larger file is refused, never cut. */
export const SKILL_BYTES_MAX = 32 * 1024;

/** The brief `collie trick skill` prints with no id: for an agent that wants to write a trick. */
export const TRICK_WRITE_BRIEF = [
  "A trick is a folder, <config dir>/tricks/<id>/, with a trick.toml and a program. The phone draws what the program prints.",
  "To write one:",
  "  1. Run `collie trick init <id>`. It makes the folder with a sample program and an AGENTS.md.",
  "  2. Read that AGENTS.md. It says what the program gets, what it may print, and the limits.",
  "  3. Write the trick. `collie trick dev <folder>` runs it once and says what the phone would get; `--watch` runs it on each change.",
  "     Then run `collie trick check --run <folder>`. It reads the folder, runs the program once and greps it.",
  "  4. Fix what it reports, and run it again until it is clean.",
  "The trick stays off. Never switch it on yourself: `collie trick on <id>` is the person's approval of the code, and it refuses inside an agent's pane.",
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
 * The line `collie trick on` refuses with inside a multiplexer pane. A SPEED BUMP, NOT A WALL: the pane's
 * markers (`readEnvMarkers`, cli/beacon.ts, the same ones `collie walky` and `collie hill` send) are what
 * make the bridge take a caller for an agent, and an agent should ask, not approve its own code. A process
 * that strips them, or writes the switch file itself, gets past it: the user account is the real boundary.
 */
export function agentPaneRefusal(id: string): string[] {
  return [
    "error: collie trick on is a person's yes to the code, and this runs inside a multiplexer pane, where Collie takes the caller for an agent.",
    `An agent does not approve its own trick. Tell your operator that ${id} is ready to switch on.`,
    `A person approves it on the phone (Settings, Tricks), or runs collie trick on ${id} in a terminal outside the multiplexer.`,
  ];
}

export async function cmdTrickSwitch(deps: TrickDeps, args: readonly string[], on: boolean): Promise<number> {
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
  if (readEnvMarkers(deps.ctx.env).length > 0) {
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
  // The copy is what is approved: its hash, and the warnings of its code, read at the moment of consent.
  const approved = await approveFolder({ stateDir: deps.ctx.stateDir, configDir: deps.ctx.configDir, id, by: "cli", at: new Date(deps.now()).toISOString() });
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
  deps.io.out(`Approved the code of ${id} as it is now: sha256 ${approved.hash}. The bridge runs this copy; an edit of the folder waits for your yes.`);
  return EXIT.OK;
}

/** `collie trick auto <id> on|off`: "take changes without asking" for one trick that is on. */
export async function cmdTrickAuto(deps: TrickDeps, args: readonly string[]): Promise<number> {
  const [id, word, ...rest] = args;
  if (id === undefined || !isTrickId(id) || (word !== "on" && word !== "off") || rest.length > 0) {
    deps.io.err("usage: collie trick auto <id> on|off   (take a new version whose powers did not change without asking)");
    return EXIT.USAGE;
  }
  if (word === "on" && readEnvMarkers(deps.ctx.env).length > 0) {
    for (const line of agentPaneRefusal(id)) deps.io.err(line);
    return EXIT.REFUSED;
  }
  const auto = word === "on";
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
      ? `${id} takes a new version on its own when its powers (environment names, places) did not change. A change of powers still waits for your yes.`
      : `${id} asks again: every new version waits for your yes.`,
  );
  return EXIT.OK;
}

// ── check ────────────────────────────────────────────────────────────────────

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
  /** The code hash `collie trick on` would approve. */
  codeHash?: string;
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

/** The static half of `check`. Reads only. */
export async function checkStatic(folder: string, files: Pick<Files, "read" | "entryType">): Promise<TrickCheckReport> {
  const id = basename(folder);
  const read = await readManifestFile(diskTrickFs, folder, id);
  const report: TrickCheckReport = { folder, id, refusals: read.refusals, problems: [], files: [], runs: [], warnings: [], notScanned: [], env: [] };
  if (read.manifest === undefined) return report;
  report.manifest = read.manifest;
  report.env = envNames(read.manifest);
  const named = programFiles(read.manifest.run, folder, files);
  report.files = named.files;
  for (const word of named.missing) report.problems.push(`The run line names ${word}, which is not in the folder.`);
  const script = runtimeScript(read.manifest.run);
  if (script !== null && named.files.length === 0 && !named.missing.includes(read.manifest.run)) report.problems.push(`The run line names ${script}, which is not in the folder.`);
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
  const runLine = named.files.length === 0 ? [{ file: MANIFEST_FILE, text: `run = ${read.manifest.run}`, shell: true }] : [];
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
  const facts: TrickFacts = { ...parsed.facts, trick: { id: manifest.id, dir: folder, state } };
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
  const kept = opts.state !== undefined;
  const state = opts.state ?? (await mkdtemp(join(tmpdir(), `collie-trick-check-${manifest.id}-`)));
  if (kept) await mkdir(state, { recursive: true, mode: 0o700 });
  try {
    const outcome = await runProgram({
      command: manifest.run,
      cwd: folder,
      env: scrubEnv(env, manifest.env ?? [], { testHooks: true }),
      stdin: JSON.stringify(checkFacts(manifest, folder, state, opts.trigger, opts.facts)),
    });
    const problem = outcomeProblem(outcome, 400);
    if (problem !== null || outcome.kind !== "exited") return { outcome, problem, stdoutBytes: 0, parsed: null, decisionsListed: false };
    const parsed = parseTrickDocumentText(outcome.stdout, { declared: manifest.places });
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

/** Run the program once against fixture facts and parse its output, as the bridge would. */
export async function checkRun(report: TrickCheckReport, env: CliContext["env"]): Promise<void> {
  const manifest = report.manifest;
  if (manifest === undefined) return;
  const ran = await runAgainstFixture(manifest, report.folder, env);
  const { outcome, problem } = ran;
  const stderr = outcome.kind === "spawn-failed" ? "" : outcome.stderr;
  const run: NonNullable<TrickCheckReport["run"]> = { outcome: outcome.kind, ms: outcome.ms, problem, parts: [], refusals: [], notes: [], wording: [], stderr };
  if (ran.parsed !== null) {
    run.parts = ran.parsed.parts.map((p) => `${p.part.at} ${p.part.id}`);
    run.refusals = ran.parsed.refusals;
    run.notes = ran.parsed.notes;
    run.wording = decisionWording(ran.parsed.decisions);
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

function printReport(deps: Pick<TrickDeps, "io">, report: TrickCheckReport): void {
  const { io } = deps;
  const m = report.manifest;
  io.out(m === undefined ? `trick ${report.id} in ${report.folder}` : `trick ${m.id} (${m.name}) in ${report.folder}`);
  if (m !== undefined) {
    io.out(`  places: ${m.places.join(", ")}`);
    io.out(`  every:  ${m.every ?? "none (runs at start and on taps)"}`);
    io.out(`  run:    ${m.run}`);
  }
  if (report.env.length > 0) {
    const names = report.env.map((e) => (e.reason === undefined ? e.name : `${e.name} (${e.reason})`));
    io.out(`  env:    ${names.join(", ")}`);
  }
  if (report.codeHash !== undefined) io.out(`  code:   sha256 ${report.codeHash} (what \`collie trick on\` approves)`);
  const h = report.helper;
  if (h !== undefined && h.modified) io.out(`  helper: ${HELPER_FILE} is a modified helper (its first line says v${String(h.version)}), so it is checked as the trick's own code`);
  else if (h !== undefined && h.current) io.out(`  helper: ${HELPER_FILE} is collie trick helper v${String(h.version)}, Collie's own code, not checked line by line`);
  else if (h !== undefined) io.out(`  helper: ${HELPER_FILE} is helper v${String(h.version)}, an older one; update with collie trick helper ${m?.id ?? report.id}`);
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
    if (run.problem !== null && run.stderr.trim() !== "") {
      io.err("  stderr:");
      for (const line of run.stderr.trimEnd().split(/\r?\n/).slice(-10)) io.err(`    ${line}`);
    }
  }
  io.out(reportFails(report) ? "Refused. Fix the errors above, then check again." : "ok: no problems.");
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
  const report = await checkStatic(folder, deps.files);
  if (run && report.manifest !== undefined && report.problems.length === 0) await checkRun(report, deps.ctx.env);
  if (json) deps.io.out(JSON.stringify(report, null, 2));
  else printReport(deps, report);
  return reportFails(report) ? EXIT.FAIL : EXIT.OK;
}

// ── init ─────────────────────────────────────────────────────────────────────

/** The two forms `init` writes: a TypeScript program with the helper (the default), or a shell program (`--sh`). */
export type InitForm = "ts" | "sh";

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
    `contract = ${String(TRICK_CONTRACT)}`,
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
printf '{"v":${String(TRICK_CONTRACT)},"parts":[{"at":"belt","id":"belt","mark":{"icon":"plug","label":"%s","tone":"plain"}}]}\\n' "$n"
`;

/** The loop and the helper's table, for a TypeScript trick. */
function agentsTsLoop(id: string): string {
  return `## The loop

1. Change \`program.ts\`. It imports \`./trick.ts\`, the helper. Collie runs the program with its own
   runtime and installs nothing, so it imports only files in this folder and the \`node:\` and \`bun:\`
   built-ins.
2. Run \`collie trick dev .\` to see what the phone would get: each part, each Decision, every refusal.
   \`collie trick dev . --watch\` runs it again on each change; \`--tap <intent>\` runs it as a tap;
   \`--facts <file.json>\`, \`--state <dir>\` and \`--rid <uuid>\` set the facts, the state folder and the tap's id.
3. Run \`collie trick check --run .\` and fix every error it prints. Read its warnings too.
4. Ask a person to switch the trick on (\`collie trick on ${id}\`, outside an agent's pane). It runs
   while a phone watches.

## The helper

\`trick.ts\` is Collie's helper. Do not edit it: \`collie trick helper ${id}\` rewrites it with the newest
version. \`run((t) => { ... })\` reads the facts, calls your function once and prints the document.

| Call | What it does |
| ---- | ------------ |
| \`t.facts\` | the facts (below), typed |
| \`t.config\` | \`config.toml\`, parsed; {} when there is none |
| \`t.tap\` | the tap that started this run, or null: \`rid\`, \`node\`, \`intent\`, \`value\`, and for an answer to a Decision \`decision\` (its key), \`text\` and \`seen\` |
| \`t.status\`, \`t.belt\`, \`t.dashboard\`, \`t.tabbar\`, \`t.session\` | one part in each place; list the place in \`places\` |
| \`v.card\`, \`v.row\`, \`v.para\`, and the rest of \`v\` | one builder per node kind, for a view |
| \`t.decide\`, \`t.keepDecisions\` | ask the person on the Hill; leave the open Decisions as they are |
| \`t.state.get\`, \`t.state.set\` | small JSON files in the trick's state folder; a name may hold folders (\`cache/ci\`) |
| \`t.log(name)\` | an append-only JSON-lines record: \`.append\`, \`.all\`, \`.last(n)\`, \`.has(rid)\`, and \`.once(rid, entry)\`, one entry per tap |
| \`t.cached(name, ttlMs, loader)\` | a read kept with its time; a failed read serves the old value as \`stale\` |
| \`t.closedUntil\`, \`t.isClosed\` | close a key for a while, such as a Decision held for a day |
| \`t.path(p)\` | a path from \`config.toml\` made absolute: \`~/\` is home, a relative path is this folder's |
| \`t.tool(name)\`, \`t.sh\` | find a program on PATH or in the usual user folders; run it without a shell, never throws |
| \`t.show(defaults)\`, \`t.put\` | where \`show\` in \`config.toml\` puts the count, and the count in each of those places |
| \`t.onPrint(fn)\` | change the whole document just before it prints, such as \`mapText(doc, mask)\` |
| \`t.sessionAt\`, \`t.sessionNamed\` | the session in a folder, or with a name |
| \`t.fresh\`, \`t.asOf\` | how long the parts stay fresh, and when the data was true |
| \`now\`, \`iso\`, \`minute\`, \`age\`, \`clip\`, \`mask\` | the clock, times as words, one masked line cut to a length |

In a test, \`TRICK_NOW\` (epoch seconds) fixes the clock and \`TRICK_TOOLS_ONLY_PATH=1\` makes \`t.tool\`
look on PATH alone. \`collie trick dev\` passes every \`TRICK_*\` variable you set; the bridge never does.

A Decision may carry a \`view\`: display nodes under its summary (a bar of chips, rows with their
proof, a code hunk), at most 8 KiB, 100 nodes and 4 deep, with no button, card or image. The options
are the taps. When neither \`t.decide\` nor \`t.keepDecisions\` is called, the run wants no Decisions and the open ones
are withdrawn. A thrown error shows one warn card in the trick's session, or fails the run when the
trick has no session.
`;
}

/** The loop of a shell trick. */
function agentsShLoop(id: string): string {
  return `## The loop

1. Change \`program.sh\` (or point \`run\` at another program in this folder).
2. Run \`collie trick check --run .\` and fix every error it prints. Read its warnings too.
3. Ask a person to switch the trick on (\`collie trick on ${id}\`, outside an agent's pane). It runs
   while a phone watches.
`;
}

/** The `AGENTS.md` `init` writes: the contract, in prose, for the agent that grows the trick. */
export function sampleAgents(id: string, form: InitForm = "ts"): string {
  return `# The Collie trick "${id}"

This folder is a Collie trick. Collie's bridge runs the program named by \`run\` in \`trick.toml\` and
draws what it prints on the phone, with Collie's own parts in the current theme.

${form === "ts" ? agentsTsLoop(id) : agentsShLoop(id)}
## Switching on approves this code

The trick runs with the full rights of the user who runs Collie: it can read and change any file that
user can, the Collie config folder too. Switching it on, on the phone or with \`collie trick on\`, is
a person's yes to the code as it is at that moment. Collie copies this folder into its state folder
and runs that approved copy. An edit here never stops the trick: it keeps running the approved copy,
and the new version waits for a person's yes. \`collie trick on\` refuses inside an agent's pane.

Not part of the code, so free to change: \`config.toml\` (settings for the program; an edit reaches
the running copy at once), a top-level \`media/\`, \`captures/\` and \`inputs/\` folder, any \`*.log\`
file, dot files and dot folders, and \`node_modules/\`. Only the code and \`config.toml\` are copied,
with what \`media/\` and \`captures/\` held at the moment of the yes; \`node_modules/\` and dot files
are not, so the program cannot rely on them. Keep state in \`trick.state\` (see below). The program
must never write a code file into its own folder: in the approved copy that stops the trick.

## What the program gets

- Its working folder is the approved copy of this folder.
- On stdin, one JSON document, the facts: \`contract\` (${String(TRICK_CONTRACT)}), \`trigger\` (\`start\`, \`timer\`, or \`tap\` with
  \`rid\`, \`node\` (the part id, or \`hill/<key>\` for a decision), \`intent\`, \`value\` and \`from\`),
  \`trick\` (\`id\`, \`dir\`, and \`state\`, a folder of its own to keep files in), \`memberId\` (this
  Collie's id: its crew member id, or \`m_\` and ten letters and digits on a solo install; it stays when
  the machine is renamed, so key saved state on it), \`host\` (the machine's name, to show only, never a
  key), \`sessions\` (each with \`id\` as \`memberId:paneId\`, \`memberId\`, \`sessionId\` (opaque, never
  parse it), \`paneId\`, \`host\` (a name to show), \`name\`, \`agent\`, \`status\`, \`cwd\`, \`space\`,
  \`tab\`, \`lastActiveAt\`) and \`spaces\` (\`name\`, \`folder\`).
- A short list of the Collie service's environment: \`PATH\`, \`HOME\`, \`USER\`, \`LOGNAME\`,
  \`SHELL\`, \`LANG\`, \`LC_*\`, \`TZ\`, \`TERM\`, \`TMPDIR\`, the \`XDG_*_HOME\` folders,
  \`XDG_RUNTIME_DIR\`, \`NVM_DIR\` and \`BUN_INSTALL\`. Any other variable the program needs, list
  in \`trick.toml\`: \`env = ["GH_TOKEN"]\`. \`collie trick check\` and the phone show each name you
  list. A \`COLLIE_*\`, \`HERDR_*\`, \`*_SOCK\` or \`*_SOCKET\` variable is never passed, even when
  listed.

## What it prints

One JSON document on stdout, at most 64 KiB, within 10 seconds. \`v\` is the contract number:

\`\`\`json
{ "v": ${String(TRICK_CONTRACT)}, "parts": [ { "at": "belt", "id": "belt", "mark": { "icon": "plug", "label": "3", "tone": "ok" } } ] }
\`\`\`

- Each part has an \`at\` (a place listed in \`places\` in \`trick.toml\`) and an \`id\` unique in the
  document. A part that does not parse is refused alone; the others still draw.
- The places a part may name, each listed in \`places\` when used: \`belt\` (a mark at the end of the
  Belt: \`mark\` with \`icon\`, \`label\`, \`badge\`, \`tone\`, \`intent\`), \`status\` (a chip in the
  status line above the Belt: \`chip\` with \`text\`, \`icon\`, \`tone\`), \`session\` (a session of its
  own, with a \`view\`), \`dashboard\` (a tile in the strip at the top of the Dashboard) and \`tabbar\`
  (an item in the Dashboard's bottom bar, after the Hill). A \`dashboard\` and a \`tabbar\` part take
  one \`item\`: \`{ "label": "Legs", "icon": "flask", "badge": 3, "tone": "ok" }\`, the label 1 to 16
  characters, the badge a count from 0 to 9999 or 1 to 12 characters. An item takes no \`intent\`: a
  tap opens the trick's session when it has one. One belt, status, dashboard and tabbar part per trick.
- Optional: \`asOf\` (an ISO 8601 instant) and \`fresh\` (such as \`"90s"\`): past that window the phone
  shows the part's age and drops its tone.
- A part's \`view\` is a list of nodes \`{ kind, text, attrs, kids }\`, the Tree UI's kinds (\`card\`,
  \`group\`, \`list\`, \`row\`, \`bar\`, \`chip\`, \`button\`, \`para\`, \`line\`, \`run\`, \`code\`, \`link\`,
  \`image\`, \`meter\`, \`spacer\`), \`number\`, and the display kinds \`compare\`, \`table\` (with
  \`col\` and \`cell\`), \`diff\` and \`spark\`. Every attribute value is a string. An \`image\`
  names a file in this folder's \`media/\` (\`media/chart.png\`: PNG, JPEG or WebP, at most 2 MB).
- Optional: \`decisions\`, up to 20 questions for the person (\`key\`, \`title\`, \`summary\`, \`options\`,
  \`recommends\`, and \`view\` for display nodes under the summary: no button or card; an \`image\`
  or a \`compare\` there names one of the Decision's own \`media\` by \`ref\`). The
  answer comes back as a tap on \`hill/<key>\`. Leave the \`decisions\` key out
  and the open decisions stay as they are; an empty list \`[]\` withdraws them all.
- A value that breaks a rule is refused, and a string over its cap is refused, never cut. What this
  Collie does not know is left out instead: a node of an unknown kind, or a part in an unknown place,
  is dropped with one note on the trick's row, and an unknown key or attribute is ignored. \`collie
  trick dev\` and \`collie trick check --run\` print each one as a note; read them, they are often a typo.
  \`trick.toml\` and a Decision stay strict: an unknown key there is refused.

## Wording a Decision

${HILL_WRITING.join("\n")}

\`collie trick dev\` and \`collie trick check --run\` warn when a Decision breaks one of these. The
warnings never refuse it.

## The contract

\`trick.toml\` names the trick contract this folder is written for, \`contract = ${String(TRICK_CONTRACT)}\`, the facts carry
it as \`contract\`, and the output's \`v\` is it. Within one number Collie only adds keys, kinds and
places. A Collie that knows an older number refuses the trick with one line that names both numbers.

## Limits

One run at a time, 10 seconds, 64 KiB of stdout. After a failed run the trick waits 1, 5 and 30
minutes, then stops until a new version is approved, its \`config.toml\` changes or a tap restarts it. A timer run should
only read: a timer that calls a model spends your subscription with no session to show for it.
Everything printed, stderr too, goes through Collie's secret mask.
`;
}

export async function cmdTrickInit(deps: TrickDeps, args: readonly string[]): Promise<number> {
  const form: InitForm = args.includes("--sh") ? "sh" : "ts";
  const id = args.find((a) => !a.startsWith("-"));
  if (id === undefined || !isTrickId(id)) {
    deps.io.err("usage: collie trick init [--sh] <id>   (an id is 1 to 32 of a-z, 0-9 and -)");
    return EXIT.USAGE;
  }
  const root = tricksConfigDir(deps.ctx.configDir);
  const dir = join(root, id);
  if (deps.files.exists(dir)) {
    deps.io.err(`error: ${dir} exists already. init makes a new folder and never writes into one.`);
    return EXIT.FAIL;
  }
  // The tricks folder sits in the config folder beside `.env`, owner only like it.
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(dir, { mode: 0o700 });
  await writeFile(join(dir, MANIFEST_FILE), sampleManifest(id, form));
  await writeFile(join(dir, "AGENTS.md"), sampleAgents(id, form));
  if (form === "sh") {
    await writeFile(join(dir, "program.sh"), SAMPLE_SHELL_PROGRAM, { mode: 0o755 });
    deps.io.out(`Made ${dir} with trick.toml, program.sh and AGENTS.md. The trick is off.`);
  } else {
    await writeFile(join(dir, "program.ts"), sampleProgram(id));
    await writeFile(join(dir, HELPER_FILE), TRICK_HELPER);
    await writeFile(join(dir, CONFIG_FILE), sampleConfig(id));
    deps.io.out(`Made ${dir} with trick.toml, program.ts, trick.ts (the helper), config.toml and AGENTS.md. The trick is off.`);
  }
  deps.io.out(`Try it: collie trick dev ${dir}`);
  deps.io.out(`Check it: collie trick check --run ${dir}`);
  deps.io.out(`Switch it on: collie trick on ${id}`);
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
