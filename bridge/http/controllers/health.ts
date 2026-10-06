// `GET /api/health` (M15/04): is this collie up, and WHICH BUILD is answering? The detached updater
// polls it after a restart, and the version is the whole point — a service that came back on the OLD
// code answers fine, and a gate that only asked "did it answer" would call that a successful update.
//
// UNGATED, and deliberately the only `/api/*` route that is. The prober is a local process holding no
// pairing credential and no device header — it is the updater, running as the same user, before
// anybody has a browser open. What it discloses is the version, to a caller that has already reached a
// loopback-bound listener behind the operator's own front door; the same string is on every response
// as `X-Collie-Build`. It grants nothing, mutates nothing and reads no session.
//
// It is a ROUTE, so it runs after every router middleware, the deposed page included: a DEPOSED
// collie must FAIL this check (`bridge/crew/deposed.ts`), and it does so by answering its one page
// instead. That is why a deposed peer can never be mistaken for a successful update.
//
// An any-method route: the handler answers a wrong method itself, with the 405 it always gave.

import type { RequestHandler } from "remix/router";
import { healthBody } from "../../server.ts";
import type { BridgeHttp } from "../deps.ts";
import { json, text } from "../respond.ts";

export function healthAction(deps: BridgeHttp): RequestHandler {
  const { opts, crew } = deps;
  return ({ request: req }) => {
    if (req.method !== "GET" && req.method !== "HEAD") return text("method not allowed", 405);
    return json(healthBody(opts.version, crew.mode), req.headers.get("accept-encoding"));
  };
}
