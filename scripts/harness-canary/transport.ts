// The send path: the bridge's own pane handlers, in this process, behind the client's own fetch.
//
// `sendGuardedReply` (web/src/lib/reply-action.ts) talks to the bridge with `fetch("/api/pane/…")`.
// Here that fetch is answered by `readPane` and `replyPane` from bridge/server.ts, called directly,
// with a Herdr adapter built on the canary session's socket. So a canary send runs the same client
// guard and the same bridge reply code as a phone, and never touches a port, a paired device or a
// running Collie. Anything else the client asks for is refused, loudly: a route the shim does not
// know means the send path changed, and the canary must say so rather than guess.

import { AuditLog } from "../../bridge/audit";
import { loadConfig, type Config } from "../../bridge/config";
import { herdrMuxFactory } from "../../bridge/mux/herdr/adapter";
import type { MuxAdapter } from "../../bridge/mux/types";
import { readPane, replyPane } from "../../bridge/server";
import { asJsonObject, asJsonString, parseJson } from "../../web/src/lib/json";
import { CANARY_SESSION, type CanarySession } from "./herdr";

const PANE_PATH = /\/api\/pane\/([^/?]+)(?:\/(reply))?$/;
/** Where the client's root-absolute paths are resolved against. Never dialled. */
const ORIGIN = "http://collie-canary.invalid/";
/** The device name the audit lines carry, so a canary send is never mistaken for a phone's. */
const CANARY_DEVICE = "collie-canary";

export interface Transport {
  /** The pane as the phone reads it: `GET /api/pane/:id` through `readPane`. */
  readScreen(paneId: string): Promise<string>;
  /** The audit lines the bridge's reply handler wrote, in order. */
  readonly audit: readonly string[];
}

/**
 * Install the browser stand-ins the client modules need (a memory `localStorage`, an inert
 * `document`) and the fetch shim. Call once, before `loadReaders`.
 */
export function installTransport(session: CanarySession, home: string): Transport {
  const cfg: Config = loadConfig({ HOME: home, HERDR_SOCKET_PATH: session.socket, COLLIE_MUX: "herdr" });
  const mux: MuxAdapter = herdrMuxFactory.create({ endpoint: session.socket, timeoutMs: 5000, options: {} });
  const audit: string[] = [];
  const log = new AuditLog((line) => {
    audit.push(line);
  });

  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelector: () => null,
      addEventListener: () => {},
      removeEventListener: () => {},
      visibilityState: "visible",
      documentElement: {},
    },
  });

  const canaryFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), ORIGIN);
    const match = PANE_PATH.exec(url.pathname);
    if (match === null) throw new Error(`canary transport: ${url.pathname} is not a pane route`);
    const paneId = decodeURIComponent(match[1]!);
    if (!session.isOwnedPane(paneId)) throw new Error(`canary transport: refusing pane ${paneId}, not the canary's`);
    const req = new Request(url, init);
    if (match[2] === undefined && req.method === "GET") return readPane(mux, cfg, paneId, url, req);
    if (match[2] === "reply" && req.method === "POST") {
      return replyPane(mux, cfg, paneId, req, log, CANARY_DEVICE, CANARY_SESSION);
    }
    throw new Error(`canary transport: ${req.method} ${url.pathname} is not routed`);
  };
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: canaryFetch });

  return {
    audit,
    async readScreen(paneId) {
      const res = await canaryFetch(`/api/pane/${encodeURIComponent(paneId)}`);
      const body = await res.text();
      if (res.status !== 200) throw new Error(`pane read ${paneId}: ${res.status} ${body.slice(0, 200)}`);
      const text = asJsonString(asJsonObject(parseJson(body))?.text);
      if (text === undefined) throw new Error(`pane read ${paneId}: no text in the reply`);
      return text;
    },
  };
}
