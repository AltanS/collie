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
import { chooseDurableTransport } from "../bridge/mux/durable/transport.ts";
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

/** The six rows about the program, in order. */
async function programFindings(deps: DurableDeps): Promise<Finding[]> {
  const dotenv = join(deps.ctx.configDir, ".env");
  const platform = deps.platform ?? HOST.platform;
  const choice = chooseDurableTransport(deps.ctx.env, platform);
  if (choice.kind === "conflict") {
    const windows = choice.windows === true;
    return [
      bad(
        ENV_ROW,
        choice.detail,
        windows
          ? `in ${dotenv}, remove ${DURABLE_SOCKET_ENV} and set ${DURABLE_URL_ENV} and ${DURABLE_TOKEN_ENV}, then \`collie restart\``
          : `in ${dotenv}, keep either ${DURABLE_SOCKET_ENV} or the pair ${DURABLE_URL_ENV} and ${DURABLE_TOKEN_ENV}, then \`collie restart\``,
      ),
      skipped(SOCKET_ROW, windows ? "Windows has no socket transport" : "no single transport to check", windows ? "nothing to do" : FIRST),
      skipped(URL_ROW, "no single transport to check", FIRST),
      skipped(TOKEN_ROW, "no single transport to check", FIRST),
      skipped(HELLO_ROW, "nothing to ask", FIRST),
      skipped(READY_ROW, "no answer to read", FIRST),
    ];
  }
  if (choice.kind === "https") return httpsFindings(choice.url, choice.token, dotenv);
  return socketFindings(choice.configured, dotenv, deps.probe ?? SYSTEM_PROBE, platform);
}

/** The rows for the private socket (WIRE.md section 1A). */
async function socketFindings(configured: string | undefined, dotenv: string, probe: SocketProbe, platform: NodeJS.Platform): Promise<Finding[]> {
  const resolved = resolveSocketPath(configured);
  const noUrl = [skipped(URL_ROW, ON_SOCKET, "nothing to do"), skipped(TOKEN_ROW, ON_SOCKET, "nothing to do")];
  if (!resolved.ok) {
    return [
      bad(
        ENV_ROW,
        resolved.detail,
        platform === "win32"
          ? `set ${DURABLE_URL_ENV} and ${DURABLE_TOKEN_ENV} in ${dotenv}, then \`collie restart\`; Windows has no socket transport`
          : `set ${DURABLE_SOCKET_ENV} to the absolute path of your program's socket in ${dotenv}, or ${DURABLE_URL_ENV} and ${DURABLE_TOKEN_ENV} for a program behind TLS, then \`collie restart\``,
      ),
      skipped(SOCKET_ROW, "no socket path to check", FIRST),
      ...noUrl,
      skipped(HELLO_ROW, "no socket to ask", FIRST),
      skipped(READY_ROW, "no answer to read", FIRST),
    ];
  }
  const path = resolved.path;
  const env = ok(ENV_ROW, `transport: private socket · ${DURABLE_SOCKET_ENV}=${path}`);

  const fault = await socketFault(path, probe);
  if (fault !== null) {
    return [env, socketRow(path, fault), ...noUrl, skipped(HELLO_ROW, "the socket was not dialled", FIRST), skipped(READY_ROW, "no answer to read", FIRST)];
  }
  const socket = ok(SOCKET_ROW, `${path} is a socket, owned by you, mode 0600, in a folder of yours with mode 0700, no link on the way`);
  const asked = await askHello(new DurableSocketClient(path), DURABLE_BUDGETS.socket.readTimeoutMs, {
    where: "on this socket",
    pointAt: `point ${DURABLE_SOCKET_ENV} at your durable program's socket`,
    notAnswering: "check that the program is running and that it is the one listening on this socket",
  });
  return [env, socket, ...noUrl, ...helloRows(asked)];
}

/** The rows for TLS with a bearer token (WIRE.md section 1B). The token's value is never in a row. */
async function httpsFindings(rawUrl: string, rawToken: string, dotenv: string): Promise<Finding[]> {
  const env = ok(ENV_ROW, `transport: https with a bearer token · ${DURABLE_URL_ENV} and ${DURABLE_TOKEN_ENV}`);
  const noSocket = skipped(SOCKET_ROW, `this peer uses ${DURABLE_URL_ENV}, so there is no socket to check`, "nothing to do");
  const url = resolveDurableUrl(rawUrl);
  const urlRow = url.ok
    ? ok(URL_ROW, `${url.base} · ${url.loopback ? "loopback http, for wrangler dev on this machine" : "https"} · ${String(url.bytes)} bytes`)
    : bad(URL_ROW, url.detail, `set ${DURABLE_URL_ENV} to your program's https:// address in ${dotenv}, then \`collie restart\``);
  const token = resolveDurableToken(rawToken);
  const tokenRow = token.ok
    ? ok(TOKEN_ROW, `set, ${String(token.bytes)} bytes`)
    : bad(TOKEN_ROW, token.detail, `set ${DURABLE_TOKEN_ENV} in ${dotenv} to the same random token the program holds, at least ${String(TOKEN_MIN_BYTES)} bytes, then \`collie restart\``);
  if (!url.ok || !token.ok) {
    return [env, noSocket, urlRow, tokenRow, skipped(HELLO_ROW, "the program was not dialled", FIRST), skipped(READY_ROW, "no answer to read", FIRST)];
  }
  const asked = await askHello(new DurableHttpClient(url.base, token.reveal()), DURABLE_BUDGETS.https.readTimeoutMs, {
    where: "at this URL",
    pointAt: `point ${DURABLE_URL_ENV} at your durable program`,
    notAnswering: "check that the program is deployed and that the URL is its address",
  });
  return [env, noSocket, urlRow, tokenRow, ...helloRows(asked)];
}

/** The hello and ready rows, from one `hello`. */
function helloRows(asked: Asked): Finding[] {
  if (!asked.ok) return [asked.row, skipped(READY_ROW, "no answer to read", FIRST)];
  const hello = asked.hello;
  const version = negotiateVersion(hello.protocol);
  if (version === null) {
    return [
      bad(
        HELLO_ROW,
        `the program answered, and ${incompatibleDetail(hello.protocol)}`,
        "run a program and a Collie whose protocol ranges overlap: update whichever is older",
      ),
      skipped(READY_ROW, "no agreed version", FIRST),
    ];
  }
  const answered = ok(
    HELLO_ROW,
    `the program answered hello · speaks ${String(hello.protocol.min)}..${String(hello.protocol.max)}, this Collie speaks ${String(SPEAKS.min)}..${String(SPEAKS.max)} · version ${String(version)}`,
  );
  if (!hello.ready) {
    return [
      answered,
      warn(READY_ROW, "the program says it is not ready yet, so the bridge shows it as starting", "wait a moment and run `collie doctor` again; if it stays, read the program's own log"),
    ];
  }
  return [answered, ok(READY_ROW, `ready${hello.hostName === "" ? "" : ` · host ${hello.hostName}`} · epoch ${hello.epoch}`)];
}

/** The socket row for a path the adapter would refuse, naming the check it failed. */
function socketRow(path: string, fault: SocketFault): Finding {
  switch (fault.kind) {
    case "missing":
      return bad(
        SOCKET_ROW,
        `nothing is at ${path}: the program is not running, or it listens somewhere else`,
        `start the program, or point ${DURABLE_SOCKET_ENV} at the path it listens on`,
      );
    case "unreadable":
      return bad(SOCKET_ROW, `cannot check ${path}: ${fault.message}`, `make ${path} readable to your user`);
    case "not-a-socket":
      return bad(SOCKET_ROW, `${path} is not a socket`, `point ${DURABLE_SOCKET_ENV} at the socket itself, not at a file`);
    case "symlink":
      return bad(
        SOCKET_ROW,
        `${fault.path} is a symlink, and the check follows no link anywhere in the path`,
        `point ${DURABLE_SOCKET_ENV} at the real path, with no link in it`,
      );
    case "not-a-directory":
      return bad(SOCKET_ROW, `${fault.path} is not a directory`, `point ${DURABLE_SOCKET_ENV} at a socket inside a folder`);
    case "parent-wrong-owner":
    case "parent-open-mode":
      return bad(
        SOCKET_ROW,
        describeFault(fault),
        `make the program create its socket in a folder of your own with mode 0700 (for example under $XDG_RUNTIME_DIR), or run \`chmod 700 ${fault.path}\``,
      );
    case "ancestor-open-mode":
      return bad(
        SOCKET_ROW,
        describeFault(fault),
        "move the socket under folders that group and others cannot write to, for example $XDG_RUNTIME_DIR",
      );
    case "no-uid":
      return bad(SOCKET_ROW, "this platform cannot show who owns the socket, so it is never dialled", "run Collie on a platform with Unix user ids");
    case "wrong-owner":
      return bad(
        SOCKET_ROW,
        `${path} is owned by user ${String(fault.owner)}, not by you (${String(fault.uid)}); other users are not supported`,
        "run the program as the same user as Collie",
      );
    case "open-mode":
      return bad(
        SOCKET_ROW,
        `${path} has mode ${octal(fault.mode)}, so group or others can reach it; it must be 0600`,
        `make the program create the socket with mode 0600 (or run \`chmod 600 ${path}\`)`,
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
async function askHello(client: DurableTransport, timeoutMs: number, words: HelloWords): Promise<Asked> {
  const refuse = (detail: string, remedy: string): Asked => ({ ok: false, row: bad(HELLO_ROW, detail, remedy) });
  let reply;
  try {
    reply = await client.get({ path: "/hello", version: null, ifNoneMatch: null, timeoutMs, maxBytes: REPLY_CAPS.hello });
  } catch (err) {
    if (!(err instanceof DurableUnreachable)) throw err;
    if (err.detail.startsWith(TOKEN_REFUSED)) {
      return refuse(
        `the program refused the token: ${err.detail}`,
        `set ${DURABLE_TOKEN_ENV} to the token the program was deployed with; to rotate it, change both sides, then \`collie restart\``,
      );
    }
    return refuse(`the program did not answer hello: ${err.detail}`, words.notAnswering);
  }
  if (reply.status === 401) {
    // Only the socket reaches here with a 401: the HTTPS client turns one into `token-refused` above.
    return refuse(
      "the program asks for a token, which the socket does not carry",
      `this Collie and the program speak different protocols: update whichever is older, or reach a program behind TLS with ${DURABLE_URL_ENV} and ${DURABLE_TOKEN_ENV}`,
    );
  }
  if (reply.status !== 200) {
    return refuse(`the program answered hello with status ${String(reply.status)}`, "read the program's own log");
  }
  const parsed = parseHello(reply.text);
  if (!parsed.ok && parsed.detail === NOT_A_DURABLE_PROGRAM) {
    return refuse(`something answered ${words.where}, and it is ${NOT_A_DURABLE_PROGRAM}: its hello has no service "${DURABLE_SERVICE}"`, words.pointAt);
  }
  if (!parsed.ok) {
    return refuse(`the program's hello is unreadable: ${parsed.detail}`, "see bridge/mux/durable/WIRE.md section 4 for the hello document");
  }
  return { ok: true, hello: parsed.value };
}
