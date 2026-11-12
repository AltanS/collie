import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CharacterPicker } from "@/components/character-picker";
import { __resetDesign, designPrefs, setDesignMark } from "@/lib/design";
import { MARKS } from "@/lib/mark-ids";
import { LIBRARY_STORAGE_KEY, __resetThemeStore, setActiveTheme } from "@/lib/theme/store";

// The Character page: a radio group of "From the theme" and one row per character, each drawn three
// ways (Still, Loading, Idle). The marks are the real generated ones, so a case can read the contract's
// `data-still` on each: that attribute is how the page keeps its cost low.

/** An observer the test drives. The page must hold ONE for all its rows. */
class FakeObserver {
  static all: FakeObserver[] = [];
  readonly targets: Element[] = [];
  readonly report: (entries: { target: Element; isIntersecting: boolean }[]) => void;
  disconnected = false;
  constructor(report: (entries: { target: Element; isIntersecting: boolean }[]) => void) {
    this.report = report;
    FakeObserver.all.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  disconnect() {
    this.disconnected = true;
  }
  /** Say which of the watched rows are on screen, by their `data-row`. */
  see(rows: Record<string, boolean>) {
    const entries = this.targets
      .filter((target) => (target.getAttribute("data-row") ?? "") in rows)
      .map((target) => ({ target, isIntersecting: rows[target.getAttribute("data-row") ?? ""] === true }));
    this.report(entries);
  }
}

const group = () => screen.getByRole("radiogroup", { name: "Character" });
const radios = () => within(group()).getAllByRole("radio");
const row = (name: string) => screen.getByRole("radio", { name });
const stored = () => JSON.parse(localStorage.getItem("collie:design:v1") ?? "null");

/** The three marks of a row, in column order: Still, Loading, Idle. */
const marksOf = (name: string) => Array.from(row(name).querySelectorAll("svg[data-mark]"));

/** Every chunk has arrived: no row holds an empty box any more. */
async function loaded() {
  await waitFor(() => expect(document.querySelector('[data-slot="brand-mark-pending"]')).toBeNull());
}

beforeEach(() => {
  FakeObserver.all = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  localStorage.clear();
  __resetDesign();
  __resetThemeStore();
});
afterEach(() => vi.unstubAllGlobals());

describe("CharacterPicker", () => {
  it("is a radio group of From the theme and the ten characters, in the registry's order, with the heads over the columns", () => {
    render(<CharacterPicker />);
    expect(radios()).toHaveLength(11);
    const nameOf = (radio: HTMLElement) => document.getElementById(radio.getAttribute("aria-labelledby") ?? "")?.textContent;
    expect(radios().map(nameOf)).toEqual([
      "From the theme",
      ...MARKS.map((mark) => mark.name),
    ]);
    for (const head of ["Still", "Loading", "Idle"]) expect(screen.getByText(head)).toBeInTheDocument();
    expect(screen.getByText("The character in the header, on this device.")).toBeInTheDocument();
    expect(screen.getByText("The app icon, the splash and the push badge stay the Collie mark.")).toBeInTheDocument();
  });

  it("checks From the theme on a device that never chose, and names the theme's character under it", () => {
    render(<CharacterPicker />);
    expect(radios().map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", ...MARKS.map(() => "false")]);
    expect(row("From the theme")).toHaveAccessibleDescription("Collie");
  });

  it("names the worn theme's character under From the theme", () => {
    localStorage.setItem(
      LIBRARY_STORAGE_KEY,
      JSON.stringify({ version: 1, themes: [{ version: 4, id: "sunroom", name: "Sunroom", character: "pixel", light: { background: "#fdfaf3" } }] }),
    );
    __resetThemeStore();
    act(() => setActiveTheme("sunroom"));
    render(<CharacterPicker />);
    expect(row("From the theme")).toHaveAccessibleDescription("Pixel");
    expect(row("From the theme")).toHaveAttribute("aria-checked", "true");
  });

  it("draws three marks in every row, the character's own in a row and the theme's in From the theme", async () => {
    render(<CharacterPicker />);
    await loaded();
    for (const { id, name } of MARKS) {
      expect(marksOf(name).map((mark) => mark.getAttribute("data-mark"))).toEqual([id, id, id]);
      expect(marksOf(name).map((mark) => mark.getAttribute("data-state"))).toEqual(["rest", "loading", "idle"]);
    }
    expect(marksOf("From the theme").map((mark) => mark.getAttribute("data-mark"))).toEqual(["collie", "collie", "collie"]);
  });

  it("sets the device choice on a tap, moves the check, and From the theme clears it", async () => {
    render(<CharacterPicker />);
    await userEvent.click(row("Pixel"));
    expect(designPrefs().mark).toBe("pixel");
    expect(stored()).toEqual({ font: "atkinson", mark: "pixel" });
    expect(row("Pixel")).toHaveAttribute("aria-checked", "true");
    expect(row("From the theme")).toHaveAttribute("aria-checked", "false");

    await userEvent.click(row("Collie with blaze"));
    expect(designPrefs().mark).toBe("collie-blaze");
    expect(row("Pixel")).toHaveAttribute("aria-checked", "false");

    await userEvent.click(row("From the theme"));
    expect(designPrefs().mark).toBeUndefined();
    expect(stored()).toEqual({ font: "atkinson" });
    expect(row("From the theme")).toHaveAttribute("aria-checked", "true");
  });

  it("follows a choice made elsewhere", () => {
    render(<CharacterPicker />);
    act(() => setDesignMark("owl"));
    expect(row("Owl")).toHaveAttribute("aria-checked", "true");
  });

  it("walks with the arrow keys, wrapping, and chooses the row it lands on", async () => {
    render(<CharacterPicker />);
    row("From the theme").focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(row("Collie")).toHaveFocus();
    expect(row("Collie")).toHaveAttribute("aria-checked", "true");
    expect(designPrefs().mark).toBe("collie");
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(row("Owl")).toHaveFocus();
    expect(designPrefs().mark).toBe("owl");
    await userEvent.keyboard("{Home}");
    expect(row("From the theme")).toHaveFocus();
    expect(designPrefs().mark).toBeUndefined();
    await userEvent.keyboard("{End}");
    expect(row("Owl")).toHaveFocus();
  });

  it("has one tab stop, on the chosen row", () => {
    render(<CharacterPicker />);
    expect(radios().filter((radio) => radio.tabIndex === 0)).toEqual([row("From the theme")]);
    act(() => setDesignMark("sheep"));
    expect(radios().filter((radio) => radio.tabIndex === 0)).toEqual([row("Sheep")]);
  });

  it("holds every mark of every row still until the one observer says the row is on screen", async () => {
    render(<CharacterPicker />);
    await loaded();
    // ONE observer for the page, watching all eleven rows.
    expect(FakeObserver.all).toHaveLength(1);
    expect(FakeObserver.all[0]?.targets).toHaveLength(11);
    for (const radio of radios()) {
      for (const mark of Array.from(radio.querySelectorAll("svg[data-mark]"))) expect(mark.hasAttribute("data-still")).toBe(true);
    }

    act(() => FakeObserver.all[0]?.see({ pixel: true }));
    const [still, loading, idle] = marksOf("Pixel");
    // Loading turns while its row is on screen; Still stays held; Idle holds by its own state.
    expect(still?.hasAttribute("data-still")).toBe(true);
    expect(loading?.hasAttribute("data-still")).toBe(false);
    expect(idle?.hasAttribute("data-still")).toBe(true);
    // A row that was never reported stays held.
    expect(marksOf("Owl")[1]?.hasAttribute("data-still")).toBe(true);

    act(() => FakeObserver.all[0]?.see({ pixel: false }));
    expect(marksOf("Pixel")[1]?.hasAttribute("data-still")).toBe(true);
  });

  it("stops its observer when it unmounts", () => {
    const { unmount } = render(<CharacterPicker />);
    unmount();
    expect(FakeObserver.all[0]?.disconnected).toBe(true);
  });

  it("holds every mark where the page has no observer at all", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    render(<CharacterPicker />);
    await loaded();
    expect(marksOf("Pixel").every((mark) => mark.hasAttribute("data-still"))).toBe(true);
  });
});
