import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  // The fixtures are version 1 copies of collie's 43 required tokens; the optional ones (version 3) are left out.
  const strip = (half: Theme["light"]) => Object.fromEntries(Object.entries(half ?? {}).filter(([token]) => !isOptionalThemeToken(token)));
  return { ...parsed.theme, version: 1, light: strip(parsed.theme.light), dark: strip(parsed.theme.dark) };
}

/** A complete imported theme: collie's tokens under another id and name. */
function copy(id: string, name: string, edit: (theme: Theme) => void = () => {}): Theme {
  const base = collie();
  const theme: Theme = { version: 1, id, name, author: "Test", light: { ...base.light }, dark: { ...base.dark } };
  edit(theme);
  return theme;
}

async function load(library: Theme[] = []) {
  localStorage.clear();
  if (library.length > 0) localStorage.setItem(LIBRARY_KEY, JSON.stringify({ version: 1, themes: library }));
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
      const bad = JSON.stringify({ version: 4, id: "x", name: "X", light: { background: "#ffffff" }, bogus: 1 });
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
      const pale = copy("pale", "Pale", (theme) => {
        theme.light = { ...theme.light, foreground: "#eeeeee" };
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
      // collie's own dark destructive pair is 2.77:1 (a known finding, pinned in themes.test.ts), so
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

    it("draws the file's shape on its own sample and names the ten words", async () => {
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
        "chrome: page",
        "rows: rules",
        "icons: default",
        "labels: caps",
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
      expect(dark.querySelector("svg.lucide")).not.toBeNull();
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
      expect(dialog).toHaveTextContent("A terminal colour is not valid, or it fails its contrast floor.");
      expect(dialog).toHaveTextContent("ansi.4");
      expect(store.library()).toHaveLength(0);
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
});
