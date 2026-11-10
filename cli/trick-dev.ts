import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { skippedName } from "../bridge/tricks/code-hash.ts";
import { tricksConfigDir } from "../bridge/tricks/paths.ts";
import { RUN_TIMEOUT_MS, STDOUT_CAP_BYTES } from "../bridge/tricks/run.ts";
import { parseJson } from "../web/src/lib/json.ts";
import { HILL_NODE_PREFIX, isRequestId, isTrickId, parseFacts, type FactsTrigger, type ParsedPart, type Refusal, type TrickDecision, type TrickFacts, type View, type ViewNode } from "../web/src/lib/tricks/schema.ts";
import { hillWordingWarnings } from "./hill-rules.ts";
import { EXIT } from "./io.ts";
import { checkStatic, decisionWording, runAgainstFixture, type FixtureOptions, type FixtureRun, type TrickDeps } from "./trick.ts";

// `collie trick dev <folder|id>` (M94 review 4): `check --run` made friendly. It runs the program once
// against the same fixture facts `check --run` uses, through the same run path (`runAgainstFixture`:
// the scrub, the launch rule, the caps, the one parser), and prints what the phone would get as a
// short summary: each part with its place, id and shape, each Decision, every refusal with its path,
// and the run's time and stdout size against the caps. `--tap <intent>` runs it as a tap instead
// (`--rid <uuid>` fixes the tap's request id), `--facts <file.json>` hands it your own facts in place of
// the fixture's, `--state <dir>` keeps the state folder between runs, `--json` prints the parsed
// result, and `--watch` runs it again on each change in the folder.
//
// It never talks to the bridge and never posts: nothing it prints reaches a phone or the hill.

/** How long the folder must be still before `--watch` runs again. */
export const WATCH_DEBOUNCE_MS = 300;

/** What `--tap` asks for. */
export interface DevTap {
  intent: string;
  text: string | null;
  node: string;
}

/** The flags of `trick dev`, or the usage line's reason. */
export interface DevArgs {
  target: string;
  tap: DevTap | null;
  json: boolean;
  watch: boolean;
  /** The path after `--facts`, as typed. Reading it is `cmdTrickDev`'s job. */
  facts: string | null;
  /** The path after `--state`, as typed. */
  state: string | null;
  /** The request id after `--rid`, a UUID. */
  rid: string | null;
}

const DEV_USAGE = "usage: collie trick dev <folder|id> [--tap <intent> [--text <words>] [--node <node>] [--rid <uuid>]] [--facts <file.json>] [--state <dir>] [--json] [--watch]";

export function parseDevArgs(args: readonly string[]): DevArgs | { error: string } {
  let target: string | undefined;
  let intent: string | undefined;
  let text: string | null = null;
  let node: string | undefined;
  let json = false;
  let watching = false;
  let facts: string | null = null;
  let state: string | null = null;
  let rid: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--json") json = true;
    else if (arg === "--watch") watching = true;
    else if (arg === "--tap" || arg === "--text" || arg === "--node" || arg === "--facts" || arg === "--state" || arg === "--rid") {
      const value = args[i + 1];
      if (value === undefined) return { error: `${arg} needs a value` };
      i += 1;
      if (arg === "--tap") intent = value;
      else if (arg === "--text") text = value;
      else if (arg === "--node") node = value;
      else if (arg === "--facts") facts = value;
      else if (arg === "--state") state = value;
      else rid = value;
    } else if (arg.startsWith("-")) return { error: `unknown flag ${arg}` };
    else if (target === undefined) target = arg;
    else return { error: `one folder or id, not "${arg}" too` };
  }
  if (target === undefined) return { error: "name a trick folder or id" };
  if (intent === undefined && (text !== null || node !== undefined)) return { error: "--text and --node go with --tap" };
  if (intent === undefined && rid !== null) return { error: "--rid goes with --tap" };
  if (rid !== null && !isRequestId(rid)) return { error: `--rid must be a UUID, not "${rid}"` };
  return { target, tap: intent === undefined ? null : { intent, text, node: node ?? "main" }, json, watch: watching, facts, state, rid };
}

/** The tap trigger `--tap` sends: a hill node carries `{ text }`, any other node the text as its value. `rid` is a fresh UUID unless `--rid` gave one. */
export function devTrigger(tap: DevTap, rid: string = randomUUID()): FactsTrigger {
  const trigger: FactsTrigger = { kind: "tap", rid, node: tap.node, intent: tap.intent };
  if (tap.node.startsWith(HILL_NODE_PREFIX)) trigger.value = { text: tap.text };
  else if (tap.text !== null) trigger.value = tap.text;
  return trigger;
}

/** Every node of a view, kids included. */
function countNodes(view: readonly ViewNode[]): number {
  return view.reduce((sum, node) => sum + 1 + ("kids" in node && node.kids !== undefined ? countNodes(node.kids) : 0), 0);
}

/** A view as words: its node count and its top-level kinds. */
function viewWords(view: View): string {
  const kinds = [...new Set(view.map((node) => node.kind))].join(", ");
  return `${String(countNodes(view))} nodes (${kinds})`;
}

function quoted(text: string): string {
  return JSON.stringify(text);
}

/** One part's shape on one line: what the phone draws from it. */
export function partSummary(parsed: ParsedPart): string {
  const words: string[] = [];
  const add = (label: string, value: string | number | undefined) => {
    if (value !== undefined) words.push(label === "" ? String(value) : `${label} ${String(value)}`);
  };
  switch (parsed.place) {
    case "belt": {
      const { mark } = parsed.part;
      add("", mark.label === undefined ? undefined : quoted(mark.label));
      add("icon", mark.icon);
      add("badge", mark.badge);
      add("tone", mark.tone);
      add("intent", mark.intent);
      break;
    }
    case "status":
      add("", quoted(parsed.part.chip.text));
      add("icon", parsed.part.chip.icon);
      add("tone", parsed.part.chip.tone);
      break;
    case "dashboard":
    case "tabbar":
      add("", quoted(parsed.part.item.label));
      add("badge", parsed.part.item.badge);
      add("tone", parsed.part.item.tone);
      break;
    case "session": {
      const part = parsed.part;
      add("", part.name === undefined ? "(the manifest's name)" : quoted(part.name));
      add("subtitle", part.subtitle === undefined ? undefined : quoted(part.subtitle));
      if (part.badge !== undefined) add("badge", "count" in part.badge ? part.badge.count : part.badge.text);
      if (part.actions !== undefined) add("actions", part.actions.map((a) => a.intent).join(", "));
      add("view", viewWords(part.view));
      break;
    }
  }
  return words.join("  ");
}

/** One Decision on one line: its key, title, options, and what it carries. */
export function decisionLine(decision: TrickDecision): string {
  const words = [decision.key, quoted(decision.title)];
  const options = decision.options ?? [];
  words.push(options.length === 0 ? "no options (words only)" : `options ${options.map((o) => o.intent).join(", ")}`);
  if (decision.recommends !== undefined && decision.recommends !== null) words.push(`recommends ${decision.recommends.intent}`);
  if (decision.priority !== undefined) words.push(decision.priority);
  if ((decision.media ?? []).length > 0) words.push(`images ${String(decision.media?.length ?? 0)}`);
  return words.join("  ");
}

function kib(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  ").trimEnd());
}

/** The summary `trick dev` prints for one run. */
export function devSummary(ran: FixtureRun, refusals: readonly Refusal[]): string[] {
  const out: string[] = [];
  const parsed = ran.parsed;
  if (parsed !== null) {
    const rows = parsed.parts.map((p) => [p.place, p.part.id, partSummary(p)]);
    if (rows.length > 0) out.push(...table(rows).map((line) => `  ${line}`));
    else out.push("  no parts");
    if (!ran.decisionsListed) out.push("  decisions: none listed, so the open ones stay as they are");
    else if (parsed.decisions.length === 0) out.push("  decisions: none, so the open ones are withdrawn");
    for (const decision of parsed.decisions) {
      out.push(`  decision  ${decisionLine(decision)}`);
      // Soft: the words are the author's (HILL_WRITING); said under the line, never a refusal.
      for (const warning of hillWordingWarnings(decision)) out.push(`    warn  ${warning}`);
    }
  }
  for (const refusal of refusals) out.push(`  refused  ${refusal.path === "" ? "(the document)" : refusal.path}  ${refusal.reason}`);
  // What the tolerant read left out or ignored: never a failure, said so the author sees a typo.
  for (const note of parsed?.notes ?? []) out.push(`  ${note.code}  ${note.path === "" ? "(the document)" : note.path}  ${note.reason}`);
  const exit = ran.outcome.kind === "exited" ? `exit ${String(ran.outcome.code)}` : ran.outcome.kind;
  out.push(`  ran in ${String(ran.outcome.ms)} ms of ${String(RUN_TIMEOUT_MS / 1000)} s, ${exit}, stdout ${kib(ran.stdoutBytes)} of ${kib(STDOUT_CAP_BYTES)}`);
  if (ran.problem !== null) out.push(`  problem: ${ran.problem}`);
  const stderr = ran.outcome.kind === "spawn-failed" ? "" : ran.outcome.stderr.trimEnd();
  if (ran.problem !== null && stderr !== "") for (const line of stderr.split(/\r?\n/).slice(-10)) out.push(`  stderr: ${line}`);
  return out;
}

/** Whether a change at `rel` (relative to the trick folder) is one `--watch` runs again for: the code hash's own rule, `config.toml` included. */
export function watchCounts(rel: string): boolean {
  const parts = rel.split(sep).filter((p) => p !== "");
  if (parts.length === 0) return false;
  if (parts.length === 1 && parts[0] === "config.toml") return true;
  return !parts.some((name, depth) => skippedName(name, depth === parts.length - 1 ? "file" : "dir", depth));
}

/** Watch a folder: `onChange` once the folder has been still for `debounceMs` after a change that counts. Returns the stop. */
export function watchFolder(folder: string, onChange: () => void, debounceMs = WATCH_DEBOUNCE_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(folder, { recursive: true }, (_event, name) => {
    if (name !== null && !watchCounts(relative(folder, join(folder, name)))) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

/** What the flags that touch the run's inputs resolved to, once, before the first run. */
interface DevInputs {
  /** The facts of `--facts`, parsed, and the path as typed (for the words that name it). */
  facts?: { file: string; value: TrickFacts };
  /** The absolute state folder of `--state`. */
  state?: string;
}

/** Read and parse a `--facts` file: the facts, or one line per problem, each naming the file and the path. */
export function loadFactsFile(deps: Pick<TrickDeps, "files">, file: string): { facts: TrickFacts } | { errors: string[] } {
  const text = deps.files.read(resolve(file));
  if (text === null) return { errors: [`--facts ${file}: cannot read the file`] };
  const json = parseJson(text);
  if (json === undefined) return { errors: [`--facts ${file}: not JSON`] };
  const parsed = parseFacts(json);
  if (parsed.facts === undefined || parsed.refusals.length > 0) {
    const errors = parsed.refusals.map((r) => `--facts ${file}: ${r.path === "" ? "(the document)" : r.path}: ${r.reason}`);
    return { errors: errors.length > 0 ? errors : [`--facts ${file}: the facts do not parse`] };
  }
  return { facts: parsed.facts };
}

/** One dev run: the static check, then the run, printed. True when nothing was refused and the run went well. */
async function devOnce(deps: TrickDeps, folder: string, args: DevArgs, inputs: DevInputs): Promise<boolean> {
  const report = await checkStatic(folder, deps.files);
  const manifest = report.manifest;
  const blocking = report.refusals.filter((r) => r.code !== "later");
  if (manifest === undefined || blocking.length > 0 || report.problems.length > 0) {
    if (args.json) deps.io.out(JSON.stringify({ folder, refusals: report.refusals, problems: report.problems }, null, 2));
    else {
      deps.io.out(`trick ${report.id} in ${folder}: not run`);
      for (const r of report.refusals) deps.io.out(`  refused  trick.toml${r.path === "" ? "" : ` ${r.path}`}  ${r.reason}`);
      for (const p of report.problems) deps.io.out(`  problem: ${p}`);
    }
    return false;
  }
  const opts: FixtureOptions = {};
  if (args.tap !== null) opts.trigger = devTrigger(args.tap, args.rid ?? undefined);
  if (inputs.facts !== undefined) opts.facts = inputs.facts.value;
  if (inputs.state !== undefined) opts.state = inputs.state;
  const ran = await runAgainstFixture(manifest, folder, deps.ctx.env, opts);
  const refusals = ran.parsed?.refusals ?? [];
  if (args.json) {
    const stderr = ran.outcome.kind === "spawn-failed" ? "" : ran.outcome.stderr;
    const parsed = ran.parsed;
    const kind = args.tap === null ? (inputs.facts?.value.trigger.kind ?? "timer") : "tap";
    const body = { folder, trigger: kind, outcome: ran.outcome.kind, ms: ran.outcome.ms, stdoutBytes: ran.stdoutBytes, problem: ran.problem, stderr, decisionsListed: ran.decisionsListed, parts: parsed?.parts ?? [], decisions: parsed?.decisions ?? [], refusals, notes: parsed?.notes ?? [], wording: decisionWording(parsed?.decisions ?? []) };
    deps.io.out(JSON.stringify(inputs.state === undefined ? body : { ...body, state: inputs.state }, null, 2));
  } else {
    const source = inputs.facts === undefined ? "fixture facts" : `facts from ${inputs.facts.file}`;
    const trigger = args.tap === null ? inputs.facts?.value.trigger : undefined;
    const what =
      args.tap !== null
        ? `a tap: ${args.tap.intent} on ${args.tap.node}`
        : trigger?.kind === "tap"
          ? `a tap: ${trigger.intent} on ${trigger.node}`
          : `a ${trigger?.kind ?? "timer"} run`;
    deps.io.out(`trick ${manifest.id} (${manifest.name}) in ${folder}, ${source}, ${what}`);
    if (inputs.state !== undefined) deps.io.out(`  state kept in ${inputs.state}`);
    for (const line of devSummary(ran, refusals)) deps.io.out(line);
  }
  return ran.problem === null && refusals.length === 0;
}

/** `collie trick dev <folder|id>`: run the trick once (or on each change) and say what the phone would get. */
export async function cmdTrickDev(deps: TrickDeps, args: readonly string[], until?: Promise<void>): Promise<number> {
  const parsed = parseDevArgs(args);
  if ("error" in parsed) {
    deps.io.err(`error: ${parsed.error}`);
    deps.io.err(DEV_USAGE);
    return EXIT.USAGE;
  }
  const byId = isTrickId(parsed.target) && deps.files.entryType(parsed.target) !== "directory";
  const folder = byId ? join(tricksConfigDir(deps.ctx.configDir), parsed.target) : resolve(parsed.target);
  if (deps.files.entryType(folder) !== "directory") {
    deps.io.err(`error: ${parsed.target} is not a trick folder.`);
    return EXIT.USAGE;
  }
  const inputs: DevInputs = {};
  if (parsed.facts !== null) {
    const loaded = loadFactsFile(deps, parsed.facts);
    if ("errors" in loaded) {
      for (const line of loaded.errors) deps.io.err(`error: ${line}`);
      return EXIT.USAGE;
    }
    inputs.facts = { file: parsed.facts, value: loaded.facts };
  }
  if (parsed.state !== null) inputs.state = resolve(parsed.state);
  const ok = await devOnce(deps, folder, parsed, inputs);
  if (!parsed.watch) return ok ? EXIT.OK : EXIT.FAIL;
  deps.io.out(`watching ${folder}; Ctrl-C stops`);
  // One run at a time: a change while one runs queues the next behind it.
  let running: Promise<boolean> = Promise.resolve(ok);
  const again = async (): Promise<boolean> => {
    deps.io.out("");
    return await devOnce(deps, folder, parsed, inputs);
  };
  const stop = watchFolder(folder, () => {
    running = running.then(again);
  });
  await (until ?? new Promise<void>((done) => process.once("SIGINT", () => done())));
  stop();
  await running;
  return EXIT.OK;
}
