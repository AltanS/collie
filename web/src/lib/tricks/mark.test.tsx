import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fireEvent, render } from "@testing-library/react";
import * as lucide from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { StatusDot } from "../../components/status-badge";
import { TRICK_ICON_COMPONENT, trickIconOf } from "./icons";
import { TrickMark } from "./mark";
import { DEFAULT_TRICK_ICON, TRICK_ICONS, TRICK_ICON_LUCIDE, TONE_TEXT_CLASS, TONES, type Mark } from "./schema";

const LEGS: Mark = { icon: "flask", label: "23/34", tone: "accent", intent: "open" };

/** The drawing of every status shape, as Collie's own status mark draws it. */
function statusDrawings(): string[] {
  return (["blocked", "working", "done", "idle", "unknown"] as const).map((status) => {
    const { container, unmount } = render(<StatusDot status={status} />);
    const svg = container.querySelector("svg")?.innerHTML ?? "";
    unmount();
    return svg;
  });
}

describe("a trick's mark", () => {
  it("never draws a status shape, in any tone or state", () => {
    const drawings = statusDrawings();
    expect(drawings.every((drawing) => drawing.length > 0)).toBe(true);
    for (const tone of TONES) {
      for (const state of [{}, { busy: true }, { unknown: true }, { stale: true }]) {
        const { container, unmount } = render(<TrickMark mark={{ ...LEGS, tone }} trickName="Browser leg" onTap={() => {}} {...state} />);
        // Collie's status glyph is a 12 by 12 drawing; a trick's icons are lucide's 24 by 24.
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
    const { container } = render(<TrickMark mark={LEGS} trickName="Browser leg" />);
    const frame = container.querySelector('[data-slot="trick-mark"]');
    expect(frame?.className).toContain("rounded-sm");
    expect(frame?.className).toContain("border-border");
    expect(frame?.className).not.toContain("rounded-full");
  });

  it("inks the icon, the face and the count through the tone map", () => {
    const { container } = render(<TrickMark mark={{ ...LEGS, badge: "3", tone: "danger" }} trickName="Browser leg" />);
    expect(container.querySelector('[data-slot="trick-mark-face"]')?.className).toContain(TONE_TEXT_CLASS.danger);
    expect(container.querySelector('[data-slot="trick-mark-face"]')?.className).toContain("font-mono");
    expect(container.querySelector('[data-slot="trick-mark-count"]')?.className).toContain(TONE_TEXT_CLASS.danger);
    expect(container.querySelector("svg")?.getAttribute("class")).toContain(TONE_TEXT_CLASS.danger);
  });

  it("goes grey when its part is stale", () => {
    const { container } = render(<TrickMark mark={{ ...LEGS, tone: "ok" }} trickName="Browser leg" stale />);
    expect(container.querySelector('[data-slot="trick-mark-face"]')?.className).toContain(TONE_TEXT_CLASS.unknown);
  });

  it("is a control with a 44px reach only when it has an intent and a tap", () => {
    const onTap = vi.fn();
    const { getByRole, rerender, container } = render(<TrickMark mark={LEGS} trickName="Browser leg" onTap={onTap} />);
    const button = getByRole("button", { name: "Browser leg: 23/34" });
    // 28px drawn, 8px of reach above and below.
    expect(button.className).toContain("h-7");
    expect(button.className).toContain("before:-inset-y-2");
    fireEvent.click(button);
    expect(onTap).toHaveBeenCalledOnce();
    rerender(<TrickMark mark={{ ...LEGS, intent: undefined }} trickName="Browser leg" onTap={onTap} />);
    expect(container.querySelector("button")).toBeNull();
  });

  it("names itself from the trick and its label, the face word", () => {
    const { getByRole } = render(<TrickMark mark={{ label: "3 due" }} trickName="Tracker" />);
    expect(getByRole("img", { name: "Tracker: 3 due" })).toBeInTheDocument();
  });

  it("swaps its icon for the spinner while busy, and for a question mark after an unknown outcome", () => {
    const busy = render(<TrickMark mark={LEGS} trickName="Browser leg" onTap={() => {}} busy />);
    expect(busy.container.querySelector('[data-slot="trick-mark-busy"]')).not.toBeNull();
    expect(busy.getByRole("button")).toBeDisabled();
    busy.unmount();
    const unknown = render(<TrickMark mark={LEGS} trickName="Browser leg" onTap={() => {}} unknown />);
    expect(unknown.container.querySelector('[data-slot="trick-mark-unknown"]')).not.toBeNull();
    expect(unknown.getByRole("button").getAttribute("aria-label")).toBe("Browser leg: 23/34, unknown");
  });

  it("keeps its slot when the trick drops its mark, so the belt does not move", () => {
    const { container, rerender } = render(<TrickMark mark={LEGS} trickName="Browser leg" onTap={() => {}} />);
    rerender(<TrickMark mark={undefined} trickName="Browser leg" onTap={() => {}} />);
    const slot = container.querySelector<HTMLElement>('[data-slot="trick-mark"]');
    expect(slot?.dataset.empty).toBe("");
    expect(slot?.className).toContain("invisible");
    expect(slot?.getAttribute("aria-hidden")).toBe("true");
    expect(slot?.textContent).toBe("23/34");
  });

  it("takes no room when it never had a mark", () => {
    const { container } = render(<TrickMark mark={undefined} trickName="Browser leg" />);
    expect(container.innerHTML).toBe("");
  });
});

describe("the icon set", () => {
  it("draws every word with the lucide export the schema names", () => {
    const exports = new Map(Object.entries(lucide));
    for (const word of TRICK_ICONS) {
      expect(TRICK_ICON_COMPONENT[word], word).toBe(exports.get(TRICK_ICON_LUCIDE[word]));
    }
  });

  it("draws the default icon for a word this Collie does not know", () => {
    expect(trickIconOf("hologram")).toBe(TRICK_ICON_COMPONENT[DEFAULT_TRICK_ICON]);
    expect(trickIconOf(undefined)).toBe(TRICK_ICON_COMPONENT[DEFAULT_TRICK_ICON]);
  });
});
