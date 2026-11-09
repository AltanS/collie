import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { createTrickScanner, readManifestText, type FoundTrick } from "../bridge/tricks/discover.ts";
import { scrubEnv } from "../bridge/tricks/env.ts";
import { MANIFEST_FILE, tricksConfigDir, switchesPath } from "../bridge/tricks/paths.ts";
import { outcomeProblem, runProvider, type RunOutcome } from "../bridge/tricks/run.ts";
import { parseSwitches, withSwitch, writeSwitches } from "../bridge/tricks/switches.ts";
import type { CrewFetch } from "../bridge/crew/peer-client.ts";
import { asJsonBoolean, asJsonObject, asJsonString, parseJson, type JsonValue } from "../web/src/lib/json.ts";
import { FACTS } from "../web/src/lib/tricks/fixtures/index.ts";
import {
  isTrickId,
  parseFacts,
  parseTrickDocumentText,
  type TrickFacts,
  type TrickManifest,
  type Refusal,
} from "../web/src/lib/tricks/schema.ts";
import type { CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import { identityHeader, readOwnSnapshot } from "./snapshot-read.ts";
import type { Files } from "./sys.ts";

// `collie trick` (M94 slice 01): the machine's half of Collie tricks. A trick is added on the machine and
// switched on from here (or, later, the phone); the bridge runs it.
//
//   list              every trick folder, its switch, and what the running bridge says of it
//   on <id> / off <id>  write the switch (`<stateDir>/tricks/switches.json`); the bridge rereads it
//   check <folder>    the static check: the manifest, its places, and the command lines the provider
//                     contains (honest, not a proof). `--run` also runs the provider once against
//                     fixture facts, with the bridge's environment rule, and parses what it prints
//   init <id>         a new folder with `trick.toml`, a sample provider and an `AGENTS.md`
//
// `check` exits 0 (clean, or only "later" notes), 1 (a refusal or a failed run) or 2 (usage: no
// folder, or not a folder), like `config check`. `--json` prints one report document instead.
// `add`, `update` and `skill` are a later slice.

export const TRICK_SUBCOMMANDS = ["list", "on", "off", "check", "init"] as const;

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
  const rows = found.tricks.map((m): TrickListRow => {
    const on = switches.on.has(m.id);
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
    deps.io.out(`No tricks in ${tricksConfigDir(deps.ctx.configDir)}. Make one: collie trick init <id>`);
    return EXIT.OK;
  }
  const lines = table([
    ["ID", "NAME", "SWITCH", "STATE", "LAST RUN", "LAST ERROR"],
    ...rows.map((r) => [r.id, r.name, r.on ? "on" : "off", r.state, r.lastRunAt ?? "-", r.error ?? "-"]),
  ]);
  for (const line of lines) deps.io.out(line);
  if (!bridge) deps.io.out("(the bridge did not answer: state and last run are from the files only)");
  return EXIT.OK;
}

// ── on / off ─────────────────────────────────────────────────────────────────

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
  if (on) {
    if (deps.files.entryType(dir) !== "directory") {
      deps.io.err(`error: there is no trick folder ${dir}. Make one: collie trick init ${id}`);
      return EXIT.FAIL;
    }
    const read = readManifestText(deps.files.read(join(dir, MANIFEST_FILE)), id);
    if (read.manifest === undefined) {
      for (const r of read.refusals) deps.io.err(`error: ${MANIFEST_FILE}${r.path} ${r.reason}`);
      deps.io.err(`error: ${id} stays off until its manifest is fixed. Check it: collie trick check ${dir}`);
      return EXIT.FAIL;
    }
  }
  if (switches.on.has(id) === on) {
    deps.io.out(`${id} is already ${verb}.`);
    return EXIT.OK;
  }
  await writeSwitches(deps.ctx.stateDir, withSwitch(switches, id, on, new Date(deps.now()).toISOString()));
  deps.io.out(
    on
      ? `${id} is on. The bridge picks it up within seconds; its timer runs while a phone watches.`
      : `${id} is off. The bridge stops running it and its parts go from the phone.`,
  );
  return EXIT.OK;
}

// ── check ────────────────────────────────────────────────────────────────────

/** One command-looking line of the provider's source. */
export interface RunsLine {
  file: string;
  line: number;
  text: string;
}

/** What `check` found. `--json` prints this object. */
export interface TrickCheckReport {
  folder: string;
  id: string;
  manifest?: TrickManifest;
  /** The manifest's refusals, "later" ones included. */
  refusals: Refusal[];
  /** Problems that are not a refusal of a field: a missing or binary provider. */
  problems: string[];
  /** The provider files the `run` line names, inside the folder. */
  files: string[];
  runs: RunsLine[];
  run?: {
    outcome: RunOutcome["kind"];
    ms: number;
    problem: string | null;
    parts: string[];
    refusals: Refusal[];
    stderr: string;
  };
}

/**
 * A line that runs or reaches something: a tool a provider would call, a subshell, a spawn, a fetch.
 * A grep, honest but not a proof: a provider can build a command out of pieces no pattern sees.
 */
const COMMAND_LINE =
  /\b(?:curl|wget|gh|git|darius|collie|bunx?|node|npx|npm|pnpm|yarn|deno|python3?|pip3?|ruby|perl|ssh|scp|rsync|rm|mv|cp|chmod|chown|sudo|doas|docker|podman|systemctl|kill|pkill|eval|exec|nc|tailscale|herdr|tmux|zellij|make|jq)\b|\$\(|`|Bun\.spawn|Bun\.\$|child_process|\bspawn(?:Sync)?\(|\bexec(?:Sync|File)?\(|\bfetch\(/;
/** The most "runs:" lines printed. */
const RUNS_MAX = 40;
const RUNS_TEXT_MAX = 160;
/** The bytes of a provider file read for the grep and the binary test. */
const SOURCE_READ_MAX = 256 * 1024;

/** The files inside `folder` that the `run` line names, by its whitespace-split words. */
/** The provider files a `run` line names, and the `./` words that name nothing. */
export interface ProviderFiles {
  files: string[];
  missing: string[];
}

export function providerFiles(run: string, folder: string, files: Pick<Files, "entryType">): ProviderFiles {
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

/** Whether a file's head looks like a compiled program rather than source. */
export function looksBinary(text: string): boolean {
  return text.slice(0, 8192).includes("\u0000") || /^(?:\u007fELF|MZ|Ïúíþ|Êþº¾)/.test(text);
}

/** The command-looking lines of the provider's source files. */
export function runsLines(sources: readonly { file: string; text: string }[]): RunsLine[] {
  const out: RunsLine[] = [];
  for (const { file, text } of sources) {
    const lines = text.slice(0, SOURCE_READ_MAX).split(/\r?\n/);
    lines.forEach((raw, i) => {
      const t = raw.trim();
      if (t === "" || t.startsWith("#") || t.startsWith("//") || t.startsWith("*")) return;
      if (!COMMAND_LINE.test(t)) return;
      out.push({ file: basename(file), line: i + 1, text: t.length > RUNS_TEXT_MAX ? `${t.slice(0, RUNS_TEXT_MAX - 1)}…` : t });
    });
  }
  return out;
}

/** The static half of `check`. Reads only. */
export function checkStatic(folder: string, files: Pick<Files, "read" | "entryType">): TrickCheckReport {
  const id = basename(folder);
  const read = readManifestText(files.read(join(folder, MANIFEST_FILE)), id);
  const report: TrickCheckReport = { folder, id, refusals: read.refusals, problems: [], files: [], runs: [] };
  if (read.manifest === undefined) return report;
  report.manifest = read.manifest;
  const named = providerFiles(read.manifest.run, folder, files);
  report.files = named.files;
  for (const word of named.missing) report.problems.push(`The run line names ${word}, which is not in the folder.`);
  const sources: { file: string; text: string }[] = [];
  for (const file of named.files) {
    const text = files.read(file);
    if (text === null) {
      report.problems.push(`${basename(file)} cannot be read.`);
      continue;
    }
    if (looksBinary(text)) {
      report.problems.push(`${basename(file)} is a compiled program. A trick's provider is source a person can read.`);
      continue;
    }
    sources.push({ file, text });
  }
  // A run line that names no file of the folder IS the command (`run = "darius due --json"`): list it.
  const runLine = named.files.length === 0 ? [{ file: MANIFEST_FILE, text: `run = ${read.manifest.run}` }] : [];
  report.runs = runsLines([...sources, ...runLine]).slice(0, RUNS_MAX);
  return report;
}

/** Fixture facts for a `--run`: the schema's timer facts, with this folder and a scratch state folder. */
export function checkFacts(manifest: TrickManifest, folder: string, state: string): TrickFacts {
  const parsed = parseFacts(FACTS.timer);
  if (parsed.facts === undefined) throw new Error("the fixture facts do not parse");
  return { ...parsed.facts, trick: { id: manifest.id, dir: folder, state } };
}

/** Run the provider once against fixture facts and parse its output, as the bridge would. */
export async function checkRun(report: TrickCheckReport, env: CliContext["env"]): Promise<void> {
  const manifest = report.manifest;
  if (manifest === undefined) return;
  // A scratch state folder, so a check never writes the bridge's own state.
  const state = await mkdtemp(join(tmpdir(), `collie-trick-check-${manifest.id}-`));
  try {
    const outcome = await runProvider({
      command: manifest.run,
      cwd: report.folder,
      env: scrubEnv(env, manifest.env ?? []),
      stdin: JSON.stringify(checkFacts(manifest, report.folder, state)),
    });
    const problem = outcomeProblem(outcome, 400);
    const stderr = outcome.kind === "spawn-failed" ? "" : outcome.stderr;
    const run: NonNullable<TrickCheckReport["run"]> = { outcome: outcome.kind, ms: outcome.ms, problem, parts: [], refusals: [], stderr };
    if (problem === null && outcome.kind === "exited") {
      const parsed = parseTrickDocumentText(outcome.stdout, { declared: manifest.places });
      run.parts = parsed.parts.map((p) => `${p.part.at} ${p.part.id}`);
      run.refusals = parsed.refusals;
    }
    report.run = run;
  } finally {
    await rm(state, { recursive: true, force: true });
  }
}

/** Whether a report fails: a refusal that is not "later", a problem, or a run that failed or was refused. */
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
  if (report.runs.length > 0) {
    io.out("  runs:");
    for (const r of report.runs) io.out(`    ${r.file}:${r.line}  ${r.text}`);
  }
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
  const report = checkStatic(folder, deps.files);
  if (run && report.manifest !== undefined && report.problems.length === 0) await checkRun(report, deps.ctx.env);
  if (json) deps.io.out(JSON.stringify(report, null, 2));
  else printReport(deps, report);
  return reportFails(report) ? EXIT.FAIL : EXIT.OK;
}

// ── init ─────────────────────────────────────────────────────────────────────

/** The sample manifest `init` writes. */
export function sampleManifest(id: string): string {
  return [
    `# Collie trick "${id}". Check it with: collie trick check --run <this folder>`,
    `id = "${id}"`,
    `name = "${id}"`,
    `run = "./provider.sh"`,
    `every = "30s"`,
    `icon = "plug"`,
    `places = ["belt"]`,
    "",
  ].join("\n");
}

/** The sample provider: it counts the sessions in the facts and prints one belt mark. */
export const SAMPLE_PROVIDER = `#!/bin/sh
# A Collie trick provider. Collie runs it with the facts on stdin (one JSON document) and reads one JSON
# document from stdout. This one counts the sessions and prints one mark in the belt's end block.
facts=$(cat)
n=$(printf '%s' "$facts" | grep -o '"paneId"' | wc -l | tr -d ' ')
printf '{"v":1,"parts":[{"at":"belt","id":"belt","mark":{"icon":"plug","label":"%s","tone":"plain"}}]}\\n' "$n"
`;

/** The `AGENTS.md` `init` writes: the contract, in prose, for the agent that grows the trick. */
export function sampleAgents(id: string): string {
  return `# The Collie trick "${id}"

This folder is a Collie trick. Collie's bridge runs the provider named by \`run\` in \`trick.toml\` and
draws what it prints on the phone, with Collie's own parts in the current theme.

## The loop

1. Change \`provider.sh\` (or point \`run\` at another program in this folder).
2. Run \`collie trick check --run .\` and fix every error it prints.
3. Switch the trick on with \`collie trick on ${id}\`. It runs while a phone watches.

## What the provider gets

- Its working folder is this folder.
- On stdin, one JSON document, the facts: \`v\` (1), \`trigger\` (\`start\`, \`timer\`, or \`tap\` with
  \`rid\`, \`node\` (the part id, or \`hill/<key>\` for a decision), \`intent\`, \`value\` and \`from\`),
  \`trick\` (\`id\`, \`dir\`, and \`state\`, a folder of its own to keep files in), \`host\`, \`sessions\`
  (each with \`id\` as \`host:paneId\`, \`memberId\`, \`sessionId\` (opaque, never parse it), \`paneId\`,
  \`host\` (a name to show), \`name\`, \`agent\`, \`status\`, \`cwd\`, \`space\`, \`tab\`, \`lastActiveAt\`)
  and \`spaces\` (\`name\`, \`folder\`).
- A short list of the Collie service's environment: \`PATH\`, \`HOME\`, \`USER\`, \`LOGNAME\`,
  \`SHELL\`, \`LANG\`, \`LC_*\`, \`TZ\`, \`TERM\`, \`TMPDIR\`, the \`XDG_*_HOME\` folders,
  \`XDG_RUNTIME_DIR\`, \`NVM_DIR\` and \`BUN_INSTALL\`. Any other variable the program needs, list
  in \`trick.toml\`: \`env = ["GH_TOKEN"]\`. \`collie trick check\` and the phone show each name you
  list. A \`COLLIE_*\`, \`HERDR_*\`, \`*_SOCK\` or \`*_SOCKET\` variable is never passed, even when
  listed.

## What it prints

One JSON document on stdout, at most 64 KiB, within 10 seconds:

\`\`\`json
{ "v": 1, "parts": [ { "at": "belt", "id": "belt", "mark": { "icon": "plug", "label": "3", "tone": "ok" } } ] }
\`\`\`

- Each part has an \`at\` (a place listed in \`places\` in \`trick.toml\`) and an \`id\` unique in the
  document. A part that does not parse is refused alone; the others still draw.
- Optional: \`asOf\` (an ISO 8601 instant) and \`fresh\` (such as \`"90s"\`): past that window the phone
  shows the part's age and drops its tone.
- A part's \`view\` is a list of nodes \`{ kind, text, attrs, kids }\`, the Tree UI's kinds (\`card\`,
  \`group\`, \`list\`, \`row\`, \`bar\`, \`chip\`, \`button\`, \`para\`, \`line\`, \`run\`, \`code\`, \`link\`,
  \`image\`, \`meter\`, \`spacer\`) and \`number\`. Every attribute value is a string.
- Optional: \`decisions\`, up to 20 questions for the person (\`key\`, \`title\`, \`summary\`, \`options\`,
  \`recommends\`). The answer comes back as a tap on \`hill/<key>\`.
- Unknown keys are refused, and a string over its cap is refused, never cut.

## Limits

One run at a time, 10 seconds, 64 KiB of stdout. After a failed run the trick waits 1, 5 and 30
minutes, then stops until this folder changes or a tap restarts it. Everything printed, stderr too,
goes through Collie's secret mask.
`;
}

export async function cmdTrickInit(deps: TrickDeps, args: readonly string[]): Promise<number> {
  const id = args.find((a) => !a.startsWith("-"));
  if (id === undefined || !isTrickId(id)) {
    deps.io.err("usage: collie trick init <id>   (an id is 1 to 32 of a-z, 0-9 and -)");
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
  await writeFile(join(dir, MANIFEST_FILE), sampleManifest(id));
  await writeFile(join(dir, "provider.sh"), SAMPLE_PROVIDER, { mode: 0o755 });
  await writeFile(join(dir, "AGENTS.md"), sampleAgents(id));
  deps.io.out(`Made ${dir} with trick.toml, provider.sh and AGENTS.md. The trick is off.`);
  deps.io.out(`Check it: collie trick check --run ${dir}`);
  deps.io.out(`Switch it on: collie trick on ${id}`);
  return EXIT.OK;
}

// ── the bare verb ────────────────────────────────────────────────────────────

export function cmdTrick(deps: Pick<TrickDeps, "io">, args: readonly string[]): number {
  const sub = args[0];
  if (sub !== undefined) deps.io.err(`error: unknown trick subcommand "${sub}"`);
  deps.io.err(`usage: collie trick <${TRICK_SUBCOMMANDS.join("|")}> ...`);
  return EXIT.USAGE;
}
