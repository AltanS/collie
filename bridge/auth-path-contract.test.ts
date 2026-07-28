import { describe, expect, test } from "bun:test";

import { isReservedAuthPath } from "./server.ts";
import { isNetworkOnlyNavigation } from "../web/src/lib/sw-routes.ts";

// The `/auth/` reservation is implemented twice — once in the service worker's navigation denylist
// (web/src/lib/sw-routes.ts) and once in the bridge's request dispatch (isReservedAuthPath). Each
// side has its own tests, so either could be changed alone and stay green while the two drift, and
// drift is silent in the way that matters: the SW hands the navigation to the network, the bridge
// doesn't recognise it, the SPA fallback answers with the app shell, and the operator is back to
// staring at the UI they were trying to escape. That is issue #31 all over again.
//
// So run one shared list through BOTH and require them to agree. This is the only test that fails
// when someone edits one side and not the other. It imports across the bridge/web boundary on
// purpose: sw-routes.ts is pure (no DOM, no workbox), which is why it was split out at all.
//
// The inputs carry query strings because workbox matches the denylist against `pathname + search`;
// the bridge matches a parsed `pathname`, so it takes the same cases with the query stripped.
const CASES: { url: string; reserved: boolean }[] = [
  { url: "/auth", reserved: true },
  { url: "/auth/", reserved: true },
  { url: "/auth/sign-in", reserved: true },
  { url: "/auth/oidc/callback", reserved: true },
  { url: "/auth?rd=%2F", reserved: true },
  { url: "/auth/?next=/settings", reserved: true },
  { url: "/", reserved: false },
  { url: "/settings", reserved: false },
  { url: "/pane/w1:p1", reserved: false },
  { url: "/pane/w1:p1?s=demo", reserved: false },
  { url: "/space/w1", reserved: false },
  { url: "/authors", reserved: false },
  { url: "/authors?x=1", reserved: false },
];

describe("the /auth reservation agrees across the service worker and the bridge", () => {
  for (const { url, reserved } of CASES) {
    test(`${url} → ${reserved ? "reserved" : "Collie's"}`, () => {
      const pathname = url.split("?")[0]!;
      expect(isReservedAuthPath(pathname)).toBe(reserved);
      // The API is network-only too, but it is not part of the reservation, so only /auth cases
      // are expected to agree with the bridge — every case here is a navigation, not an API call.
      expect(isNetworkOnlyNavigation(url)).toBe(reserved);
    });
  }
});
