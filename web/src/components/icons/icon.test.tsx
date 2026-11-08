import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { GLYPH_SET_IDS } from "@/lib/glyph-sets";
import { installTheme, __resetThemeStore } from "@/lib/theme/store";
import { endTrial, startTrial, __resetTrial } from "@/lib/theme/trial";
import type { Theme } from "@/lib/theme/schema";

import { __resetGlyphSets, preloadGlyphSet, glyphSetData } from "./glyphs";
import { Icon } from "./icon";
import { ICON_KEY_LIST } from "./keys";

function svg(container: HTMLElement): SVGSVGElement {
  const found = container.querySelector("svg");
  if (found === null) throw new Error("no svg");
  return found;
}

afterEach(() => {
  endTrial();
  __resetTrial();
  __resetThemeStore();
  __resetGlyphSets();
});

describe("the Icon contract", () => {
  it("draws one direct svg with the class `icon` and the key in `data-icon`", () => {
    const { container } = render(
      <span>
        <Icon name="close" className="size-4 text-primary" />
      </span>,
    );
    const glyph = svg(container);
    expect(glyph.parentElement?.tagName).toBe("SPAN");
    expect(glyph.getAttribute("data-icon")).toBe("close");
    expect(glyph.classList.contains("icon")).toBe(true);
    expect(glyph.classList.contains("size-4")).toBe(true);
    expect(glyph.getAttribute("aria-hidden")).toBe("true");
  });

  it("passes a label through and then is not hidden", () => {
    const { container } = render(<Icon name="busy" role="img" aria-label="Sending" className="animate-spin" />);
    const glyph = svg(container);
    expect(glyph.getAttribute("aria-label")).toBe("Sending");
    expect(glyph.getAttribute("aria-hidden")).toBeNull();
    expect(glyph.classList.contains("animate-spin")).toBe(true);
  });

  it("draws every key in every set without throwing", () => {
    for (const set of GLYPH_SET_IDS) {
      for (const name of ICON_KEY_LIST) {
        const { container, unmount } = render(<Icon name={name} set={set} />);
        expect(svg(container).getAttribute("data-icon")).toBe(name);
        unmount();
      }
    }
  });
});

describe("a glyph set", () => {
  it("draws lucide until the set arrives, then the set, in the same box", async () => {
    const { container } = render(<Icon name="close" set="phosphor" className="size-5" />);
    expect(svg(container).getAttribute("viewBox")).toBe("0 0 24 24");
    await waitFor(() => expect(svg(container).getAttribute("viewBox")).toBe("0 0 256 256"));
    const glyph = svg(container);
    expect(glyph.getAttribute("data-glyphs")).toBe("phosphor");
    expect(glyph.getAttribute("data-icon")).toBe("close");
    expect(glyph.classList.contains("size-5")).toBe(true);
    expect(glyph.getAttribute("fill")).toBe("currentColor");
  });

  it("draws a key the family lacks in lucide", async () => {
    await preloadGlyphSet("iconoir");
    expect(glyphSetData("iconoir")?.glyphs.busy).toBeUndefined();
    const { container } = render(<Icon name="busy" set="iconoir" />);
    expect(svg(container).getAttribute("data-glyphs")).toBeNull();
    expect(svg(container).classList.contains("lucide-loader-circle")).toBe(true);
  });

  it("Phosphor Fill keeps the outline of a cross, a tick and an empty ring", async () => {
    await Promise.all([preloadGlyphSet("phosphor"), preloadGlyphSet("phosphor-fill")]);
    const regular = glyphSetData("phosphor")?.glyphs;
    const fill = glyphSetData("phosphor-fill")?.glyphs;
    for (const key of ["close", "selected", "plan-pending", "voice-setup", "update-step-skipped"] as const) {
      expect(fill?.[key], key).toEqual(regular?.[key]);
    }
    expect(fill?.send).not.toEqual(regular?.send);
  });

  it("holds only the mapped glyphs, as flat shapes", async () => {
    await preloadGlyphSet("phosphor-duotone");
    const data = glyphSetData("phosphor-duotone");
    expect(data).not.toBeNull();
    for (const node of Object.values(data?.glyphs ?? {})) {
      for (const [tag] of node) expect(["path", "circle", "rect", "line", "polyline", "polygon", "ellipse"]).toContain(tag);
    }
  });

  it("follows the worn theme, and a tried theme first", async () => {
    const worn: Theme = { version: 4, id: "worn", name: "Worn", light: { background: "#ffffff" }, glyphs: "iconoir" };
    expect(installTheme(worn).ok).toBe(true);
    const { container } = render(<Icon name="send" />);
    await waitFor(() => expect(svg(container).getAttribute("data-glyphs")).toBe("iconoir"));
    const tried: Theme = { version: 4, id: "tried", name: "Tried", light: { background: "#ffffff" }, glyphs: "phosphor-fill" };
    startTrial(tried);
    await waitFor(() => expect(svg(container).getAttribute("data-glyphs")).toBe("phosphor-fill"));
    endTrial();
    await waitFor(() => expect(svg(container).getAttribute("data-glyphs")).toBe("iconoir"));
  });

  it("draws lucide for a tried or worn theme whose set this Collie does not have", async () => {
    const worn: Theme = { version: 4, id: "worn-three", name: "Worn three", light: { background: "#ffffff" }, glyphs: "iconoir" };
    expect(installTheme(worn).ok).toBe(true);
    const { container } = render(<Icon name="send" />);
    await waitFor(() => expect(svg(container).getAttribute("data-glyphs")).toBe("iconoir"));
    startTrial({ ...worn, id: "future", name: "Future", glyphs: "tabler" });
    await waitFor(() => expect(svg(container).getAttribute("data-glyphs")).toBeNull());
    expect(svg(container).getAttribute("data-icon")).toBe("send");
  });

  it("a `set` prop wins over the worn theme", async () => {
    const worn: Theme = { version: 4, id: "worn-two", name: "Worn two", light: { background: "#ffffff" }, glyphs: "iconoir" };
    expect(installTheme(worn).ok).toBe(true);
    const { container } = render(<Icon name="send" set="lucide" />);
    await preloadGlyphSet("iconoir");
    expect(svg(container).getAttribute("data-glyphs")).toBeNull();
  });
});
