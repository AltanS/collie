// The per-request half of the old `fetch` closure: the values every session-scoped route, the
// snapshot, `/api/config` and the cache-watch routes read off one request.
//
// They were `const`s at the top of that closure, computed for every request that got past the health
// check. Here they are computed by the route that reads them, from the same expressions; each is pure
// apart from `target()`, which a route calls only after its gate, exactly as before.

import type { RequestContext } from "remix/router";
import type { AuditEntry } from "../audit.ts";
import type { CacheWarnPane } from "../cache/watch-key.ts";
import { localWatchPane, peerWatchPane } from "../cache/watch-key.ts";
import { selectHostFrom, type HostSelector } from "../crew/registry.ts";
import { apiError, type ErrorCode } from "../error-codes.ts";
import { afterPaneInput, isPaneInput, type RouteCaller } from "../server.ts";
import type { SessionRuntime } from "../sessions.ts";
import type { BridgeHttp } from "./deps.ts";
import { browserGate } from "./middleware/guard.ts";
import { secure } from "./middleware/secure.ts";
import { jsonError } from "./respond.ts";

/**
 * The host selector every request takes when this collie has no trust store — i.e. the only one a
 * solo instance ever sees. Named rather than parsed so that on solo the `?host=` grammar is never
 * applied to a URL at all: not a lookup, not a regex, not a branch a client can steer (§11).
 */
export const LOCAL_HOST: HostSelector = { kind: "local" };

export interface RequestScope {
  readonly sessionName: string | undefined;
  readonly unknownSession: () => Response;
  readonly host: HostSelector;
  readonly watchTargetFor: (
    paneId: string,
    selector: HostSelector,
    session: string | undefined,
  ) => { pane: CacheWarnPane; error?: undefined } | { pane?: undefined; error: ErrorCode };
  readonly target: () => Promise<SessionRuntime | Response>;
}

/**
 * How the four session-scoped families (pane, tab, workspace, launch) are wired into a router.
 *
 * ONE SET OF ACTIONS, TWO CALLERS, NO SECOND HANDLER SET. A browser reaches them through the front
 * door's router; a LEAD reaches them through this collie's `/crew/v1/*` surface, which dispatches
 * into a router holding these very controllers (server.ts `serveSessionRoute`). What differs is only
 * who is asking, and where a request goes that no session route answers.
 */
export interface SessionWiring {
  /** The caller of this request: the browser ({@link browserCaller}), or the crew lead. */
  callerOf(context: RequestContext): RouteCaller;
  /** Where a request goes that no session route answers: the app shell, or "not a session route". */
  fallThrough(context: RequestContext): Response | Promise<Response>;
}

export function requestScope(deps: BridgeHttp, req: Request, url: URL): RequestScope {
  const { registry, audit, whois, crewLead, crewHandler, cache, localRuntime } = deps;
  const { pathname } = url;

  // Session-scoped routes accept an optional `?session=<name>`; absent → the primary session
  // (identical to pre-multi-session behaviour). The name is only ever a registry Map lookup — it
  // never builds a path. An unknown name is a 404. Global routes below ignore the param entirely.
  const sessionName = url.searchParams.get("session") ?? undefined;
  const unknownSession = () =>
    jsonError(
      apiError("session.unknown", { session: sessionName ?? "" }),
      404,
      req.headers.get("accept-encoding"),
    );

  // The host dimension of the `(host, session, paneId)` address (§4), read exactly where the
  // session name is and by the same rule: a client-supplied value that is ONLY ever a registry
  // key. Parsed only when this collie has a trust store — the same predicate the crew surface
  // mounts on — so a solo instance never applies the grammar to a URL and `?h=` stays a
  // parameter that provably does not exist there (§11).
  const host = crewHandler ? selectHostFrom(url) : LOCAL_HOST;

  /**
   * The watch identity behind `(host, session, paneId)`, or the reason there is none.
   *
   * THE BRIDGE IS THE ONLY PARTY THAT CAN DO THIS, which is the whole reason the routes speak an
   * address rather than a key: a phone can only ever name `(host, session, paneId)`, and the ref a
   * watch is keyed by is server-side only (`bridge/types.ts` § agentSession).
   *
   * It resolves WITHOUT FORWARDING. A peer's pane is read out of the body the lead's own sweep
   * last parsed (`CrewLead.contributions`), exactly as `bridge/crew/notify.ts` reads it, because
   * the preference belongs on the machine holding the subscription and a forward would store it on
   * the machine that cannot send.
   */
  const watchTargetFor = (
    paneId: string,
    selector: HostSelector,
    session: string | undefined,
  ): { pane: CacheWarnPane; error?: undefined } | { pane?: undefined; error: ErrorCode } => {
    if (selector.kind === "member") {
      const body = crewLead?.contributions().find((c) => c.state.memberId === selector.id)?.body;
      const wire = body?.agents.find((p) => p.paneId === paneId);
      if (wire === undefined) return { error: "cache.pane_unknown" };
      // A peer's pane carries no ref, so `hasSession` is what "names a session" means here — the
      // same flag the History affordance is gated on.
      if (wire.hasSession !== true) return { error: "cache.no_session" };
      const pane = peerWatchPane(wire, selector.id);
      return pane === undefined ? { error: "cache.no_session" } : { pane };
    }
    if (selector.kind !== "local") return { error: "cache.pane_unknown" };
    const rt = registry.get(session);
    if (!rt) return { error: "cache.pane_unknown" };
    const view = rt.engine.current().agents.find((p) => p.paneId === paneId);
    if (view === undefined) return { error: "cache.pane_unknown" };
    // The session is omitted for the primary, the omitted-not-null rule the push payload follows —
    // and it is read off the REGISTRY rather than off the query, so one pane has one key however
    // the caller spelled its address.
    const pane = localWatchPane(view, rt.isPrimary ? undefined : rt.name, (key) => cache?.get(key));
    return pane === undefined ? { error: "cache.no_session" } : { pane };
  };

  /**
   * The `(host, session)` target of a session-scoped route, or the Response refusing it.
   *
   * An unknown host is a 404, mirroring `unknownSession()` exactly (§4) — and so is an
   * ill-formed one, which is the shape a probe takes (a path, a URL, an IP). A *known* peer is
   * FORWARDED, and the peer's own answer is what comes back (§5, §9.1): the load-bearing part is
   * that it is never silently served from the LEAD's registry, because pane ids collide across
   * machines and `?h=laptop` + `w1:p1` must never type into the desk's `w1:p1`.
   *
   * The forward is the only asynchrony this adds, and it is why `target()` is async: a local
   * request does not await a thing it did not do — `registry.get` is still one Map lookup.
   */
  const target = async (): Promise<SessionRuntime | Response> => {
    if (host.kind !== "local") {
      const resolved = crewLead?.resolve(host, sessionName);
      if (resolved === undefined) {
        return jsonError(
          apiError("host.unknown", { host: host.kind === "member" ? host.id : host.raw }),
          404,
          req.headers.get("accept-encoding"),
        );
      }
      if (resolved.kind === "peer") {
        // An input forwarded to a member makes the member's engine hot there, and the LEAD's
        // too: the lead sees the member's panes only through its sweep, which rides this
        // engine's tick (CREW_PROTOCOL.md §10.1), so a cold lead would show the member's answer
        // up to one idle interval late.
        const input = isPaneInput(pathname, req.method);
        // The lead's own record of the forward (§12): one line, the same `action` the peer will
        // write, plus the target host — two independent logs of one event, neither depending on
        // the other machine's disk.
        const forwarded = secure(
          await crewLead!.forward(req, url, resolved, {
            device: whois(req).device,
            audit: (entry) => {
              // Assigned, never conditionally spread: an entry without a pane or session must
              // carry NO such key rather than record it as `undefined`.
              const row: AuditEntry = {
                action: entry.action,
                host: entry.host,
                device: whois(req).device,
                detail: { forwarded: entry.outcome },
              };
              if (entry.paneId !== undefined) row.paneId = entry.paneId;
              if (entry.session !== undefined) row.session = entry.session;
              audit.record(row);
            },
          }),
        );
        // The PRIMARY engine, because that is the one whose tick the sweep rides (index.ts).
        const own = registry.get()?.engine;
        return input && own !== undefined ? afterPaneInput(own, forwarded) : forwarded;
      }
      return resolved.runtime;
    }
    return localRuntime(sessionName, req.headers.get("accept-encoding"));
  };

  return { sessionName, unknownSession, host, watchTargetFor, target };
}

/**
 * The browser's {@link RouteCaller}: who is asking for a session-scoped route at this collie's front
 * door. The other one is the crew dispatch in server.ts; there must never be a third.
 *
 * ── ONE GATE EXPRESSION, SHARED BY NAME ──────────────────────────────
 * `browserGate` is the browser's whole authorisation story: `checkAccess` (host allowlist,
 * same-origin, Tailscale identity) plus, for a write, the device header AND the pairing
 * credential. Typing into a pane goes through it, and so does `POST /api/update` — the SAME
 * function (`browserGate` in ./middleware/guard.ts, which the update route's `gate("write")` calls),
 * never a second call that agrees today. Two authorisation
 * checks meant to be identical drift the moment one of them is edited, so there is only one
 * (spec M15/05; `server.test.ts` → "same device auth as pane input").
 */
export function browserCaller(deps: BridgeHttp, req: Request, url: URL): RouteCaller {
  const { cfg, pairing, whois, audit } = deps;
  const { target } = requestScope(deps, req, url);
  return {
    resolve: target,
    gate: browserGate(req, cfg, pairing),
    device: () => whois(req).device,
    audit,
  };
}
