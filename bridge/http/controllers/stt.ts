// Speech-to-text (bridge/stt/). WRITE-gated, exactly like typing into a pane — and for the same
// reason. This route's whole purpose is to put words in the composer, and the audio leaves the host
// for an operator-configured endpoint. A read-only device watches; it does not speak.

import type { Action } from "remix/router";
import { transcribeRequest } from "../../stt/http.ts";
import type { BridgeHttp } from "../deps.ts";
import { gate } from "../middleware/guard.ts";
import { secure } from "../middleware/secure.ts";
import type { routes } from "../routes.ts";

export function sttAction(deps: BridgeHttp): Action<typeof routes.stt> {
  const { audit, whois, stt, sttAdmission } = deps;
  return {
    middleware: [gate(deps, "write")],
    async handler({ request: req }) {
      // WRITE-gated, exactly like typing into a pane — and for the same reason. This route's whole
      // purpose is to put words in the composer, and the audio leaves the host for an
      // operator-configured endpoint. A read-only device watches; it does not speak.
      // Deliberately NOT session- or pane-scoped: the transcript is text handed back to the
      // phone, which then decides what to do with it. Nothing here touches a terminal, so there is
      // no pane to attribute it to and no `x-collie-seen` meaning to claim.
      const { response, attempt } = await transcribeRequest(await stt(), req, sttAdmission);
      // One line per attempt, and route metadata only: the recording, the transcript and the
      // provider's own words never reach the audit log.
      audit.record({ action: "stt", device: whois(req).device, detail: { ...attempt } });
      return secure(response);
    },
  };
}
