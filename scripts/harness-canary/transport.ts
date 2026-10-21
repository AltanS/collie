// The send path: the bridge's own pane and send handlers, in this process, behind the client's own fetch.
//
// `sendText` (web/src/lib/reply-action.ts, and `sendGuardedReply` on checkouts before M56 spec 06)
// talks to the bridge with `fetch("/api/send")` or `fetch("/api/pane/…")`. Here that fetch is answered
// by `sendRoute`, `readPane` and `replyPane` from bridge/server.ts, called directly, with a Herdr
// adapter built on the canary session's socket. So a canary send runs the same client send action and
// the same bridge Send Protocol as a phone, and never touches a port, a paired device or a running
// Collie. Anything else the client asks for is refused, loudly: a route the shim does not know means
// the send path changed, and the canary must say so rather than guess.

import { join } from "node:path";
import { AuditLog } from "../../bridge/audit";
import { loadConfig, type Config } from "../../bridge/config";
import { HOST } from "../../bridge/host";
import { herdrMuxFactory } from "../../bridge/mux/herdr/adapter";
import type { MuxAdapter } from "../../bridge/mux/types";
import { readPane, replyPane, sendRoute, type ReplySendContext, type SendRouteRuntime } from "../../bridge/server";
import { VersionCache, type AsyncVersionReader } from "../../bridge/surface/binary-version";
import { KeyGate } from "../../bridge/surface/key-gate";
import { RowRing, SendProtocol, SessionLocks } from "../../bridge/surface/protocol";
import { RequestStore } from "../../bridge/surface/requests";
import { asJsonObject, asJsonString, parseJson, type JsonValue } from "../../web/src/lib/json";
import { findProfile, loadProfiles, profileForPlatform } from "../../web/src/lib/surface/profile";
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
  /**
   * Who hears of a successful pane read (a 200 or a 304), the way the client's `fetchPane` stamps
   * lib/liveness.ts. Without it M46's isLive gate in `sendText` / `sendGuardedReply` refuses every canary send.
   */
  onLiveRead(fn: (paneId: string) => void): void;
}

export interface TransportDeps {
  readonly mux?: MuxAdapter;
  readonly versionOf?: AsyncVersionReader;
}

export type TransportSession = Pick<CanarySession, "socket" | "isOwnedPane" | "paneInfo">;

/**
 * Install the browser stand-ins the client modules need (a memory `localStorage`, an inert
 * `document`) and the fetch shim. Call once, before `loadReaders`.
 */
export function installTransport(session: TransportSession, home: string, deps: TransportDeps = {}): Transport {
  const cfg: Config = loadConfig({
    HOME: home,
    COLLIE_STATE_DIR: join(home, "state"),
    HERDR_PLUGIN_CONFIG_DIR: join(home, "config"),
    HERDR_SOCKET_PATH: session.socket,
    COLLIE_MUX: "herdr",
  });
  const mux: MuxAdapter = deps.mux ?? herdrMuxFactory.create({ endpoint: session.socket, timeoutMs: 5000, options: {} });
  const audit: string[] = [];
  const log = new AuditLog((line) => {
    audit.push(line);
  });
  const sendVersions = new VersionCache(deps.versionOf);
  let protocol: SendProtocol | undefined;
  const getSend = (): SendProtocol => {
    protocol ??= new SendProtocol({
      mux,
      gate: new KeyGate(mux),
      store: new RequestStore(join(cfg.stateDir, "sends")),
      locks: new SessionLocks(),
      ring: new RowRing(),
      profile: async (harness) => {
        const profile = findProfile(loadProfiles(), harness);
        if (profile === undefined) return null;
        return profileForPlatform(profile.id, await sendVersions.versionOf(profile), HOST.platform);
      },
      generation: (paneId) => {
        if (!session.isOwnedPane(paneId)) return null;
        const info = session.paneInfo(paneId);
        return `${info.agent ?? ""}:${info.session?.value ?? "-"}`;
      },
    });
    return protocol;
  };
  const replySend = (): ReplySendContext => ({
    protocol: getSend(),
    harnessOf: (paneId) => {
      if (!session.isOwnedPane(paneId)) return null;
      return session.paneInfo(paneId).agent ?? "";
    },
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

  let liveRead: ((paneId: string) => void) | undefined;
  const canaryFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), ORIGIN);
    const req = new Request(url, init);
    if (url.pathname === "/api/send" && req.method === "POST") {
      let body: JsonValue | undefined;
      try {
        // SAFETY: `Request.json()` output IS a JsonValue by construction; `parseSendRequest` checks every field.
        body = (await req.json()) as JsonValue;
      } catch {
        body = undefined;
      }
      const paneId = asJsonString(asJsonObject(body)?.pane);
      if (paneId === undefined || !session.isOwnedPane(paneId)) {
        throw new Error(`canary transport: refusing pane ${String(paneId)}, not the canary's`);
      }
      const info = session.paneInfo(paneId);
      const rt: SendRouteRuntime = {
        send: getSend(),
        name: CANARY_SESSION,
        herdr: mux,
        engine: {
          current: () =>
            info.agent !== null
              ? { agents: [{ paneId, agent: info.agent }], shellPanes: [] }
              : { agents: [], shellPanes: [{ paneId }] },
          noteInput: () => undefined,
          pokeNow: () => undefined,
        },
      };
      return sendRoute(rt, body, { audit: log, device: CANARY_DEVICE, redact: cfg.redact, acceptEncoding: null });
    }
    const match = PANE_PATH.exec(url.pathname);
    if (match === null) throw new Error(`canary transport: ${url.pathname} is not a pane route`);
    const paneId = decodeURIComponent(match[1]!);
    if (!session.isOwnedPane(paneId)) throw new Error(`canary transport: refusing pane ${paneId}, not the canary's`);
    if (match[2] === undefined && req.method === "GET") {
      const res = await readPane(mux, cfg, paneId, url, req);
      if (res.status === 200 || res.status === 304) liveRead?.(paneId);
      return res;
    }
    if (match[2] === "reply" && req.method === "POST") {
      // An older `--readers` checkout (v1.13.1's one-shot send) posts `{ text, submit: true }` with no
      // request `id`, which `replyPane` now refuses as `old_phone` before reaching `replyThroughProtocol`.
      const raw = asJsonObject(parseJson(await req.clone().text()));
      const forwarded =
        raw !== undefined && raw.id === undefined && (asJsonString(raw.text) ?? "") !== "" && raw.submit !== false
          ? new Request(url, {
              method: "POST",
              headers: req.headers,
              body: JSON.stringify({ ...raw, id: `canary-${crypto.randomUUID()}` }),
            })
          : req;
      return replyPane(mux, cfg, paneId, forwarded, log, CANARY_DEVICE, CANARY_SESSION, replySend());
    }
    throw new Error(`canary transport: ${req.method} ${url.pathname} is not routed`);
  };
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: canaryFetch });

  return {
    audit,
    onLiveRead(fn) {
      liveRead = fn;
    },
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
