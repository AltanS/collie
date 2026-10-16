import { join } from "node:path";

import type { JsonValue } from "../bridge/json.ts";
import { HOST, type Host } from "../bridge/host.ts";
import { jsonRecord, jsonStringField } from "../bridge/stt/json.ts";
import { localAuthHeader, readLocalSecret } from "../bridge/local-secret.ts";
import { DURABLE_SOCKET_ENV, resolveSocketPath } from "../bridge/mux/durable/client.ts";
import { PROGRAMS_OFF_NOTE, programsOff } from "../bridge/sources.ts";
import {
  DURABLE_TOKEN_ENV,
  DURABLE_URL_ENV,
  resolveDurableToken,
  resolveDurableUrl,
} from "../bridge/mux/durable/http-client.ts";
import type { CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import type { Exec, Files } from "./sys.ts";
import { bridgeUrl, dialableBridgeHost } from "./tailnet.ts";

// `durable attach | detach | list` — the operator's half of "a program is a session" (ADR 0104).
//
// ── WHAT THESE THREE VERBS DO ────────────────────────────────────────────────
// One Collie carries its terminal mux and any number of durable programs. Each program is one entry
// in `sources.json`, in the instance's config dir beside `.env`, mode 0600:
//
//   [{ "name": "desk", "kind": "durable", "socket": "/run/user/1000/desk/app.sock" },
//    { "name": "edge", "kind": "durable", "url": "https://x.example", "token": "<64 hex chars>" }]
//
//  - `attach` validates, then writes or replaces the entry for that name.
//  - `detach` removes it.
//  - `list`   prints the entries and asks the running bridge what state each is in.
//
// ── THE THREE RULES THIS MODULE MUST NOT BREAK ───────────────────────────────
//  1. **It restarts nothing unless asked.** The bridge reads `sources.json` at start. `attach` and
//     `detach` write the file and print "restart to apply". Only `--restart` calls the restart verb,
//     and that is the SAME `cmdRestart` the `restart` verb runs: it restarts the unit that owns this
//     binary's checkout. A test must never reach it; the seam below is how a test says so.
//  2. **The token never leaves the environment and the file.** It is read from the variable that
//     `--token-env` NAMES, so it is in no argv and in no shell history. No line this module prints
//     carries it, in any verb, in any error.
//  3. **A corrupt file is never overwritten.** If `sources.json` cannot be read as the contract
//     says, the verb stops and names the problem; the operator's other entries are not lost to a typo.

/** The file's name, in the instance config dir. */
export const SOURCES_FILE = "sources.json";

/** The `durable` sub-verbs, in the order the usage block prints them. */
export const DURABLE_SUBCOMMANDS = ["attach", "detach", "list"] as const;

/** The usage line for `attach`, as the docs print it. */
export const ATTACH_USAGE = "collie durable attach <name> (--socket <path> | --url <url> --token-env <VAR>) [--restart]";

/**
 * What `attach --socket` says on Windows. A private socket is proved by its owner's Unix user id, and
 * Windows has none, so the verb refuses before it writes anything: the program attaches over HTTPS.
 */
export const WINDOWS_SOCKET_REFUSAL = "a private socket needs Unix user ids; on Windows use --url <https://...> --token-env VAR";

/** The name rule from the contract: lower case, digits and hyphens, 1 to 32 characters. */
const NAME_RULE = /^[a-z0-9][a-z0-9-]{0,31}$/u;

/** One program, as the contract writes it. `token` appears only with `url`. */
export interface SourceEntry {
  readonly name: string;
  readonly kind: "durable";
  readonly socket?: string;
  readonly url?: string;
  readonly token?: string;
}

export interface DurableAttachDeps {
  readonly ctx: CliContext;
  readonly io: Io;
  readonly files: Files;
  /** The restart verb. `--restart` is the only caller. A test passes a spy; none passes the real one. */
  readonly restart: () => Promise<number>;
  /** `tailscale status` and the like, for the phone URL. Only {@link bridgeUrl} asks. */
  readonly exec: Exec;
  /** For `list`: the running bridge's answer to `/api/config?session=`. */
  readonly fetch: (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;
  /** The platform facts `attach` reads. Absent reads as this machine's; a test pins one. */
  readonly host?: Host;
}

// ── The file ─────────────────────────────────────────────────────────────────

function sourcesPath(ctx: CliContext): string {
  return join(ctx.configDir, SOURCES_FILE);
}

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string };

type Loaded = { readonly ok: true; readonly entries: SourceEntry[] } | { readonly ok: false; readonly detail: string };

/**
 * One parsed entry as the contract reads it, or the first reason it breaks the contract. Names the
 * field. This is the parse at the file boundary: past it, an entry is a {@link SourceEntry}.
 */
export function parseEntry(raw: JsonValue | undefined, index: number): Parsed<SourceEntry> {
  const at = `${SOURCES_FILE} entry ${String(index + 1)}`;
  const e = jsonRecord(raw);
  if (e === null) return { ok: false, detail: `${at} is not an object` };
  const name = jsonStringField(e.name);
  if (name === null || !NAME_RULE.test(name)) return { ok: false, detail: `${at}: name must match ${String(NAME_RULE)}` };
  if (e.kind !== "durable") return { ok: false, detail: `${at}: kind must be "durable"` };
  if ((e.socket === undefined) === (e.url === undefined)) return { ok: false, detail: `${at}: give exactly one of socket or url` };
  if (e.socket !== undefined) {
    const socket = jsonStringField(e.socket);
    if (socket === null) return { ok: false, detail: `${at}: socket must be a string` };
    if (e.token !== undefined) return { ok: false, detail: `${at}: a socket entry takes no token` };
    return { ok: true, value: { name, kind: "durable", socket } };
  }
  const url = jsonStringField(e.url);
  if (url === null) return { ok: false, detail: `${at}: url must be a string` };
  const token = jsonStringField(e.token);
  if (token === null) return { ok: false, detail: `${at}: url needs a token` };
  return { ok: true, value: { name, kind: "durable", url, token } };
}

function load(deps: DurableAttachDeps): Loaded {
  const path = sourcesPath(deps.ctx);
  const text = deps.files.read(path);
  if (text === null) return { ok: true, entries: [] };
  let parsed: JsonValue;
  try {
    // SAFETY: JSON.parse output is a JsonValue by construction; every field is re-read below.
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    return { ok: false, detail: `${path} is not valid JSON; fix or remove it first` };
  }
  if (!Array.isArray(parsed)) return { ok: false, detail: `${path} must hold an array of sources` };
  const entries: SourceEntry[] = [];
  for (const [i, raw] of parsed.entries()) {
    const parsedEntry = parseEntry(raw, i);
    if (!parsedEntry.ok) return { ok: false, detail: `${path}: ${parsedEntry.detail}` };
    const entry = parsedEntry.value;
    if (entries.some((e) => e.name === entry.name)) return { ok: false, detail: `${path}: the name ${entry.name} appears twice` };
    entries.push(entry);
  }
  return { ok: true, entries };
}

/** Write the whole file at 0600. A temp file then a rename, so an existing looser file is replaced, not kept. */
function save(deps: DurableAttachDeps, entries: readonly SourceEntry[]): void {
  const path = sourcesPath(deps.ctx);
  const temp = `${path}.tmp`;
  deps.files.write(temp, `${JSON.stringify(entries, null, 2)}\n`, 0o600);
  deps.files.rename(temp, path);
}

// ── Flags ────────────────────────────────────────────────────────────────────

interface AttachFlags {
  readonly name: string;
  readonly socket: string | null;
  readonly url: string | null;
  readonly tokenEnv: string | null;
  readonly restart: boolean;
}

const VALUE_FLAGS = ["socket", "url", "token-env"] as const;

function parseAttach(args: readonly string[]): Parsed<AttachFlags> {
  const values = new Map<string, string>();
  let restart = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--restart") {
      restart = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (!VALUE_FLAGS.some((known) => known === flag)) return { ok: false, detail: `unknown flag --${flag}` };
    const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined || value === "" || (eq === -1 && value.startsWith("--"))) return { ok: false, detail: `--${flag} needs a value` };
    if (values.has(flag)) return { ok: false, detail: `--${flag} is given twice` };
    values.set(flag, value);
  }
  if (positional.length !== 1) return { ok: false, detail: "give the durable agent one name" };
  return {
    ok: true,
    value: {
      name: positional[0]!,
      socket: values.get("socket") ?? null,
      url: values.get("url") ?? null,
      tokenEnv: values.get("token-env") ?? null,
      restart,
    },
  };
}

/** A transport rule's message, with the old variable names swapped for the flags the operator typed. */
function inFlags(detail: string, tokenEnv = "--token-env"): string {
  return detail
    .replaceAll(DURABLE_SOCKET_ENV, "--socket")
    .replaceAll(DURABLE_URL_ENV, "--url")
    .replaceAll(DURABLE_TOKEN_ENV, `the token in ${tokenEnv}`);
}

/** The entry for these flags, or the first reason it breaks the contract. */
function buildEntry(flags: AttachFlags, env: CliContext["env"], host: Host): Parsed<SourceEntry> {
  if (!NAME_RULE.test(flags.name)) return { ok: false, detail: `name ${flags.name} must match ${String(NAME_RULE)}` };
  // m55-01: replace with the bridge loader at fold. The bridge refuses a name that is a terminal
  // session's; the CLI cannot see those names, so only the shape is checked here.
  if ((flags.socket === null) === (flags.url === null)) return { ok: false, detail: "give exactly one of --socket or --url" };
  if (flags.socket !== null) {
    if (host.platform === "win32") return { ok: false, detail: WINDOWS_SOCKET_REFUSAL };
    if (flags.tokenEnv !== null) return { ok: false, detail: "--token-env goes with --url; a socket entry takes no token" };
    const socket = resolveSocketPath(flags.socket);
    if (!socket.ok) return { ok: false, detail: inFlags(socket.detail) };
    return { ok: true, value: { name: flags.name, kind: "durable", socket: socket.path } };
  }
  if (flags.tokenEnv === null) return { ok: false, detail: "--url needs --token-env <VAR>, the name of the variable that holds the token" };
  const url = resolveDurableUrl(flags.url ?? undefined);
  if (!url.ok) return { ok: false, detail: inFlags(url.detail) };
  const held = env[flags.tokenEnv];
  if (held === undefined || held === "") return { ok: false, detail: `the variable ${flags.tokenEnv} named by --token-env is not set` };
  const token = resolveDurableToken(held);
  // The rule's message states a size and a rule, never the value.
  if (!token.ok) return { ok: false, detail: inFlags(token.detail, flags.tokenEnv) };
  return { ok: true, value: { name: flags.name, kind: "durable", url: url.base, token: token.reveal() } };
}

// ── attach ───────────────────────────────────────────────────────────────────

export async function cmdDurableAttach(deps: DurableAttachDeps, args: readonly string[]): Promise<number> {
  const parsedFlags = parseAttach(args);
  if (!parsedFlags.ok) {
    deps.io.err(`error: ${parsedFlags.detail}`);
    deps.io.err(`usage: ${ATTACH_USAGE}`);
    return EXIT.USAGE;
  }
  const flags = parsedFlags.value;
  const built = buildEntry(flags, deps.ctx.env, deps.host ?? HOST);
  if (!built.ok) {
    deps.io.err(`error: ${built.detail}`);
    return EXIT.USAGE;
  }
  const entry = built.value;
  const loaded = load(deps);
  if (!loaded.ok) {
    deps.io.err(`error: ${loaded.detail}`);
    return EXIT.FAIL;
  }
  const replaced = loaded.entries.some((e) => e.name === entry.name);
  save(deps, [...loaded.entries.filter((e) => e.name !== entry.name), entry]);
  deps.io.out(`${replaced ? "updated" : "added"} ${entry.name} in ${sourcesPath(deps.ctx)}`);
  if (flags.restart) return await deps.restart();
  deps.io.out(`restart to apply: collie restart`);
  deps.io.out(`then open ${bridgeUrl(deps.exec, deps.ctx)} on your phone`);
  return EXIT.OK;
}

// ── detach ───────────────────────────────────────────────────────────────────

export async function cmdDurableDetach(deps: DurableAttachDeps, args: readonly string[]): Promise<number> {
  const restart = args.includes("--restart");
  const names = args.filter((a) => a !== "--restart");
  if (names.length !== 1 || names[0]!.startsWith("--")) {
    deps.io.err("usage: collie durable detach <name> [--restart]");
    return EXIT.USAGE;
  }
  const name = names[0]!;
  const loaded = load(deps);
  if (!loaded.ok) {
    deps.io.err(`error: ${loaded.detail}`);
    return EXIT.FAIL;
  }
  if (!loaded.entries.some((e) => e.name === name)) {
    deps.io.err(`error: no durable agent named ${name} in ${sourcesPath(deps.ctx)}`);
    return EXIT.STATE;
  }
  save(deps, loaded.entries.filter((e) => e.name !== name));
  deps.io.out(`removed ${name} from ${sourcesPath(deps.ctx)}`);
  if (restart) return await deps.restart();
  deps.io.out("restart to apply: collie restart");
  return EXIT.OK;
}

// ── list ─────────────────────────────────────────────────────────────────────

/** Long enough for a busy loopback bridge, short enough that a wedged one does not hold the verb. */
const LIST_BUDGET_MS = 3000;

/**
 * What the running bridge says about one source: `loaded`, `not loaded (restart to apply)`,
 * `refused (<status>)` or `bridge not answering`. `loaded` means the bridge loaded the entry, not that
 * the program answers; `collie doctor` asks the program.
 */
async function stateOf(deps: DurableAttachDeps, name: string): Promise<string> {
  const host = dialableBridgeHost(deps.ctx.env);
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const secret = readLocalSecret(deps.ctx.stateDir, (p) => deps.files.read(p));
  const login = deps.ctx.env.COLLIE_TRUSTED_USER ?? "";
  const headers = login === "" ? localAuthHeader(secret) : { ...localAuthHeader(secret), "Tailscale-User-Login": login };
  try {
    const res = await deps.fetch(
      `http://${bracketed}:${String(deps.ctx.port)}/api/config?session=${encodeURIComponent(name)}`,
      { signal: AbortSignal.timeout(LIST_BUDGET_MS), headers },
    );
    if (res.status === 404 || res.status === 400) return "not loaded (restart to apply)";
    if (!res.ok) return `refused (${String(res.status)})`;
    return "loaded";
  } catch {
    return "bridge not answering";
  }
}

export async function cmdDurableList(deps: DurableAttachDeps): Promise<number> {
  const loaded = load(deps);
  if (!loaded.ok) {
    deps.io.err(`error: ${loaded.detail}`);
    return EXIT.FAIL;
  }
  if (loaded.entries.length === 0) {
    deps.io.out(`no durable agents attached (${sourcesPath(deps.ctx)})`);
  }
  for (const e of loaded.entries) {
    // The token is in the entry and never in the line: the way in is shown, the credential is not.
    const way = e.socket !== undefined ? `socket ${e.socket}` : `url ${e.url ?? ""} (token set)`;
    deps.io.out(`${e.name}  ${way}  ${await stateOf(deps, e.name)}`);
  }
  // The kill switch: the entries print as usual, and the last line says the bridge ignores them.
  if (programsOff(deps.ctx.env)) deps.io.out(PROGRAMS_OFF_NOTE);
  return EXIT.OK;
}

// ── the tree's own answer ────────────────────────────────────────────────────

/** A bare or misspelt `durable`. */
export function cmdDurable(deps: DurableAttachDeps, args: readonly string[]): Promise<number> | number {
  switch (args[0]) {
    case "attach":
      return cmdDurableAttach(deps, args.slice(1));
    case "detach":
      return cmdDurableDetach(deps, args.slice(1));
    case "list":
      return cmdDurableList(deps);
    default:
      deps.io.err("usage:");
      deps.io.err(`  ${ATTACH_USAGE}`);
      deps.io.err("  collie durable detach <name> [--restart]");
      deps.io.err("  collie durable list");
      return EXIT.USAGE;
  }
}
