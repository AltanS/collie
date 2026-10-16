import { statSync } from "node:fs";
import { join } from "node:path";

import { DURABLE_BUDGETS } from "../bridge/mux/durable/adapter.ts";
import { REPLY_CAPS } from "../bridge/mux/durable/clean.ts";
import {
  DURABLE_SOCKET_ENV,
  DurableSocketClient,
  DurableUnreachable,
  describeFault,
  octal,
  resolveSocketPath,
  socketFault,
  SYSTEM_PROBE,
  type DurableTransport,
  type SocketFault,
  type SocketProbe,
} from "../bridge/mux/durable/client.ts";
import {
  DURABLE_TOKEN_ENV,
  DURABLE_URL_ENV,
  DurableHttpClient,
  resolveDurableToken,
  resolveDurableUrl,
  TOKEN_MIN_BYTES,
  TOKEN_REFUSED,
} from "../bridge/mux/durable/http-client.ts";
import { HOST } from "../bridge/host.ts";
import { chooseDurableTransport, type DurableEnv } from "../bridge/mux/durable/transport.ts";
import { PROGRAMS_OFF_NOTE, programsOff, readSources, sourcesPath, sourceTransportEnv, SourcesError, type DurableSource } from "../bridge/sources.ts";
import {
  DURABLE_SERVICE,
  incompatibleDetail,
  negotiateVersion,
  NOT_A_DURABLE_PROGRAM,
  parseHello,
  SPEAKS,
  type DurableHello,
} from "../bridge/mux/durable/protocol.ts";
import type { CrewRuntimeMarker } from "../bridge/crew/staleness.ts";
import { DURABLE_LEAD_MINIMUM, leadIsOld, oldLeadSentence } from "../bridge/durable/old-lead.ts";
import type { CrewMode } from "../bridge/types.ts";
import type { CliContext } from "./context.ts";
import { bad, ok, skipped, warn, type Finding } from "./finding.ts";

// ── Can this install reach its durable program? ──────────────────────────────
//
// Six rows, one question each, asked in the order the adapter asks them (`bridge/mux/durable/`):
// which transport the variables configure (`durable-env`), then that transport's own checks, then
// whether the program answers `hello` in a range this Collie speaks, and whether it says `ready`.
//
//   socket (WIRE.md 1A): `durable-socket`, the path walk. `durable-url` and `durable-token` are
//     skipped with the reason.
//   https (WIRE.md 1B, ADR 0103): `durable-url` (https, or loopback http, and its length) and
//     `durable-token` ("set, N bytes", NEVER the value). `durable-socket` is skipped with the reason.
//
// A row that fails stops the ones after it, which are then `skipped`: asking a program over a socket
// the privacy check refuses, or with a token that breaks its rule, would be the one thing the
// adapter never does. The rules are the adapter's own functions (transport.ts), not copies.
//
// Only a program's `hello` is read. Nothing here sends a control, an answer or a start.

/** What this section reaches: the context, and the socket check's two system questions. */
export interface DurableDeps {
  readonly ctx: CliContext;
  /** `lstat` and the user id. The verb passes the system's; a test can pass its own. */
  readonly probe?: SocketProbe;
  /**
   * This machine's crew mode and the running bridge's marker, for the `durable-lead` row. Absent reads
   * as solo: the row is then skipped with that reason.
   */
  readonly crew?: { readonly mode: CrewMode; readonly marker: CrewRuntimeMarker | null };
  /** The platform the transport rules read. Absent reads as this process's; a test names one. */
  readonly platform?: NodeJS.Platform;
}

const ENV_ROW = "durable-env";
const SOCKET_ROW = "durable-socket";
const URL_ROW = "durable-url";
const TOKEN_ROW = "durable-token";
const HELLO_ROW = "durable-hello";
const READY_ROW = "durable-ready";
const LEAD_ROW = "durable-lead";

const FIRST = "fix the row above first";

/** Why the two HTTPS rows are skipped on a socket peer. */
const ON_SOCKET = `this peer uses the socket, and ${DURABLE_URL_ENV} is not set`;

/** The six rows, in order, then `durable-lead`. */
export async function durableFindings(deps: DurableDeps): Promise<Finding[]> {
  return [...(await programFindings(deps)), leadRow(deps.crew)];
}

/**
 * Whether the lead can show this peer's durable panes: the release it stated (M50 spec 14). A lead below
 * {@link DURABLE_LEAD_MINIMUM} shows them without the question card, and its Terminal tab polls. The
 * release comes from the running bridge's marker, which hears it on the lead's sweep
 * (bridge/durable/old-lead.ts).
 */
function leadRow(crew: DurableDeps["crew"]): Finding {
  const mode = crew?.mode ?? "solo";
  if (mode === "solo") return skipped(LEAD_ROW, "this machine is not in a crew, so there is no lead to show its panes", "nothing to do");
  if (mode === "lead") return skipped(LEAD_ROW, "this machine is the lead, and it shows its own durable panes", "nothing to do");
  const release = crew?.marker?.leadRelease;
  if (release === undefined) {
    return skipped(
      LEAD_ROW,
      "the lead has stated no release: it runs a dev build, it is updating, or it has not called since the bridge started",
      "nothing to do",
    );
  }
  if (leadIsOld(release)) return warn(LEAD_ROW, oldLeadSentence(release), `update the lead to ${DURABLE_LEAD_MINIMUM} or later`);
  return ok(LEAD_ROW, `the lead is ${release}, which shows the question card`);
}

/** The six rows about the program, in order, for the env form. */
async function programFindings(deps: DurableDeps): Promise<Finding[]> {
  return transportFindings(deps.ctx.env, envSetting(join(deps.ctx.configDir, ".env")), deps.probe ?? SYSTEM_PROBE, deps.platform ?? HOST.platform);
}

/**
 * The six rows for one program's settings: the env form's (`env` is the process environment), or one
 * source's (`env` is {@link sourceTransportEnv} of its entry). `w` names the rows and the settings.
 */
async function transportFindings(env: DurableEnv, w: Setting, probe: SocketProbe, platform: NodeJS.Platform): Promise<Finding[]> {
  const choice = chooseDurableTransport(env, platform);
  if (choice.kind === "conflict") {
    const windows = choice.windows === true;
    return [
      bad(
        w.rows.env,
        choice.detail,
        windows
          ? `in ${w.file}, remove ${w.socket} and set ${w.url} and ${w.token}, then \`collie restart\``
          : `in ${w.file}, keep either ${w.socket} or the pair ${w.url} and ${w.token}, then \`collie restart\``,
      ),
      skipped(w.rows.socket, windows ? "Windows has no socket transport" : "no single transport to check", windows ? "nothing to do" : FIRST),
      skipped(w.rows.url, "no single transport to check", FIRST),
      skipped(w.rows.token, "no single transport to check", FIRST),
      skipped(w.rows.hello, "nothing to ask", FIRST),
      skipped(w.rows.ready, "no answer to read", FIRST),
    ];
  }
  if (choice.kind === "https") return httpsFindings(choice.url, choice.token, w);
  return socketFindings(choice.configured, w, probe, platform);
}

/** The rows for the private socket (WIRE.md section 1A). */
async function socketFindings(configured: string | undefined, w: Setting, probe: SocketProbe, platform: NodeJS.Platform): Promise<Finding[]> {
  const resolved = resolveSocketPath(configured);
  const noUrl = [skipped(w.rows.url, w.onSocket, "nothing to do"), skipped(w.rows.token, w.onSocket, "nothing to do")];
  if (!resolved.ok) {
    return [
      bad(
        w.rows.env,
        resolved.detail,
        platform === "win32"
          ? `set ${w.url} and ${w.token} in ${w.file}, then \`collie restart\`; Windows has no socket transport`
          : `set ${w.socket} to the absolute path of your durable agent's socket in ${w.file}, or ${w.url} and ${w.token} for a durable agent behind TLS, then \`collie restart\``,
      ),
      skipped(w.rows.socket, "no socket path to check", FIRST),
      ...noUrl,
      skipped(w.rows.hello, "no socket to ask", FIRST),
      skipped(w.rows.ready, "no answer to read", FIRST),
    ];
  }
  const path = resolved.path;
  const env = ok(w.rows.env, `transport: private socket · ${w.socketKey}=${path}`);

  const fault = await socketFault(path, probe);
  if (fault !== null) {
    return [env, socketRow(path, fault, w), ...noUrl, skipped(w.rows.hello, "the socket was not dialled", FIRST), skipped(w.rows.ready, "no answer to read", FIRST)];
  }
  const socket = ok(w.rows.socket, `${path} is a socket, owned by you, mode 0600, in a folder of yours with mode 0700, no link on the way`);
  const asked = await askHello(new DurableSocketClient(path), DURABLE_BUDGETS.socket.readTimeoutMs, w, {
    where: "on this socket",
    pointAt: `point ${w.socket} at your durable agent's socket`,
    notAnswering: "check that the durable agent is running and that it is the one listening on this socket",
  });
  return [env, socket, ...noUrl, ...helloRows(asked, w)];
}

/** The rows for TLS with a bearer token (WIRE.md section 1B). The token's value is never in a row. */
async function httpsFindings(rawUrl: string, rawToken: string, w: Setting): Promise<Finding[]> {
  const env = ok(w.rows.env, `transport: https with a bearer token · ${w.pair}`);
  const noSocket = skipped(w.rows.socket, `this peer uses ${w.url}, so there is no socket to check`, "nothing to do");
  const url = resolveDurableUrl(rawUrl);
  const urlRow = url.ok
    ? ok(w.rows.url, `${url.base} · ${url.loopback ? "loopback http, for wrangler dev on this machine" : "https"} · ${String(url.bytes)} bytes`)
    : bad(w.rows.url, url.detail, `set ${w.url} to your durable agent's https:// address in ${w.file}, then \`collie restart\``);
  const token = resolveDurableToken(rawToken);
  const tokenRow = token.ok
    ? ok(w.rows.token, `set, ${String(token.bytes)} bytes`)
    : bad(w.rows.token, token.detail, `set ${w.token} in ${w.file} to the same random token the durable agent holds, at least ${String(TOKEN_MIN_BYTES)} bytes, then \`collie restart\``);
  if (!url.ok || !token.ok) {
    return [env, noSocket, urlRow, tokenRow, skipped(w.rows.hello, "the durable agent was not dialled", FIRST), skipped(w.rows.ready, "no answer to read", FIRST)];
  }
  const asked = await askHello(new DurableHttpClient(url.base, token.reveal()), DURABLE_BUDGETS.https.readTimeoutMs, w, {
    where: "at this URL",
    pointAt: `point ${w.url} at your durable agent`,
    notAnswering: "check that the durable agent is deployed and that the URL is its address",
  });
  return [env, noSocket, urlRow, tokenRow, ...helloRows(asked, w)];
}

/** The hello and ready rows, from one `hello`. */
function helloRows(asked: Asked, w: Setting): Finding[] {
  if (!asked.ok) return [asked.row, skipped(w.rows.ready, "no answer to read", FIRST)];
  const hello = asked.hello;
  const version = negotiateVersion(hello.protocol);
  if (version === null) {
    return [
      bad(
        w.rows.hello,
        `the durable agent answered, and ${incompatibleDetail(hello.protocol)}`,
        "run a durable agent and a Collie whose protocol ranges overlap: update whichever is older",
      ),
      skipped(w.rows.ready, "no agreed version", FIRST),
    ];
  }
  const answered = ok(
    w.rows.hello,
    `the durable agent answered hello · speaks ${String(hello.protocol.min)}..${String(hello.protocol.max)}, this Collie speaks ${String(SPEAKS.min)}..${String(SPEAKS.max)} · version ${String(version)}`,
  );
  if (!hello.ready) {
    return [
      answered,
      warn(w.rows.ready, "the durable agent says it is not ready yet, so the bridge shows it as starting", "wait a moment and run `collie doctor` again; if it stays, read the durable agent's own log"),
    ];
  }
  return [answered, ok(w.rows.ready, `ready${hello.hostName === "" ? "" : ` · host ${hello.hostName}`} · epoch ${hello.epoch}`)];
}

/** The socket row for a path the adapter would refuse, naming the check it failed. */
function socketRow(path: string, fault: SocketFault, w: Setting): Finding {
  switch (fault.kind) {
    case "missing":
      return bad(
        w.rows.socket,
        `nothing is at ${path}: the durable agent is not running, or it listens somewhere else`,
        `start the durable agent, or point ${w.socket} at the path it listens on`,
      );
    case "unreadable":
      return bad(w.rows.socket, `cannot check ${path}: ${fault.message}`, `make ${path} readable to your user`);
    case "not-a-socket":
      return bad(w.rows.socket, `${path} is not a socket`, `point ${w.socket} at the socket itself, not at a file`);
    case "symlink":
      return bad(
        w.rows.socket,
        `${fault.path} is a symlink, and the check follows no link anywhere in the path`,
        `point ${w.socket} at the real path, with no link in it`,
      );
    case "not-a-directory":
      return bad(w.rows.socket, `${fault.path} is not a directory`, `point ${w.socket} at a socket inside a folder`);
    case "parent-wrong-owner":
    case "parent-open-mode":
      return bad(
        w.rows.socket,
        describeFault(fault),
        `make the durable agent create its socket in a folder of your own with mode 0700 (for example under $XDG_RUNTIME_DIR), or run \`chmod 700 ${fault.path}\``,
      );
    case "ancestor-open-mode":
      return bad(
        w.rows.socket,
        describeFault(fault),
        "move the socket under folders that group and others cannot write to, for example $XDG_RUNTIME_DIR",
      );
    case "no-uid":
      return bad(w.rows.socket, "this platform cannot show who owns the socket, so it is never dialled", "run Collie on a platform with Unix user ids");
    case "wrong-owner":
      return bad(
        w.rows.socket,
        `${path} is owned by user ${String(fault.owner)}, not by you (${String(fault.uid)}); other users are not supported`,
        "run the durable agent as the same user as Collie",
      );
    case "open-mode":
      return bad(
        w.rows.socket,
        `${path} has mode ${octal(fault.mode)}, so group or others can reach it; it must be 0600`,
        `make the durable agent create the socket with mode 0600 (or run \`chmod 600 ${path}\`)`,
      );
  }
}

type Asked = { readonly ok: true; readonly hello: DurableHello } | { readonly ok: false; readonly row: Finding };

/** The words that differ between the two transports' hello rows. */
interface HelloWords {
  /** "on this socket" or "at this URL". */
  readonly where: string;
  /** The remedy for a server that is not a durable program. */
  readonly pointAt: string;
  /** The remedy for no answer at all. */
  readonly notAnswering: string;
}

/** One `hello`, with the transport's budget and the adapter's cap, read by the adapter's own parser. */
async function askHello(client: DurableTransport, timeoutMs: number, w: Setting, words: HelloWords): Promise<Asked> {
  const refuse = (detail: string, remedy: string): Asked => ({ ok: false, row: bad(w.rows.hello, detail, remedy) });
  let reply;
  try {
    reply = await client.get({ path: "/hello", version: null, ifNoneMatch: null, timeoutMs, maxBytes: REPLY_CAPS.hello });
  } catch (err) {
    if (!(err instanceof DurableUnreachable)) throw err;
    if (err.detail.startsWith(TOKEN_REFUSED)) {
      return refuse(
        `the durable agent refused the token: ${err.detail}`,
        `set ${w.token} to the token the durable agent was deployed with; to rotate it, change both sides, then \`collie restart\``,
      );
    }
    return refuse(`the durable agent did not answer hello: ${err.detail}`, words.notAnswering);
  }
  if (reply.status === 401) {
    // Only the socket reaches here with a 401: the HTTPS client turns one into `token-refused` above.
    return refuse(
      "the durable agent asks for a token, which the socket does not carry",
      `this Collie and the durable agent speak different protocols: update whichever is older, or reach a durable agent behind TLS with ${w.url} and ${w.token}`,
    );
  }
  if (reply.status !== 200) {
    return refuse(`the durable agent answered hello with status ${String(reply.status)}`, "read the durable agent's own log");
  }
  const parsed = parseHello(reply.text);
  if (!parsed.ok && parsed.detail === NOT_A_DURABLE_PROGRAM) {
    return refuse(`something answered ${words.where}, and it is ${NOT_A_DURABLE_PROGRAM}: its hello has no service "${DURABLE_SERVICE}"`, words.pointAt);
  }
  if (!parsed.ok) {
    return refuse(`the durable agent's hello is unreadable: ${parsed.detail}`, "see bridge/mux/durable/WIRE.md section 4 for the hello document");
  }
  return { ok: true, hello: parsed.value };
}

// ── Programs beside the terminal mux (M55) ───────────────────────────────────

/** What one block's rows are called and what its remedies tell the operator to edit. */
interface Setting {
  readonly rows: {
    readonly env: string;
    readonly socket: string;
    readonly url: string;
    readonly token: string;
    readonly hello: string;
    readonly ready: string;
  };
  /** The file the remedies point at: `.env`, or `sources.json`. */
  readonly file: string;
  /** How the remedies name the socket setting, the URL setting and the token setting. */
  readonly socket: string;
  readonly url: string;
  readonly token: string;
  /** The socket setting's key, as the env row prints `key=path`. */
  readonly socketKey: string;
  /** The URL and the token together, as the env row prints them. */
  readonly pair: string;
  /** Why the two HTTPS rows are skipped on a socket. */
  readonly onSocket: string;
}

/** The env form's names: the rows and variables doctor always printed. */
function envSetting(dotenv: string): Setting {
  return {
    rows: { env: ENV_ROW, socket: SOCKET_ROW, url: URL_ROW, token: TOKEN_ROW, hello: HELLO_ROW, ready: READY_ROW },
    file: dotenv,
    socket: DURABLE_SOCKET_ENV,
    url: DURABLE_URL_ENV,
    token: DURABLE_TOKEN_ENV,
    socketKey: DURABLE_SOCKET_ENV,
    pair: `${DURABLE_URL_ENV} and ${DURABLE_TOKEN_ENV}`,
    onSocket: ON_SOCKET,
  };
}

/** One source's names: each row carries `:<name>`, and the remedies name the entry's fields. */
function sourceSetting(file: string, name: string): Setting {
  const field = (key: string): string => `"${key}" of "${name}"`;
  return {
    rows: {
      env: `${ENV_ROW}:${name}`,
      socket: `${SOCKET_ROW}:${name}`,
      url: `${URL_ROW}:${name}`,
      token: `${TOKEN_ROW}:${name}`,
      hello: `${HELLO_ROW}:${name}`,
      ready: `${READY_ROW}:${name}`,
    },
    file,
    socket: field("socket"),
    url: field("url"),
    token: field("token"),
    socketKey: "socket",
    pair: "url and token",
    onSocket: `this durable agent uses a socket, and ${field("url")} is not set`,
  };
}

/** The row about the file itself. */
const SOURCES_ROW = "sources";

/** What the sources section reaches. */
export interface SourcesDeps {
  readonly ctx: CliContext;
  readonly probe?: SocketProbe;
  readonly platform?: NodeJS.Platform;
  /** The file's mode bits, or null when it cannot be read. The verb reads the disk; a test names one. */
  readonly mode?: (path: string) => number | null;
  /**
   * Add the `durable-lead` row after the blocks. The verb passes this when the env form's rows, which
   * carry their own, are not printed.
   */
  readonly crew?: DurableDeps["crew"];
}

function diskMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

/**
 * `collie doctor`'s rows for the programs in `sources.json` (M55): one row for the file (it parses,
 * and it is owner-only, because a `url` entry carries a token), then one block of six rows per source,
 * each row named `<row>:<source>`, asked exactly as the env form's are. No file: no rows.
 */
export async function sourcesFindings(deps: SourcesDeps): Promise<Finding[]> {
  const path = sourcesPath(deps.ctx.configDir);
  // The kill switch: the bridge ignores the file, so the file is not read here either, and a wrong
  // one is not an error. One row says why there are no blocks.
  if (programsOff(deps.ctx.env)) {
    return [skipped(SOURCES_ROW, PROGRAMS_OFF_NOTE, "unset COLLIE_PROGRAMS, then `collie restart`")];
  }
  let sources: DurableSource[];
  try {
    sources = readSources(deps.ctx.configDir);
  } catch (err) {
    const detail = err instanceof SourcesError ? err.message : String(err);
    return [bad(SOURCES_ROW, detail, `fix ${path} (an array of { "name", "kind": "durable", "socket" } or { ..., "url", "token" }), then \`collie restart\`; the bridge does not start while it is wrong`)];
  }
  if (sources.length === 0) return [];
  const platform = deps.platform ?? HOST.platform;
  const counted = `${String(sources.length)} durable agent${sources.length === 1 ? "" : "s"} in ${path}`;
  const mode = platform === "win32" ? null : (deps.mode ?? diskMode)(path);
  const fileRow =
    mode !== null && (mode & 0o077) !== 0
      ? bad(SOURCES_ROW, `${counted}, mode ${octal(mode)}: group or others can read it, and it may hold a token`, `run \`chmod 600 ${path}\``)
      : ok(SOURCES_ROW, mode === null ? counted : `${counted}, mode ${octal(mode)}`);
  const blocks: Finding[] = [fileRow];
  for (const source of sources) {
    blocks.push(...(await transportFindings(sourceTransportEnv(source), sourceSetting(path, source.name), deps.probe ?? SYSTEM_PROBE, platform)));
  }
  return deps.crew === undefined ? blocks : [...blocks, leadRow(deps.crew)];
}
