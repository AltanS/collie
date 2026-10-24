import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MetaColours } from "@/hooks/use-theme";
import { parseJsonObject } from "@/lib/json";

import { THEME_TOKENS, fillHalves, isOptionalThemeToken, parseTheme, toSrgbHex, type Theme } from "./schema";
import { ANSI_PROPERTIES, VERSION_TWO_PROPERTIES, SURFACE_PROPERTIES } from "./surface";

// The store keeps module-scope state (the design store, the library, the metas), so each case
// imports a fresh graph over a storage it seeded itself.

const web = resolve(import.meta.dirname, "../../..");
const COLLIE_RAW = readFileSync(resolve(web, "src/themes/collie.json"), "utf8");
const DESIGN_KEY = "collie:design:v1";
const LIBRARY_KEY = "collie:themes:v1";

function collie(): Theme {
  const parsed = parseTheme(COLLIE_RAW, { maxBytes: 64 * 1024, allowReservedId: true });
  if (!parsed.ok) throw new Error("collie.json no longer parses");
  // The fixtures are version 1 copies of collie's 43 required tokens; the optional ones (version 3) are left out.
  const strip = (half: Theme["light"]) => Object.fromEntries(Object.entries(half ?? {}).filter(([token]) => !isOptionalThemeToken(token)));
  return { ...parsed.theme, version: 1, light: strip(parsed.theme.light), dark: strip(parsed.theme.dark) };
}

/** A complete imported theme: collie's tokens, another id, and a dark ground of #123456. */
function midnight(id = "midnight", extra: Partial<Theme> = {}): Theme {
  const base = collie();
  return {
    version: 1,
    id,
    name: "Midnight",
    author: "Test",
    light: { ...base.light },
    dark: { ...base.dark, background: "#123456" },
    ...extra,
  };
}

/** Collie's own index.css palette on its own ground: a palette that passes the gate. */
const PALETTE = {
  "0": "#000000", "1": "#cd3131", "2": "#0dbc79", "3": "#e5e510", "4": "#2472c8", "5": "#bc3fbc",
  "6": "#11a8cd", "7": "#e5e5e5", "8": "#666666", "9": "#f14c4c", "10": "#23d18b", "11": "#f5f543",
  "12": "#3b8eea", "13": "#d670d6", "14": "#29b8db", "15": "#ffffff", ink: "#fafafa", ground: "#0a0a0a",
};

/** A stored blob as text. Tests pass objects through here, and a hand-edited blob as a plain string. */
const blob = JSON.stringify;

async function boot(opts: { design?: string; library?: string } = {}) {
  localStorage.clear();
  if (opts.design !== undefined) localStorage.setItem(DESIGN_KEY, opts.design);
  if (opts.library !== undefined) {
    localStorage.setItem(LIBRARY_KEY, opts.library);
  }
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.className = "";
  document.head.innerHTML =
    '<meta name="theme-color" content="#f5f5f5" media="(prefers-color-scheme: light)">' +
    '<meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme: dark)">';
  vi.resetModules();
  const store = await import("./store");
  const design = await import("@/lib/design");
  const theme = await import("@/hooks/use-theme");
  return { store, design, theme };
}

const root = () => document.documentElement;
const inline = () => THEME_TOKENS.filter((t) => root().style.getPropertyValue(`--${t}`) !== "");
const metas = () =>
  [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((m) => m.content);
const storedDesign = () => parseJsonObject(localStorage.getItem(DESIGN_KEY) ?? "{}") ?? {};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("the default theme", () => {
  it("applies nothing: no attribute and no inline property, metas as before", async () => {
    const { store } = await boot();
    store.initTheme();
    expect(root().hasAttribute("data-theme")).toBe(false);
    expect(root().getAttribute("style")).toBeNull();
    expect(inline()).toEqual([]);
    expect(metas()).toEqual(["#f5f5f5", "#0a0a0a"]);
    expect(store.activeThemeId()).toBe("collie");
  });

  it("leaves nothing behind after going back to it from an imported theme", async () => {
    const { store } = await boot();
    expect(store.addImported(midnight())).toEqual({ ok: true });
    store.setActiveTheme("midnight");
    expect(inline()).toHaveLength(43);
    store.setActiveTheme("collie");
    expect(root().hasAttribute("data-theme")).toBe(false);
    expect(root().getAttribute("style") ?? "").toBe("");
    expect(metas()).toEqual(["#f5f5f5", "#0a0a0a"]);
  });

  it("stores no theme field for collie", async () => {
    const { store } = await boot();
    store.addImported(midnight());
    store.setActiveTheme("midnight");
    expect(storedDesign().theme).toBe("midnight");
    store.setActiveTheme("collie");
    expect("theme" in storedDesign()).toBe(false);
  });
});

describe("an imported theme", () => {
  it("applies one light-dark() property per token, from the validated object", async () => {
    const { store } = await boot();
    store.addImported(midnight());
    store.setActiveTheme("midnight");
    expect(inline()).toEqual([...THEME_TOKENS]);
    expect(root().hasAttribute("data-theme")).toBe(false);
    const base = collie();
    expect(root().style.getPropertyValue("--background")).toBe(
      `light-dark(${base.light?.background}, #123456)`,
    );
    expect(root().style.getPropertyValue("--status-blocked")).toBe(
      `light-dark(${base.light?.["status-blocked"]}, ${base.dark?.["status-blocked"]})`,
    );
  });

  it("fills a half it leaves out from collie", async () => {
    const { store } = await boot();
    const dark: Theme = { version: 1, id: "dark-only", name: "Dark only", dark: { background: "#101010" } };
    store.addImported(dark);
    store.setActiveTheme("dark-only");
    expect(inline()).toHaveLength(43);
    const filled = fillHalves(dark, collie());
    expect(root().style.getPropertyValue("--background")).toBe(`light-dark(${filled.light.background}, #101010)`);
    expect(root().style.getPropertyValue("--border")).toBe(
      `light-dark(${collie().light?.border}, ${collie().dark?.border})`,
    );
  });

  it("sets the theme-color metas from its two backgrounds, and gives collie's back", async () => {
    const { store, theme } = await boot();
    store.addImported(midnight());
    store.setActiveTheme("midnight");
    expect(theme.metaColours()).toEqual({ light: toSrgbHex(collie().light?.background ?? ""), dark: "#123456" });
    expect(metas()).toEqual([theme.metaColours().light, "#123456"]);
    store.setActiveTheme("collie");
    expect(theme.metaColours()).toEqual({ light: "#f5f5f5", dark: "#0a0a0a" });
  });

  it("writes its bundled face into design.font once, and keeps the font alone afterwards", async () => {
    const { store, design } = await boot();
    store.addImported(midnight("sys", { fonts: { ui: "system" } }));
    store.setActiveTheme("sys");
    expect(design.designPrefs().font).toBe("system");
    expect(root().classList.contains("font-system")).toBe(true);
    design.setDesignFont("grotesk");
    expect(design.designPrefs().font).toBe("grotesk");
    expect(design.designPrefs().theme).toBe("sys");
  });

  it("does not touch the font when it names none", async () => {
    const { store, design } = await boot({ design: blob({ font: "grotesk" }) });
    store.addImported(midnight());
    store.setActiveTheme("midnight");
    expect(design.designPrefs().font).toBe("grotesk");
  });

  it("is restored from storage by initTheme", async () => {
    const { store } = await boot({ design: blob({ font: "aldrich", theme: "midnight" }), library: blob({ version: 1, themes: [midnight()] }) });
    expect(root().hasAttribute("style")).toBe(false);
    store.initTheme();
    expect(inline()).toHaveLength(43);
  });
});

describe("a shipped theme", () => {
  it("sets the attribute and no inline property, with the id from the shipped list", async () => {
    const { store } = await boot();
    const night: Theme = { ...collie(), id: "nightwatch", name: "Nightwatch" };
    store.applyTheme(night, "shipped");
    expect(root().dataset.theme).toBe("nightwatch");
    expect(inline()).toEqual([]);
  });

  it("removes inline properties an imported theme left", async () => {
    const { store } = await boot();
    store.addImported(midnight());
    store.setActiveTheme("midnight");
    store.applyTheme({ ...collie(), id: "daylight", name: "Daylight" }, "shipped");
    expect(root().dataset.theme).toBe("daylight");
    expect(inline()).toEqual([]);
  });

  it("is refused when the id is not a shipped id", async () => {
    const { store } = await boot();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    store.applyTheme(midnight("not-shipped"), "shipped");
    expect(root().hasAttribute("data-theme")).toBe(false);
    expect(inline()).toEqual([]);
  });
});

describe("removal", () => {
  it("falls back to collie in the same tick when the active theme goes", async () => {
    const { store, design } = await boot();
    store.addImported(midnight());
    store.setActiveTheme("midnight");
    store.removeImported("midnight");
    expect(store.activeThemeId()).toBe("collie");
    expect(design.designPrefs().theme).toBeUndefined();
    expect(inline()).toEqual([]);
    expect(metas()).toEqual(["#f5f5f5", "#0a0a0a"]);
    expect(store.library()).toEqual([]);
    expect(localStorage.getItem(LIBRARY_KEY)).toBeNull();
  });

  it("keeps the typeface when it removes the active theme", async () => {
    const { store, design } = await boot();
    store.addImported(midnight("sys", { fonts: { ui: "system" } }));
    store.setActiveTheme("sys");
    store.removeImported("sys");
    expect(design.designPrefs().font).toBe("system");
  });

  it("leaves the active theme alone when another one goes", async () => {
    const { store } = await boot();
    store.addImported(midnight("one"));
    store.addImported(midnight("two"));
    store.setActiveTheme("one");
    store.removeImported("two");
    expect(store.activeThemeId()).toBe("one");
    expect(inline()).toHaveLength(43);
  });

  it("shows collie while a stored id has no theme, and keeps the id for tomorrow", async () => {
    const { store, design } = await boot({ design: blob({ font: "aldrich", theme: "gone" }) });
    store.initTheme();
    expect(store.activeThemeId()).toBe("collie");
    expect(design.designPrefs().theme).toBe("gone");
    expect(inline()).toEqual([]);
  });
});

describe("the library", () => {
  it("drops, with a warning, every stored theme that no longer validates", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = midnight("good");
    const { store } = await boot({
      library: blob({
        version: 1,
        themes: [
          good,
          { ...midnight("urlish"), light: { background: "url(https://x.test/a.png)" } },
          { ...midnight("extra"), surprise: true },
          midnight("nightwatch"),
          { ...midnight("future"), version: 4 },
          "not an object",
          midnight("good"),
        ],
      }),
    });
    expect(store.library().map((t) => t.id)).toEqual(["good"]);
    expect(warn).toHaveBeenCalledTimes(6);
  });

  it("reads nothing from a blob of another version or shape", async () => {
    expect((await boot({ library: blob({ version: 2, themes: [midnight()] }) })).store.library()).toEqual([]);
    expect((await boot({ library: "not json" })).store.library()).toEqual([]);
    expect((await boot({ library: blob({ version: 1, themes: "x" }) })).store.library()).toEqual([]);
  });

  it("keeps at most eight", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const many = Array.from({ length: 10 }, (_, i) => midnight(`t${i}`));
    const { store } = await boot({ library: blob({ version: 1, themes: many }) });
    expect(store.library()).toHaveLength(8);
  });

  it("answers add with the reason it refuses", async () => {
    const { store } = await boot();
    expect(store.addImported(midnight("nightwatch"))).toEqual({ ok: false, reason: "reserved-id" });
    expect(store.addImported(midnight("collie"))).toEqual({ ok: false, reason: "reserved-id" });
    expect(store.addImported(midnight("one"))).toEqual({ ok: true });
    expect(store.addImported(midnight("one"))).toEqual({ ok: false, reason: "duplicate" });
    expect(store.addImported({ ...midnight("bad"), light: { background: "red" } })).toEqual({
      ok: false,
      reason: "invalid",
    });
    for (let i = 1; i < 8; i += 1) expect(store.addImported(midnight(`t${i}`))).toEqual({ ok: true });
    expect(store.addImported(midnight("ninth"))).toEqual({ ok: false, reason: "full" });
    expect(store.library()).toHaveLength(8);
  });

  it("persists what it holds, as the validated object", async () => {
    const { store } = await boot();
    store.addImported(midnight());
    const stored = JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? "{}");
    expect(stored.version).toBe(1);
    expect(stored.themes).toEqual([midnight()]);
  });
});

describe("applyTheme checks the theme again", () => {
  it("applies nothing for a theme with a value outside the grammar", async () => {
    const { store } = await boot();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    store.applyTheme({ ...midnight(), light: { background: "url(https://x.test/a.png)" } }, "imported");
    expect(inline()).toEqual([]);
    expect(root().getAttribute("style") ?? "").toBe("");
    expect(warn).toHaveBeenCalled();
  });

  it("applies nothing, and sets no property, for a key outside the token list", async () => {
    const { store } = await boot();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const theme = midnight();
    Object.assign(theme.dark ?? {}, { "--evil": "#ff0000", "background; color": "#ff0000" });
    store.applyTheme(theme, "imported");
    expect(root().getAttribute("style") ?? "").toBe("");
  });

  it("puts a theme that no longer validates back to collie", async () => {
    const { store } = await boot();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    store.addImported(midnight());
    store.setActiveTheme("midnight");
    store.applyTheme({ ...midnight(), dark: { background: "#12345" } }, "imported");
    expect(inline()).toEqual([]);
    expect(metas()).toEqual(["#f5f5f5", "#0a0a0a"]);
  });

  it("refuses an imported theme that wears a shipped id", async () => {
    const { store } = await boot();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    store.applyTheme(midnight("nightwatch"), "imported");
    expect(root().hasAttribute("data-theme")).toBe(false);
    expect(inline()).toEqual([]);
  });

  it("writes only a colour into only a custom property, and never the name or the author", async () => {
    const { store } = await boot();
    const theme = midnight("markup", { name: "<img src=x onerror=alert(1)>", author: "<b>me</b>" });
    store.addImported(theme);
    store.setActiveTheme("markup");
    expect(inline()).toHaveLength(43);
    expect(root().style.length).toBe(43);
    for (let i = 0; i < root().style.length; i += 1) {
      const name = root().style.item(i);
      expect(THEME_TOKENS.map((t) => `--${t}`)).toContain(name);
      expect(root().style.getPropertyValue(name)).toMatch(/^light-dark\([#a-z0-9 ./()%-]+, [#a-z0-9 ./()%-]+\)$/);
    }
    expect(root().outerHTML).not.toContain("onerror");
    expect(root().outerHTML).not.toContain("<b>");
  });
});

describe("useActiveTheme", () => {
  it("hands a stable object until the theme changes, then a new one", async () => {
    const { store } = await boot();
    store.addImported(midnight());
    const { result, rerender } = renderHook(() => store.useActiveTheme());
    const first = result.current;
    expect(first).toMatchObject({ id: "collie", source: "shipped" });
    rerender();
    expect(result.current).toBe(first);

    act(() => store.setActiveTheme("midnight"));
    expect(result.current).toMatchObject({ id: "midnight", source: "imported" });
    expect(result.current.theme.name).toBe("Midnight");
    const second = result.current;
    rerender();
    expect(result.current).toBe(second);

    act(() => store.removeImported("midnight"));
    expect(result.current).toMatchObject({ id: "collie", source: "shipped" });
  });

  it("follows the library", async () => {
    const { store } = await boot();
    const { result } = renderHook(() => store.useLibrary());
    expect(result.current).toEqual([]);
    act(() => void store.addImported(midnight()));
    expect(result.current.map((t) => t.id)).toEqual(["midnight"]);
  });
});

describe("the shape words of an imported theme (schema version 2)", () => {
  const surfaceSet = () => SURFACE_PROPERTIES.filter((p) => root().style.getPropertyValue(p) !== "");
  const versionTwoSet = () => VERSION_TWO_PROPERTIES.filter((p) => root().style.getPropertyValue(p) !== "");

  it("sets the declarations of the words the theme names, and only those", async () => {
    const { store } = await boot();
    store.addImported(midnight("shaped", { version: 2, surface: { radius: "soft", density: "roomy" } }));
    store.setActiveTheme("shaped");
    expect(surfaceSet()).toEqual(["--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--edge-accent", "--edge-shadow", "--spacing"]);
    expect(root().style.getPropertyValue("--edge-accent")).toBe("inset 0 0 0 2px");
    expect(root().style.getPropertyValue("--edge-shadow")).toBe("0 1px 3px 0 rgb(0 0 0 / 0.1)");
    expect(root().style.getPropertyValue("--radius-md")).toBe("6px");
    expect(root().style.getPropertyValue("--spacing")).toBe("0.28rem");
  });

  it("sets no shape property for a theme without a surface block", async () => {
    const { store } = await boot();
    store.addImported(midnight());
    store.setActiveTheme("midnight");
    expect(inline()).toHaveLength(THEME_TOKENS.length);
    expect(surfaceSet()).toEqual([]);
  });

  it("takes every shape property off on the way back to collie or to another theme", async () => {
    const { store } = await boot();
    const all = {
      radius: "round",
      shadow: "flat",
      density: "roomy",
      weight: "bold",
      border: "strong",
      ground: "gradient",
      chrome: "band",
      rows: "cards",
      icons: "thin",
      labels: "sentence",
    } as const;
    store.addImported(midnight("shaped", { version: 2, surface: all, fonts: { display: "geist" }, ansi: PALETTE }));
    store.addImported(midnight("plain"));
    store.setActiveTheme("shaped");
    expect(surfaceSet()).toEqual([...SURFACE_PROPERTIES]);
    expect(versionTwoSet()).toEqual([...VERSION_TWO_PROPERTIES]);
    store.setActiveTheme("plain");
    expect(versionTwoSet()).toEqual([]);
    store.setActiveTheme("shaped");
    store.setActiveTheme("collie");
    expect(root().getAttribute("style") ?? "").toBe("");
  });

  it("applies nothing for a theme whose surface holds a word outside the table", async () => {
    const { store } = await boot();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const theme = midnight("odd", { version: 2 });
    Object.assign(theme, { surface: { radius: "9px" } });
    store.applyTheme(theme, "imported");
    expect(root().getAttribute("style") ?? "").toBe("");
  });

  it("stores each theme at the lowest version that holds it", async () => {
    const { store } = await boot();
    store.addImported(midnight("plain"));
    store.addImported(midnight("plain-two", { version: 2 }));
    store.addImported(midnight("shaped", { version: 2, surface: { radius: "soft" } }));
    const stored = JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? "{}");
    expect(stored.version).toBe(1);
    expect(stored.themes.map((t: Theme) => [t.id, t.version])).toEqual([
      ["plain", 1],
      ["plain-two", 1],
      ["shaped", 2],
    ]);
    expect(store.library().map((t) => t.version)).toEqual([1, 1, 2]);
  });

  it("re-reads a stored version 2 theme with its surface at startup", async () => {
    const stored = midnight("shaped", { version: 2, surface: { weight: "bold" } });
    const { store } = await boot({
      design: blob({ font: "aldrich", theme: "shaped" }),
      library: blob({ version: 1, themes: [stored] }),
    });
    store.initTheme();
    expect(store.library()[0]?.surface).toEqual({ weight: "bold" });
    expect(root().style.getPropertyValue("--font-weight-semibold")).toBe("700");
  });
});

// ── Spec 17: the band colour on the browser chrome, the display face and the palette ─────────────
describe("the seven more tokens on an imported theme", () => {
  it("gives the theme-color metas the band colour under `chrome: band`, and the page colour under `page` and any ground", async () => {
    const { store, theme } = await boot();
    const banded = midnight("banded", { version: 2, surface: { chrome: "band" } });
    store.addImported(banded);
    store.addImported(midnight("ground", { version: 2, surface: { ground: "gradient", chrome: "page" } }));
    store.setActiveTheme("banded");
    const secondary = fillHalvesOf(banded, "secondary");
    expect(theme.metaColours()).toEqual(secondary);
    expect(metas()).toEqual([secondary.light, secondary.dark]);
    store.setActiveTheme("ground");
    expect(theme.metaColours()).toEqual({ light: toSrgbHex(collie().light?.background ?? ""), dark: "#123456" });
  });

  it("sets the display face and the eighteen palette properties, and nothing for a theme without them", async () => {
    const { store } = await boot();
    store.addImported(midnight("faced", { version: 2, fonts: { display: "plex" }, ansi: PALETTE }));
    store.setActiveTheme("faced");
    expect(root().style.getPropertyValue("--font-display")).toBe("var(--face-plex)");
    expect(ANSI_PROPERTIES.filter((p) => root().style.getPropertyValue(p) !== "")).toEqual([...ANSI_PROPERTIES]);
    expect(root().style.getPropertyValue("--mirror-ink")).toBe("#fafafa");
    expect(root().style.getPropertyValue("--ansi-4")).toBe("#2472c8");
    store.addImported(midnight());
    store.setActiveTheme("midnight");
    expect(VERSION_TWO_PROPERTIES.filter((p) => root().style.getPropertyValue(p) !== "")).toEqual([]);
  });

  it("applies nothing for a stored palette that fails the gate", async () => {
    const { store } = await boot();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const theme = midnight("dim", { version: 2 });
    Object.assign(theme, { ansi: { ...PALETTE, "4": "#101010" } });
    store.applyTheme(theme, "imported");
    expect(root().getAttribute("style") ?? "").toBe("");
  });
});

function fillHalvesOf(theme: Theme, token: "secondary"): MetaColours {
  const filled = fillHalves(theme, collie());
  return { light: toSrgbHex(filled.light[token] ?? ""), dark: toSrgbHex(filled.dark[token] ?? "") };
}
