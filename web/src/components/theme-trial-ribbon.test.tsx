import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { en } from "@/lib/i18n/messages/en";
import type { Theme } from "@/lib/theme/schema";

// The trial ribbon (M59 spec 08): it shows only while a trial runs, says what is being tried, Keep
// installs through the import's own path, Back ends the trial, and its stylesheet reads no theme.

const LIBRARY_KEY = "collie:themes:v1";

function sample(id = "sunroom", name = "Sunroom"): Theme {
  return { version: 1, id, name, author: "Kim", light: { background: "#fdfaf3" }, dark: { background: "#123456" } };
}

async function mount() {
  document.documentElement.removeAttribute("style");
  document.documentElement.className = "";
  vi.resetModules();
  const store = await import("@/lib/theme/store");
  const trial = await import("@/lib/theme/trial");
  const { ThemeTrialRibbon } = await import("./theme-trial-ribbon");
  render(<ThemeTrialRibbon />);
  return { store, trial };
}

const ribbon = () => screen.queryByRole("region", { name: en["theme.trial.region"] });

describe("ThemeTrialRibbon", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("draws nothing while no trial runs", async () => {
    await mount();
    expect(ribbon()).toBeNull();
    expect(document.documentElement.classList.contains("collie-trial")).toBe(false);
  });

  it("names the theme being tried, marks the root, and offers Keep and Back", async () => {
    const { trial } = await mount();
    act(() => void trial.startTrial(sample()));
    const bar = ribbon();
    expect(bar).not.toBeNull();
    expect(within(bar!).getByRole("status")).toHaveTextContent("Trying Sunroom");
    expect(within(bar!).getByRole("button", { name: en["theme.trial.keep"] })).toBeInTheDocument();
    expect(within(bar!).getByRole("button", { name: en["theme.trial.back"] })).toBeInTheDocument();
    expect(document.documentElement.classList.contains("collie-trial")).toBe(true);
  });

  it("draws a name that holds markup as text", async () => {
    const { trial } = await mount();
    act(() => void trial.startTrial(sample("odd", "<b>bold</b>")));
    expect(within(ribbon()!).getByRole("status")).toHaveTextContent("Trying <b>bold</b>");
    expect(ribbon()!.querySelector("b")).toBeNull();
  });

  it("Back ends the trial, takes the ribbon away and unmarks the root", async () => {
    const { trial } = await mount();
    act(() => void trial.startTrial(sample()));
    await userEvent.click(screen.getByRole("button", { name: en["theme.trial.back"] }));
    expect(ribbon()).toBeNull();
    expect(trial.currentTrial()).toBeNull();
    expect(document.documentElement.classList.contains("collie-trial")).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
  });

  it("Keep installs the theme and switches to it", async () => {
    const { store, trial } = await mount();
    act(() => void trial.startTrial(sample()));
    await userEvent.click(screen.getByRole("button", { name: en["theme.trial.keep"] }));
    expect(ribbon()).toBeNull();
    expect(store.activeThemeId()).toBe("sunroom");
    expect(store.library().map((theme) => theme.id)).toEqual(["sunroom"]);
  });

  it("a refused Keep shows the library's sentence in the ribbon, and the trial goes on", async () => {
    const full = Array.from({ length: 8 }, (_, i) => sample(`t${i}`, `Theme ${i}`));
    localStorage.setItem(LIBRARY_KEY, JSON.stringify({ version: 1, themes: full }));
    const { trial } = await mount();
    act(() => void trial.startTrial(sample()));
    await userEvent.click(screen.getByRole("button", { name: en["theme.trial.keep"] }));
    expect(within(ribbon()!).getByRole("status")).toHaveTextContent("You already hold 8 imported themes.");
    expect(trial.currentTrial()?.theme.id).toBe("sunroom");
  });
});

describe("the ribbon's stylesheet", () => {
  const css = readFileSync(resolve(import.meta.dirname, "theme-trial-ribbon.css"), "utf8");

  it("reads no custom property except the app's own height token", () => {
    const read = [...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]);
    expect(read).toEqual(["--app-h-ios-standalone"]);
  });

  it("is fixed at the bottom, at the highest z-index, with pointer events on", () => {
    const rule = css.slice(css.indexOf(".collie-trial-ribbon {"), css.indexOf("}", css.indexOf(".collie-trial-ribbon {")));
    expect(rule).toContain("position: fixed;");
    expect(rule).toContain("bottom: 0;");
    expect(rule).toContain("z-index: 2147483647;");
    expect(rule).toContain("pointer-events: auto;");
    expect(rule).toContain("all: initial;");
  });

  it("names every colour as a literal", () => {
    for (const match of css.matchAll(/(?:^|[\s{;])(?:color|background|border-top):\s*([^;]+);/g)) {
      expect(match[1]).toMatch(/#[0-9a-f]{6}/);
    }
  });
});
