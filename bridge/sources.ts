// THE PROGRAMS ONE COLLIE RUNS BESIDE ITS TERMINAL MUX (M55 spec 01).
//
// A durable program used to need a Collie of its own: `COLLIE_MUX=durable` made the whole instance
// one program, and putting it beside a terminal meant a second Collie and a crew. A source lifts
// that: each entry of `sources.json` becomes one more session in the session registry
// (bridge/sessions.ts), built by the same factory, with the durable adapter. The terminal mux stays
// the primary, exactly as it was.
//
// THE FILE. `<configDir>/sources.json`, next to `.env`, mode 0600, because a `url` entry carries its
// bearer token. An array of `{ "name", "kind": "durable", "socket"? , "url"?, "token"? }`:
//
//   name    ^[a-z0-9][a-z0-9-]{0,31}$, unique, and not the name of a terminal session. It is the
//           session's id on the phone (`?session=<name>`) and the folder its log lives in, so the
//           pattern is strict on purpose: nothing in it can be a path or need escaping.
//   kind    "durable", the one kind there is today.
//   socket  the program's private Unix socket (WIRE.md section 1A), or
//   url     its https address (section 1B), which needs
//   token   the bearer token for that address.
//
// Exactly one of `socket` and `url`. A missing file is no sources. A file that is there and wrong
// stops the bridge with one line that names the entry and the field, because a program the operator
// listed and Collie silently skipped is a phone that never shows it, with nothing to say why.
//
// THE OLD FORM. `COLLIE_MUX=durable` with `COLLIE_DURABLE_SOCKET`, or `COLLIE_DURABLE_URL` and
// `COLLIE_DURABLE_TOKEN`, still runs a durable-only instance (Windows, a hosted program with no
// terminal). It maps to one source named `default`, which is then the primary session.
//
// The adapter takes its socket, URL and token from the source, never from the process environment
// ({@link sourceTransportEnv}), so two programs in one process cannot read each other's settings.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "./json.ts";
import { DURABLE_SOCKET_ENV } from "./mux/durable/client.ts";
import { DURABLE_TOKEN_ENV, DURABLE_URL_ENV, resolveDurableUrl } from "./mux/durable/http-client.ts";
import type { DurableEnv } from "./mux/durable/transport.ts";

/** The file, in the instance's config dir beside `.env`. */
export const SOURCES_FILE = "sources.json";

/** The name a durable-only instance's one program takes (the old env form). */
export const ENV_SOURCE_NAME = "default";

/** What a source name may be: a short lowercase slug, never a path. */
export const SOURCE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The kinds a source may be. One today. */
export const SOURCE_KINDS = ["durable"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** One program this Collie runs as a session. */
export interface DurableSource {
  readonly name: string;
  readonly kind: SourceKind;
  /** The program's private socket. Exactly one of this and {@link url} in a file entry. */
  readonly socket?: string;
  /** The program's https address. Needs {@link token}. */
  readonly url?: string;
  /** The bearer token for {@link url}. Never printed. */
  readonly token?: string;
}

/** A `sources.json` that cannot be used. The message names the entry and the field. */
export class SourcesError extends Error {
  override readonly name = "SourcesError";
}

/** Where the file is, for a config dir. */
export function sourcesPath(configDir: string): string {
  return join(configDir, SOURCES_FILE);
}

function isRecord(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const KNOWN_FIELDS: ReadonlySet<string> = new Set(["name", "kind", "socket", "url", "token"]);

/** One optional string field: absent, or a string with something in it. */
function optionalText(entry: JsonObject, field: string, at: string): string | undefined {
  const value = entry[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new SourcesError(`${at}: "${field}" must be a non-empty string`);
  return value.trim();
}

function parseEntry(raw: JsonValue, index: number, file: string): DurableSource {
  const at = `${file} entry ${String(index)}`;
  if (!isRecord(raw)) throw new SourcesError(`${at}: must be an object`);
  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) throw new SourcesError(`${at}: unknown field "${key}"`);
  }
  const name = raw.name;
  if (typeof name !== "string" || !SOURCE_NAME_PATTERN.test(name)) {
    throw new SourcesError(`${at}: "name" must match ${SOURCE_NAME_PATTERN.source}`);
  }
  const named = `${file} entry "${name}"`;
  const kind = raw.kind;
  if (kind !== "durable") throw new SourcesError(`${named}: "kind" must be "durable"`);
  const socket = optionalText(raw, "socket", named);
  const url = optionalText(raw, "url", named);
  const token = optionalText(raw, "token", named);
  if (socket !== undefined && url !== undefined) throw new SourcesError(`${named}: set "socket" or "url", not both`);
  if (socket === undefined && url === undefined) throw new SourcesError(`${named}: set "socket" or "url"`);
  if (socket !== undefined && token !== undefined) throw new SourcesError(`${named}: "token" is only sent to a "url"`);
  if (url !== undefined && token === undefined) throw new SourcesError(`${named}: "url" needs "token"`);
  if (socket !== undefined) return { name, kind, socket };
  // SAFETY: the two checks above leave `url` and `token` both set on this branch.
  return { name, kind, url: url as string, token: token as string };
}

/**
 * Read the file's text. Pure: the caller read the file. `file` is the name the errors use.
 *
 * Throws {@link SourcesError} for the first thing wrong, naming the entry and the field. The URL and
 * token RULES (https, the token's length) are not repeated here: the adapter applies them and reports
 * a broken one as `unreachable` with the reason, as it always did for the env form, and doctor names
 * it. What this checks is the shape that decides which transport a source has at all.
 */
export function parseSources(text: string, file: string = SOURCES_FILE): DurableSource[] {
  let parsed: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction.
    parsed = JSON.parse(text) as JsonValue;
  } catch (err) {
    throw new SourcesError(`${file}: not JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!Array.isArray(parsed)) throw new SourcesError(`${file}: must be an array of sources`);
  const out: DurableSource[] = [];
  const seen = new Set<string>();
  parsed.forEach((raw, index) => {
    const source = parseEntry(raw, index, file);
    if (seen.has(source.name)) throw new SourcesError(`${file} entry "${source.name}": the name is used twice`);
    seen.add(source.name);
    out.push(source);
  });
  return out;
}

/** How the loader reads a file. A missing file answers null. */
export type ReadText = (path: string) => string | null;

const readFromDisk: ReadText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw new SourcesError(`${path}: cannot be read (${err instanceof Error ? err.message : String(err)})`);
  }
};

/** The sources in a config dir. A missing file is an empty list; a bad one throws {@link SourcesError}. */
export function readSources(configDir: string, read: ReadText = readFromDisk): DurableSource[] {
  const path = sourcesPath(configDir);
  const text = read(path);
  return text === null ? [] : parseSources(text, path);
}

/** The kill switch: `COLLIE_PROGRAMS=off` makes the bridge ignore `sources.json` altogether. */
export const PROGRAMS_ENV = "COLLIE_PROGRAMS";

/** The one line the bridge logs at boot when the switch is set. */
export const PROGRAMS_OFF_LOG = `[bridge] programs are off (${PROGRAMS_ENV}=off); ${SOURCES_FILE} ignored`;

/** What `collie doctor` and `collie durable list` say when the switch is set. */
export const PROGRAMS_OFF_NOTE = `durable agents are off (${PROGRAMS_ENV}=off)`;

/** Whether the kill switch is set. Only `off` turns programs off; any other value, or none, leaves them on. */
export function programsOff(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[PROGRAMS_ENV]?.trim().toLowerCase() === "off";
}

/**
 * The sources the bridge boots with: {@link readSources}, or none at all while programs are off. With
 * the switch set the file is not read, so a missing, unreadable or wrong `sources.json` cannot stop a
 * bridge the operator has switched programs off on.
 */
export function bootSources(
  configDir: string,
  env: Readonly<Record<string, string | undefined>>,
  read: ReadText = readFromDisk,
): DurableSource[] {
  return programsOff(env) ? [] : readSources(configDir, read);
}

/**
 * The old env form as a source: `default`, with whatever the three variables hold. Unchecked on
 * purpose: the transport's own rules (bridge/mux/durable/transport.ts) report a missing or
 * conflicting setting as `unreachable` with the line that names the variable, exactly as a
 * durable-only instance did before sources existed.
 */
export function envSource(env: Readonly<Record<string, string | undefined>>): DurableSource {
  const pick = (key: string): string | undefined => {
    const value = env[key];
    return value === undefined || value.trim() === "" ? undefined : value;
  };
  const socket = pick(DURABLE_SOCKET_ENV);
  const url = pick(DURABLE_URL_ENV);
  const token = pick(DURABLE_TOKEN_ENV);
  let source: DurableSource = { name: ENV_SOURCE_NAME, kind: "durable" };
  if (socket !== undefined) source = { ...source, socket };
  if (url !== undefined) source = { ...source, url };
  if (token !== undefined) source = { ...source, token };
  return source;
}

/**
 * The source's settings in the shape the transport rules read. The adapter is built from THIS, never
 * from `process.env`, so each program in the process reads only its own entry.
 */
export function sourceTransportEnv(source: DurableSource): DurableEnv {
  return { [DURABLE_SOCKET_ENV]: source.socket, [DURABLE_URL_ENV]: source.url, [DURABLE_TOKEN_ENV]: source.token };
}

/** Where a source's program runs, as the session card says it: a socket or a loopback URL is local. */
export function sourceWhere(source: DurableSource): "local" | "remote" {
  if (source.url === undefined) return "local";
  const url = resolveDurableUrl(source.url);
  return url.ok && url.loopback ? "local" : "remote";
}

/** The programs this instance runs: the primary one (durable-only only) and the others. */
export interface ProgramPlan {
  /** Set only on a durable-only instance: the source that is the primary session. */
  readonly primary: DurableSource | undefined;
  /** Every other source, in file order. Each becomes one more session. */
  readonly others: readonly DurableSource[];
}

/**
 * Which sources become sessions, and which one is primary.
 *
 * A source is never primary unless the instance is durable-only (`COLLIE_MUX=durable`). Then the old
 * env form is the primary, named `default`, and the file's entries are sessions beside it.
 * `primaryName` is the terminal primary's registry name on every other instance: a source may not take
 * it, because the phone addresses a session by name alone.
 */
export function planPrograms(opts: {
  readonly durableOnly: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly sources: readonly DurableSource[];
  readonly primaryName: string;
}): ProgramPlan {
  const primary = opts.durableOnly ? envSource(opts.env) : undefined;
  const taken = primary?.name ?? opts.primaryName;
  const clash = opts.sources.find((source) => source.name === taken);
  if (clash !== undefined) {
    throw new SourcesError(
      `${SOURCES_FILE} entry "${clash.name}": the name is the ${primary === undefined ? "terminal" : "durable-only"} session's own; pick another`,
    );
  }
  return { primary, others: [...opts.sources] };
}
