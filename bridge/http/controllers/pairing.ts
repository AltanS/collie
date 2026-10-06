// Device pairing (bridge/pairing.ts): the bootstrap claim, the device list, and a revoke. Each keeps
// its gate inline, because each answers 503 first when pairing is unavailable.

import { createController } from "remix/router";
import { apiError } from "../../error-codes.ts";
import type { JsonValue } from "../../json.ts";
import { bearerToken, normalizeLabel, toDeviceWire } from "../../pairing.ts";
import { asJsonRecord, checkAccess, guard, PAIRING_ERROR_CODES, parsePairRequest } from "../../server.ts";
import type { BridgeHttp } from "../deps.ts";
import { json, jsonError, text } from "../respond.ts";
import { routes } from "../routes.ts";

export function pairingController(deps: BridgeHttp) {
  const { cfg, pairing, audit, whois } = deps;
  return createController(routes.pairing, {
    actions: {
      async pair({ request: req }) {
        if (!pairing) return text("pairing unavailable", 503);
        // THE BOOTSTRAP, and the one write-shaped route that is deliberately not write-gated: a
        // device that has never paired holds no token, so gating this on one would make pairing
        // unreachable. It is not ungoverned — `checkAccess(…, "write")` still demands a same-origin
        // `Origin` (so no cross-site page can drive it), and the credential it hands out is worthless
        // without a code the operator read off their own terminal in the last ten minutes, behind a
        // five-attempt counter. The header device gate is skipped for the same reason and with the
        // same reasoning: it answers "is this device allowlisted", which is the question pairing
        // exists to stop asking.
        const gate = checkAccess(req, cfg, "write");
        if (!gate.ok) return text(gate.reason, 403);
        let body: JsonValue;
        try {
          // SAFETY: `Request.json()` output IS a JsonValue by construction; `parsePairRequest`
          // re-checks every field of it before any of it is used.
          body = (await req.json()) as JsonValue;
        } catch {
          return jsonError(apiError("pairing.bad_request"), 400, req.headers.get("accept-encoding"));
        }
        const parsed = parsePairRequest(body);
        if (!parsed) {
          return jsonError(apiError("pairing.bad_request"), 400, req.headers.get("accept-encoding"));
        }
        const claimed = await pairing.claim(parsed.code, parsed.label);
        if (!claimed.ok) {
          // Every failure is one status and one machine-readable reason; the client turns the reason
          // into the sentence that says what to do next. No timing or count is leaked back — the
          // attempts remaining are the operator's business, on the operator's terminal.
          // The `error` string is still the bare reason word it has always been — the catalogue
          // entry for each pairing code IS that word — so `recoverPairFailure` in the web app keeps
          // matching it byte for byte while `code` says the same thing the way every other surface
          // now says it.
          return jsonError(
            apiError(PAIRING_ERROR_CODES[claimed.reason]),
            400,
            req.headers.get("accept-encoding"),
          );
        }
        audit.record({ action: "pair", device: parsed.label, detail: { label: parsed.label } });
        // The ONLY time this token exists outside the requesting device. Nothing stores it here.
        return json({ token: claimed.token, label: parsed.label }, req.headers.get("accept-encoding"));
      },
      devices({ request: req }) {
        if (!pairing) return text("pairing unavailable", 503);
        // Read-level, so an unpaired device can still see whether pairing is on and which devices
        // hold credentials. Labels are the operator's own names for their own phones; the token
        // hashes never reach this shape (see toDeviceWire).
        const denied = guard(req, cfg, "read", pairing);
        if (denied) return denied;
        const current = pairing.resolve(bearerToken(req.headers))?.label ?? null;
        return json(
          { enforced: pairing.enforced(), current, devices: toDeviceWire(pairing.registry(), current) },
          req.headers.get("accept-encoding"),
        );
      },
      async revoke({ request: req }) {
        if (!pairing) return text("pairing unavailable", 503);
        // A write: revoking is exactly as consequential as typing into a terminal, so it needs a
        // paired device (and the header gate, if configured). Revoking YOURSELF is allowed — that is
        // how a device un-pairs — and it is the last device leaving that switches enforcement back
        // off, which is the only way this feature can't strand an operator.
        const denied = guard(req, cfg, "write", pairing);
        if (denied) return denied;
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return jsonError(apiError("pairing.bad_request"), 400, req.headers.get("accept-encoding"));
        }
        // SAFETY: `body` is this handler's own `req.json()` output — a JsonValue by construction;
        // `normalizeLabel` refuses anything that is not a usable string.
        const label = normalizeLabel(asJsonRecord(body as JsonValue)?.label);
        if (label === null) {
          return jsonError(apiError("pairing.bad_request"), 400, req.headers.get("accept-encoding"));
        }
        if (!(await pairing.revoke(label))) {
          return jsonError(apiError("device.unknown"), 404, req.headers.get("accept-encoding"));
        }
        audit.record({ action: "device.revoke", device: whois(req).device, detail: { label } });
        const current = pairing.resolve(bearerToken(req.headers))?.label ?? null;
        return json(
          { enforced: pairing.enforced(), current, devices: toDeviceWire(pairing.registry(), current) },
          req.headers.get("accept-encoding"),
        );
      },
    },
  });
}
