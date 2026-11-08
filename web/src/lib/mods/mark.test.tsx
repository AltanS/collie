import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fireEvent, render } from "@testing-library/react";
import * as lucide from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { StatusDot } from "../../components/status-badge";
import { MOD_ICON_COMPONENT, modIconOf } from "./icons";
import { ModMark } from "./mark";
import { DEFAULT_MOD_ICON, MOD_ICONS, MOD_ICON_LUCIDE, TONE_TEXT_CLASS, TONES, type Mark } from "./schema";

const LEGS: Mark = { icon: "flask", face: "23/34", tone: "working", label: "Browser leg, 23 of 34 cases green", intent: "open" };

/** The drawing of every status shape, as Collie's own status mark draws it. */
function statusDrawings(): string[] {
  return (["blocked", "working", "done", "idle", "unknown"] as const).map((status) => {
    const { container, unmount } = render(<StatusDot status={status} />);
    const svg = container.querySelector("svg")?.innerHTML ?? "";
    unmount();
    return svg;
  });
}

describe("a mod's mark", () => {
  it("never draws a status shape, in any tone or state", () => {
    const drawings = statusDrawings();
    expect(drawings.every((drawing) => drawing.length > 0)).toBe(true);
    for (const tone of TONES) {
      for (const state of [{}, { busy: true }, { unknown: true }, { stale: true }]) {
        const { container, unmount } = render(<ModMark mark={{ ...LEGS, tone }} modName="Browser leg" onTap={() => {}} {...state} />);
        // Collie's status glyph is a 12 by 12 drawing; a mod's icons are lucide's 24 by 24.
        expect(container.querySelector('svg[viewBox="0 0 12 12"]')).toBeNull();
        for (const drawing of drawings) expect(container.innerHTML).not.toContain(drawing);
        unmount();
      }
    }
  });

  it("imports nothing from the status components", () => {
    const source = readFileSync(join(__dirname, "mark.tsx"), "utf8");
    expect(source).not.toMatch(/status-badge|pane-glyph|unseen-mark/);
  });

  it("draws in its own frame: a 2px cornered outline in the border token", () => {
    const { container } = render(<ModMark mark={LEGS} modName="Browser leg" />);
    const frame = container.querySelector('[data-slot="mod-mark"]');
    expect(frame?.className).toContain("rounded-sm");
    expect(frame?.className).toContain("border-border");
    expect(frame?.className).not.toContain("rounded-full");
  });

  it("inks the icon, the face and the count through the tone map", () => {
    const { container } = render(<ModMark mark={{ ...LEGS, count: 3, tone: "error" }} modName="Browser leg" />);
    expect(container.querySelector('[data-slot="mod-mark-face"]')?.className).toContain(TONE_TEXT_CLASS.error);
    expect(container.querySelector('[data-slot="mod-mark-face"]')?.className).toContain("font-mono");
    expect(container.querySelector('[data-slot="mod-mark-count"]')?.className).toContain(TONE_TEXT_CLASS.error);
    expect(container.querySelector("svg")?.getAttribute("class")).toContain(TONE_TEXT_CLASS.error);
  });

  it("goes grey when its part is stale", () => {
    const { container } = render(<ModMark mark={{ ...LEGS, tone: "ok" }} modName="Browser leg" stale />);
    expect(container.querySelector('[data-slot="mod-mark-face"]')?.className).toContain(TONE_TEXT_CLASS.unknown);
  });

  it("is a control with a 44px reach only when it has an intent and a tap", () => {
    const onTap = vi.fn();
    const { getByRole, rerender, container } = render(<ModMark mark={LEGS} modName="Browser leg" onTap={onTap} />);
    const button = getByRole("button", { name: "Browser leg, 23 of 34 cases green" });
    // 28px drawn, 8px of reach above and below.
    expect(button.className).toContain("h-7");
    expect(button.className).toContain("before:-inset-y-2");
    fireEvent.click(button);
    expect(onTap).toHaveBeenCalledOnce();
    rerender(<ModMark mark={{ ...LEGS, intent: undefined }} modName="Browser leg" onTap={onTap} />);
    expect(container.querySelector("button")).toBeNull();
  });

  it("names itself from the mod and the face when it has no label", () => {
    const { getByRole } = render(<ModMark mark={{ face: "3 due" }} modName="Tracker" />);
    expect(getByRole("img", { name: "Tracker: 3 due" })).toBeInTheDocument();
  });

  it("swaps its icon for the spinner while busy, and for a question mark after an unknown outcome", () => {
    const busy = render(<ModMark mark={LEGS} modName="Browser leg" onTap={() => {}} busy />);
    expect(busy.container.querySelector('[data-slot="mod-mark-busy"]')).not.toBeNull();
    expect(busy.getByRole("button")).toBeDisabled();
    busy.unmount();
    const unknown = render(<ModMark mark={LEGS} modName="Browser leg" onTap={() => {}} unknown />);
    expect(unknown.container.querySelector('[data-slot="mod-mark-unknown"]')).not.toBeNull();
    expect(unknown.getByRole("button").getAttribute("aria-label")).toBe("Browser leg, 23 of 34 cases green, unknown");
  });

  it("keeps its slot when the mod drops its mark, so the belt does not move", () => {
    const { container, rerender } = render(<ModMark mark={LEGS} modName="Browser leg" onTap={() => {}} />);
    rerender(<ModMark mark={undefined} modName="Browser leg" onTap={() => {}} />);
    const slot = container.querySelector<HTMLElement>('[data-slot="mod-mark"]');
    expect(slot?.dataset.empty).toBe("");
    expect(slot?.className).toContain("invisible");
    expect(slot?.getAttribute("aria-hidden")).toBe("true");
    expect(slot?.textContent).toBe("23/34");
  });

  it("takes no room when it never had a mark", () => {
    const { container } = render(<ModMark mark={undefined} modName="Browser leg" />);
    expect(container.innerHTML).toBe("");
  });
});

describe("the icon set", () => {
  it("draws every word with the lucide export the schema names", () => {
    const exports = new Map(Object.entries(lucide));
    for (const word of MOD_ICONS) {
      expect(MOD_ICON_COMPONENT[word], word).toBe(exports.get(MOD_ICON_LUCIDE[word]));
    }
  });

  it("draws the default icon for a word this Collie does not know", () => {
    expect(modIconOf("hologram")).toBe(MOD_ICON_COMPONENT[DEFAULT_MOD_ICON]);
    expect(modIconOf(undefined)).toBe(MOD_ICON_COMPONENT[DEFAULT_MOD_ICON]);
  });
});
