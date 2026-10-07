// The service worker is web/'s own, reused as it stands: it imports nothing from React, and
// workbox-build fills the `self.__WB_MANIFEST` it reads with this build's precache list.
//
// One addition, imported FIRST so its fetch listener runs before Workbox's: `/` and `/pane/:paneId`
// navigations try the bridge's server document before the precached shell (sw-document.ts).
import "./sw-document.ts";
import "../../web/src/sw.ts";
