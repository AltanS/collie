// Push, snooze, prefs and the per-pane half of the cache warning (ADR 0042). All read-level:
// managing your own notifications does not drive a terminal.
//
// THE CACHE-WATCH ROUTES ARE QUERY-ADDRESSED AND NONE OF THEM IS FORWARDABLE. `?host=` names the
// machine the PANE lives on; the preference itself always lives on the collie the phone is talking to,
// because that is the only machine holding a push subscription (CREW_PROTOCOL.md §5). A segment on the
// pane route would have been forwarded to the peer and stored there, where nothing can send.

import { createController } from "remix/router";
import { apiError } from "../../error-codes.ts";
import type { JsonValue } from "../../json.ts";
import {
  cacheWatchable,
  guard,
  isPushSubscription,
  parseCacheWatchForget,
  parseCacheWatchRequest,
  parseNotifyPrefsPatch,
  parseSnoozeRequest,
  supersededEndpoint,
} from "../../server.ts";
import { herdTagFor } from "../../sessions.ts";
import type { BridgeHttp } from "../deps.ts";
import { gate } from "../middleware/guard.ts";
import { secure } from "../middleware/secure.ts";
import { json, jsonError, text } from "../respond.ts";
import { requestScope } from "../scope.ts";
import { routes } from "../routes.ts";

export function notificationsController(deps: BridgeHttp) {
  const {
    opts,
    cfg,
    pairing,
    registry,
    push,
    snooze,
    notifyPrefs,
    peerNotifier,
    cacheWatchBody,
    cacheWatchListBody,
  } = deps;
  return createController(routes.notifications, {
    actions: {
      // Read-level: registering for push isn't terminal-driving, so a read-only device may still
      // subscribe to notifications.
      subscribe: {
        middleware: [gate(deps, "read")],
        async handler({ request: req }) {
          // Read-level: registering for push isn't terminal-driving, so a read-only device may still
          // subscribe to notifications.
          let body: JsonValue;
          try {
            // SAFETY: `Request.json()` output IS a JsonValue by construction; `isPushSubscription`
            // checks every field this route stores before a byte of it is persisted.
            body = (await req.json()) as JsonValue;
          } catch {
            return text("bad subscription", 400);
          }
          if (!isPushSubscription(body)) return text("bad subscription", 400);
          await push.addSubscription(body, {
            replaces: supersededEndpoint(body),
            userAgent: req.headers.get("user-agent") ?? undefined,
          });
          return secure(new Response(null, { status: 204 }));
        },
      },
      // Managing your own notification quiet-hours isn't terminal-driving — read-level, like subscribe.
      snooze: {
        middleware: [gate(deps, "read")],
        async handler({ request: req }) {
          // Managing your own notification quiet-hours isn't terminal-driving — read-level, like subscribe.
          let body: JsonValue;
          try {
            // SAFETY: `Request.json()` output IS a JsonValue by construction; `snoozedUntil` is
            // checked to be a number (or null) below before it is stored.
            body = (await req.json()) as JsonValue;
          } catch {
            return text("bad request", 400);
          }
          const parsed = parseSnoozeRequest(body);
          if (!parsed.ok) return text("bad snoozedUntil", 400);
          await snooze.set(parsed.until);
          // Snoozing should also clear whatever's already on the lock screen — across every session,
          // since snooze is bridge-wide. Each session owns its own notification slot (tag).
          if (snooze.isMuted()) {
            for (const rt of registry.all()) {
              void push.send({ type: "clear", tag: herdTagFor(rt.isPrimary, rt.name) });
            }
            // …and across every peer's slot. A snooze that only quiets the lead's own sessions is the
            // bug the operator finds at 3am. Nothing is asked of the peer to make this work: the lead
            // raised those alerts and owns the subscription, so an unreachable peer is irrelevant here
            // — there is no policy to deliver and nothing to queue for reconnect (§5).
            for (const tag of peerNotifier?.tags() ?? []) void push.send({ type: "clear", tag });
          }
          return json({ snoozedUntil: snooze.until() }, req.headers.get("accept-encoding"));
        },
      },
      // Any method. The gate is inside, per method, and a third method is a 405 with no gate at all,
      // as it always was — so this route keeps its gate inline.
      async prefs({ request: req }) {
        // Which agent statuses push (bridge-wide). Read-level like snooze — managing your own
        // notification preferences isn't terminal-driving.
        if (req.method === "GET") {
          const denied = guard(req, cfg, "read", pairing);
          if (denied) return denied;
          return json(notifyPrefs.current(), req.headers.get("accept-encoding"));
        }
        if (req.method === "POST") {
          const denied = guard(req, cfg, "read", pairing);
          if (denied) return denied;
          let body: JsonValue;
          try {
            // SAFETY: `Request.json()` output IS a JsonValue by construction;
            // `parseNotifyPrefsPatch` rejects anything that is not three optional booleans.
            body = (await req.json()) as JsonValue;
          } catch {
            return text("bad request", 400);
          }
          const patch = parseNotifyPrefsPatch(body);
          if (!patch) return text("bad prefs", 400);
          const updated = await notifyPrefs.set(patch);
          // Prefs may have just disabled a kind — retract any pending/outstanding alerts of it, in
          // every live session (prefs are bridge-wide; each session has its own coordinator).
          for (const rt of registry.all()) rt.notifications.applyPrefs();
          // Same fan, one dimension out — a disabled kind must retract on every host, not just here.
          peerNotifier?.applyPrefs();
          return json(updated, req.headers.get("accept-encoding"));
        }
        return text("method not allowed", 405);
      },
      // Any method, gated first; GET and POST answer, anything else is the handler's own 405.
      cacheWatch: {
        middleware: [gate(deps, "read")],
        async handler({ request: req, url }) {
          const { sessionName, host, watchTargetFor } = requestScope(deps, req, url);
          const watch = opts.cacheWatch;
          if (!watch) return text("not found", 404);
          const paneId = url.searchParams.get("pane");
          // A malformed REQUEST is refused the way the prefs block above refuses one: in plain text, with
          // no code. A code is for a refusal the phone has to explain to the operator, and "you forgot a
          // query parameter" is a bug in the caller. The two refusals below are the explainable ones.
          if (paneId === null || paneId === "") return text("bad request", 400);
          const found = watchTargetFor(paneId, host, sessionName);
          if (found.error !== undefined) {
            const status = found.error === "cache.pane_unknown" ? 404 : 409;
            return jsonError(apiError(found.error, { paneId }), status, req.headers.get("accept-encoding"));
          }
          if (req.method === "POST") {
            let body: JsonValue;
            try {
              // SAFETY: `Request.json()` output IS a JsonValue by construction; `parseCacheWatchRequest`
              // rejects anything that is not a single boolean `on`.
              body = (await req.json()) as JsonValue;
            } catch {
              return text("bad request", 400);
            }
            const parsed = parseCacheWatchRequest(body);
            if (parsed === null) return text("bad on", 400);
            // The 409 a race earns: the GET already reported `watchable: false` and the sheet already
            // disabled the switch, so the ordinary operator never sees this. It exists for the tap that
            // lands after the harness dropped its session, where accepting would leave a switch that lies.
            if (parsed.on && !cacheWatchable(found.pane)) {
              return jsonError(apiError("cache.no_session", { paneId }), 409, req.headers.get("accept-encoding"));
            }
            await watch.set(found.pane, found.pane.label, parsed.on);
          } else if (req.method !== "GET") {
            return text("method not allowed", 405);
          }
          return json(cacheWatchBody(watch, found.pane), req.headers.get("accept-encoding"));
        },
      },
      cacheWatchList: {
        middleware: [gate(deps, "read")],
        handler({ request: req }) {
          const watch = opts.cacheWatch;
          if (!watch) return text("not found", 404);
          return json(cacheWatchListBody(watch), req.headers.get("accept-encoding"));
        },
      },
      cacheWatchForget: {
        middleware: [gate(deps, "read")],
        async handler({ request: req }) {
          const watch = opts.cacheWatch;
          if (!watch) return text("not found", 404);
          let body: JsonValue;
          try {
            // SAFETY: as above — `parseCacheWatchForget` rejects anything but a non-empty string `id`.
            body = (await req.json()) as JsonValue;
          } catch {
            return text("bad request", 400);
          }
          const id = parseCacheWatchForget(body);
          if (id === null) return text("bad id", 400);
          // An id naming no entry is NOT an error: removing something already gone is the outcome the
          // operator asked for, and the answer is the list either way.
          await watch.forget(id);
          return json(cacheWatchListBody(watch), req.headers.get("accept-encoding"));
        },
      },
    },
  });
}
