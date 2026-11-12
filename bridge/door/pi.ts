// pi's door (ADR 0141): the inbox extension in pi's own process (`pi-extension/collie-inbox.ts`), reached
// over its private unix socket. It hands the text to `pi.sendUserMessage`, so no key reaches the pane.
//
// FINDING THE SOCKET. The extension names its socket by the digest of every multiplexer marker in its
// environment (`beaconKey`), the key that names a beacon. The bridge cannot rebuild that digest: a pane
// nested in a second multiplexer carries a marker the bridge never sees, and the socket path Herdr
// exports can be another spelling of the one the bridge dials (`bridge/mux/herdr/markers.ts`). So the
// door reads the folder, asks each socket `/hello`, and joins the raw markers each one reports to the
// pane with the multiplexer's own beacon matcher, the join a beacon gets. A socket whose name is not
// the digest of the markers it reports is not one of ours. One socket must name the pane; none, or more
// than one, refuses (ambiguity is absence, `bridge/beacon/decorate.ts`).
//
// THE BINDING (ADR 0141 point 3). pi says which session file it writes; the multiplexer (Herdr's
// `agent_session`) or a beacon says which session the pane runs. The door binds only when the two are
// the same path, byte for byte. A pane that names no path, a pi session with no file, or another file
// refuses, and the send takes the screen path. Neither side is resolved or cleaned first: a check that
// made two spellings agree would bind where the two sides did not say the same thing.
//
// THE SOCKET'S RULES (ADR 0141 point 7, ADR 0103): every path part is walked with `lstat` before each
// connect, the same check the durable wire runs (`socketAccessProblem`), and no link is followed.

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { BeaconMatcher } from "../beacon/decorate.ts";
import { parseInboxHello, parseInboxTook } from "../beacon/parse.ts";
import { beaconKey, inboxSocketName } from "../beacon/paths.ts";
import type { InboxHello } from "../beacon/types.ts";
import type { AgentSessionRef } from "../journal/types.ts";
import { readCapped, socketAccessProblem } from "../mux/durable/client.ts";
import type { BoundDoor, Door, DoorAnswer, DoorSend, DoorTarget, Preflight } from "./door.ts";

/** The harness id pi's door serves. */
export const PI_DOOR = "pi";

/** An inbox socket's name: a pane key, 16 hex. A bind name (`<key>-<hex>.sock`) is still being opened. */
const INBOX_SOCKET = /^[0-9a-f]{16}\.sock$/u;

/** The most sockets one preflight asks. More than this many open pi sessions refuses rather than waits. */
export const INBOX_MAX = 32;

/** How long one socket gets to answer `/hello`: a wedged pi in another pane must not hold up this one. */
export const HELLO_MS = 1500;

/** The largest answer read from an inbox. Both answers are a few hundred bytes. */
const REPLY_MAX_BYTES = 16 * 1024;

/** The answers that say pi ran nothing (`collie-inbox.ts`): a bad body, an unknown route, too large, not taken. */
const RAN_NOTHING = new Set([400, 404, 409, 413]);

/** One answer from an inbox socket. */
export interface InboxReply {
  readonly status: number;
  readonly text: string;
}

/** The disk and the socket, as the door touches them. A test supplies its own. */
export interface InboxIo {
  /** The names in the inbox folder; none when it does not exist. */
  list(dir: string): Promise<string[]>;
  /** Why the socket at `path` may not be dialled, or null when it may (`socketAccessProblem`). */
  problem(path: string): Promise<string | null>;
  /** One HTTP request on the socket: a POST of `body` as JSON, or a GET with none. A failed connect or read throws. */
  request(path: string, route: string, body: string | undefined, signal: AbortSignal): Promise<InboxReply>;
}

/** The real folder and sockets. */
export const SYSTEM_INBOX_IO: InboxIo = {
  async list(dir) {
    try {
      return await readdir(dir);
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
      throw err;
    }
  },
  problem: (path) => socketAccessProblem(path),
  async request(path, route, body, signal) {
    const url = `http://inbox${route}`;
    const response =
      body === undefined
        ? await fetch(url, { unix: path, signal })
        : await fetch(url, { unix: path, method: "POST", body, headers: { "content-type": "application/json" }, signal });
    return { status: response.status, text: await readCapped(response, REPLY_MAX_BYTES) };
  },
};

/** What pi's door needs from the session it serves. */
export interface PiDoorDeps {
  /** The inbox folder (`inboxDir`). */
  readonly dir: string;
  /** The multiplexer's beacon matcher: which raw marker names which of its panes. */
  readonly matcher: BeaconMatcher;
  /** The session the multiplexer or a beacon names on the pane now (`AgentView.agentSession`). */
  sessionOf(paneId: string): AgentSessionRef | undefined;
  readonly io?: InboxIo;
}

/** A socket that answered `/hello`, at its path. */
interface Heard {
  readonly path: string;
  readonly hello: InboxHello;
}

/** pi's door for one session. */
export function piDoor(deps: PiDoorDeps): Door {
  const io = deps.io ?? SYSTEM_INBOX_IO;

  /** The socket's `/hello`, or null when it gives none this build reads, or its name is not its markers' key. */
  const hear = async (name: string, signal: AbortSignal): Promise<Heard | null> => {
    const path = join(deps.dir, name);
    if ((await io.problem(path)) !== null) return null;
    let reply: InboxReply;
    try {
      reply = await io.request(path, "/hello", undefined, AbortSignal.any([signal, AbortSignal.timeout(HELLO_MS)]));
    } catch {
      return null;
    }
    const hello = reply.status === 200 ? parseInboxHello(reply.text) : null;
    if (hello === null || inboxSocketName(beaconKey(hello.markers)) !== name) return null;
    return { path, hello };
  };

  const bound = (path: string): BoundDoor => ({
    async submit(send: DoorSend, signal: AbortSignal): Promise<DoorAnswer> {
      const problem = await io.problem(path);
      if (problem !== null) return { kind: "refused", why: `the inbox socket: ${problem}` };
      // No `steer`: the Send Protocol never hands a door a steer (ADR 0117).
      const reply = await io.request(path, "/send", JSON.stringify({ text: send.text, requestId: send.requestId }), signal);
      if (RAN_NOTHING.has(reply.status)) return { kind: "refused", why: `pi answered ${String(reply.status)}` };
      const took = reply.status === 202 ? parseInboxTook(reply.text) : null;
      // Anything else may have reached pi: a throw is `uncertain`, never typed again (ADR 0141 point 2).
      if (took === null) throw new Error(`pi answered ${String(reply.status)} with no state Collie reads`);
      if (took.replayed) return { kind: "replayed" };
      if (took.state === "steered") throw new Error("pi steered a send that asked for no steer");
      return { kind: took.state };
    },
  });

  return {
    id: PI_DOOR,
    // No inbox for the pane is `absent`: the pane has no door, and the screen path is the ordinary one
    // (SPEC V25). Only the pane's own inbox, heard and then not bound, is a refusal the receipt names.
    async preflight(target: DoorTarget, signal: AbortSignal): Promise<Preflight> {
      const scope = await deps.matcher.scope();
      if (scope === null) return { ok: false, why: "the multiplexer's scope is unknown", absent: true };
      const names = (await io.list(deps.dir)).filter((name) => INBOX_SOCKET.test(name));
      if (names.length === 0) return { ok: false, why: "no pi inbox is open", absent: true };
      if (names.length > INBOX_MAX) return { ok: false, why: `more than ${String(INBOX_MAX)} pi inboxes are open` };
      const heard = await Promise.all(names.map((name) => hear(name, signal)));
      const mine = heard.filter(
        (one): one is Heard =>
          one !== null && one.hello.markers.some((marker) => marker.namespace === deps.matcher.namespace && deps.matcher.matches({ paneId: target.paneId }, marker, scope)),
      );
      const [only] = mine;
      if (only === undefined) return { ok: false, why: "no pi inbox names this pane", absent: true };
      if (mine.length > 1) return { ok: false, why: "more than one pi inbox names this pane" };
      if (only.hello.agent !== PI_DOOR) return { ok: false, why: `the inbox is ${only.hello.agent}'s, not pi's` };
      const ref = deps.sessionOf(target.paneId);
      if (ref?.kind !== "path") return { ok: false, why: "the pane names no pi session file" };
      if (only.hello.sessionFile === null) return { ok: false, why: "pi's session has no file" };
      if (only.hello.sessionFile !== ref.value) return { ok: false, why: "pi's session file is not the one the pane names" };
      return { ok: true, door: bound(only.path) };
    },
  };
}
