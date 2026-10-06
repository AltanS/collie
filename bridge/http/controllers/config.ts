// This collie's own configuration, and the two kinds of file it publishes beside it: the
// multiplexer's mark and the operator's typefaces. Not session-scoped, never forwarded: `config` is
// on `bridge/crew/forward.ts`'s not-forwarded list, because it is the request every page load makes
// and it must not be able to make the lead dial a machine.

import { createController } from "remix/router";
import { cacheRulesRoute, bridgeConfigBody, buildId, muxLogoResponse, operatorFontResponse } from "../../server.ts";
import { apiError } from "../../error-codes.ts";
import { resolveOperatorFont } from "../../operator-fonts.ts";
import { sttCapability } from "../../stt/http.ts";
import { OPERATOR_FONTS_PATH } from "../../types.ts";
import { IMAGE_EXTS, TEXT_EXTS } from "../../uploads.ts";
import type { BridgeHttp } from "../deps.ts";
import { gate } from "../middleware/guard.ts";
import { json, jsonError, text } from "../respond.ts";
import { requestScope } from "../scope.ts";
import { routes } from "../routes.ts";

export function configController(deps: BridgeHttp) {
  const {
    cfg,
    registry,
    push,
    crew,
    crewLead,
    stt,
    operatorCommands,
    operatorKeys,
    operatorQuickReplies,
    operatorFonts,
    operatorCacheRules,
  } = deps;
  return createController(routes.config, {
    actions: {
      // The rule catalog behind the cache chips, and the overrides this host applies. Gated exactly as
      // `/api/config` is — read-level, and through `guard` so COLLIE_PUBLIC_HOSTS covers it — because
      // it is the same kind of payload: Collie's own facts plus operator-authored text.
      cacheRules: {
        middleware: [gate(deps, "read")],
        handler({ request: req }) {
          return cacheRulesRoute(
            operatorCacheRules,
            req.headers.get("accept-encoding"),
            req.headers.get("if-none-match"),
          );
        },
      },
      // Any method, as it always answered.
      config: {
        middleware: [gate(deps, "read")],
        async handler({ request: req, url }) {
          const { host } = requestScope(deps, req, url);
          // Read-level, like the other non-terminal endpoints. Nothing Collie puts here is a
          // credential — the VAPID public key is handed to every browser by design — but the payload
          // is no longer entirely Collie's: operatorCommands is operator-authored text, and any read
          // client sees it verbatim (`.env.example` says so where it is set).
          // It was also the one route that skipped checkAccess entirely, so COLLIE_PUBLIC_HOSTS
          // didn't cover it and a rebound DNS name could still read the build id. The client only ever
          // calls this same-origin, and a refusal can't be mistaken for an outage: ConnectionBanner
          // short-circuits to AuthErrorBanner before its red-state probe runs. Noted in #32.
          // Re-read per request behind an mtime check, like buildId() — editing commands.toml is live,
          // with no restart. The path is cfg's, never the request's.
          const mine = await operatorCommands();
          const myKeys = await operatorKeys();
          const myReplies = await operatorQuickReplies();
          // Same mtime-checked re-read, same reason: an operator who adds a face to theme.toml wants
          // it in the picker on the next page load, not after a restart.
          const myFonts = await operatorFonts();
          // The PRIMARY session's adapter, because one collie drives one multiplexer: every session in
          // the registry is built by the same factory off the same `cfg.mux`, so which runtime answers
          // is not a choice. `?.` only because `get()` is total over a Map — the primary is created
          // eagerly in the constructor and never disposed.
          const activeMux = registry.get();
          // ── `?host=<member>`: THIS MEMBER's capability declaration (M22/03) ──────────────────
          //
          // Answered from what the lead already holds, and never forwarded: `config` is on
          // `bridge/crew/forward.ts`'s not-forwarded list and must stay there, because a config read
          // is the request every page load makes and it must not be able to make the lead dial a
          // machine. The lead learned the block from that member's last `hello`.
          //
          // The host selector is the one `target()` above already resolved, so an unknown or
          // ill-formed member id gets the same 404 every host-scoped route gives it. It is never
          // silently rewritten to the lead: quietly answering for a different machine is the exact
          // failure the host dimension exists to prevent.
          const scoped = host.kind === "local" ? undefined : crewLead?.resolve(host);
          if (host.kind !== "local" && scoped === undefined) {
            return jsonError(
              apiError("host.unknown", { host: host.kind === "member" ? host.id : host.raw }),
              404,
              req.headers.get("accept-encoding"),
            );
          }
          // A member that has published nothing answers with the LEAD's block, because absent means
          // "use the lead's" — which is byte for byte the reading the phone gives every pane today.
          // The lead's own entry resolves `local`, so it takes its own branch and its own adapter.
          const memberMux = scoped?.kind === "peer" ? crewLead?.muxFor(scoped.link.memberId) : null;
          // Re-resolved per request for the same reason `commands.toml` is: `collie stt setup` is
          // live, and this is where the phone learns whether to draw a microphone at all. `?? undefined`
          // because "no provider" must OMIT the key, never send a null one (CREW_PROTOCOL.md §11).
          const sttWire = (await sttCapability(await stt())) ?? undefined;
          return json(
            bridgeConfigBody({
              push: push.enabled,
              vapidPublicKey: push.publicKey,
              build: await buildId(),
              mode: crew.mode,
              operatorCommands: mine,
              operatorKeys: myKeys,
              operatorQuickReplies: myReplies,
              operatorFonts: myFonts,
              mux: activeMux?.herdr,
              // Assigned through `?? undefined` rather than conditionally, so the no-`host=` request
              // builds the byte-identical body it always did (CREW_PROTOCOL.md §11).
              muxWire: memberMux ?? undefined,
              stt: sttWire,
              // This host's own limits, read from cfg on every request like everything else here.
              // A crew member answers with ITS number, which is the number that will judge the bytes.
              upload: {
                maxBytes: cfg.maxUploadBytes,
                imageTypes: [...IMAGE_EXTS],
                textTypes: [...TEXT_EXTS, ...cfg.uploadExtraTypes],
              },
            }),
            req.headers.get("accept-encoding"),
          );
        },
      },
      muxLogo: {
        middleware: [gate(deps, "read")],
        handler({ request: req }) {
          // Read-level, exactly like the `/api/config` block that publishes its URL — an image the
          // header shows is part of the same answer, and gating it harder than the config that names
          // it would only ever produce a broken image beside a rendered name. Both device gates stay
          // where they are (writes), so a read-only device still sees the mark.
          // The PRIMARY session's adapter, for the reason `/api/config` gives: one collie drives one
          // multiplexer, so which runtime answers is not a choice.
          const logo = registry.get()?.herdr.logo;
          // 404 rather than an empty 200, and rather than a stand-in: an adapter with no mark
          // publishes no `logoUrl`, so nothing in a current client can even ask this. Reaching here
          // means a stale page holding a URL this bridge no longer serves — and "there is no picture"
          // is the true answer to that.
          if (logo === undefined) return text("this multiplexer has no logo", 404);
          return muxLogoResponse(logo, req.headers.get("if-none-match"));
        },
      },
      font: {
        middleware: [gate(deps, "read")],
        async handler({ request: req, url }) {
          const { pathname } = url;
          // Read-level, and in the Misc block beside the mux mark rather than in the session router:
          // this is a file THIS collie's operator declared, not a pane's, so there is nothing to
          // forward to a peer. Reads are ungated app-wide, so a read-only device still gets the face
          // it is set to — a picker whose choice cannot render is worse than no picker.
          // `decodeURIComponent` is undone here and NOWHERE ELSE, because what comes back is only ever
          // used as a Map key. It is looked UP in the rows theme.toml declared; a name nobody declared
          // is a 404 before any path exists. See bridge/operator-fonts.ts for the four-step order.
          let name: string;
          try {
            name = decodeURIComponent(pathname.slice(OPERATOR_FONTS_PATH.length));
          } catch {
            // A malformed percent-escape is not a name this bridge could have declared.
            return text("no such font", 404);
          }
          const real = await resolveOperatorFont(name, await operatorFonts(), cfg.fontsDir);
          // ONE answer for every refusal — undeclared, missing, escaped its directory, over the size
          // cap. A client must not be able to tell those apart, and a stale page holding a URL this
          // bridge no longer serves gets the true answer: there is no such file.
          if (real === null) return text("no such font", 404);
          const bytes = await Bun.file(real).bytes();
          return operatorFontResponse(bytes, req.headers.get("if-none-match"));
        },
      },
    },
  });
}
