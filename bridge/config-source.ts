import { join } from "node:path";

import {
  CONFIG_SETTINGS,
  settingByKey,
  type ConfigSection,
  type ConfigSetting,
  CONFIG_SECTIONS,
} from "./config-schema.ts";
import type { OperatorFileIo } from "./operator-file.ts";

// ── THE CONFIG FILE, TURNED INTO AN ENVIRONMENT ──────────────────────────────
//
// Two files, two layers, and the process environment on top of both (ADR 0040):
//
//   default  <  ~/.collie/config.toml  <  <configDir>/config.toml  <  process env (the `.env` included)
//
// The environment keeps winning because the service manager's `EnvironmentFile=` and the Herdr
// plugin's `.env` are the deployment's own statement — the same argument `bridge/stt/config.ts`
// already makes for `stt.json`. A file cannot take a setting away from an operator who configured
// it the way Collie has always asked them to.
//
// **Nothing here ever throws.** A file that will not parse, a key nobody declared, a value of the
// wrong type: each is a {@link ConfigProblem} carried on the layer, and the affected key alone falls
// back to the env-only view. A Collie that refuses to boot over its own config file is a Collie the
// operator cannot use to fix the file. Because the fallback is the env-only view, a malformed
// network key lands on the loopback default and never on a wider one.
//
// The file is read ONCE, at startup. The operator TOML files beside it (`commands.toml` and its four
// siblings) are re-read live behind an mtime check; this one is not, because it holds the port, the
// bind address and the state dir, and a bridge that re-bound itself mid-flight is a different
// program. `collie restart` is the apply step, exactly as it is for `.env`.

/** A process environment: variable names to values, an unset name reading `undefined`. */
export interface Environment {
  [name: string]: string | undefined;
}

/** Where an effective value came from. A closed set, so `config show` never parses a string. */
export type ConfigSource = "default" | "file:home" | "file:instance" | "file:blocked" | "env";

/** Which of the two files a layer is. */
export type ConfigLayerName = "home" | "instance";

/** One of the two config files, before anything has looked for it. */
export interface ConfigFilePath {
  readonly path: string;
  readonly layer: ConfigLayerName;
}

/** One of the two config files, after the reader has looked. */
export interface ConfigFileStatus extends ConfigFilePath {
  readonly present: boolean;
}

/**
 * One thing wrong with a file. No line number, because `Bun.TOML.parse` reports none — the message
 * names the file, the section and the key instead, which is what an operator greps for.
 */
export interface ConfigProblem {
  readonly file: string;
  /** The `[section]` the problem sits in, or `null` for a problem with the whole file. */
  readonly section: string | null;
  /** The key inside that section, or `null` for a problem with the section or the whole file. */
  readonly key: string | null;
  readonly message: string;
}

export interface ConfigFileLayer {
  /** The settings the files declared, already named and valued as environment variables. */
  readonly env: Environment;
  /** Per environment name, which file won it. Only names present in {@link env} appear. */
  readonly sources: ReadonlyMap<string, ConfigSource>;
  readonly problems: readonly ConfigProblem[];
  readonly files: readonly ConfigFileStatus[];
  /** Secret-kind names dropped because the file holding them could not be made owner-only. */
  readonly blocked: readonly string[];
}

/** The environment name pointing at the base file. It is not a setting; it decides which file is read. */
export const CONFIG_PATH_ENV = "COLLIE_CONFIG";

/** The file's name in both locations. There is deliberately no `config.<instance>.toml`. */
export const CONFIG_FILENAME = "config.toml";

/** The directory Altan asked for: the machine's own statement, one per home. */
export const HOME_CONFIG_DIRNAME = ".collie";

/**
 * The two files that would be read, in precedence order: the machine's base, then the instance's.
 *
 * Pure, with `home` and `configDir` as parameters, for the same reason `resolveStateDir` is pure:
 * the CLI and the bridge must land on one path or `collie config show` would describe a file the
 * service never opened. `COLLIE_CONFIG` replaces the BASE path only — the instance file's home is
 * the config dir and nothing else.
 */
export function configFilePaths(
  env: Environment,
  home: string,
  configDir: string,
): readonly ConfigFilePath[] {
  const named = env[CONFIG_PATH_ENV]?.trim();
  return [
    { path: named !== undefined && named !== "" ? named : join(home, HOME_CONFIG_DIRNAME, CONFIG_FILENAME), layer: "home" },
    { path: join(configDir, CONFIG_FILENAME), layer: "instance" },
  ];
}

// ── The permission rule ──────────────────────────────────────────────────────

/** The modes a file holding a credential may already carry without anyone touching it. */
export const PRIVATE_FILE_MODES: ReadonlySet<number> = new Set([0o600, 0o400]);

/** What the permission rule decided: whether secrets may be believed, and the line to print. */
export interface PrivateFileVerdict {
  /** False only when the file is loose AND the chmod failed. The caller decides what to withhold. */
  readonly ok: boolean;
  readonly warning: string | null;
}

/** The two filesystem facts the permission guard needs, kept behind an interface so it is testable. */
export interface FilePerms {
  /** The file's permission bits (`mode & 0o777`), or `null` when it cannot be stated. */
  mode(path: string): number | null;
  /** Tighten it to `0600`. `false` when the chmod failed — a file owned by someone else. */
  tighten(path: string): boolean;
}

/**
 * Hold a file that may carry a credential to owner-only, tightening it in place when it is not, and
 * say so either way.
 *
 * **Warn, never refuse.** A file this process cannot chmod belongs to another user, and a Collie
 * that would not start because of it is a Collie the operator cannot use to fix it. `ok` is false
 * only when the file is loose AND the chmod failed; the caller decides what to withhold.
 *
 * `cli/context.ts`'s `tightenEnvFile` is this function with the `.env` path passed in — one rule,
 * two files, so `config.toml` can never drift into a looser posture than the `.env` beside it.
 */
export function tightenPrivateFile(path: string, perms: FilePerms): PrivateFileVerdict {
  const mode = perms.mode(path);
  if (mode === null || PRIVATE_FILE_MODES.has(mode)) return { ok: true, warning: null };
  const shown = mode.toString(8).padStart(3, "0");
  if (perms.tighten(path)) {
    return { ok: true, warning: `warn: ${path} was mode ${shown} (expected 600); tightened it to 600.` };
  }
  return {
    ok: false,
    warning: `warn: ${path} is mode ${shown} (expected 600) and could not be tightened; it may be readable by other users.`,
  };
}

// ── Reading ──────────────────────────────────────────────────────────────────

export interface ReadConfigOptions {
  /** The resolving process's home, for the `~/` a hand-written path value starts with. */
  readonly home: string;
  /** Absent means the secret permission rule does not run — which is what a `--print` check wants. */
  readonly perms?: FilePerms;
}

/** One file as it arrived: its text, or the reason there is none. */
export interface ConfigFileRead extends ConfigFilePath {
  /** The file's text, or `null` when it is absent or could not be read. */
  readonly text: string | null;
  /** Why there is no text, when the file exists but would not open. `null` for a plain absence. */
  readonly error: string | null;
}

/** A synchronous file reader, so `cli/context.ts` can resolve the layer without becoming async. */
export interface ConfigFileReader {
  /** The file's text, `null` when absent, or an error to report. */
  read(path: string): { text: string | null; error: string | null };
}

/**
 * Turn two already-read files into a layer: validate them against the schema and map every good key
 * to its environment name. Never throws.
 *
 * The instance file wins KEY BY KEY, not file by file: a key absent from it keeps the home file's
 * value. When both paths resolve to one file it is read once and reported as `file:instance`, which
 * is the quieter answer to an operator who pointed `COLLIE_CONFIG` at their own config dir.
 *
 * Pure and synchronous, so the bridge's async io seam and the CLI's synchronous one share one set of
 * rules. {@link readConfigFiles} and {@link readConfigFilesSync} are the two thin ways in.
 */
export function buildConfigLayer(
  reads: readonly ConfigFileRead[],
  warn: (message: string) => void,
  opts: ReadConfigOptions,
): ConfigFileLayer {
  const env: Environment = {};
  const sources = new Map<string, ConfigSource>();
  const problems: ConfigProblem[] = [];
  const files: ConfigFileStatus[] = [];
  const blocked: string[] = [];
  const seen = new Set<string>();

  for (const entry of reads) {
    const duplicate = seen.has(entry.path);
    seen.add(entry.path);
    const present = entry.text !== null || entry.error !== null;
    files.push({ path: entry.path, layer: entry.layer, present });
    // A collapsed pair is reported once, on the entry that wins, so the header does not print one
    // file twice under two names.
    if (!present || duplicate) continue;
    if (entry.text === null) {
      problems.push(fileProblem(entry.path, `could not be read (${entry.error ?? "unknown"})`));
      continue;
    }

    let doc: TomlValue;
    try {
      // SAFETY: `Bun.TOML.parse` answers with a parsed TOML document, and `collect` is its only
      // reader — every field it names is a {@link TomlValue} there and checked before it is believed,
      // so this assertion claims nothing beyond "a document came back".
      doc = Bun.TOML.parse(entry.text) as TomlValue;
    } catch (err) {
      problems.push(fileProblem(entry.path, `is not valid TOML (${String(err)})`));
      continue;
    }

    // The layer a key read here is attributed to. A file reached twice is the instance's.
    const collapsed = reads.some((p) => p !== entry && p.path === entry.path);
    const source: ConfigSource =
      entry.layer === "instance" || collapsed ? "file:instance" : "file:home";
    const values = collect(doc, entry.path, opts.home, problems);

    // The secret rule runs only when this file actually holds one, so an ordinary config file is
    // never chmodded for settings that are not credentials.
    const holdsSecret = values.some((v) => v.setting.kind === "secret");
    let secretsAllowed = true;
    if (holdsSecret && opts.perms !== undefined) {
      const verdict = tightenPrivateFile(entry.path, opts.perms);
      if (verdict.warning !== null) warn(verdict.warning);
      secretsAllowed = verdict.ok;
    }

    for (const { setting, value } of values) {
      if (setting.kind === "secret" && !secretsAllowed) {
        if (!blocked.includes(setting.env)) blocked.push(setting.env);
        sources.set(setting.env, "file:blocked");
        continue;
      }
      env[setting.env] = value;
      sources.set(setting.env, source);
    }
  }

  if (problems.length > 0) {
    const byFile = new Map<string, number>();
    for (const p of problems) byFile.set(p.file, (byFile.get(p.file) ?? 0) + 1);
    for (const [file, count] of byFile) {
      warn(`[config] ${file}: ${count} problem${count === 1 ? "" : "s"}, run \`collie config check\``);
    }
  }
  if (blocked.length > 0) {
    warn(
      `[config] dropped ${blocked.join(", ")} because the file holding them is not owner-only, ` +
        "run `collie config check`",
    );
  }

  return { env, sources, problems, files, blocked };
}

/** {@link buildConfigLayer} over the bridge's own async io seam. */
export async function readConfigFiles(
  io: OperatorFileIo,
  paths: readonly ConfigFilePath[],
  warn: (message: string) => void,
  opts: ReadConfigOptions,
): Promise<ConfigFileLayer> {
  const reads: ConfigFileRead[] = [];
  for (const entry of paths) {
    const mtime = await io.mtime(entry.path);
    if (mtime === null) {
      reads.push({ ...entry, text: null, error: null });
      continue;
    }
    try {
      reads.push({ ...entry, text: await io.read(entry.path), error: null });
    } catch (err) {
      reads.push({ ...entry, text: null, error: String(err) });
    }
  }
  return buildConfigLayer(reads, warn, opts);
}

/** {@link buildConfigLayer} over a synchronous reader, which is what the CLI's context needs. */
export function readConfigFilesSync(
  reader: ConfigFileReader,
  paths: readonly ConfigFilePath[],
  warn: (message: string) => void,
  opts: ReadConfigOptions,
): ConfigFileLayer {
  return buildConfigLayer(
    paths.map((entry) => ({ ...entry, ...reader.read(entry.path) })),
    warn,
    opts,
  );
}

/**
 * Put the layer's names into a live environment, for the names that environment does not already
 * carry. Returns the names it set.
 *
 * This is how one read of the file reaches the fifteen modules that resolve their own settings from
 * `process.env` — the crew budgets, the standby door, the update lane, speech-to-text. The
 * precedence rule holds by construction: a name already set, to anything non-empty, is left alone,
 * so the process environment still wins. It is applied in ONE place, the bridge's entry point.
 */
export function applyConfigLayer(
  layer: ConfigFileLayer,
  target: Environment = process.env,
): readonly string[] {
  const set: string[] = [];
  for (const [name, value] of Object.entries(layer.env)) {
    if (value === undefined) continue;
    const already = target[name];
    if (already !== undefined && already !== "") continue;
    target[name] = value;
    set.push(name);
  }
  return set;
}

/** An empty layer: no file, no problem. What a verb resolving no config at all carries. */
export function emptyConfigLayer(): ConfigFileLayer {
  return { env: {}, sources: new Map(), problems: [], files: [], blocked: [] };
}

/**
 * The file layer under the process environment. The process env is spread LAST, which is the whole
 * precedence rule in one function.
 *
 * An explicitly-undefined name on the process side is skipped rather than copied: it says nothing,
 * and letting it overwrite a file value would make `{ COLLIE_PORT: undefined }` mean something
 * different from an absent name.
 */
export function overlayConfig(processEnv: Environment, layer: ConfigFileLayer): Environment {
  const out: Environment = { ...layer.env };
  for (const [name, value] of Object.entries(processEnv)) {
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * Where a setting's effective value came from, given the EFFECTIVE environment (the one a verb
 * actually reads, file layer and `.env` already merged in) and the layer that went under it.
 *
 * A name the file set and the effective environment still carries unchanged came from the file. A
 * name carrying anything else came from the environment, which is the only thing that could have
 * replaced it. That is an answer, not a guess: `overlayConfig` is the one merge, and it only ever
 * overwrites.
 */
export function sourceOf(
  setting: ConfigSetting,
  effective: Environment,
  layer: ConfigFileLayer,
): ConfigSource {
  const fromFile = layer.sources.get(setting.env);
  if (fromFile === "file:blocked") return "file:blocked";
  const names = setting.alias === undefined ? [setting.env] : [setting.env, setting.alias];
  for (const name of names) {
    const value = effective[name];
    if (value === undefined || value === "") continue;
    if (fromFile !== undefined && layer.env[setting.env] === value) return fromFile;
    return "env";
  }
  return fromFile ?? "default";
}

// ── Validation ───────────────────────────────────────────────────────────────

interface Resolved {
  readonly setting: ConfigSetting;
  readonly value: string;
}

/**
 * A value as `Bun.TOML.parse` hands it back, before anything is believed about it. Named so the
 * readers below take a domain type rather than `unknown`: this IS the parse boundary, and the domain
 * at a TOML boundary is "some TOML value".
 */
export type TomlValue = string | number | boolean | readonly TomlValue[] | TomlTable | null;

/** A TOML table: keys to values, every value still unchecked. */
export interface TomlTable {
  readonly [key: string]: TomlValue | undefined;
}

/** Why a value cannot be believed. Returned instead of the string a good value converts to. */
interface Refusal {
  readonly why: string;
}

function fileProblem(file: string, message: string): ConfigProblem {
  return { file, section: null, key: null, message: `${file} ${message}` };
}

/** Every declared section name, as a set, so an unknown one is named rather than silently skipped. */
const SECTION_NAMES: ReadonlySet<string> = new Set(CONFIG_SECTIONS);

/**
 * Walk a parsed document into resolved environment assignments, appending a problem for everything
 * the schema does not recognise.
 *
 * It never GUESSES at a near neighbour. The schema is printed by `collie config init` and listed in
 * the docs, so a spelling suggestion buys nothing and a wrong one costs trust.
 */
function collect(
  doc: TomlValue,
  file: string,
  home: string,
  problems: ConfigProblem[],
): Resolved[] {
  const out: Resolved[] = [];
  const table = asTable(doc);
  if (table === null) {
    problems.push(fileProblem(file, "does not hold a table of sections"));
    return out;
  }
  for (const [sectionName, body] of Object.entries(table)) {
    if (!SECTION_NAMES.has(sectionName)) {
      problems.push({
        file,
        section: sectionName,
        key: null,
        message: `${file}: [${sectionName}] is not a section Collie knows`,
      });
      continue;
    }
    const keys = body === undefined ? null : asTable(body);
    if (keys === null) {
      problems.push({
        file,
        section: sectionName,
        key: null,
        message: `${file}: [${sectionName}] must be a table of keys`,
      });
      continue;
    }
    // SAFETY: `SECTION_NAMES` is built from `CONFIG_SECTIONS`, so a name that passed the check above
    // is one of its members and the narrowing claims nothing the check did not establish.
    const section = sectionName as ConfigSection;
    for (const [key, raw] of Object.entries(keys)) {
      const setting = settingByKey(section, key);
      if (setting === undefined) {
        problems.push({
          file,
          section: sectionName,
          key,
          message: `${file}: [${sectionName}] has no key "${key}"`,
        });
        continue;
      }
      const value = convert(setting, raw ?? null, home);
      if (isRefusal(value)) {
        problems.push({ file, section: sectionName, key, message: `${file}: [${sectionName}] ${key} ${value.why}` });
        continue;
      }
      out.push({ setting, value });
    }
  }
  return out;
}

/** The value as a table, or `null` when it is anything else. The one narrowing in this module. */
function asTable(value: TomlValue): TomlTable | null {
  if (value === null || Array.isArray(value)) return null;
  if (typeof value !== "object") return null;
  // SAFETY: `TomlValue`'s only object members are `TomlTable` and `readonly TomlValue[]`, and the
  // array was refused on the line above, so what remains is a table.
  return value as TomlTable;
}

/** Whether a conversion refused. A {@link Refusal} is the only non-string `convert` returns. */
function isRefusal(value: string | Refusal): value is Refusal {
  return typeof value !== "string";
}

/** The entries as strings, or `null` when the array holds anything else. */
function asStringList(value: TomlValue): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    out.push(entry);
  }
  return out;
}

/** A leading `~/` expanded, because a hand-written file is the first place anyone types one. */
function expandHome(value: string, home: string): string {
  return value.startsWith("~/") ? join(home, value.slice(2)) : value;
}

const typeName = (raw: TomlValue): string =>
  raw === null ? "null" : Array.isArray(raw) ? "an array" : `a ${typeof raw}`;

/** The value as the environment would carry it, or the reason it cannot be believed. */
function convert(setting: ConfigSetting, raw: TomlValue, home: string): string | Refusal {
  switch (setting.kind) {
    case "int": {
      if (typeof raw !== "number" || !Number.isInteger(raw)) {
        return { why: `must be a whole number, not ${typeName(raw)}` };
      }
      if (setting.min !== undefined && raw < setting.min) {
        return { why: `must be at least ${setting.min}` };
      }
      if (setting.max !== undefined && raw > setting.max) {
        return { why: `must be at most ${setting.max}` };
      }
      return String(raw);
    }
    case "bool": {
      if (typeof raw !== "boolean") return { why: `must be true or false, not ${typeName(raw)}` };
      // `1`/`0` rather than `true`/`false` only because both are what `envBool` already reads; the
      // shape on the wire between these two modules is not the operator's business.
      return raw ? "1" : "0";
    }
    case "enum": {
      if (typeof raw !== "string") return { why: `must be a string, not ${typeName(raw)}` };
      const allowed = setting.values ?? [];
      const match = allowed.find((a) => a.toLowerCase() === raw.trim().toLowerCase());
      if (match === undefined) return { why: `must be one of ${allowed.join(", ")}` };
      return match;
    }
    case "list":
    case "roots": {
      const list = asStringList(raw);
      if (list === null) return { why: `must be an array of strings, not ${typeName(raw)}` };
      // Joined with `,` so `envList` reads exactly what it has always read. A value carrying the
      // separator would silently become two entries, so it is refused rather than mangled.
      const entries = list.map((e) => expandHome(e.trim(), home));
      if (entries.some((e) => e.includes(","))) return { why: "may not contain a comma" };
      return entries.join(",");
    }
    case "string":
    case "secret": {
      if (typeof raw !== "string") return { why: `must be a string, not ${typeName(raw)}` };
      return expandHome(raw, home);
    }
  }
}

/** Every setting in file order, grouped by section. Shared by `config init` and `config show`. */
export function settingsBySection(): ReadonlyMap<ConfigSection, readonly ConfigSetting[]> {
  const out = new Map<ConfigSection, ConfigSetting[]>();
  for (const section of CONFIG_SECTIONS) out.set(section, []);
  for (const setting of CONFIG_SETTINGS) out.get(setting.section)!.push(setting);
  return out;
}
