import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { en } from "@/lib/i18n/messages/en";
import type { Theme } from "@/lib/theme/schema";

// Keep this look? (theme-confirm-ribbon.tsx): it shows only while the question is open, counts down,
// Keep ends it, Back and the countdown put the old theme back, and a trial's Keep asks it.

function sample(id = "night", name = "Night"): Theme {
  return { version: 1, id, name, light: { background: "#fdfaf3" }, dark: { background: "#123456" } };
}

async function mount() {
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.className = "";
  vi.resetModules();
  const store = await import("@/lib/theme/store");
  const confirm = await import("@/lib/theme/confirm");
  const trial = await import("@/lib/theme/trial");
  const { ThemeConfirmRibbon } = await import("./theme-confirm-ribbon");
  const { ThemeTrialRibbon } = await import("./theme-trial-ribbon");
  render(
    <>
      <ThemeTrialRibbon />
      <ThemeConfirmRibbon />
    </>,
  );
  return { store, confirm, trial };
}

const ribbon = () => screen.queryByRole("region", { name: en["theme.confirm.region"] });

/** Install `night` as Apply does, and open the question. */
function apply(page: Awaited<ReturnType<typeof mount>>) {
  act(() => {
    const before = page.confirm.lookBefore();
    page.store.installTheme(sample());
    page.confirm.confirmLook(before);
  });
}

describe("ThemeConfirmRibbon", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("draws nothing while no question is open", async () => {
    await mount();
    expect(ribbon()).toBeNull();
    expect(document.documentElement.classList.contains("collie-confirm")).toBe(false);
  });

  it("asks Keep this look? with the seconds left, Keep and Back, and marks the root", async () => {
    const page = await mount();
    apply(page);
    const bar = ribbon();
    if (bar === null) throw new Error("no ribbon");
    expect(within(bar).getByRole("status")).toHaveTextContent(en["theme.confirm.question"]);
    expect(within(bar).getByRole("status")).toHaveTextContent("15 seconds");
    expect(bar).toHaveTextContent("15");
    expect(within(bar).getByRole("button", { name: en["theme.trial.keep"] })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: en["theme.trial.back"] })).toBeInTheDocument();
    expect(document.documentElement.classList.contains("collie-confirm")).toBe(true);
  });

  it("Keep ends the question and keeps the theme on", async () => {
    const page = await mount();
    apply(page);
    await userEvent.click(within(ribbon()!).getByRole("button", { name: en["theme.trial.keep"] }));
    expect(ribbon()).toBeNull();
    expect(page.store.activeThemeId()).toBe("night");
    expect(document.documentElement.classList.contains("collie-confirm")).toBe(false);
  });

  it("Back puts the old theme back at once", async () => {
    const page = await mount();
    apply(page);
    await userEvent.click(within(ribbon()!).getByRole("button", { name: en["theme.trial.back"] }));
    expect(ribbon()).toBeNull();
    expect(page.store.activeThemeId()).toBe("collie");
  });

  it("counts down and goes back by itself when nobody taps", async () => {
    vi.useFakeTimers();
    const page = await mount();
    apply(page);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(ribbon()).toHaveTextContent("10");
    expect(page.store.activeThemeId()).toBe("night");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_250);
    });
    expect(ribbon()).toBeNull();
    expect(page.store.activeThemeId()).toBe("collie");
  });

  it("asks after a trial's Keep, and Back returns to the theme worn before the trial", async () => {
    const page = await mount();
    act(() => page.store.setActiveTheme("harbour"));
    act(() => void page.trial.startTrial(sample()));
    await userEvent.click(screen.getByRole("button", { name: en["theme.trial.keep"] }));
    expect(page.store.activeThemeId()).toBe("night");
    await userEvent.click(within(ribbon()!).getByRole("button", { name: en["theme.trial.back"] }));
    expect(page.store.activeThemeId()).toBe("harbour");
  });
});

describe("the ribbon's own stylesheet for the question", () => {
  const css = readFileSync(resolve(import.meta.dirname, "theme-trial-ribbon.css"), "utf8");

  it("shortens the app for the question as for a trial", () => {
    expect(css).toContain(":root.collie-confirm");
  });

  it("draws no drain bar under reduced motion, and moves it by transform, never by a CSS animation", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.collie-confirm-ribbon__drain\s*\{\s*display:\s*none;/);
    expect(css).not.toMatch(/animation/);
  });
});
