import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { en } from "@/lib/i18n/messages/en";
import { server } from "@/test/setup";
import type { ThemeOrigin } from "@/lib/theme/origin";
import { THEME_TOKENS, isOptionalThemeToken, parseTheme, type Theme } from "@/lib/theme/schema";

// The Theme card. The store keeps module-scope state (design prefs, the library), so each case
// imports a fresh graph over a storage it seeded itself. Only `collie` ships on the branch that
// wrote this file, so the options are checked against the store's own shipped list and never against
// four hard-coded names.

const web = resolve(import.meta.dirname, "../..");
const COLLIE_RAW = readFileSync(resolve(web, "src/themes/collie.json"), "utf8");
const LIBRARY_KEY = "collie:themes:v1";
const DESIGN_KEY = "collie:design:v1";

function collie(): Theme {
  const parsed = parseTheme(COLLIE_RAW, { maxBytes: 64 * 1024, allowReservedId: true });
  if (!parsed.ok) throw new Error("collie.json no longer parses");
  // The fixtures are version 1 copies of collie's 43 required tokens; the optional ones (version 3), the surface and the palette are left out.
  const strip = (half: Theme["light"]) => Object.fromEntries(Object.entries(half ?? {}).filter(([token]) => !isOptionalThemeToken(token)));
  const { surface: _surface, ansi: _ansi, ...rest } = parsed.theme;
  return { ...rest, version: 1, fonts: { ui: "aldrich" }, light: strip(parsed.theme.light), dark: strip(parsed.theme.dark) };
}

/** A complete imported theme: collie's tokens under another id and name. */
function copy(id: string, name: string, edit: (theme: Theme) => void = () => {}): Theme {
  const base = collie();
  const theme: Theme = { version: 1, id, name, author: "Test", light: { ...base.light }, dark: { ...base.dark } };
  edit(theme);
  return theme;
}

async function load(library: Theme[] = [], origins?: Record<string, ThemeOrigin>) {
  localStorage.clear();
  if (library.length > 0) localStorage.setItem(LIBRARY_KEY, JSON.stringify({ version: 1, themes: library, origins }));
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
  vi.resetModules();
  const component = await import("./theme-picker-control");
  const store = await import("@/lib/theme/store");
  return { ...component, store };
}

function fileOf(text: string, name = "theme.json"): File {
  return new File([text], name, { type: "application/json" });
}

function pick(container: HTMLElement, file: File): void {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("no file input");
  fireEvent.change(input, { target: { files: [file] } });
}

describe("ThemePickerControl", () => {
  // The global setup stubs the object-URL pair; a case that swaps or removes them puts them back.
  const objectUrls = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  beforeEach(() => {
    document.head.innerHTML = "";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    URL.createObjectURL = objectUrls.create;
    URL.revokeObjectURL = objectUrls.revoke;
  });

  it("draws one Theme row: a select with the shipped themes in the store's order, then the imported ones by name", async () => {
    const { ThemePickerControl, store } = await load([copy("zed", "Zed"), copy("mine", "Mine")]);
    render(<ThemePickerControl />);
    const select = screen.getByRole("combobox", { name: "Theme" });
    const options = within(select).getAllByRole("option");
    const shipped = store.shippedThemes().map((theme) => theme.name);
    expect(shipped).toEqual(["Collie", "Nightwatch", "Daylight", "Harbour"]);
    expect(options.map((option) => option.textContent)).toEqual([...shipped, "Zed", "Mine"]);
    expect(select).toHaveValue("collie");
    // The chip strip is gone: no radio group, no radios.
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("selects the current theme, also when it is an imported one", async () => {
    const { ThemePickerControl, store } = await load([copy("mine", "Mine")]);
    store.setActiveTheme("mine");
    render(<ThemePickerControl />);
    expect(screen.getByRole("combobox", { name: "Theme" })).toHaveValue("mine");
  });

  it("applies a chosen theme at once and writes the choice", async () => {
    const { ThemePickerControl, store } = await load([copy("mine", "Mine")]);
    render(<ThemePickerControl />);
    const select = screen.getByRole("combobox", { name: "Theme" });
    await userEvent.selectOptions(select, "Mine");
    expect(select).toHaveValue("mine");
    expect(store.activeThemeId()).toBe("mine");
    expect(JSON.parse(localStorage.getItem(DESIGN_KEY) ?? "{}").theme).toBe("mine");
    expect(document.documentElement.style.getPropertyValue("--background")).toContain("light-dark(");
    await userEvent.selectOptions(select, "Collie");
    expect(select).toHaveValue("collie");
    expect(store.activeThemeId()).toBe("collie");
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
  });

  it("applies a shipped theme other than the default", async () => {
    const { ThemePickerControl, store } = await load();
    render(<ThemePickerControl />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Theme" }), "Harbour");
    expect(store.activeThemeId()).toBe("harbour");
    expect(JSON.parse(localStorage.getItem(DESIGN_KEY) ?? "{}").theme).toBe("harbour");
  });

  it("says what a theme cannot do, in a line that is always there", async () => {
    const { ThemePickerControl } = await load();
    render(<ThemePickerControl />);
    expect(
      screen.getByText(
        "A theme changes how the app looks and nothing else. It cannot run code, load files or reach a server.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps Remove disabled while the active theme is not an imported one", async () => {
    const { ThemePickerControl } = await load([copy("mine", "Mine")]);
    render(<ThemePickerControl />);
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Theme" }), "Mine");
    expect(screen.getByRole("button", { name: "Remove" })).toBeEnabled();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Theme" }), "Daylight");
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
  });

  it("falls back to collie when the active imported theme is removed", async () => {
    const { ThemePickerControl, store } = await load([copy("mine", "Mine")]);
    render(<ThemePickerControl />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Theme" }), "Mine");
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(store.activeThemeId()).toBe("collie");
    expect(screen.queryByRole("option", { name: "Mine" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Theme" })).toHaveValue("collie");
    expect(localStorage.getItem(LIBRARY_KEY)).toBeNull();
  });

  describe("import", () => {
    it("lists every refusal of a refused file, names the key, and offers only Close", async () => {
      const { ThemePickerControl } = await load();
      const { container } = render(<ThemePickerControl />);
      const bad = JSON.stringify({ version: 5, id: "x", name: "X", light: { background: "#ffffff" }, bogus: 1 });
      pick(container, fileOf(bad));
      const dialog = await screen.findByRole("dialog", { name: "This file was not imported" });
      expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);
      expect(dialog).toHaveTextContent("bogus");
      expect(dialog).toHaveTextContent("version");
      expect(within(dialog).queryByRole("button", { name: "Apply" })).toBeNull();
      // The sheet's own corner button is also named Close; the text button is the card's.
      await userEvent.click(within(dialog).getByText("Close"));
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("refuses a file over the cap without reading it, with the real size", async () => {
      const { ThemePickerControl } = await load();
      const { container } = render(<ThemePickerControl />);
      pick(container, fileOf("x".repeat(65 * 1024)));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("This file is too big for a theme.");
      expect(dialog).toHaveTextContent(`${65 * 1024} bytes`);
    });

    it("tells a person with an exported shipped theme exactly what to change", async () => {
      const { ThemePickerControl } = await load();
      const { container } = render(<ThemePickerControl />);
      pick(container, fileOf(JSON.stringify(collie(), null, 2), "collie.collie-theme.json"));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent(
        'This id belongs to a shipped theme. Change "id" in the file to import your copy.',
      );
      expect(within(dialog).getAllByRole("listitem")).toHaveLength(1);
    });

    it("previews a theme with a failing floor as a warning and still allows Apply", async () => {
      const { ThemePickerControl } = await load();
      const { container } = render(<ThemePickerControl />);
      // About 3.2 to 1: under the warning floor (4.5), over the hard floor that refuses (3).
      const pale = copy("pale", "Pale", (theme) => {
        theme.light = { ...theme.light, foreground: "#888888" };
      });
      pick(container, fileOf(JSON.stringify(pale)));
      const dialog = await screen.findByRole("dialog", { name: "Import this theme?" });
      expect(dialog).toHaveTextContent("Pale");
      expect(dialog).toHaveTextContent("By Test");
      expect(dialog).toHaveTextContent("Light and dark");
      expect(dialog).toHaveTextContent("Light: foreground on background measures");
      expect(dialog).not.toHaveTextContent("Every contrast check passes.");
      expect(within(dialog).getByRole("button", { name: "Apply" })).toBeEnabled();
      // Eight swatches a half, each named by token and hex.
      expect(within(dialog).getAllByRole("img")).toHaveLength(16);
      expect(within(dialog).getAllByRole("img", { name: /^background #[0-9a-f]{6}$/ })).toHaveLength(2);
    });

    it("says so when a half is filled from the default theme", async () => {
      const { ThemePickerControl } = await load();
      const { container } = render(<ThemePickerControl />);
      const darkOnly = copy("dusk", "Dusk", (theme) => {
        delete theme.light;
      });
      pick(container, fileOf(JSON.stringify(darkOnly)));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("Dark only");
      expect(dialog).toHaveTextContent("It fills its light half from the default theme.");
    });

    it("passes a clean theme with one success line", async () => {
      const { ThemePickerControl } = await load();
      const { container } = render(<ThemePickerControl />);
      // collie's own dark destructive pair is 2.77:1 (a known finding of the first Collie look), so
      // the clean copy gives it a black ink. The light red itself stays: it is also drawn as text and
      // as a mark on the page, where a dark red would fail the destructive pairs (M57 spec 12).
      const clean = copy("same", "Same", (theme) => {
        theme.dark = { ...theme.dark, "destructive-foreground": "#000000" };
      });
      pick(container, fileOf(JSON.stringify(clean)));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("Every contrast check passes.");
    });

    it("cancel keeps nothing", async () => {
      const { ThemePickerControl, store } = await load();
      const { container } = render(<ThemePickerControl />);
      pick(container, fileOf(JSON.stringify(copy("same", "Same"))));
      await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(store.library()).toHaveLength(0);
    });

    it("apply adds the theme to the library and makes it the active one", async () => {
      const { ThemePickerControl, store } = await load();
      const { container } = render(<ThemePickerControl />);
      pick(container, fileOf(JSON.stringify(copy("same", "Same"))));
      await userEvent.click(await screen.findByRole("button", { name: "Apply" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(store.library().map((theme) => theme.id)).toEqual(["same"]);
      expect(store.activeThemeId()).toBe("same");
      expect(screen.getByRole("combobox", { name: "Theme" })).toHaveValue("same");
      expect(screen.getByRole("option", { name: "Same" })).toBeInTheDocument();
      expect(JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? "{}").themes).toHaveLength(1);
    });

    it("picking the same file twice works", async () => {
      const { ThemePickerControl } = await load();
      const { container } = render(<ThemePickerControl />);
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      const file = fileOf(JSON.stringify(copy("same", "Same")));
      pick(container, file);
      await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      expect(input.value).toBe("");
      pick(container, file);
      expect(await screen.findByRole("dialog", { name: "Import this theme?" })).toBeInTheDocument();
    });

    it("refuses an id that is already imported, at Apply", async () => {
      const { ThemePickerControl } = await load([copy("same", "Same")]);
      const { container } = render(<ThemePickerControl />);
      pick(container, fileOf(JSON.stringify(copy("same", "Same again"))));
      await userEvent.click(await screen.findByRole("button", { name: "Apply" }));
      const dialog = await screen.findByRole("dialog", { name: "This file was not imported" });
      expect(dialog).toHaveTextContent("already imported");
    });

    it("refuses at the Import button when the library is full", async () => {
      const full = Array.from({ length: 8 }, (_, i) => copy(`t${i}`, `Theme ${i}`));
      const { ThemePickerControl } = await load(full);
      render(<ThemePickerControl />);
      await userEvent.click(screen.getByRole("button", { name: "Import" }));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("You already hold 8 imported themes.");
    });

    it("opens the file chooser from the Import button", async () => {
      const { ThemePickerControl } = await load();
      const { container } = render(<ThemePickerControl />);
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      expect(input).toHaveAttribute("accept", ".json,application/json");
      const click = vi.spyOn(input, "click").mockImplementation(() => {});
      await userEvent.click(screen.getByRole("button", { name: "Import" }));
      expect(click).toHaveBeenCalledOnce();
    });
  });

  describe("the shape of a file (schema version 2)", () => {
    function surfaceFile(surface: Record<string, string>): string {
      return JSON.stringify({ ...copy("shaped", "Shaped"), version: 2, surface });
    }

    it("draws the file's shape on its own sample and names the thirteen words", async () => {
      const { ThemePickerControl } = await load();
      const { container } = render(<ThemePickerControl />);
      pick(container, fileOf(surfaceFile({ radius: "round", shadow: "lifted", density: "roomy", weight: "bold" })));
      const dialog = await screen.findByRole("dialog", { name: "Import this theme?" });
      expect(dialog).toHaveTextContent("Shape");
      const sample = within(dialog).getByTestId("theme-shape-sample");
      const box = sample.parentElement;
      expect(box?.style.getPropertyValue("--radius-lg")).toBe("16px");
      expect(box?.style.getPropertyValue("--spacing")).toBe("0.28rem");
      expect(box?.style.getPropertyValue("--font-weight-semibold")).toBe("700");
      expect(box?.style.getPropertyValue("--surface-shadow-md")).toBe(
        "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
      );
      // A token the file leaves out is drawn at its default word, never at the page's.
      expect(box?.style.getPropertyValue("--surface-border-width")).toBe("1px");
      expect(sample.className).toMatch(/\brounded-lg\b/);
      expect(sample.className).toMatch(/\bshadow-md\b/);
      expect(sample.className).toMatch(/\bp-3\b/);
      expect(within(sample).getByText("Sample").className).toMatch(/\bfont-medium\b/);
      const words = within(dialog).getByTestId("theme-shape-words");
      expect([...words.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
        "radius: round",
        "shadow: lifted",
        "density: roomy",
        "weight: bold",
        "border: default",
        "ground: flat",
        "chrome: band",
        "rows: rules",
        "icons: default",
        "labels: sentence",
        "zoom: screen",
        "tabs: plain",
        "composer: field",
      ]);
    });

    // ── Spec 17: the seven more tokens in the preview ───────────────────────────────────────────
    const PALETTE = {
      "0": "#000000", "1": "#cd3131", "2": "#0dbc79", "3": "#e5e510", "4": "#2472c8", "5": "#bc3fbc",
      "6": "#11a8cd", "7": "#e5e5e5", "8": "#666666", "9": "#f14c4c", "10": "#23d18b", "11": "#f5f543",
      "12": "#3b8eea", "13": "#d670d6", "14": "#29b8db", "15": "#ffffff", ink: "#fafafa", ground: "#14141e",
    };

    it("draws one small page per half in the file's colours, with its band, ground, rows, icons, labels and display face", async () => {
      const { ThemePickerControl } = await load();
      const { container } = render(<ThemePickerControl />);
      const file = {
        ...copy("paged", "Paged", (t) => {
          t.dark = { ...t.dark, secondary: "#223344", background: "#101820" };
        }),
        version: 2,
        surface: { ground: "grain", chrome: "band", rows: "cards", icons: "thin", labels: "sentence" },
        fonts: { display: "geist" },
      };
      pick(container, fileOf(JSON.stringify(file)));
      const dialog = await screen.findByRole("dialog", { name: "Import this theme?" });
      const dark = within(dialog).getByTestId("theme-page-sample-dark");
      expect(dark.style.colorScheme).toBe("dark");
      expect(dark.style.getPropertyValue("--background")).toBe("#101820");
      expect(dark.style.getPropertyValue("--secondary")).toBe("#223344");
      expect(dark.style.getPropertyValue("--band-ground")).toBe("var(--secondary)");
      expect(dark.style.getPropertyValue("--ground-image")).toContain("repeating-linear-gradient(45deg");
      expect(dark.style.getPropertyValue("--row-gap")).toBe("8px");
      expect(dark.style.getPropertyValue("--icon-stroke")).toBe("1.5");
      expect(dark.style.getPropertyValue("--label-transform")).toBe("none");
      expect(dark.style.getPropertyValue("--font-display")).toBe("var(--face-geist)");
      expect(dark.querySelector(".bg-band-ground")).not.toBeNull();
      expect(dark.querySelector('[data-slot="list-group"]')?.children).toHaveLength(2);
      expect(dark.querySelector("svg[data-icon]")).not.toBeNull();
      expect(within(dialog).getByTestId("theme-page-sample-light").style.colorScheme).toBe("light");
      const words = [...within(dialog).getByTestId("theme-shape-words").querySelectorAll("li")].map((li) => li.textContent);
      expect(words).toEqual(expect.arrayContaining(["ground: grain", "chrome: band", "rows: cards", "icons: thin", "labels: sentence", "display: geist"]));
    });

    it("draws the file's terminal palette as sixteen swatches on its ground", async () => {
      const { ThemePickerControl } = await load();
      const { container } = render(<ThemePickerControl />);
      pick(container, fileOf(JSON.stringify({ ...copy("term", "Term"), version: 2, ansi: PALETTE })));
      const dialog = await screen.findByRole("dialog", { name: "Import this theme?" });
      expect(dialog).toHaveTextContent("Terminal colours");
      const strip = within(dialog).getByTestId("theme-ansi-strip");
      expect(strip.style.background).toBe("rgb(20, 20, 30)");
      const swatches = within(strip).getAllByRole("img");
      expect(swatches).toHaveLength(16);
      expect(swatches[3]).toHaveAccessibleName("ansi 3 #e5e510");
      expect(strip).toHaveTextContent("ansi.ink #fafafa");
    });

    it("draws no palette strip for a file without one", async () => {
      const { ThemePickerControl } = await load();
      const { container } = render(<ThemePickerControl />);
      pick(container, fileOf(JSON.stringify(copy("plain", "Plain"))));
      const dialog = await screen.findByRole("dialog", { name: "Import this theme?" });
      expect(within(dialog).queryByTestId("theme-ansi-strip")).toBeNull();
      const dark = within(dialog).getByTestId("theme-page-sample-dark");
      expect(dark.style.getPropertyValue("--ground-image")).toBe("none");
      expect(dark.style.getPropertyValue("--font-display")).toBe("var(--font-sans)");
    });

    it("refuses a palette that fails its gate, naming the slot, and applies nothing", async () => {
      const { ThemePickerControl, store } = await load();
      const { container } = render(<ThemePickerControl />);
      pick(container, fileOf(JSON.stringify({ ...copy("dim", "Dim"), version: 2, ansi: { ...PALETTE, "4": "#20203a" } })));
      const dialog = await screen.findByRole("dialog", { name: "This file was not imported" });
      // The headline names both colours, the measured ratio and the floor.
      expect(dialog).toHaveTextContent(/ansi\.4 on ansi\.ground measures \d+(\.\d+)?\. It needs at least 3\./);
      expect(store.library()).toHaveLength(0);
    });

    it("says a file of a newer version was made for a newer Collie", async () => {
      const { ThemePickerControl } = await load();
      const { container } = render(<ThemePickerControl />);
      pick(container, fileOf(JSON.stringify({ ...copy("later", "Later"), version: 7 })));
      const dialog = await screen.findByRole("dialog", { name: "This file was not imported" });
      expect(dialog).toHaveTextContent("This file was made for a newer Collie (version 7). Update Collie to use it.");
    });

    it("names the two tokens and the ratio when page text cannot be read", async () => {
      const { ThemePickerControl } = await load();
      const { container } = render(<ThemePickerControl />);
      const base = copy("grey", "Grey");
      pick(container, fileOf(JSON.stringify({ ...base, light: { ...base.light, foreground: "#777777", background: "#808080" } })));
      const dialog = await screen.findByRole("dialog", { name: "This file was not imported" });
      expect(dialog).toHaveTextContent(/light\.foreground on light\.background measures \d+(\.\d+)?\. It needs at least 3\./);
    });

    it("exports the seven tokens as the file named them", async () => {
      const { themeFileText } = await load();
      const raw = {
        ...copy("all", "All"),
        version: 2,
        fonts: { display: "plex" },
        surface: { ground: "gradient", chrome: "band", rows: "cards", icons: "heavy", labels: "sentence" },
        ansi: PALETTE,
      };
      const parsed = parseTheme(JSON.stringify(raw), { maxBytes: 64 * 1024 });
      if (!parsed.ok) throw new Error(parsed.refusals.map((r) => r.detail).join("\n"));
      const out = JSON.parse(themeFileText(parsed.theme));
      expect(out.version).toBe(2);
      expect(out.surface).toEqual(raw.surface);
      expect(out.fonts).toEqual({ display: "plex" });
      expect(out.ansi).toEqual(PALETTE);
      const again = parseTheme(themeFileText(parsed.theme), { maxBytes: 64 * 1024 });
      expect(again.ok && again.theme).toEqual(parsed.theme);
    });

    it("draws a version 1 file at the default shape", async () => {
      const { ThemePickerControl } = await load();
      const { container } = render(<ThemePickerControl />);
      pick(container, fileOf(JSON.stringify(copy("plain", "Plain"))));
      const dialog = await screen.findByRole("dialog", { name: "Import this theme?" });
      const box = within(dialog).getByTestId("theme-shape-sample").parentElement;
      expect(box?.style.getPropertyValue("--radius-lg")).toBe("2px");
      expect(box?.style.getPropertyValue("--spacing")).toBe("0.25rem");
      expect(within(dialog).getByTestId("theme-shape-words")).toHaveTextContent("radius: sharp");
    });

    it("refuses a file with an unknown shape word, names the token, and applies nothing", async () => {
      const { ThemePickerControl, store } = await load();
      const { container } = render(<ThemePickerControl />);
      pick(container, fileOf(surfaceFile({ radius: "pill" })));
      const dialog = await screen.findByRole("dialog", { name: "This file was not imported" });
      expect(dialog).toHaveTextContent("A shape word is not valid.");
      expect(dialog).toHaveTextContent("surface.radius");
      expect(within(dialog).queryByRole("button", { name: "Apply" })).toBeNull();
      expect(store.library()).toHaveLength(0);
      expect(document.documentElement.getAttribute("style") ?? "").toBe("");
    });

    it("exports version 1 for a theme without a shape and version 2 for one with", async () => {
      const { themeFileText } = await load();
      const one = parseTheme(JSON.stringify(copy("old", "Old")), { maxBytes: 64 * 1024 });
      const twoPlain = parseTheme(JSON.stringify({ ...copy("plain", "Plain"), version: 2 }), { maxBytes: 64 * 1024 });
      const twoWithSurface = parseTheme(surfaceFile({ density: "roomy" }), { maxBytes: 64 * 1024 });
      if (!one.ok || !twoPlain.ok || !twoWithSurface.ok) throw new Error("a fixture no longer parses");
      expect(JSON.parse(themeFileText(one.theme)).version).toBe(1);
      expect(JSON.parse(themeFileText(twoPlain.theme)).version).toBe(1);
      expect(JSON.parse(themeFileText(twoWithSurface.theme)).version).toBe(2);
      // A stale version on the object never reaches the file: the content decides.
      expect(JSON.parse(themeFileText({ ...twoWithSurface.theme, version: 1 })).version).toBe(2);
      expect(Object.keys(JSON.parse(themeFileText(one.theme)))[0]).toBe("version");
    });

    it("keeps an imported version 1 file at version 1 in the library", async () => {
      const { ThemePickerControl } = await load();
      const { container } = render(<ThemePickerControl />);
      pick(container, fileOf(JSON.stringify(copy("old", "Old"))));
      await userEvent.click(await screen.findByRole("button", { name: "Apply" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? "{}").themes[0].version).toBe(1);
    });
  });

  describe("export", () => {
    it("saves the active theme as valid JSON under <id>.collie-theme.json", async () => {
      const { ThemePickerControl } = await load([copy("mine", "Mine")]);
      const blobs: Blob[] = [];
      URL.createObjectURL = vi.fn((blob: Blob) => {
        blobs.push(blob);
        return "blob:theme";
      });
      URL.revokeObjectURL = vi.fn();
      const names: string[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
        names.push(this.download);
      });
      render(<ThemePickerControl />);
      await userEvent.selectOptions(screen.getByRole("combobox", { name: "Theme" }), "Mine");
      await userEvent.click(screen.getByRole("button", { name: "Export" }));
      expect(URL.createObjectURL).toHaveBeenCalledOnce();
      expect(names).toEqual(["mine.collie-theme.json"]);
      const text = await blobs[0]!.text();
      expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2));
      const parsed = parseTheme(text, { maxBytes: 64 * 1024 });
      expect(parsed.ok).toBe(true);
      expect(Object.keys(JSON.parse(text).light).toSorted()).toEqual([...THEME_TOKENS].toSorted());
    });

    it("exports a shipped theme to a file that re-imports and is refused only for its id", async () => {
      const { ThemePickerControl } = await load();
      const blobs: Blob[] = [];
      URL.createObjectURL = vi.fn((blob: Blob) => {
        blobs.push(blob);
        return "blob:theme";
      });
      URL.revokeObjectURL = vi.fn();
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      render(<ThemePickerControl />);
      await userEvent.click(screen.getByRole("button", { name: "Export" }));
      const text = await blobs[0]!.text();
      const reparsed = parseTheme(text, { maxBytes: 64 * 1024 });
      expect(reparsed.ok).toBe(false);
      if (!reparsed.ok) expect(reparsed.refusals.map((refusal) => refusal.code)).toEqual(["reserved-id"]);
    });

    it("falls back to a sheet with a copyable block when the browser cannot save a file", async () => {
      const { ThemePickerControl } = await load();
      render(<ThemePickerControl />);
      // A browser that cannot make an object URL: the global stub is set aside, then put back after the case.
      URL.createObjectURL = () => {
        throw new TypeError("URL.createObjectURL is not available");
      };
      await act(async () => {
        await userEvent.click(screen.getByRole("button", { name: "Export" }));
      });
      const dialog = await screen.findByRole("dialog", { name: "Copy this theme" });
      const shown = within(dialog).getByText(/"id": "collie"/);
      expect(JSON.parse(shown.textContent ?? "").id).toBe("collie");
    });
  });

  describe("paste a theme (M59 spec 04)", () => {
    async function openPaste() {
      await userEvent.click(screen.getByRole("button", { name: "Paste" }));
      return screen.findByRole("dialog", { name: "Paste a theme" });
    }

    function paste(dialog: HTMLElement, text: string): void {
      fireEvent.change(within(dialog).getByLabelText("The text of a theme file"), { target: { value: text } });
    }

    it("previews pasted text with the file's preview, and Apply keeps it", async () => {
      const { ThemePickerControl, store } = await load();
      render(<ThemePickerControl />);
      const sheet = await openPaste();
      paste(sheet, `  ${JSON.stringify(copy("pasted", "Pasted"))}\n`);
      await userEvent.click(within(sheet).getByRole("button", { name: "Read" }));
      const preview = await screen.findByRole("dialog", { name: "Import this theme?" });
      expect(preview).toHaveTextContent("Pasted");
      expect(screen.queryByRole("dialog", { name: "Paste a theme" })).toBeNull();
      await userEvent.click(within(preview).getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(store.library().map((theme) => theme.id)).toEqual(["pasted"]);
      expect(store.activeThemeId()).toBe("pasted");
    });

    it("keeps Read off while the field is empty or blank", async () => {
      const { ThemePickerControl } = await load();
      render(<ThemePickerControl />);
      const sheet = await openPaste();
      expect(within(sheet).getByRole("button", { name: "Read" })).toBeDisabled();
      paste(sheet, "   ");
      expect(within(sheet).getByRole("button", { name: "Read" })).toBeDisabled();
    });

    it("refuses a pasted https link and fetches nothing", async () => {
      const fetching = vi.spyOn(globalThis, "fetch");
      const { ThemePickerControl, store } = await load();
      render(<ThemePickerControl />);
      paste(await openPaste(), "https://raw.githubusercontent.com/sam/my-day/main/collie-theme.json");
      await userEvent.click(screen.getByRole("button", { name: "Read" }));
      const dialog = await screen.findByRole("dialog", { name: "This file was not imported" });
      expect(dialog).toHaveTextContent(en["theme.paste.refusal.link"]);
      expect(fetching).not.toHaveBeenCalled();
      expect(store.library()).toHaveLength(0);
    });

    it("refuses a pasted http link the same way, before the parser", async () => {
      const fetching = vi.spyOn(globalThis, "fetch");
      const { ThemePickerControl } = await load();
      render(<ThemePickerControl />);
      paste(await openPaste(), "http://example.com/theme.json");
      await userEvent.click(screen.getByRole("button", { name: "Read" }));
      const dialog = await screen.findByRole("dialog", { name: "This file was not imported" });
      expect(within(dialog).getAllByRole("listitem")).toHaveLength(1);
      expect(dialog).toHaveTextContent(en["theme.paste.refusal.link"]);
      expect(dialog).not.toHaveTextContent(en["theme.refusal.json"]);
      expect(fetching).not.toHaveBeenCalled();
    });

    it("refuses a paste over the cap with the real size", async () => {
      const { ThemePickerControl } = await load();
      render(<ThemePickerControl />);
      paste(await openPaste(), `{"pad":"${"x".repeat(65 * 1024)}"}`);
      await userEvent.click(screen.getByRole("button", { name: "Read" }));
      const dialog = await screen.findByRole("dialog", { name: "This file was not imported" });
      expect(dialog).toHaveTextContent(en["theme.refusal.size"]);
      expect(dialog).toHaveTextContent(`${65 * 1024 + 10} bytes`);
    });

    it("refuses bad JSON with the file's refusal words, and keeps the text to fix", async () => {
      const { ThemePickerControl } = await load();
      render(<ThemePickerControl />);
      paste(await openPaste(), '{ "version": 1, "id": ');
      await userEvent.click(screen.getByRole("button", { name: "Read" }));
      const dialog = await screen.findByRole("dialog", { name: "This file was not imported" });
      expect(dialog).toHaveTextContent(en["theme.refusal.json"]);
      // The sheet's own close and the Close button carry the same name; either shuts it.
      await userEvent.click(within(dialog).getAllByRole("button", { name: "Close" })[0]!);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      const again = await openPaste();
      expect(within(again).getByLabelText("The text of a theme file")).toHaveValue('{ "version": 1, "id": ');
    });

    it("refuses pasted text the parser refuses, naming the key", async () => {
      const { ThemePickerControl } = await load();
      render(<ThemePickerControl />);
      paste(await openPaste(), JSON.stringify({ ...copy("odd", "Odd"), extra: true }));
      await userEvent.click(screen.getByRole("button", { name: "Read" }));
      const dialog = await screen.findByRole("dialog", { name: "This file was not imported" });
      expect(dialog).toHaveTextContent(en["theme.refusal.unknown-key"]);
      expect(dialog).toHaveTextContent("extra");
    });

    it("refuses at the Paste button when the library is full", async () => {
      const full = Array.from({ length: 8 }, (_, i) => copy(`t${i}`, `Theme ${i}`));
      const { ThemePickerControl } = await load(full);
      render(<ThemePickerControl />);
      await userEvent.click(screen.getByRole("button", { name: "Paste" }));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("You already hold 8 imported themes.");
      expect(screen.queryByRole("dialog", { name: "Paste a theme" })).toBeNull();
    });
  });

  describe("browse community themes (M59 spec 06)", () => {
    const SHA = "0123456789abcdef0123456789abcdef01234567";

    function registry(themes: Theme[]) {
      server.use(
        http.get("/api/themes/registry", () =>
          HttpResponse.json({
            fetchedAt: "2026-11-07T10:00:00.000Z",
            ageMs: 60_000,
            generated: null,
            dropped: 0,
            fetching: false,
            themes: themes.map((theme) => ({ repo: `sam/${theme.id}`, sha: SHA, path: "collie-theme.json", text: JSON.stringify(theme) })),
          }),
        ),
      );
    }

    it("Install opens the file's preview, and Apply keeps the theme", async () => {
      registry([copy("shared", "Shared")]);
      const { ThemePickerControl, store } = await load();
      render(<ThemePickerControl />);
      await userEvent.click(screen.getByRole("button", { name: "Browse community themes" }));
      const sheet = await screen.findByRole("dialog", { name: "Community themes" });
      await userEvent.click(await within(sheet).findByRole("button", { name: "Install" }));
      const preview = await screen.findByRole("dialog", { name: "Import this theme?" });
      expect(screen.queryByRole("dialog", { name: "Community themes" })).toBeNull();
      await userEvent.click(within(preview).getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(store.library().map((theme) => theme.id)).toEqual(["shared"]);
      expect(store.activeThemeId()).toBe("shared");
    });

    it("Install with eight imported themes refuses before the preview", async () => {
      registry([copy("shared", "Shared")]);
      const full = Array.from({ length: 8 }, (_, i) => copy(`t${i}`, `Theme ${i}`));
      const { ThemePickerControl } = await load(full);
      render(<ThemePickerControl />);
      await userEvent.click(screen.getByRole("button", { name: "Browse community themes" }));
      const sheet = await screen.findByRole("dialog", { name: "Community themes" });
      await userEvent.click(await within(sheet).findByRole("button", { name: "Install" }));
      const dialog = await screen.findByRole("dialog", { name: "This file was not imported" });
      expect(dialog).toHaveTextContent("You already hold 8 imported themes.");
    });
  });

  describe("About and Update (theme sources)", () => {
    const OLD = "1111111111111111111111111111111111111111";
    const NEW = "2222222222222222222222222222222222222222";
    const AT = Date.parse("2026-11-08T10:00:00Z");
    const ORIGIN: ThemeOrigin = { kind: "registry", repo: "sam/shared", path: "collie-theme.json", sha: OLD, at: AT };

    /** The host's copy: `listed` at `sha`, made at `generated`. Counts the reads and the refreshes. */
    /** The host's copy of the list. `none`: the host never fetched one, until a POST fetches `afterPost`. */
    function hostList(listed: Theme[], opts: { sha?: string; none?: boolean; afterPost?: { sha: string }; texts?: string[] } = {}) {
      const calls = { gets: 0, posts: 0 };
      const body = (sha: string, none: boolean) => ({
        fetchedAt: none ? null : "2026-11-08T12:00:00.000Z",
        ageMs: none ? null : 60_000,
        generated: none ? null : "2026-11-08T06:00:00Z",
        dropped: 0,
        fetching: false,
        themes: none
          ? []
          : [
              ...listed.map((theme) => ({ repo: `sam/${theme.id}`, sha, path: "collie-theme.json", text: JSON.stringify(theme) })),
              ...(opts.texts ?? []).map((text) => ({ repo: "sam/shared", sha, path: "collie-theme.json", text })),
            ],
      });
      let current = body(opts.sha ?? NEW, opts.none === true);
      server.use(
        http.get("/api/themes/registry", () => {
          calls.gets += 1;
          return HttpResponse.json(current);
        }),
        http.post("/api/themes/registry", () => {
          calls.posts += 1;
          if (opts.afterPost !== undefined) current = body(opts.afterPost.sha, false);
          return HttpResponse.json(current);
        }),
      );
      return calls;
    }

    const aboutButton = (name: string) => screen.getByRole("button", { name: `About ${name}` });

    it("keeps About a disabled slot on a shipped theme", async () => {
      const { ThemePickerControl } = await load();
      render(<ThemePickerControl />);
      expect(aboutButton("Collie")).toBeDisabled();
    });

    it("Install from Browse records where the theme came from, and About shows it with links built on the phone", async () => {
      hostList([copy("shared", "Shared")], { sha: OLD });
      const { ThemePickerControl, store } = await load();
      render(<ThemePickerControl />);
      await userEvent.click(screen.getByRole("button", { name: "Browse community themes" }));
      const sheet = await screen.findByRole("dialog", { name: "Community themes" });
      await userEvent.click(await within(sheet).findByRole("button", { name: "Install" }));
      const preview = await screen.findByRole("dialog", { name: "Import this theme?" });
      expect(preview).toHaveTextContent("From sam/shared");
      await userEvent.click(within(preview).getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(store.originOf("shared")).toMatchObject({ kind: "registry", repo: "sam/shared", path: "collie-theme.json", sha: OLD });

      await userEvent.click(aboutButton("Shared"));
      const about = await screen.findByRole("dialog", { name: "About this theme" });
      expect(within(about).getByRole("link", { name: "@sam/shared" })).toHaveAttribute("href", "https://github.com/sam/shared");
      expect(within(about).getByRole("link", { name: "collie-theme.json" })).toHaveAttribute(
        "href",
        `https://github.com/sam/shared/blob/${OLD}/collie-theme.json`,
      );
      expect(about).toHaveTextContent("1111111");
      expect(within(about).getByRole("link", { name: "Report Shared on GitHub" })).toHaveAttribute(
        "href",
        expect.stringContaining("https://github.com/AltanS/collie/issues/new"),
      );
    });

    it("says a file, a paste, or this device, with no link", async () => {
      const { ThemePickerControl, store } = await load(
        [copy("filed", "Filed"), copy("pasted", "Pasted"), copy("old", "Old")],
        { filed: { kind: "file", at: AT }, pasted: { kind: "paste", at: AT } },
      );
      render(<ThemePickerControl />);
      for (const [id, name, words] of [
        ["filed", "Filed", "Added from a file on"],
        ["pasted", "Pasted", "Pasted on"],
        ["old", "Old", "Added on this device."],
      ] as const) {
        act(() => store.setActiveTheme(id));
        await userEvent.click(aboutButton(name));
        const about = await screen.findByRole("dialog", { name: "About this theme" });
        expect(about).toHaveTextContent(words);
        expect(within(about).queryByRole("link")).toBeNull();
        await userEvent.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      }
    });

    it("a file that is a listed theme gets that entry's source, stored at the import", async () => {
      hostList([copy("shared", "Shared")], { sha: OLD });
      const { ThemePickerControl, store } = await load();
      const { container } = render(<ThemePickerControl />);
      const before = Date.now();
      // The same theme, keys in another order and other white space.
      const theme = copy("shared", "Shared");
      const reordered = { dark: theme.dark, light: theme.light, name: theme.name, author: theme.author, id: theme.id, version: theme.version };
      pick(container, fileOf(JSON.stringify(reordered, null, 4)));
      const preview = await screen.findByRole("dialog", { name: "Import this theme?" });
      await userEvent.click(within(preview).getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(store.originOf("shared")).toMatchObject({ kind: "registry", repo: "sam/shared", sha: OLD }));
      expect(store.originOf("shared")?.at).toBeGreaterThanOrEqual(before);
      await userEvent.click(aboutButton("Shared"));
      const about = await screen.findByRole("dialog", { name: "About this theme" });
      expect(within(about).getByRole("link", { name: "@sam/shared" })).toHaveAttribute("href", "https://github.com/sam/shared");
    });

    async function openPasteSheet() {
      await userEvent.click(screen.getByRole("button", { name: "Paste" }));
      return screen.findByRole("dialog", { name: "Paste a theme" });
    }

    it("a paste that is a listed theme gets its source too; two listed copies give none", async () => {
      hostList([copy("shared", "Shared")], { sha: OLD });
      const first = await load();
      render(<first.ThemePickerControl />);
      let sheet = await openPasteSheet();
      fireEvent.change(within(sheet).getByLabelText("The text of a theme file"), { target: { value: JSON.stringify(copy("shared", "Shared")) } });
      await userEvent.click(within(sheet).getByRole("button", { name: "Read" }));
      let preview = await screen.findByRole("dialog", { name: "Import this theme?" });
      await userEvent.click(within(preview).getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(first.store.originOf("shared")?.kind).toBe("registry"));
      cleanup();

      // A fork with the same content: Collie never guesses which one.
      hostList([copy("shared", "Shared")], { sha: OLD, texts: [JSON.stringify(copy("shared", "Shared"))] });
      const second = await load();
      render(<second.ThemePickerControl />);
      sheet = await openPasteSheet();
      fireEvent.change(within(sheet).getByLabelText("The text of a theme file"), { target: { value: JSON.stringify(copy("shared", "Shared")) } });
      await userEvent.click(within(sheet).getByRole("button", { name: "Read" }));
      preview = await screen.findByRole("dialog", { name: "Import this theme?" });
      await userEvent.click(within(preview).getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(second.store.originOf("shared")?.kind).toBe("paste"));
    });

    it("a kept theme with no source shows the listed source it matches, and stores nothing", async () => {
      const calls = hostList([copy("shared", "Shared")], { sha: OLD });
      const { ThemePickerControl, store } = await load([copy("shared", "Shared")]);
      act(() => store.setActiveTheme("shared"));
      render(<ThemePickerControl />);
      await userEvent.click(aboutButton("Shared"));
      const about = await screen.findByRole("dialog", { name: "About this theme" });
      expect(await within(about).findByRole("link", { name: "@sam/shared" })).toBeInTheDocument();
      expect(within(about).getByText("Added on this device.")).toBeInTheDocument();
      expect(within(about).queryByText("Installed")).toBeNull();
      expect(within(about).getByText("No newer version is listed.")).toBeInTheDocument();
      expect(store.originOf("shared")).toBeUndefined();
      expect(calls.posts).toBe(0);
    });

    it("a file import records the file kind", async () => {
      const { ThemePickerControl, store } = await load();
      const { container } = render(<ThemePickerControl />);
      pick(container, fileOf(JSON.stringify(copy("mine", "Mine"))));
      const preview = await screen.findByRole("dialog", { name: "Import this theme?" });
      await userEvent.click(within(preview).getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(store.originOf("mine")?.kind).toBe("file"));
    });

    it("offers Update for a newer commit of the same file, and Update replaces the theme in its slot and keeps it on", async () => {
      const calls = hostList([copy("shared", "Shared 2")]);
      const { ThemePickerControl, store } = await load([copy("a", "A"), copy("shared", "Shared"), copy("c", "C")], { shared: ORIGIN });
      act(() => store.setActiveTheme("shared"));
      render(<ThemePickerControl />);
      await userEvent.click(aboutButton("Shared"));
      const about = await screen.findByRole("dialog", { name: "About this theme" });
      expect(await within(about).findByText("A newer version is listed.")).toBeInTheDocument();
      await userEvent.click(within(about).getByRole("button", { name: "Update" }));
      const preview = await screen.findByRole("dialog", { name: "Import this theme?" });
      expect(within(preview).queryByRole("button", { name: "Try" })).toBeNull();
      await userEvent.click(within(preview).getByRole("button", { name: "Update" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(store.library().map((theme) => theme.name)).toEqual(["A", "Shared 2", "C"]);
      expect(store.activeThemeId()).toBe("shared");
      expect(store.originOf("shared")).toMatchObject({ sha: NEW });
      expect(calls.posts).toBe(0);
    });

    it("refuses an update whose theme was reinstalled after About checked it, saying the theme is unchanged", async () => {
      hostList([copy("shared", "Shared 2")]);
      const { ThemePickerControl, store } = await load([copy("shared", "Shared")], { shared: ORIGIN });
      act(() => store.setActiveTheme("shared"));
      render(<ThemePickerControl />);
      await userEvent.click(aboutButton("Shared"));
      const about = await screen.findByRole("dialog", { name: "About this theme" });
      await userEvent.click(await within(about).findByRole("button", { name: "Update" }));
      const preview = await screen.findByRole("dialog", { name: "Import this theme?" });
      // Removed and installed again, at another commit, while the preview is open.
      act(() => {
        store.removeImported("shared");
        store.addImported(copy("shared", "Shared again"), { ...ORIGIN, sha: NEW });
      });
      await userEvent.click(within(preview).getByRole("button", { name: "Update" }));
      const refused = await screen.findByRole("dialog", { name: "This file was not imported" });
      expect(refused).toHaveTextContent("This theme changed after About checked it, so your current theme is unchanged; open About again.");
      expect(store.library().map((theme) => theme.name)).toEqual(["Shared again"]);
    });

    it("Check for updates is the one tap that fetches, shown while the host has no copy", async () => {
      const calls = hostList([copy("shared", "Shared 2")], { none: true, afterPost: { sha: NEW } });
      const { ThemePickerControl, store } = await load([copy("shared", "Shared")], { shared: ORIGIN });
      act(() => store.setActiveTheme("shared"));
      render(<ThemePickerControl />);
      await userEvent.click(aboutButton("Shared"));
      const about = await screen.findByRole("dialog", { name: "About this theme" });
      const check = await within(about).findByRole("button", { name: "Check for updates" });
      expect(within(about).queryByRole("button", { name: "Update" })).toBeNull();
      expect(calls).toEqual({ gets: 1, posts: 0 });
      await userEvent.click(check);
      expect(await within(about).findByText("A newer version is listed.")).toBeInTheDocument();
      expect(calls.posts).toBe(1);
    });

    it("says the listed version needs a newer Collie, with no Update, when this Collie cannot read it", async () => {
      const future = JSON.stringify({ ...copy("shared", "Shared 9"), version: 99 });
      hostList([], { texts: [future] });
      const { ThemePickerControl, store } = await load([copy("shared", "Shared")], { shared: ORIGIN });
      act(() => store.setActiveTheme("shared"));
      render(<ThemePickerControl />);
      await userEvent.click(aboutButton("Shared"));
      const about = await screen.findByRole("dialog", { name: "About this theme" });
      expect(await within(about).findByText(/needs a newer Collie/)).toBeInTheDocument();
      expect(within(about).queryByRole("button", { name: /Update|Check for updates/ })).toBeNull();
    });

    it("says No longer listed when a newer list no longer holds the file", async () => {
      hostList([copy("other", "Other")]);
      const { ThemePickerControl, store } = await load([copy("shared", "Shared")], { shared: ORIGIN });
      act(() => store.setActiveTheme("shared"));
      render(<ThemePickerControl />);
      await userEvent.click(aboutButton("Shared"));
      const about = await screen.findByRole("dialog", { name: "About this theme" });
      expect(await within(about).findByText("No longer listed. Your installed copy keeps working.")).toBeInTheDocument();
      expect(within(about).queryByRole("button", { name: /Update|Check for updates/ })).toBeNull();
    });
  });

  describe("try a theme (M59 spec 08)", () => {
    it("Try on the preview wears the theme, keeps nothing, and closes the sheet", async () => {
      sessionStorage.clear();
      const { ThemePickerControl, store } = await load();
      const trial = await import("@/lib/theme/trial");
      const { container } = render(<ThemePickerControl />);
      pick(container, fileOf(JSON.stringify(copy("tried", "Tried", (theme) => (theme.dark = { ...theme.dark, background: "#123456" })))));
      const preview = await screen.findByRole("dialog", { name: "Import this theme?" });
      await userEvent.click(within(preview).getByRole("button", { name: "Try" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(trial.currentTrial()?.theme.id).toBe("tried");
      expect(store.library()).toEqual([]);
      expect(store.activeThemeId()).toBe("collie");
      expect(document.documentElement.style.getPropertyValue("--background")).toContain("#123456");
    });

    it("a pick in the Theme row ends the trial", async () => {
      sessionStorage.clear();
      const { ThemePickerControl, store } = await load();
      const trial = await import("@/lib/theme/trial");
      render(<ThemePickerControl />);
      act(() => void trial.startTrial(copy("tried", "Tried")));
      await userEvent.selectOptions(screen.getByRole("combobox", { name: "Theme" }), "Harbour");
      expect(trial.currentTrial()).toBeNull();
      expect(store.activeThemeId()).toBe("harbour");
    });
  });
});

describe("ThemePickerControl and the header character", () => {
  it("shows the character a file names in the preview, drawn from the file and not from the device", async () => {
    const { ThemePickerControl } = await load();
    const { container } = render(<ThemePickerControl />);
    pick(container, fileOf(JSON.stringify({ ...copy("kawaii-day", "Kawaii day"), version: 4, character: "kawaii" })));
    const dialog = await screen.findByRole("dialog", { name: "Import this theme?" });
    const line = within(dialog).getByTestId("theme-mark-line");
    expect(line).toHaveTextContent("Character: Kawaii");
    expect(line.querySelector('[data-slot="brand-mark-pending"], svg')).not.toBeNull();
  });

  it("shows no character line for a file that names none", async () => {
    const { ThemePickerControl } = await load();
    const { container } = render(<ThemePickerControl />);
    pick(container, fileOf(JSON.stringify(copy("plain", "Plain"))));
    const dialog = await screen.findByRole("dialog", { name: "Import this theme?" });
    expect(within(dialog).queryByTestId("theme-mark-line")).toBeNull();
  });

  it("shows the five sample icons of a file's glyph set, in that set, and no line for a file without one", async () => {
    const { ThemePickerControl } = await load();
    const { container } = render(<ThemePickerControl />);
    pick(container, fileOf(JSON.stringify({ ...copy("duo-day", "Duo day"), version: 4, glyphs: "phosphor-duotone" })));
    const dialog = await screen.findByRole("dialog", { name: "Import this theme?" });
    const line = within(dialog).getByTestId("theme-glyphs-line");
    expect(line).toHaveTextContent("Icons: Phosphor Duotone");
    const shown = [...line.querySelectorAll("svg")].map((svg) => svg.getAttribute("data-icon"));
    expect(shown).toEqual(["close", "send", "settings", "back", "attach"]);
    await waitFor(() => expect(line.querySelector('svg[data-glyphs="phosphor-duotone"]')).not.toBeNull());
  });

  it("imports a file with words this Collie does not have, says so line by line, and keeps the words", async () => {
    const { ThemePickerControl, store, themeFileText } = await load();
    const { container } = render(<ThemePickerControl />);
    const future = { ...copy("future", "Future"), version: 4, glyphs: "tabler", character: "dragon", fonts: { display: "comic" } };
    pick(container, fileOf(JSON.stringify(future)));
    const preview = await screen.findByRole("dialog", { name: "Import this theme?" });
    const lines = within(preview).getAllByTestId("theme-fallback-line").map((line) => line.textContent);
    expect(lines).toEqual([
      'This Collie does not have the typeface "comic"; it uses the standard one.',
      'This Collie does not have the character "dragon"; it shows the standard character.',
      'This Collie does not have the icon set "tabler"; it shows the standard icons.',
    ]);
    // No sample row for a set or a character this Collie cannot draw.
    expect(within(preview).queryByTestId("theme-glyphs-line")).toBeNull();
    expect(within(preview).queryByTestId("theme-mark-line")).toBeNull();
    await userEvent.click(within(preview).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(store.activeThemeId()).toBe("future"));
    const stored = store.library()[0];
    expect(stored).toMatchObject({ glyphs: "tabler", character: "dragon", fonts: { display: "comic" } });
    if (stored === undefined) return;
    expect(JSON.parse(themeFileText(stored))).toMatchObject({ glyphs: "tabler", character: "dragon", fonts: { display: "comic" } });
  });

  it("keeps a stored theme's unknown words through a reload of the library, and wears the defaults", async () => {
    const future: Theme = { ...copy("kept", "Kept"), version: 4, glyphs: "tabler", surface: { ground: { pattern: "stars", size: "wide" } } };
    const { store } = await load([future]);
    expect(store.library()[0]).toMatchObject({ glyphs: "tabler", surface: { ground: { pattern: "stars", size: "wide" } } });
    store.setActiveTheme("kept");
    const glyphs = await import("@/lib/glyphs");
    expect(glyphs.currentGlyphSetId()).toBe("lucide");
    expect(document.documentElement.style.getPropertyValue("--ground-image")).toBe("none");
    expect(document.documentElement.style.getPropertyValue("--ground-scale")).toBe("2");
  });

  it("refuses a character in a file that says version 3, and names the version it needs", async () => {
    const { ThemePickerControl, store } = await load();
    const { container } = render(<ThemePickerControl />);
    pick(container, fileOf(JSON.stringify({ ...copy("old", "Old"), version: 3, character: "pixel" })));
    const dialog = await screen.findByRole("dialog", { name: "This file was not imported" });
    expect(dialog).toHaveTextContent('A file with "character" must say version 4. This one says version 3.');
    expect(store.library()).toHaveLength(0);
  });

  it("refuses a character word of the wrong shape and lists every one", async () => {
    const { ThemePickerControl } = await load();
    const { container } = render(<ThemePickerControl />);
    pick(container, fileOf(JSON.stringify({ ...copy("odd", "Odd"), version: 4, character: "Dog" })));
    const dialog = await screen.findByRole("dialog", { name: "This file was not imported" });
    expect(dialog).toHaveTextContent("The character choice is not valid.");
    expect(dialog).toHaveTextContent('"character" must be one of: collie, kawaii, kawaii-tilt, pixel, glass, glass-front, sheep, owl.');
  });

  it("exports a theme with a character as version 4, and the file imports back to the same theme", async () => {
    const { themeFileText } = await load();
    const parsed = parseTheme(JSON.stringify({ ...copy("m", "M"), version: 4, character: "pixel" }), { maxBytes: 64 * 1024 });
    if (!parsed.ok) throw new Error(parsed.refusals.map((r) => r.detail).join("\n"));
    const text = themeFileText(parsed.theme);
    expect(JSON.parse(text)).toMatchObject({ version: 4, character: "pixel" });
    const again = parseTheme(text, { maxBytes: 64 * 1024 });
    expect(again.ok && again.theme).toEqual(parsed.theme);
  });

  it("exports a theme without a character exactly as before: no character key, the version its content needs", async () => {
    const { themeFileText } = await load();
    const parsed = parseTheme(JSON.stringify(copy("old", "Old")), { maxBytes: 64 * 1024 });
    if (!parsed.ok) throw new Error("fixture");
    const doc = JSON.parse(themeFileText(parsed.theme));
    expect(doc).not.toHaveProperty("character");
    expect(doc.version).toBe(1);
  });
});
