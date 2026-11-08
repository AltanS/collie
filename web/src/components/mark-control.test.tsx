import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MarkControl } from "@/components/mark-control";
import { __resetDesign, designPrefs, setDesignMark } from "@/lib/design";
import { t } from "@/lib/i18n";
import { MARKS } from "@/lib/mark-ids";
import { collieMark } from "@/test/collie-mark";
import { LIBRARY_STORAGE_KEY, __resetThemeStore, setActiveTheme } from "@/lib/theme/store";

// The Mark card: From the theme (the default, stored as no field), then Collie, Kawaii, Kawaii Tilt, Pixel, each
// with its mark drawn small beside the words.

// The chunked marks are replaced by a marker each, so a row can be asked which mark it draws.
vi.mock("@/components/kawaii-mark", () => ({ KawaiiMark: () => <span data-mock="kawaii" /> }));
vi.mock("@/components/kawaii-tilt-mark", () => ({ KawaiiTiltMark: () => <span data-mock="kawaii-tilt" /> }));
vi.mock("@/components/pixel-mark", () => ({ PixelMark: () => <span data-mock="pixel" /> }));
vi.mock("@/components/glass-mark", () => ({ GlassMark: () => <span data-mock="glass" /> }));
vi.mock("@/components/glass-front-mark", () => ({ GlassFrontMark: () => <span data-mock="glass-front" /> }));
vi.mock("@/components/sheep-mark", () => ({ SheepMark: () => <span data-mock="sheep" /> }));
vi.mock("@/components/owl-mark", () => ({ OwlMark: () => <span data-mock="owl" /> }));

/** The mark a row draws, once its chunk has arrived: "collie" for the eager one, else the chunk's marker. */
async function drawn(name: string): Promise<string> {
  const row = screen.getByRole("radio", { name });
  await waitFor(() => expect(row.querySelector('[data-slot="brand-mark-pending"]')).toBeNull());
  const marker = row.querySelector("[data-mock]");
  if (marker !== null) return marker.getAttribute("data-mock") ?? "none";
  return collieMark(row) === null ? "none" : "collie";
}

const group = () => screen.getByRole("radiogroup", { name: t("settings.mark.title") });
const radios = () => within(group()).getAllByRole("radio");
const stored = () => JSON.parse(localStorage.getItem("collie:design:v1") ?? "null");

beforeEach(() => {
  localStorage.clear();
  __resetDesign();
  __resetThemeStore();
});

describe("MarkControl", () => {
  it("offers From the theme and then every character in the registry's order, with From the theme on by default", () => {
    render(<MarkControl />);
    const names = ["From the theme", "Collie", "Kawaii", "Kawaii Tilt", "Pixel", "Glass", "Glass Front", "Sheep", "Owl"];
    expect(radios()).toEqual(names.map((name) => screen.getByRole("radio", { name })));
    expect(radios().map((r) => r.getAttribute("aria-checked"))).toEqual(names.map((_, i) => String(i === 0)));
  });

  it("draws each character's own mark beside its name, and Collie's beside From the theme", async () => {
    render(<MarkControl />);
    for (const { id, name } of MARKS) expect(await drawn(name)).toBe(id);
    expect(await drawn("From the theme")).toBe("collie");
  });

  it("writes the choice to the design store, and From the theme removes the field", async () => {
    render(<MarkControl />);
    await userEvent.click(screen.getByRole("radio", { name: "Pixel" }));
    expect(designPrefs().mark).toBe("pixel");
    expect(stored()).toEqual({ font: "atkinson", mark: "pixel" });
    expect(screen.getByRole("radio", { name: "Pixel" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "From the theme" })).toHaveAttribute("aria-checked", "false");

    await userEvent.click(screen.getByRole("radio", { name: "Collie" }));
    expect(stored()).toEqual({ font: "atkinson", mark: "collie" });

    await userEvent.click(screen.getByRole("radio", { name: "From the theme" }));
    expect(designPrefs().mark).toBeUndefined();
    expect(stored()).toEqual({ font: "atkinson" });
  });

  it("follows a choice made elsewhere", () => {
    render(<MarkControl />);
    act(() => setDesignMark("kawaii-tilt"));
    expect(screen.getByRole("radio", { name: "Kawaii Tilt" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Kawaii" })).toHaveAttribute("aria-checked", "false");
  });

  it("carries one line of help, its description, and no second note", () => {
    // One help line per card (the lead, 2026-11-08): that the icon and the splash stay Collie is in
    // the docs, not on the card.
    render(<MarkControl />);
    expect(screen.queryByText(/The app icon and the splash stay the Collie mark/)).not.toBeInTheDocument();
  });

  it("draws the worn theme's mark on the From the theme row", async () => {
    localStorage.setItem(
      LIBRARY_STORAGE_KEY,
      JSON.stringify({ version: 1, themes: [{ version: 4, id: "sunroom", name: "Sunroom", character: "pixel", light: { background: "#fdfaf3" } }] }),
    );
    __resetThemeStore();
    act(() => setActiveTheme("sunroom"));
    render(<MarkControl />);
    // The row stays From the theme; only the drawing beside it is the theme's.
    expect(screen.getByRole("radio", { name: "From the theme" })).toHaveAttribute("aria-checked", "true");
    expect(await drawn("From the theme")).toBe("pixel");
  });
});
