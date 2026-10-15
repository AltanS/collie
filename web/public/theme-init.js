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
// It only ever ADDS a class. Removing a stale one, reconciling the theme-color metas, and every
// other runtime concern belong to hooks/use-theme.ts and src/lib/design.ts. Pre-paint DOM mutation
// is how a four-line script turns into a liability, so the rule here is: read a key, check it
// against a closed list, add a class, and do nothing else whatsoever.
//
// Storage is a BARE string, not JSON — hooks/use-theme.ts must agree. JSON.stringify would write
// `"dark"` *with* the quote characters, the strict compare below would reject it, and the anti-flash
// would silently stop firing with nothing failing a test.
//
// IT NOW DOES A SECOND, IDENTICAL THING: the UI typeface (ADR 0033). Same shape, same reason — a
// reader who chose Aldrich must not watch the app paint in Space Grotesk and then change voice. The
// two are kept in one file because they are one job (get the root classes right before paint) and
// because a second blocking <script> in <head> costs a round trip on the phone this app is for.
//
// UNLIKE THE THEME, the typeface is stored as JSON — `collie:design:v1` holds an object because it
// is the seed of theming and will grow siblings (src/lib/design.ts's header says why). So this one
// parses defensively and validates the result against a CLOSED LIST before the string is allowed to
// become a class name. The list is spelled here rather than derived, because this file can import
// nothing; src/lib/design.ts holds the twin and `design.test.ts` reads BOTH files and fails if the
// key name or the class names drift apart.
//
// OPERATOR FACES GET NO PRE-PAINT PATH, deliberately. Their `@font-face` needs a family name only
// /api/config knows, so there is nothing this script could do before the network answers. A device
// set to one paints in the default shipped stack for one frame and is reconciled at store init —
// which is also exactly what it does offline, forever, without losing the preference.
//
// IT NOW DOES A THIRD THING: the colour theme (M57). A device that picked a theme must not watch the
// app paint in Collie's colours first. The id is the `theme` field of the same design blob.
//   * A shipped id sets `data-theme`, and the value written is the entry of SHIPPED below, never the
//     stored string. `collie` is not in the list: the default theme writes nothing at all.
//   * An imported id is looked up in the library (`collie:themes:v1`). Each name in TOKENS, the closed
//     list, is set as an inline property when BOTH halves hold a value that matches COLOUR. Nothing
//     is taken from the stored object's own keys, and no stored CSS text is ever used. A token left
//     in only one half is skipped here; the app fills it from `collie` at load.
// `src/theme-init.test.ts` reads this file and holds every list and pattern equal to its twin in
// `lib/theme/schema.ts`.
(function () {
  var root = document.documentElement;
  var SHIPPED = ["nightwatch", "daylight", "harbour"];
  var TOKENS = [
    "background", "foreground", "card", "card-foreground", "chrome", "primary", "primary-foreground",
    "control-on", "control-on-foreground", "secondary", "secondary-foreground", "muted",
    "muted-foreground", "accent", "accent-foreground", "destructive", "destructive-foreground",
    "border", "input", "rule", "ring", "status-blocked", "status-working", "status-done",
    "status-idle", "status-unknown", "status-info", "syntax-keyword", "syntax-string",
    "syntax-constant", "syntax-property", "syntax-entity", "syntax-comment", "host-0", "host-1",
    "host-2", "host-3", "host-4", "host-5", "host-6", "host-7", "host-8", "host-9"
  ];
  var COLOUR = /^(?:#(?:[0-9a-f]{6}|[0-9a-f]{8})|oklch\( ?(?:\d+(?:\.\d+)?|\.\d+) (?:\d+(?:\.\d+)?|\.\d+) (?:\d+(?:\.\d+)?|\.\d+)(?: \/ (?:\d+(?:\.\d+)?|\.\d+)%?)? ?\))$/;
  var ok = function (v) { return typeof v === "string" && v.length <= 64 && COLOUR.test(v); };
  function applyColourTheme(id) {
    for (var i = 0; i < SHIPPED.length; i++) {
      if (SHIPPED[i] === id) return root.setAttribute("data-theme", SHIPPED[i]);
    }
    if (typeof id !== "string") return;
    var lib = JSON.parse(localStorage.getItem("collie:themes:v1") || "null");
    var list = lib && lib.version === 1 && Array.isArray(lib.themes) ? lib.themes : [];
    for (var j = 0; j < list.length; j++) {
      var t = list[j];
      if (!t || t.id !== id) continue;
      for (var k = 0; k < TOKENS.length; k++) {
        var l = t.light && t.light[TOKENS[k]];
        var d = t.dark && t.dark[TOKENS[k]];
        if (ok(l) && ok(d)) root.style.setProperty("--" + TOKENS[k], "light-dark(" + l + ", " + d + ")");
      }
      return;
    }
  }
  try {
    var t = localStorage.getItem("collie:theme:v1");
    if (t === "dark" || t === "light") root.classList.add(t);
  } catch {
    // Safari private mode throws on localStorage. Falling through leaves `color-scheme: light dark`
    // in charge, which follows the OS — the right default anyway.
  }
  try {
    var raw = localStorage.getItem("collie:design:v1");
    if (!raw) return;
    var d = JSON.parse(raw);
    if (!d || typeof d !== "object") return;
    // The closed list, and the whole of it. `aldrich` is the default and wears NO class — no class
    // means the --font-sans already in index.css, which is the stack index.html preloads. Anything
    // else, including an `op:` value, falls through and leaves the element bare.
    if (d.font === "system") root.classList.add("font-system");
    else if (d.font === "grotesk") root.classList.add("font-grotesk");
    applyColourTheme(d.theme);
  } catch {
    // A truncated write, a hand-edited blob, or private mode. The default face is the right answer
    // to all three, and it is the one already in the stylesheet.
  }
})();
