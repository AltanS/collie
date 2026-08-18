// Applies a pinned theme to <html> before first paint, so an explicit Light/Dark choice never
// flashes the other one on a cold load.
//
// Deliberately NOT part of the bundle: it has to run before the module graph loads. A same-origin
// <script src> is already permitted by the app's `script-src 'self'` CSP (bridge/server.ts), so
// this needs no policy change — which is the whole reason it's a file rather than an inline script.
//
// Users on System — the default — don't need this at all: `color-scheme: light dark` in index.css
// gets their first paint right with no JavaScript whatsoever. This is only for the pinned case.
//
// It does exactly one thing: add the pin class. Removing a stale class and reconciling the
// theme-color metas belong to hooks/use-theme.ts at runtime. Pre-paint DOM mutation is how a
// four-line script turns into a liability.
//
// Storage is a BARE string, not JSON — hooks/use-theme.ts must agree. JSON.stringify would write
// `"dark"` *with* the quote characters, the strict compare below would reject it, and the anti-flash
// would silently stop firing with nothing failing a test.
(function () {
  try {
    var t = localStorage.getItem("collie:theme:v1");
    if (t === "dark" || t === "light") document.documentElement.classList.add(t);
  } catch {
    // Safari private mode throws on localStorage. Falling through leaves `color-scheme: light dark`
    // in charge, which follows the OS — the right default anyway.
  }
})();
