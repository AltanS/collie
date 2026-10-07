// `/api/snapshot`: the live state every open client polls.
//
// It answers any method, as it always has. It carries no ETag: the body changes on every poll (`ts`),
// so the old route never sent one and never read `If-None-Match`, and neither does this one. The
// header it does carry is the build id, so an open client notices a live rebuild between polls.

import type { RequestHandler } from "remix/router";
import { snapshotPlan } from "../../crew/merge.ts";
import { checkAccess, buildId, withBuildHeader } from "../../server.ts";
import { selectView } from "../../sessions.ts";
import type { BridgeHttp } from "../deps.ts";
import type { SnapshotResponse } from "../../types.ts";
import { json, text } from "../respond.ts";
import { requestScope } from "../scope.ts";

/**
 * The snapshot body `req` may read at `url` (the `/api/snapshot` URL with its scope query), or the
 * refusal the route answers instead (403 for the access gate, 404 for an unknown session). The route
 * below serialises it; the server document (./document.ts) renders from it, with no HTTP hop.
 */
export function snapshotFor(deps: BridgeHttp, req: Request, url: URL): SnapshotResponse | Response {
  const { cfg, registry, whois, crewLead, localSnapshot } = deps;
  const { sessionName, unknownSession, host } = requestScope(deps, req, url);
  const gate = checkAccess(req, cfg);
  if (!gate.ok) return text(gate.reason, 403);
  const device = whois(req);
  // A BROWSER poll is a phone looking; the lead's own sweep of a peer is not, which is why
  // this stamp sits here rather than inside `localSnapshot` (that closure also serves
  // `/crew/v1/snapshot`, and a lead sweeps on its own clock whether or not anybody is reading
  // it — stamping there would pin every peer at `watched` for the life of the crew). A server
  // document is a phone looking too.
  registry.get(sessionName)?.engine.noteAttention();
  // `?sessions=all` WIDENS the pane lists to every session on ONE machine (see localSnapshot).
  // One exact spelling and nothing else is accepted: the parameter is a switch, not a list, and
  // a typo must read as "no" rather than as some third behaviour. It does NOT replace
  // `?session=` — the named session still decides `bridge`, `workspaces`, `tabs` and the 404
  // below, so a widened view of an unknown session is still an unknown session.
  //
  // WHICH MACHINE is the other half, and the two compose (M22/06). `?host=` was resolved above
  // for every session-scoped route; this route is the one that answers from the lead's own
  // registry plus its CACHE of every member, so it never forwards and it reads the host here
  // rather than through the gate. No host, or the lead, and the view lands on this collie's own
  // registry exactly as it always has — which is the only body a solo install can get, because
  // it cannot emit the parameter at all (§11). A member, and the view lands on that member's
  // cached body at the merge instead, where `narrowPeerBody` applies it.
  const plan = snapshotPlan(host.kind === "member" ? host.id : null, selectView(url));
  const body = localSnapshot(plan.local.session, device.enforced ? device : null, plan.local.widen);
  if (!body) return unknownSession();
  // The ONE place the lead re-serialises (§9.2). With no crew this is the identity function's
  // absence: `body` goes out as assembled, same keys, same order, same bytes, same ETag.
  // The merged body's ETag is then the lead's own assertion about its own merged view — a
  // peer's ETag is never recomputed here, because no peer body is re-hashed on this path.
  return crewLead ? crewLead.merge(body, plan) : body;
}

export function snapshotAction(deps: BridgeHttp): RequestHandler {
  return async ({ request: req, url }) => {
    const body = snapshotFor(deps, req, url);
    if (body instanceof Response) return body;
    // Tag every snapshot poll with the on-disk build id so an open client notices a live rebuild
    // between polls — the no-service-worker self-update path (web/src/lib/self-update.ts).
    return withBuildHeader(json(body, req.headers.get("accept-encoding")), await buildId());
  };
}
