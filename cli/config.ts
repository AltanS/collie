import { dirname } from "node:path";

import {
  CONFIG_SECTIONS,
  CONFIG_SETTINGS,
  SECTION_DOC,
  type ConfigSetting,
} from "../bridge/config-schema.ts";
import {
  configFilePaths,
  readConfigFilesSync,
  sourceOf,
  type ConfigFileLayer,
  type ConfigFileReader,
  type ConfigFilePath,
  type ConfigSource,
} from "../bridge/config-source.ts";
import type { CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import type { Files } from "./sys.ts";

// `config show | check | init` — the operator's half of the config file (ADR 0040).
//
// ── WHAT THESE THREE VERBS ARE FOR ───────────────────────────────────────────
// Collie has sixty settings and, until now, one hand-written listing of them (`.env.example`). These
// verbs replace guessing with asking:
//
//  - `show`  answers "why is my poll interval still 1500": every setting, its effective value, and
//            WHICH layer won it. The source column is the point of the verb.
//  - `check` answers "will this file do what I think": one line per problem, a non-zero exit.
//  - `init`  answers "what can I even set": a complete, commented file, written from the schema.
//
// ── THE TWO RULES THIS MODULE MUST NOT BREAK ─────────────────────────────────
//  1. **It never re-implements the resolve.** The paths come from `configFilePaths`, the validation
//     from `readConfigFilesSync`, the precedence answer from `sourceOf` — the same functions the
//     bridge runs. A config the CLI calls good can never be one the bridge calls broken.
//  2. **It never prints a secret.** A `secret`-kind value shows as `set` or `unset` and never its
//     bytes, by the rule `cli/context.ts`'s shadow notes already apply.
//
// `init` is the only writer of a config file anywhere in Collie. The bridge only ever reads.

/** The `config` sub-verbs, in the order the usage block prints them. */
export const CONFIG_SUBCOMMANDS = ["show", "check", "init"] as const;

export interface ConfigDeps {
  ctx: CliContext;
  io: Io;
  files: Files;
}

export function configDeps(ctx: CliContext, io: Io, files: Files): ConfigDeps {
  return { ctx, io, files };
}

/** {@link ConfigFileReader} over the CLI's own `Files` seam, so a test needs no real file. */
function reader(files: Files): ConfigFileReader {
  return {
    read(path) {
      if (!files.exists(path)) return { text: null, error: null };
      const text = files.read(path);
      return text === null ? { text: null, error: "could not be opened" } : { text, error: null };
    },
  };
}

/** The two files this process would read, as `show`, `check` and `init` all need them. */
function paths(deps: ConfigDeps): readonly ConfigFilePath[] {
  return configFilePaths(deps.ctx.env, deps.ctx.home, deps.ctx.configDir);
}

// ── show ─────────────────────────────────────────────────────────────────────

/** The sources `--source` accepts, which are exactly the ones a line can print. */
const SOURCES: readonly ConfigSource[] = ["default", "file:home", "file:instance", "file:blocked", "env"];

/**
 * The value to print for a setting: the effective one, or the schema's default when nothing set it.
 *
 * A `secret` never prints its bytes. `set`/`unset` is the whole of what an operator needs here —
 * whether the credential reached the process — and it is what the shadow-note rule already does for
 * a name shaped like a credential.
 */
function shownValue(setting: ConfigSetting, deps: ConfigDeps): string {
  const raw = deps.ctx.env[setting.env] ?? (setting.alias === undefined ? undefined : deps.ctx.env[setting.alias]);
  if (setting.kind === "secret") return raw === undefined || raw === "" ? "unset" : "set";
  if (raw !== undefined && raw !== "") return raw;
  return renderDefault(setting);
}

/** The schema's default as a line of output: an empty one reads `(unset)` rather than as nothing. */
function renderDefault(setting: ConfigSetting): string {
  switch (setting.kind) {
    case "int":
      return setting.default === 0 ? "(unset)" : String(setting.default);
    case "bool":
      return String(setting.default);
    case "list":
    case "roots":
      return setting.default.length === 0 ? "(unset)" : setting.default.join(",");
    case "enum":
    case "string":
    case "secret":
      return setting.default === "" ? "(unset)" : setting.default;
  }
}

/** One JSON-shaped row per setting, for `--json`. */
interface ShownSetting {
  readonly section: string;
  readonly key: string;
  readonly env: string;
  readonly value: string;
  readonly source: ConfigSource;
}

export function cmdConfigShow(deps: ConfigDeps, args: readonly string[]): number {
  const flags = parseFlags(args, ["json"], ["source"]);
  if (flags.error !== null) {
    deps.io.err(`error: ${flags.error}`);
    return EXIT.USAGE;
  }
  const asked = flags.values.source;
  const wanted = asked === undefined ? undefined : SOURCES.find((s) => s === asked);
  if (asked !== undefined && wanted === undefined) {
    deps.io.err(`error: --source must be one of ${SOURCES.join(", ")}`);
    return EXIT.USAGE;
  }
  const layer = deps.ctx.configLayer;
  const rows: ShownSetting[] = CONFIG_SETTINGS.map((setting) => ({
    section: setting.section,
    key: setting.key,
    env: setting.env,
    value: shownValue(setting, deps),
    source: sourceOf(setting, deps.ctx.env, layer),
  })).filter((row) => wanted === undefined || row.source === wanted);

  if (flags.bare.json) {
    deps.io.out(
      JSON.stringify(
        { files: layer.files, problems: layer.problems, blocked: layer.blocked, settings: rows },
        null,
        2,
      ),
    );
    return EXIT.OK;
  }

  for (const file of layer.files) {
    deps.io.out(`${file.layer === "home" ? "machine " : "instance"}  ${file.path}  (${file.present ? "present" : "absent"})`);
  }
  deps.io.out("");
  // The widest key, so the source column lines up and the file can be read down rather than across.
  const width = Math.max(...rows.map((r) => r.key.length), 1);
  for (const section of CONFIG_SECTIONS) {
    const inSection = rows.filter((r) => r.section === section);
    if (inSection.length === 0) continue;
    deps.io.out(`[${section}]`);
    for (const row of inSection) {
      deps.io.out(`  ${row.key.padEnd(width)}  ${row.value}  [${row.source}]`);
    }
    deps.io.out("");
  }
  if (layer.problems.length > 0) {
    deps.io.err(`warn: ${String(layer.problems.length)} problem(s) in your config file; run \`collie config check\`.`);
  }
  return EXIT.OK;
}

// ── check ────────────────────────────────────────────────────────────────────

export function cmdConfigCheck(deps: ConfigDeps, args: readonly string[]): number {
  const named = args.find((a) => !a.startsWith("-"));
  // A named path is checked ALONE, which is how a file is checked before it is moved into place. The
  // layer it is read as does not matter to validation, and `instance` is the one it will become.
  const entries: readonly ConfigFilePath[] =
    named === undefined ? paths(deps) : [{ path: named, layer: "instance" }];
  if (named !== undefined && !deps.files.exists(named)) {
    deps.io.err(`error: ${named} does not exist.`);
    return EXIT.FAIL;
  }
  // Warnings are swallowed here: this verb's whole output IS the problem list, printed in full
  // rather than summarised as a count.
  const layer = readConfigFilesSync(reader(deps.files), entries, () => {}, { home: deps.ctx.home });
  for (const file of layer.files) {
    deps.io.out(`${file.path}: ${file.present ? "checked" : "absent"}`);
  }
  if (layer.problems.length === 0) {
    deps.io.out("ok: no problems.");
    return EXIT.OK;
  }
  for (const problem of layer.problems) deps.io.err(`error: ${problem.message}`);
  return EXIT.FAIL;
}

// ── init ─────────────────────────────────────────────────────────────────────

/** A default as the TOML line `init` writes, commented out. */
function tomlDefault(setting: ConfigSetting): string {
  switch (setting.kind) {
    case "int":
      return String(setting.default);
    case "bool":
      return String(setting.default);
    case "list":
    case "roots":
      return `[${setting.default.map((e) => JSON.stringify(e)).join(", ")}]`;
    case "enum":
    case "string":
    case "secret":
      return JSON.stringify(setting.default);
  }
}

/** The bounds or allowed values a row has, as the one extra comment line, or `null`. */
function constraintLine(setting: ConfigSetting): string | null {
  if (setting.kind === "enum") return `# one of: ${setting.values.join(", ")}`;
  if (setting.kind !== "int") return null;
  if (setting.min !== undefined && setting.max !== undefined) return `# ${String(setting.min)} to ${String(setting.max)}`;
  if (setting.min !== undefined) return `# at least ${String(setting.min)}`;
  if (setting.max !== undefined) return `# at most ${String(setting.max)}`;
  return null;
}

/**
 * The file, written from the schema and from nothing else.
 *
 * Every key is commented out, so the file as written changes no behaviour: it is a complete listing
 * first and a configuration second. The `[section]` headers are live, because an empty section is
 * valid TOML and means nothing, and because uncommenting one key should then be the whole edit.
 */
export function generateConfigFile(path: string): string {
  const lines: string[] = [
    `# ${path}`,
    "# the environment and your .env always override this file; run `collie config show` to see what is active",
  ];
  for (const section of CONFIG_SECTIONS) {
    const rows = CONFIG_SETTINGS.filter((s) => s.section === section);
    if (rows.length === 0) continue;
    const title = section.charAt(0).toUpperCase() + section.slice(1);
    lines.push("", `# ── ${title} ${"─".repeat(Math.max(1, 60 - title.length))}`, `# ${SECTION_DOC[section]}`, `[${section}]`);
    for (const setting of rows) {
      lines.push("", `# ${setting.doc}`);
      const constraint = constraintLine(setting);
      if (constraint !== null) lines.push(constraint);
      lines.push(`# env: ${setting.env}`);
      lines.push(`#${setting.key} = ${tomlDefault(setting)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function cmdConfigInit(deps: ConfigDeps, args: readonly string[]): number {
  const flags = parseFlags(args, ["instance", "print"], []);
  if (flags.error !== null) {
    deps.io.err(`error: ${flags.error}`);
    return EXIT.USAGE;
  }
  const resolved = paths(deps);
  const target = (flags.bare.instance ? resolved[1] : resolved[0])!.path;
  const text = generateConfigFile(target);
  if (flags.bare.print) {
    for (const line of text.replace(/\n$/u, "").split("\n")) deps.io.out(line);
    return EXIT.OK;
  }
  if (deps.files.exists(target)) {
    deps.io.err(`error: ${target} already exists — refusing to overwrite it.`);
    deps.io.err("       Compare with `collie config init --print`, or edit the file you have.");
    return EXIT.STATE;
  }
  // 0700 on the directory and 0600 on the file, because a `[push] vapid_private` or a `[stt] stt_key`
  // belongs in here and the permission rule would otherwise drop it on the next read.
  deps.files.mkdirp(dirname(target), 0o700);
  deps.files.write(target, text, 0o600);
  deps.io.out(target);
  return EXIT.OK;
}

// ── The verb itself ──────────────────────────────────────────────────────────

/** A bare or misspelt sub-verb lands here, as it does for `devices` and `stt`. */
export function cmdConfig(deps: ConfigDeps, args: readonly string[]): number {
  const sub = args[0];
  if (sub === "show") return cmdConfigShow(deps, args.slice(1));
  if (sub === "check") return cmdConfigCheck(deps, args.slice(1));
  if (sub === "init") return cmdConfigInit(deps, args.slice(1));
  if (sub !== undefined) deps.io.err(`error: unknown subcommand "${sub}".`);
  deps.io.err("usage: collie config <show|check|init>");
  deps.io.err("  show [--json] [--source default|file:home|file:instance|file:blocked|env]");
  deps.io.err("  check [path]");
  deps.io.err("  init [--instance] [--print]");
  return sub === undefined ? EXIT.USAGE : EXIT.USAGE;
}

// ── Flags ────────────────────────────────────────────────────────────────────

interface ParsedFlags {
  readonly bare: Readonly<Record<string, boolean>>;
  readonly values: Readonly<Record<string, string | undefined>>;
  readonly error: string | null;
}

/**
 * `--name` for a switch and `--name value` / `--name=value` for the rest. Deliberately tiny: this
 * verb has four flags and no positional grammar beyond `check`'s optional path.
 */
function parseFlags(
  args: readonly string[],
  bareNames: readonly string[],
  valueNames: readonly string[],
): ParsedFlags {
  const bare: Record<string, boolean> = {};
  const values: Record<string, string | undefined> = {};
  for (const name of bareNames) bare[name] = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (bareNames.includes(name)) {
      bare[name] = true;
      continue;
    }
    if (!valueNames.includes(name)) return { bare, values, error: `unknown flag --${name}` };
    if (eq >= 0) {
      values[name] = arg.slice(eq + 1);
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      return { bare, values, error: `--${name} needs a value` };
    }
    values[name] = next;
    i += 1;
  }
  return { bare, values, error: null };
}

/** The layer `config show` reports, exported so `cli/doctor.ts` reads the same one. */
export type { ConfigFileLayer };
