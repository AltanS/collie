import { join } from "node:path";

import { READ_TIMEOUT_MS } from "../bridge/mux/durable/adapter.ts";
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
  type SocketFault,
  type SocketProbe,
} from "../bridge/mux/durable/client.ts";
import {
  DURABLE_SERVICE,
  incompatibleDetail,
  negotiateVersion,
  NOT_A_DURABLE_PROGRAM,
  parseHello,
  SPEAKS,
  type DurableHello,
} from "../bridge/mux/durable/protocol.ts";
import type { CliContext } from "./context.ts";
import { bad, ok, skipped, warn, type Finding } from "./finding.ts";

// ── Can this install reach its durable program? ──────────────────────────────
//
// Four rows, one question each, asked in the order the adapter asks them (`bridge/mux/durable/`):
// is the variable usable, may the socket be dialled, does the program answer `hello` in a range this
// Collie speaks, and does it say `ready`. A row that fails stops the ones after it, which are then
// `skipped`: asking a program over a socket the privacy check refuses would be the one thing the
// adapter never does. The path and privacy rules are the adapter's own functions, not copies.
//
// Only a program's `hello` is read. Nothing here sends a control, an answer or a start.

/** What this section reaches: the context, and the socket check's two system questions. */
export interface DurableDeps {
  readonly ctx: CliContext;
  /** `lstat` and the user id. The verb passes the system's; a test can pass its own. */
  readonly probe?: SocketProbe;
}

const ENV_ROW = "durable-env";
const SOCKET_ROW = "durable-socket";
const HELLO_ROW = "durable-hello";
const READY_ROW = "durable-ready";

const FIRST = "fix the row above first";

/** The four rows, in order. */
export async function durableFindings(deps: DurableDeps): Promise<Finding[]> {
  const dotenv = join(deps.ctx.configDir, ".env");
  const resolved = resolveSocketPath(deps.ctx.env[DURABLE_SOCKET_ENV]);
  if (!resolved.ok) {
    return [
      bad(ENV_ROW, resolved.detail, `set ${DURABLE_SOCKET_ENV} to the absolute path of your program's socket in ${dotenv}, then \`collie restart\``),
      skipped(SOCKET_ROW, "no socket path to check", FIRST),
      skipped(HELLO_ROW, "no socket to ask", FIRST),
      skipped(READY_ROW, "no answer to read", FIRST),
    ];
  }
  const path = resolved.path;
  const env = ok(ENV_ROW, `${DURABLE_SOCKET_ENV}=${path}`);

  const fault = await socketFault(path, deps.probe ?? SYSTEM_PROBE);
  if (fault !== null) {
    return [
      env,
      socketRow(path, fault),
      skipped(HELLO_ROW, "the socket was not dialled", FIRST),
      skipped(READY_ROW, "no answer to read", FIRST),
    ];
  }
  const socket = ok(SOCKET_ROW, `${path} is a socket, owned by you, mode 0600, in a folder of yours with mode 0700, no link on the way`);

  const asked = await askHello(path);
  if (!asked.ok) return [env, socket, asked.row, skipped(READY_ROW, "no answer to read", FIRST)];
  const hello = asked.hello;
  const version = negotiateVersion(hello.protocol);
  if (version === null) {
    return [
      env,
      socket,
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
      env,
      socket,
      answered,
      warn(READY_ROW, "the program says it is not ready yet, so the bridge shows it as starting", "wait a moment and run `collie doctor` again; if it stays, read the program's own log"),
    ];
  }
  return [env, socket, answered, ok(READY_ROW, `ready${hello.hostName === "" ? "" : ` · host ${hello.hostName}`} · epoch ${hello.epoch}`)];
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

/** One `hello`, with the adapter's budget and cap, read by the adapter's own parser. */
async function askHello(path: string): Promise<Asked> {
  const refuse = (detail: string, remedy: string): Asked => ({ ok: false, row: bad(HELLO_ROW, detail, remedy) });
  const client = new DurableSocketClient(path);
  let reply;
  try {
    reply = await client.get({ path: "/hello", version: null, ifNoneMatch: null, timeoutMs: READ_TIMEOUT_MS, maxBytes: REPLY_CAPS.hello });
  } catch (err) {
    if (!(err instanceof DurableUnreachable)) throw err;
    return refuse(`the program did not answer hello: ${err.detail}`, "check that the program is running and that it is the one listening on this socket");
  }
  if (reply.status === 401) {
    return refuse("the program asks for a token, which this wire does not have", "this Collie and the program speak different protocols: update whichever is older");
  }
  if (reply.status !== 200) {
    return refuse(`the program answered hello with status ${String(reply.status)}`, "read the program's own log");
  }
  const parsed = parseHello(reply.text);
  if (!parsed.ok && parsed.detail === NOT_A_DURABLE_PROGRAM) {
    return refuse(
      `something answered on this socket, and it is ${NOT_A_DURABLE_PROGRAM}: its hello has no service "${DURABLE_SERVICE}"`,
      `point ${DURABLE_SOCKET_ENV} at your durable program's socket`,
    );
  }
  if (!parsed.ok) {
    return refuse(`the program's hello is unreadable: ${parsed.detail}`, "see bridge/mux/durable/WIRE.md section 4 for the hello document");
  }
  return { ok: true, hello: parsed.value };
}
