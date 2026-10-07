// The pane family, "look now" and journal blobs: session-scoped routes, answered for a browser at the
// front door and for a crew lead through `/crew/v1/*` by these same actions (CREW_PROTOCOL.md §5).
// What differs between the two is only the caller (`SessionWiring`, ../scope.ts).

import { createController, type RequestContext } from "remix/router";
import type { ActionResponse } from "../../types.ts";
import {
  afterPaneInput,
  blobRoute,
  closePane,
  filesPrivateFolders,
  focusPane,
  isPaneReadAction,
  keysPane,
  marksPaneSeen,
  paneChanges,
  paneChat,
  paneFiles,
  paneGateLevel,
  paneHistory,
  readPane,
  renamePane,
  replyPane,
  uploadPane,
  type RouteCaller,
} from "../../server.ts";
import type { BridgeHttp } from "../deps.ts";
import { json, text } from "../respond.ts";
import { routes } from "../routes.ts";
import { browserCaller, type SessionWiring } from "../scope.ts";

/** The action segment of a pane route; absent for the pane itself. */
type PaneAction =
  | "reply"
  | "keys"
  | "upload"
  | "close"
  | "rename"
  | "history"
  | "chat"
  | "changes"
  | "files"
  | "focus";

/**
 * ── Per-pane read / send ──
 * One body for the pane and all ten of its actions, as `PANE_ROUTE` had one. Each action is its own
 * route (../routes.ts), so an unknown action segment matches none of them and falls through to the
 * app shell, as it did when the regex refused it. Every route takes any method: a wrong one is this
 * body's own 405, after the gate. Module level, so the pane frames (./frames.ts) and the server
 * document (./document.ts) read a pane through exactly this path, gate, seen mark and crew forward
 * included, with no HTTP hop.
 */
async function paneRoute(
  deps: BridgeHttp,
  caller: RouteCaller,
  req: Request,
  url: URL,
  rawPaneId: string,
  routeAction: PaneAction | undefined,
): Promise<Response> {
  const { cfg, activity, journals, transcripts, live } = deps;
  const paneId = decodeURIComponent(rawPaneId);
  const action = routeAction;
  // Reading a pane is allowed for any access-gated client; every action (reply/keys/upload/
  // close) types into or restructures a terminal, so it additionally needs an authorised device.
  // `history` and `changes` are READS despite being action segments — one reads a log off disk,
  // the other runs read-only git over the pane's folder.
  const isRead = !action || isPaneReadAction(action);
  // `files` is a read that still needs an authorised device (ADR 0083); see paneGateLevel.
  const denied = caller.gate(paneGateLevel(action));
  if (denied) return denied;
  const rt = await caller.resolve();
  if (rt instanceof Response) return rt;
  const { herdr, name: session } = rt;
  // You are in this pane: reading it, replying, sending keys, browsing its history. That is
  // the whole definition of "seen" (.adr/0003), and this is the one place every such request
  // passes through. It cannot false-positive from background polling — the dashboard loader
  // only ever fetches /api/snapshot; paneLoader is the sole reader of pane text — nor from a
  // cross-site request forged at a guessed pane id (see marksPaneSeen).
  //
  // Gated on the request actually being ROUTED below. PANE_ROUTE constrains `action` to the
  // known set, so the only way to reach here unrouted is a method mismatch (a GET at /reply, a
  // POST at /history) — which 405s. Without this a malformed request still marked the pane seen.
  //
  // ── AND IT IS RECORDED EXACTLY ONCE, ON THE OWNING HOST ────────────────
  // A pane on a peer never reaches this line on the LEAD: `caller.resolve()` returned the peer's
  // forwarded response above. It reaches it on the PEER, through the crew dispatch, against the
  // peer's own ledger — which is what makes "seen" one shared fact (.adr/0003) rather than two
  // machines' guesses, and why the `x-collie-seen` header is forwarded verbatim.
  const routed = isRead ? req.method === "GET" : req.method === "POST";
  if (routed && marksPaneSeen(req, action)) activity.noteSeen(session, paneId);
  // A pane request means a phone is looking at this collie — the second of the two routes that
  // stamp attention (state-engine.ts § noteAttention). It is stamped HERE rather than at the
  // browser's dispatch so that a pane the lead FORWARDED to a peer counts on the peer, where
  // the census that attention tightens actually runs.
  if (routed) rt.engine.noteAttention();
  // Every action is a write; attribute it to the authorised device for the audit trail.
  // `history` is a read, so it gets no device attribution (nothing is written to attribute).
  const device = isRead ? null : caller.device();
  const audit_ = caller.audit;

  if (!action && req.method === "GET") return readPane(herdr, cfg, paneId, url, req);
  if (action === "history" && req.method === "GET")
    return paneHistory(cfg, journals, transcripts, rt.engine, paneId, url, req);
  if (action === "chat" && req.method === "GET")
    return paneChat(cfg, journals, live, rt.engine, paneId, url, req);
  if (action === "changes" && req.method === "GET") return paneChanges(rt.engine, paneId, url, req);
  if (action === "files" && req.method === "GET")
    return paneFiles(rt.engine, paneId, url, req, filesPrivateFolders(cfg));
  // A landed input makes the engine hot for a few polls (§ isPaneInput). On a member this runs
  // through the crew dispatch, so the member that owns the pane is the one that goes hot.
  if (action === "reply" && req.method === "POST")
    return afterPaneInput(rt.engine, await replyPane(herdr, cfg, paneId, req, audit_, device, session));
  if (action === "keys" && req.method === "POST")
    return afterPaneInput(rt.engine, await keysPane(herdr, cfg, paneId, req, audit_, device, session));
  if (action === "upload" && req.method === "POST") return uploadPane(cfg, paneId, req, audit_, device, session);
  if (action === "close" && req.method === "POST") return closePane(herdr, rt.engine, paneId, req, audit_, device, session);
  if (action === "rename" && req.method === "POST") return renamePane(herdr, rt.engine, paneId, req, audit_, device, session);
  if (action === "focus" && req.method === "POST") return focusPane(herdr, rt.engine, paneId, req, audit_, device, session);
  return text("method not allowed", 405);
}

/**
 * The browser's GET of one pane's mirror, `/api/pane/:paneId` at `url`, answered by the pane route
 * itself: the read gate, the seen mark (when `req` carries `x-collie-seen`), the attention stamp and
 * the crew forward all as for the browser's own JSON poll. `rawPaneId` is the path segment as sent.
 */
export function browserPaneRead(deps: BridgeHttp, req: Request, url: URL, rawPaneId: string): Promise<Response> {
  return paneRoute(deps, browserCaller(deps, req, url), req, url, rawPaneId, undefined);
}

export function paneController(deps: BridgeHttp, wiring: SessionWiring) {
  const { cfg, refreshes, lookNow } = deps;
  const pane =
    (routeAction?: PaneAction) =>
    (context: RequestContext<{ paneId: string }>): Promise<Response> =>
      paneRoute(deps, wiring.callerOf(context), context.request, context.url, context.params.paneId, routeAction);

  return createController(routes.pane, {
    actions: {
      // ── "Look now" ──
      async refresh(context) {
        const caller = wiring.callerOf(context);
        const req = context.request;
        const denied = caller.gate("read");
        if (denied) return denied;
        const rt = await caller.resolve();
        if (rt instanceof Response) return rt;
        // A refresh is a phone asking to be shown something, which is attention by any reading.
        rt.engine.noteAttention();
        await refreshes.run(rt.name, () => lookNow(rt));
        return json({ ok: true } satisfies ActionResponse, req.headers.get("accept-encoding"));
      },
      // ── Blobs: the bytes a pi/omp journal named (`resolveImageUrl` in journal/pi.ts) ──
      async blob(context) {
        const caller = wiring.callerOf(context);
        const req = context.request;
        const denied = caller.gate("read");
        if (denied) return denied;
        const rt = await caller.resolve();
        if (rt instanceof Response) return rt;
        let hash: string;
        try {
          hash = decodeURIComponent(context.params.hash);
        } catch {
          return text("malformed URL", 400);
        }
        return blobRoute(hash, cfg.journalRoots.pi, req.headers.get("if-none-match"));
      },
      read: pane(),
      reply: pane("reply"),
      keys: pane("keys"),
      upload: pane("upload"),
      close: pane("close"),
      rename: pane("rename"),
      history: pane("history"),
      chat: pane("chat"),
      changes: pane("changes"),
      files: pane("files"),
      focus: pane("focus"),
    },
  });
}
