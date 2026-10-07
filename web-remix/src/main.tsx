// The entry. Two boots, one per kind of document, and only one of them ever loads:
//
//   - AN ISLANDS DOCUMENT (S3, `experiments/remix-v3/ACTION-PLAN.md` B) carries
//     `<script type="application/json" id="collie-boot">`. Its boot (islands/boot.ts) hydrates the few
//     `clientEntry` islands the bridge drew and leaves the rest as server HTML; every island arrives as
//     its own chunk through `loadModule` (islands/registry.ts).
//   - ANYTHING ELSE (the static shell: offline, the service worker's fallback, a refused gate, a route
//     the bridge does not render; or the S1/S2 `AppRoot` document under `?islands=0`) boots the SPA,
//     which is a separate chunk (spa-boot.tsx) the islands boot never requests.
//
// The polyfills go first, before either runtime starts (lib/polyfills.ts).
import "./app.css";

import { installPolyfills } from "./lib/polyfills";
import { bootIslands } from "./islands/boot";
import { BOOT_SCRIPT_ID } from "./islands/document-data";

installPolyfills();

if (document.getElementById(BOOT_SCRIPT_ID) !== null) {
  // In the entry itself, not a chunk: an islands document starts here, and a chunk would be one more
  // request in series before the first island can load.
  await bootIslands();
} else {
  const { bootSpa } = await import("./spa-boot");
  await bootSpa();
}
