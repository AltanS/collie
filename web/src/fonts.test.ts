import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  DEFAULT_FONT,
  DESIGN_STORAGE_KEY,
  SHIPPED_FONTS,
  fontClass,
  parseDesignPrefs,
} from "@/lib/design";
import { acceptOperatorFonts, operatorFontCss, operatorFontUrl } from "@/lib/operator-fonts";
import { DEFAULT_UI_FONT_URL, FONT_URLS, UI_FONT_URLS } from "@/lib/sw-routes";

// Collie ships four webfonts — two Nerd Font symbol subsets and two UI typefaces — and the design
// rests on facts that are silent when broken: the stylesheet, the service worker and the disk agree
// on which files exist; the symbol faces stay range-restricted so they stay lazy; the UI face is
// preloaded and metric-matched so its swap moves nothing; and none of them re-enters the precache.
// A renamed file is a tofu box again (#70); a woff2 back in `globPatterns` charges every install
// ~1.2 MB; a URL the SW doesn't know gets swept out of the font cache on activate; a UI face without
// its `size-adjust` twin reflows the whole app when it lands.
//
// SINCE ADR 0033 the UI face is a per-device SETTING, so "the UI typeface" is a list rather than a
// singular. That changes two things here and nothing else: the twin table is asserted for EVERY
// shipped face rather than for the one, and the critical-path facts (preload, boot splash, the size
// budget) target DEFAULT_UI_FONT_URL — the face a device gets when it has never opened the setting,
// which is still the only one on the first-paint path.

const root = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const css = read("src/index.css");
const html = read("index.html");
const cssUrls = [...css.matchAll(/url\("([^"]+\.woff2)"\)/g)].map((m) => m[1]!);

describe("bundled fonts", () => {
  it("declares one symbol face per private-use plane", () => {
    expect(css).toContain("unicode-range: U+E000-F8FF");
    expect(css).toContain("unicode-range: U+F0000-F1AFF");
  });

  // Drift here is the whole failure mode: the SW sweeps every font-cache entry it can't name, so a
  // stylesheet URL missing from FONT_URLS would be re-fetched on every cold load, forever.
  it("names the same files in the stylesheet and the service worker", () => {
    expect(cssUrls).toEqual([...FONT_URLS]);
  });

  it.each(FONT_URLS)("ships %s", (url) => {
    // Throws if the asset is missing — a rename that misses one side lands as tofu, not an error.
    expect(statSync(resolve(root, `public${url}`)).size).toBeGreaterThan(0);
  });

  // `[\s\S]`, not `.`: Prettier is free to wrap that array, and a newline-blind pattern would pass
  // while `woff2` sat back in the precache list.
  it("keeps woff2 out of the precache manifest", () => {
    expect(read("vite.config.ts")).not.toMatch(/globPatterns[\s\S]{0,200}?woff2/);
  });
});

describe("the UI typefaces", () => {
  // The entries that are NOT range-restricted, because one of them dresses every label in the app.
  const uiUrls = FONT_URLS.filter((u) => u.startsWith("/fonts/ui-"));

  it("ships exactly the shipped faces, and the default is one of them", () => {
    expect(uiUrls).toEqual([...UI_FONT_URLS]);
    expect(UI_FONT_URLS).toContain(DEFAULT_UI_FONT_URL);
  });

  // The whole of K3 in one assertion. `font-display: swap` paints in a fallback first; that swap is
  // free of layout shift ONLY because the fallback families are the local system face re-declared
  // with the webfont's metrics. Delete a `size-adjust` and the app reflows on every cold load.
  // ONE TWIN PER SHIPPED FACE, and the count is asserted EXACTLY rather than as a floor: a new face
  // that forgot its twin would otherwise pass a `toBeGreaterThan` while reflowing the app for every
  // reader who picked it. Faces and twins are counted independently and compared, so neither a
  // missing twin nor an orphaned one gets through.
  it("gives every shipped face its own full metric override table", () => {
    const fallbacks = [...css.matchAll(/font-family:\s*"([^"]*Fallback[^"]*)";([\s\S]*?)\}/g)];
    expect(fallbacks).toHaveLength(UI_FONT_URLS.length);
    for (const [, family, body] of fallbacks) {
      expect(body, family).toMatch(/size-adjust:\s*\d/);
      expect(body, family).toMatch(/ascent-override:\s*\d/);
      expect(body, family).toMatch(/descent-override:\s*\d/);
      expect(body, family).toMatch(/line-gap-override:\s*\d/);
      // A stand-in must never fetch anything: it is `local()` only, or it is a second download that
      // arrives no sooner than the face it was supposed to stand in for.
      expect(body, family).not.toContain("url(");
    }
  });

  // Order is the whole mechanism: webfont, then the metric-matched stand-in, then the plain system
  // stack. Put the stand-in last and it never renders; leave it out and the swap reflows.
  it("puts the stand-in between the webfont and the plain system stack", () => {
    const stack = /--font-sans:\s*([\s\S]*?);/.exec(css)?.[1] ?? "";
    expect(stack).toMatch(/^\s*"Space Grotesk",\s*"Space Grotesk Fallback",/);
    expect(stack).toContain("system-ui");
  });

  // `crossorigin` is not optional on a font preload, even same-origin: fonts are fetched in CORS
  // mode, and without it the browser downloads the file twice and preloads nothing useful.
  // The DEFAULT face only. Preloading a face most devices never render would spend everyone's first
  // paint on a minority — an opt-in face is fetched when someone opts in.
  it("preloads the default face from index.html, with crossorigin", () => {
    const preload = /<link\s+rel="preload"[\s\S]*?\/>/.exec(html)?.[0] ?? "";
    expect(preload).toContain(DEFAULT_UI_FONT_URL);
    expect(preload).toContain('as="font"');
    expect(preload).toContain('type="font/woff2"');
    expect(preload).toContain("crossorigin");
  });

  // The boot splash paints before index.css exists, and its caption is the same string at the same
  // size as routes/root.tsx's BootSplash. If it fell back to the system face the hand-off to React
  // would change the family under the reader — so index.html re-declares the face itself.
  // EVERY shipped face, not just the default: theme-init.js has already put the chosen class on
  // <html> by the time the splash paints, so a face missing from here is a reader watching the
  // splash render in the system font and the app change voice on hand-off — which is the exact bug
  // this splash block exists to prevent, just for a different reader.
  it("re-declares every shipped face for the pre-CSS boot splash", () => {
    for (const family of ["Space Grotesk", "Aldrich"]) {
      expect(html).toContain(`font-family: "${family}";`);
      expect(html).toContain(`font-family: "${family} Fallback";`);
    }
  });

  // The splash resolves --font-sans, so the root-class blocks have to be mirrored into it or the
  // face declared above is never actually selected for the caption.
  it("mirrors the typeface root classes into the boot splash", () => {
    expect(html).toContain(":root.font-system");
    expect(html).toContain(":root.font-aldrich");
  });

  it("is small enough to sit on the critical path", () => {
    // 27 KB today. The two symbol faces are 641 KB and 504 KB and are lazy behind `unicode-range`;
    // this one is not, so a candidate that cannot be subset under ~60 KB is the wrong candidate.
    // Only the DEFAULT is held to this: an opt-in face is not on anybody's first paint.
    const bytes = statSync(resolve(root, `public${DEFAULT_UI_FONT_URL}`)).size;
    expect(bytes).toBeLessThan(60 * 1024);
  });
});

describe("the chrome/content boundary", () => {
  // F-D2: the custom face dresses the app's own chrome and never an agent's words. Two mechanisms
  // hold that line — `font-mono` for verbatim terminal surfaces, and `font-content` for agent text
  // that is not monospaced (rendered markdown, and the labels the interactive blocks lift out of a
  // dialog). Both need a family token to resolve through; losing either silently re-dresses the
  // agent's own output in the app's voice, which is exactly the failure F-D2 names.
  it("declares the content stack, and ships no bytes for it", () => {
    const stack = /--font-content:\s*([\s\S]*?);/.exec(css)?.[1] ?? "";
    expect(stack).toContain("system-ui");
    expect(stack).not.toContain("Space Grotesk");
    expect(stack).not.toContain("url(");
  });

  it("keeps agent markdown off the UI face", () => {
    expect(read("src/components/markdown-text.tsx")).toContain("font-content");
  });

  // The four interactive blocks (menu / prompt-select / wizard / multi-select) print an agent's own
  // question and option labels through these three shared pieces. mirror-space.ts's header calls
  // them "siblings of the mirror, not children" — true of colour, which is why family needs saying
  // separately here.
  it("keeps the dialog labels the blocks lift out of the terminal off the UI face", () => {
    const shared = read("src/components/option-button.tsx");
    expect([...shared.matchAll(/font-content/g)]).toHaveLength(4);
  });
});

// ── The operator's own faces (ADR 0033) ─────────────────────────────────────────────────────────
//
// These are the assertions that keep an operator's font from becoming a shipped one by accident.
// The service worker sweeps every entry in the font cache it cannot name, and it caches by URL —
// so a font served from anywhere under `/fonts/` is in that cache's world, and one under `/api/` is
// not. That boundary is the whole reason the wire carries a basename and this client builds the URL.
describe("operator fonts stay off the shipped path", () => {
  // The `/fonts/` namespace belongs to the precache-adjacent runtime cache and the activate sweep.
  // An operator URL landing there would be fetched, cached, and then swept on the next activate —
  // forever, on every cold load. `/api/` is safe not because of the navigation denylist (that only
  // governs NAVIGATIONS) but because sw.ts registers NO runtime route matching it, so the SW never
  // sees these requests at all.
  it("never builds a URL under /fonts/", () => {
    for (const name of ["departure.woff2", "a.woff2", "x-1.woff2"]) {
      const url = operatorFontUrl(name);
      expect(url.startsWith("/fonts/")).toBe(false);
      expect(url.startsWith("/api/fonts/")).toBe(true);
    }
  });

  it("keeps every operator URL out of the swept font list", () => {
    expect(FONT_URLS).not.toContain(operatorFontUrl("departure.woff2"));
    for (const url of FONT_URLS) expect(url.startsWith("/fonts/")).toBe(true);
  });

  // S9's shared predicate. The two sides cannot import one module — src/lib/types.ts is a deliberate
  // duplicate of the bridge's domain model so this app builds without the Bun server's source tree —
  // so the ONE grammar is a literal on each side and this reads the bridge's file to prove they are
  // the same characters. Widening one side alone fails here.
  it("validates a family against the same pattern the bridge does", () => {
    const bridge = readFileSync(resolve(root, "../bridge/operator-fonts.ts"), "utf8");
    const pattern = /OPERATOR_FONT_FAMILY_PATTERN = "([^"]+)"/.exec(bridge)?.[1];
    expect(pattern).toBeDefined();
    const web = read("src/lib/operator-fonts.ts");
    expect(web).toContain(`const FAMILY_RE = /${pattern}/;`);
  });

  // Rebuilt from validated parts, never escaped — so the test that matters is that a row which
  // could break out never survives validation in the first place.
  it("drops a row that could break out of the stylesheet", () => {
    expect(acceptOperatorFonts([{ family: 'X"; } :root { color: red', basename: "a.woff2" }])).toEqual([]);
    expect(acceptOperatorFonts([{ family: "X", basename: "../../etc/passwd" }])).toEqual([]);
    expect(acceptOperatorFonts([{ family: "X", basename: "a.woff2", weight: "700 400" }])).toEqual([]);
  });

  it("quotes the family and points the src at the api path", () => {
    const sheet = operatorFontCss([{ family: "Departure Mono", basename: "d.woff2", weight: "400 700" }], "op:d.woff2");
    expect(sheet).toContain('font-family: "Departure Mono";');
    expect(sheet).toContain('src: url("/api/fonts/d.woff2") format("woff2");');
    expect(sheet).toContain("font-weight: 400 700;");
    expect(sheet).toContain('--font-operator-family: "Departure Mono";');
  });

  // The offline / deleted-row case, and the reason index.css's `var()` carries a fallback: with no
  // `--font-operator-family` the stack starts at the DEFAULT SHIPPED FACE, never `sans-serif`.
  it("emits no family property for a choice no row answers to", () => {
    const sheet = operatorFontCss([{ family: "Departure Mono", basename: "d.woff2" }], "op:gone.woff2");
    expect(sheet).not.toContain("--font-operator-family");
    expect(sheet).toContain('font-family: "Departure Mono";');
    expect(cssRootOperatorStack()).toContain('var(--font-operator-family, "Space Grotesk")');
  });

  function cssRootOperatorStack(): string {
    return /:root\.font-operator\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? "";
  }
});

// ── The pre-paint coupling (DESIGN.md §9) ───────────────────────────────────────────────────────
//
// public/theme-init.js runs before the module graph exists, so it can import NOTHING — it carries
// the storage key and the class names as literals. src/lib/design.ts carries the same three facts.
// Nothing but a test that reads both files can stop them drifting, and the drift is silent: the app
// keeps working and the anti-flash simply stops firing.
describe("theme-init.js and lib/design.ts agree", () => {
  const init = read("public/theme-init.js");
  const design = read("src/lib/design.ts");

  it("uses the same storage key", () => {
    expect(DESIGN_STORAGE_KEY).toBe("collie:design:v1");
    expect(init).toContain(`localStorage.getItem("${DESIGN_STORAGE_KEY}")`);
    expect(design).toContain(`const STORAGE_KEY = "${DESIGN_STORAGE_KEY}";`);
  });

  it("agrees on the shape — a JSON object with a `font` field", () => {
    expect(init).toContain("JSON.parse(raw)");
    expect(init).toContain("d.font ===");
    expect(parseDesignPrefs(JSON.stringify({ font: "aldrich" })).font).toBe("aldrich");
  });

  // The closed list, on both sides. theme-init.js must name every shipped face that HAS a class, and
  // must name no others: a value it does not recognise leaves the element bare, which resolves to
  // the default — the right answer for both an unknown key and an operator one.
  it("agrees on which faces get a class, and on the class names", () => {
    for (const font of SHIPPED_FONTS) {
      const cls = fontClass(font);
      if (cls === "") continue;
      expect(init).toContain(`root.classList.add("${cls}")`);
      expect(init).toContain(`d.font === "${font}"`);
    }
    // The default wears no class on either side — that is what keeps JavaScript off the first-paint
    // path for every device that never opened the setting.
    expect(fontClass(DEFAULT_FONT)).toBe("");
    expect(init).not.toContain(`"${DEFAULT_FONT}"`);
  });

  // Operator faces get NO pre-paint path: their family name only exists once /api/config answers,
  // so there is nothing this script could do. It must not learn to try.
  it("gives an operator face no pre-paint path", () => {
    // The QUOTED forms, so the script's prose may still explain why the branch is absent — it is
    // the code that must not grow one, and a comment saying so is the opposite of a regression.
    expect(init).not.toContain('"op:"');
    expect(init).not.toContain('"font-operator"');
    expect(fontClass("op:a.woff2")).toBe("font-operator");
  });

  // Every class either side can produce must exist in the stylesheet, or the setting silently does
  // nothing for that choice.
  it("declares every class it can produce", () => {
    for (const font of [...SHIPPED_FONTS, "op:a.woff2"]) {
      const cls = fontClass(font);
      if (cls !== "") expect(css).toContain(`:root.${cls}`);
    }
  });
});
