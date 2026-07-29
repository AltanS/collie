import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// use-theme holds module-scope state, so each case re-imports both the hook and this component to
// get a clean slate (see use-theme.test.ts for why the state lives there).

const STORAGE_KEY = "collie:theme:v1";

async function load(stored: string | null) {
  localStorage.clear();
  if (stored !== null) localStorage.setItem(STORAGE_KEY, stored);
  document.documentElement.className = "";
  vi.resetModules();
  return import("./theme-control");
}

describe("ThemeControl", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
  });

  it("renders three options with the stored one selected", async () => {
    const { ThemeControl } = await load("dark");
    render(<ThemeControl />);

    const group = screen.getByRole("radiogroup", { name: "Appearance" });
    const options = within(group).getAllByRole("radio");
    expect(options.map((o) => o.textContent)).toEqual(["System", "Light", "Dark"]);
    expect(options.map((o) => o.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
  });

  it("defaults to System when nothing is stored", async () => {
    const { ThemeControl } = await load(null);
    render(<ThemeControl />);
    expect(screen.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");
  });

  it("pins a theme on selection, stamping the class and persisting it", async () => {
    const { ThemeControl } = await load(null);
    render(<ThemeControl />);

    await userEvent.click(screen.getByRole("radio", { name: "Light" }));

    expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
    expect([...document.documentElement.classList]).toEqual(["light"]);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("light");
  });

  it("un-pins back to System, clearing both the class and the key", async () => {
    const { ThemeControl } = await load("dark");
    render(<ThemeControl />);

    await userEvent.click(screen.getByRole("radio", { name: "System" }));

    expect([...document.documentElement.classList]).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
