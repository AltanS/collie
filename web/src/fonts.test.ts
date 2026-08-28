import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { FONT_URLS } from "@/lib/sw-routes";

// Collie ships three webfonts — two Nerd Font symbol subsets and one UI typeface — and the design
// rests on facts that are silent when broken: the stylesheet, the service worker and the disk agree
// on which files exist; the symbol faces stay range-restricted so they stay lazy; the UI face is
// preloaded and metric-matched so its swap moves nothing; and none of them re-enters the precache.
// A renamed file is a tofu box again (#70); a woff2 back in `globPatterns` charges every install
// ~1.2 MB; a URL the SW doesn't know gets swept out of the font cache on activate; a UI face without
// its `size-adjust` twin reflows the whole app when it lands.

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

describe("the UI typeface", () => {
  // The one entry that is NOT range-restricted, because it dresses every label in the app.
  const uiUrl = FONT_URLS.find((u) => u.startsWith("/fonts/ui-"));

  it("ships exactly one UI face", () => {
    expect(FONT_URLS.filter((u) => u.startsWith("/fonts/ui-"))).toHaveLength(1);
    expect(uiUrl).toBeDefined();
  });

  // The whole of K3 in one assertion. `font-display: swap` paints in a fallback first; that swap is
  // free of layout shift ONLY because the fallback families are the local system face re-declared
  // with the webfont's metrics. Delete a `size-adjust` and the app reflows on every cold load.
  it("gives every fallback family a full metric override table", () => {
    const fallbacks = [...css.matchAll(/font-family:\s*"([^"]*Fallback[^"]*)";([\s\S]*?)\}/g)];
    expect(fallbacks).toHaveLength(1);
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
  it("preloads the shipped face from index.html, with crossorigin", () => {
    const preload = /<link\s+rel="preload"[\s\S]*?\/>/.exec(html)?.[0] ?? "";
    expect(preload).toContain(uiUrl);
    expect(preload).toContain('as="font"');
    expect(preload).toContain('type="font/woff2"');
    expect(preload).toContain("crossorigin");
  });

  // The boot splash paints before index.css exists, and its caption is the same string at the same
  // size as routes/root.tsx's BootSplash. If it fell back to the system face the hand-off to React
  // would change the family under the reader — so index.html re-declares the face itself.
  it("re-declares the face for the pre-CSS boot splash", () => {
    expect(html).toContain('font-family: "Space Grotesk";');
    expect(html).toContain('font-family: "Space Grotesk Fallback";');
  });

  it("is small enough to sit on the critical path", () => {
    // 27 KB today. The two symbol faces are 641 KB and 504 KB and are lazy behind `unicode-range`;
    // this one is not, so a candidate that cannot be subset under ~60 KB is the wrong candidate.
    const bytes = statSync(resolve(root, `public${uiUrl}`)).size;
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
