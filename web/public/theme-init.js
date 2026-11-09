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
// reader who chose Aldrich must not watch the app paint in Atkinson and then change voice. The
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
//   * Then its shape words, display face and palette (version 2): SURFACE, DISPLAY and ANSI are the
//     closed tables of `lib/theme/surface.ts`, written here by `scripts/build-themes.ts`. A stored
//     word or face is compared with each entry and only the table's own declarations are set; the
//     palette's eighteen values are set only when all of them match COLOUR (the app gates them).
// `src/theme-init.test.ts` reads this file and holds every list and pattern equal to its twin in
// `lib/theme/schema.ts`, the SURFACE line equal to what surface.ts writes, and runs it to check it
// sets the same declarations as the store for every word.
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
    "host-2", "host-3", "host-4", "host-5", "host-6", "host-7", "host-8", "host-9", "pane-active", "tab-active"
  ];
  var COLOUR = /^(?:#(?:[0-9a-f]{6}|[0-9a-f]{8})|oklch\( ?(?:\d+(?:\.\d+)?|\.\d+) (?:\d+(?:\.\d+)?|\.\d+) (?:\d+(?:\.\d+)?|\.\d+)(?: \/ (?:\d+(?:\.\d+)?|\.\d+)%?)? ?\))$/;
  var ok = function (v) { return typeof v === "string" && v.length <= 64 && COLOUR.test(v); };
  var set = function (decl) { for (var x = 0; x < decl.length; x++) root.style.setProperty(decl[x][0], decl[x][1]); };
  // generated by scripts/build-themes.ts from web/src/lib/theme/surface.ts, do not edit
  var SURFACE = [["radius",[["sharp",[["--radius-sm","2px"],["--radius-md","2px"],["--radius-lg","2px"],["--radius-xl","2px"],["--edge-accent","inset 2px 0 0 0"],["--edge-shadow","0 0 #0000"]]],["soft",[["--radius-sm","4px"],["--radius-md","6px"],["--radius-lg","8px"],["--radius-xl","12px"],["--edge-accent","inset 0 0 0 2px"],["--edge-shadow","0 1px 3px 0 rgb(0 0 0 / 0.1)"]]],["round",[["--radius-sm","8px"],["--radius-md","12px"],["--radius-lg","16px"],["--radius-xl","24px"],["--edge-accent","inset 0 0 0 2px"],["--edge-shadow","0 1px 3px 0 rgb(0 0 0 / 0.1)"]]]]],["shadow",[["flat",[["--surface-shadow","0 0 #0000"],["--surface-shadow-xs","0 0 #0000"],["--surface-shadow-sm","0 0 #0000"],["--surface-shadow-md","0 0 #0000"],["--surface-shadow-lg","0 0 #0000"],["--surface-shadow-xl","0 0 #0000"],["--surface-shadow-2xl","0 0 #0000"]]],["default",[["--surface-shadow","0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)"],["--surface-shadow-xs","0 1px 2px 0 rgb(0 0 0 / 0.05)"],["--surface-shadow-sm","0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)"],["--surface-shadow-md","0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)"],["--surface-shadow-lg","0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)"],["--surface-shadow-xl","0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)"],["--surface-shadow-2xl","0 25px 50px -12px rgb(0 0 0 / 0.25)"]]],["lifted",[["--surface-shadow","0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)"],["--surface-shadow-xs","0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)"],["--surface-shadow-sm","0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)"],["--surface-shadow-md","0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)"],["--surface-shadow-lg","0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)"],["--surface-shadow-xl","0 25px 50px -12px rgb(0 0 0 / 0.25)"],["--surface-shadow-2xl","0 32px 64px -12px rgb(0 0 0 / 0.3)"]]]]],["density",[["default",[["--spacing","0.25rem"]]],["roomy",[["--spacing","0.28rem"]]]]],["weight",[["bold",[["--font-weight-medium","600"],["--font-weight-semibold","700"]]],["default",[["--font-weight-medium","500"],["--font-weight-semibold","600"]]]]],["border",[["default",[["--surface-border-width","1px"]]],["strong",[["--surface-border-width","2px"]]]]],["chrome",[["band",[["--band-ground","var(--secondary)"],["--band-rule","var(--border)"]]],["page",[["--band-ground","var(--background)"],["--band-rule","var(--rule)"]]]]],["rows",[["rules",[["--row-gap","0px"],["--row-rule","var(--surface-border-width)"],["--row-edge","0px"],["--row-corner","0px"],["--row-shadow","none"],["--row-inset","0px"],["--row-fill","transparent"]]],["cards",[["--row-gap","8px"],["--row-rule","0px"],["--row-edge","var(--surface-border-width)"],["--row-corner","var(--radius-sm)"],["--row-shadow","var(--surface-shadow-xs)"],["--row-inset","8px"],["--row-fill","var(--card)"]]]]],["icons",[["default",[["--icon-stroke","2"]]],["thin",[["--icon-stroke","1.5"]]],["heavy",[["--icon-stroke","2.5"]]]]],["labels",[["sentence",[["--label-transform","none"],["--label-tracking","normal"]]],["caps",[["--label-transform","uppercase"],["--label-tracking","0.025em"]]]]],["zoom",[["screen",[]],["none",[]]]],["tabs",[["plain",[]],["folder",[]]]],["composer",[["field",[]],["box",[]]]]], GROUND = [["pattern",[["flat",[["--ground-image","none"],["--ground-size","auto"],["--ground-ink","var(--foreground)"]]],["gradient",[["--ground-image","linear-gradient(to bottom, var(--background), var(--ground-tint))"],["--ground-size","auto"],["--ground-ink","var(--primary)"]]],["grain",[["--ground-image","repeating-linear-gradient(45deg, var(--ground-line) 0 1px, transparent 1px calc(4px * var(--ground-scale))), repeating-linear-gradient(-45deg, var(--ground-line) 0 1px, transparent 1px calc(4px * var(--ground-scale)))"],["--ground-size","auto"],["--ground-ink","var(--foreground)"]]],["dots",[["--ground-image","radial-gradient(circle, var(--ground-dot) 0 1.25px, transparent 1.75px)"],["--ground-size","calc(12px * var(--ground-scale)) calc(12px * var(--ground-scale))"],["--ground-ink","var(--foreground)"]]],["grid",[["--ground-image","linear-gradient(var(--ground-line) 0 1px, transparent 1px), linear-gradient(90deg, var(--ground-line) 0 1px, transparent 1px)"],["--ground-size","calc(16px * var(--ground-scale)) calc(16px * var(--ground-scale))"],["--ground-ink","var(--foreground)"]]],["lines",[["--ground-image","repeating-linear-gradient(45deg, var(--ground-line) 0 1px, transparent 1px calc(6px * var(--ground-scale)))"],["--ground-size","auto"],["--ground-ink","var(--foreground)"]]],["checks",[["--ground-image","conic-gradient(var(--ground-area) 25%, transparent 0 50%, var(--ground-area) 0 75%, transparent 0)"],["--ground-size","calc(16px * var(--ground-scale)) calc(16px * var(--ground-scale))"],["--ground-ink","var(--foreground)"]]],["waves",[["--ground-image","radial-gradient(circle at 25% 0, transparent calc(calc(6px * var(--ground-scale)) - 1px), var(--ground-line) calc(calc(6px * var(--ground-scale)) - 1px) calc(6px * var(--ground-scale)), transparent calc(6px * var(--ground-scale))), radial-gradient(circle at 75% 100%, transparent calc(calc(6px * var(--ground-scale)) - 1px), var(--ground-line) calc(calc(6px * var(--ground-scale)) - 1px) calc(6px * var(--ground-scale)), transparent calc(6px * var(--ground-scale)))"],["--ground-size","calc(24px * var(--ground-scale)) calc(12px * var(--ground-scale))"],["--ground-ink","var(--foreground)"]]],["weave",[["--ground-image","linear-gradient(45deg, var(--ground-area) 12%, transparent 0 88%, var(--ground-area) 0), linear-gradient(135deg, transparent 37%, var(--ground-area) 0 63%, transparent 0), linear-gradient(45deg, transparent 37%, var(--ground-area) 0 63%, transparent 0)"],["--ground-size","calc(20px * var(--ground-scale)) calc(20px * var(--ground-scale))"],["--ground-ink","var(--foreground)"]]]],1],["size",[["default",[["--ground-scale","1"]]],["fine",[["--ground-scale","0.75"]]],["wide",[["--ground-scale","2"]]]],1],["strength",[["default",[["--ground-line","color-mix(in oklab, var(--background) 96%, var(--ground-ink))"],["--ground-dot","color-mix(in oklab, var(--background) 93%, var(--ground-ink))"],["--ground-area","color-mix(in oklab, var(--background) 97%, var(--ground-ink))"],["--ground-tint","color-mix(in oklab, var(--background) 88%, var(--ground-ink))"]]],["faint",[["--ground-line","color-mix(in oklab, var(--background) 97.5%, var(--ground-ink))"],["--ground-dot","color-mix(in oklab, var(--background) 95%, var(--ground-ink))"],["--ground-area","color-mix(in oklab, var(--background) 98%, var(--ground-ink))"],["--ground-tint","color-mix(in oklab, var(--background) 93%, var(--ground-ink))"]]],["bold",[["--ground-line","color-mix(in oklab, var(--background) 93%, var(--ground-ink))"],["--ground-dot","color-mix(in oklab, var(--background) 90%, var(--ground-ink))"],["--ground-area","color-mix(in oklab, var(--background) 95%, var(--ground-ink))"],["--ground-tint","color-mix(in oklab, var(--background) 82%, var(--ground-ink))"]]]],1],["ink",[["foreground",[["--ground-ink","var(--foreground)"]]],["primary",[["--ground-ink","var(--primary)"]]]],0]], DISPLAY = [["system",[["--font-display","var(--face-system)"]]],["grotesk",[["--font-display","var(--face-grotesk)"]]],["aldrich",[["--font-display","var(--face-aldrich)"]]],["plex",[["--font-display","var(--face-plex)"]]],["geist",[["--font-display","var(--face-geist)"]]],["atkinson",[["--font-display","var(--face-atkinson)"]]],["nunito",[["--font-display","var(--face-nunito)"]]]], ANSI = [["0","--ansi-0"],["1","--ansi-1"],["2","--ansi-2"],["3","--ansi-3"],["4","--ansi-4"],["5","--ansi-5"],["6","--ansi-6"],["7","--ansi-7"],["8","--ansi-8"],["9","--ansi-9"],["10","--ansi-10"],["11","--ansi-11"],["12","--ansi-12"],["13","--ansi-13"],["14","--ansi-14"],["15","--ansi-15"],["ink","--mirror-ink"],["ground","--mirror-ground"]];
  function applyColourTheme(id) {
    for (var i = 0; i < SHIPPED.length; i++) {
      if (SHIPPED[i] === id) return root.setAttribute("data-theme", SHIPPED[i]);
    }
    if (typeof id !== "string" || id === "collie") return; // collie writes nothing, whatever the library holds
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
      var s = t.surface && typeof t.surface === "object" ? t.surface : {};
      for (var n = 0; n < SURFACE.length; n++) for (var w = 0; w < SURFACE[n][1].length; w++) if (s[SURFACE[n][0]] === SURFACE[n][1][w][0]) set(SURFACE[n][1][w][1]);
      // The ground, a word or an object of four (surface.ts): each key's word, a key left out at its
      // first word. :root carries Collie's grain, so a theme that names no ground says flat itself.
      var gr = typeof s.ground === "string" ? { pattern: s.ground } : s.ground && typeof s.ground === "object" ? s.ground : null;
      if (!gr) set([["--ground-image", "none"]]);
      else for (var x = 0; x < GROUND.length; x++) { var hit = false; for (var y = 0; y < GROUND[x][1].length; y++) if (gr[GROUND[x][0]] === GROUND[x][1][y][0]) { set(GROUND[x][1][y][1]); hit = true; } if (!hit && GROUND[x][2]) set(GROUND[x][1][0][1]); }
      var f = t.fonts && typeof t.fonts === "object" ? t.fonts : {};
      for (var m = 0; m < DISPLAY.length; m++) if (f.display === DISPLAY[m][0]) set(DISPLAY[m][1]);
      var a = t.ansi && typeof t.ansi === "object" ? t.ansi : {}, all = true;
      for (var q = 0; q < ANSI.length; q++) all = all && ok(a[ANSI[q][0]]);
      if (all) for (var r = 0; r < ANSI.length; r++) root.style.setProperty(ANSI[r][1], a[ANSI[r][0]]);
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
    // The closed list, and the whole of it. `atkinson` is the default (since 2026-11-06) and wears
    // NO class — no class means the --font-sans already in index.css, which is the stack index.html
    // preloads. A missing or unknown `font` and an `op:` value fall through and leave the element
    // bare. `aldrich` is a choice now and wears `font-aldrich`.
    if (d.font === "system") root.classList.add("font-system");
    else if (d.font === "grotesk") root.classList.add("font-grotesk");
    else if (d.font === "plex") root.classList.add("font-plex");
    else if (d.font === "geist") root.classList.add("font-geist");
    else if (d.font === "nunito") root.classList.add("font-nunito");
    else if (d.font === "aldrich") root.classList.add("font-aldrich");
    // `#theme=collie` (lib/theme/escape.ts) is the way back from any theme: paint Collie, store
    // nothing; the app writes the choice and takes the hash off.
    if (!/(?:^#|&)theme=collie(?:&|$)/.test(location.hash)) applyColourTheme(d.theme);
  } catch {
    // A truncated write, a hand-edited blob, or private mode. The default face is the right answer
    // to all three, and it is the one already in the stylesheet.
  }
})();
