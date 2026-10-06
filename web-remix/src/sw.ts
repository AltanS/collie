// The service worker is web/'s own, reused as it stands: it imports nothing from React, and
// workbox-build fills the `self.__WB_MANIFEST` it reads with this build's precache list.
import "../../web/src/sw.ts";
