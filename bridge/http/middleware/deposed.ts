// A DEPOSED collie serves one page and fails its health check (§18.12). It runs AFTER the federated
// surface on purpose: the machine that just deposed this one must still be able to reach
// `/crew/v1/*` here — that is how it was told, and how it will be told again — while the app, the PWA
// and `/api/*` are gone. Every route after this middleware is the front door, and a deposed collie
// has none.
//
// The paths it owns are declared in `bridge/crew/deposed.ts`, so the route table names none of them.

import type { Middleware } from "remix/router";
import type { StartServerOptions } from "../../server.ts";
import { secure } from "./secure.ts";

export function deposedPage(opts: StartServerOptions): Middleware {
  return (context, next) => {
    const req = context.request;
    const url = context.url;
    const deposedAnswer = opts.deposed?.(req, url);
    if (deposedAnswer) return secure(deposedAnswer);
    return next();
  };
}
