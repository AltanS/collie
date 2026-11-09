import { Profiler } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDesignFont } from "@/lib/design";
import { DEFAULT_THEME_ID } from "@/lib/theme/schema";
import type { Theme } from "@/lib/theme/schema";
import { addImported, installTheme, removeImported, setActiveTheme, __resetThemeStore } from "@/lib/theme/store";
import { endTrial, startTrial, __resetTrial } from "@/lib/theme/trial";

import { __resetGlyphSets, preloadGlyphSet } from "./glyphs";
import { Icon } from "./icon";

// AN ICON RE-RENDERS FOR ITS OWN REASONS ONLY. Every icon in the app subscribes to the worn theme, a
// trial and the glyph set chunks, so a store change that does not move the resolved set must cost
// the page no icon renders at all. React's Profiler counts commits that touched the tree under it, so
// a count that holds still is a tree that did not render.

function theme(id: string, glyphs?: string): Theme {
  const base: Theme = { version: 4, id, name: id, light: { background: "#ffffff" } };
  return glyphs === undefined ? base : { ...base, glyphs };
}

/** Mounts one icon and returns the commits it has been through since it settled. */
interface MountedIcon {
  commits: () => number;
  glyph: () => string | null;
}

function mountIcon(): MountedIcon {
  let count = 0;
  const { container } = render(
    <Profiler id="icon" onRender={() => (count += 1)}>
      <Icon name="close" />
    </Profiler>,
  );
  count = 0;
  return { commits: () => count, glyph: () => container.querySelector("svg")?.getAttribute("data-glyphs") ?? null };
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  __resetThemeStore();
  setActiveTheme(DEFAULT_THEME_ID);
  // Both sets are in before the icon mounts, so the arrival of a chunk is not counted as a render.
  await preloadGlyphSet("iconoir");
  await preloadGlyphSet("phosphor-fill");
});

afterEach(() => {
  endTrial();
  __resetTrial();
  setActiveTheme(DEFAULT_THEME_ID);
  localStorage.clear();
  __resetThemeStore();
  __resetGlyphSets();
});

describe("an icon's renders", () => {
  it("does not re-render when an unrelated theme is added to the library", () => {
    expect(installTheme(theme("worn", "iconoir")).ok).toBe(true);
    const icon = mountIcon();
    expect(icon.glyph()).toBe("iconoir");
    act(() => {
      expect(addImported(theme("bystander", "phosphor-fill")).ok).toBe(true);
    });
    expect(icon.commits()).toBe(0);
    act(() => removeImported("bystander"));
    expect(icon.commits()).toBe(0);
  });

  it("does not re-render when an unrelated design preference changes", () => {
    expect(installTheme(theme("worn", "iconoir")).ok).toBe(true);
    const icon = mountIcon();
    act(() => setDesignFont("space-grotesk"));
    act(() => setDesignFont("aldrich"));
    expect(icon.commits()).toBe(0);
    expect(icon.glyph()).toBe("iconoir");
  });

  it("does not re-render when the worn theme changes to another one in the same set", () => {
    expect(installTheme(theme("worn", "iconoir")).ok).toBe(true);
    const icon = mountIcon();
    act(() => {
      expect(installTheme(theme("sibling", "iconoir")).ok).toBe(true);
    });
    expect(icon.commits()).toBe(0);
  });

  it("re-renders once when the worn theme's glyph set changes", () => {
    expect(installTheme(theme("worn", "iconoir")).ok).toBe(true);
    const icon = mountIcon();
    act(() => {
      expect(installTheme(theme("other", "phosphor-fill")).ok).toBe(true);
    });
    expect(icon.commits()).toBe(1);
    expect(icon.glyph()).toBe("phosphor-fill");
  });

  it("re-renders once when a trial wears another set, and once when it ends", () => {
    expect(installTheme(theme("worn", "iconoir")).ok).toBe(true);
    const icon = mountIcon();
    act(() => {
      startTrial(theme("tried", "phosphor-fill"));
    });
    expect(icon.commits()).toBe(1);
    expect(icon.glyph()).toBe("phosphor-fill");
    act(() => endTrial());
    expect(icon.commits()).toBe(2);
    expect(icon.glyph()).toBe("iconoir");
  });
});
