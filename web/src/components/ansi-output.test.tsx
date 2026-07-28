import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { AnsiOutput } from "./ansi-output";

const ESC = "\x1b";

// The mirror renders in DARK space under every theme, and the light theme inverts it wholesale
// (.adr/0002). These guard the two ways that arrangement silently breaks.
describe("terminal mirror colour space", () => {
  function mirror(text: string) {
    const { container } = render(<AnsiOutput text={text} />);
    return container.querySelector("pre")!;
  }

  it("inverts in light and leaves dark alone", () => {
    const pre = mirror("hello");
    expect(pre.className).toContain("[filter:invert(1)_hue-rotate(180deg)]");
    // Without the dark: reset the filter would apply in BOTH themes and dark would render inverted.
    expect(pre.className).toContain("dark:[filter:none]");
  });

  // The bug this exists to prevent: `bg-background` looks like the tidy, idiomatic choice, but an
  // inherited light-dark() token resolves against the ROOT's colour-scheme, not this element's — so
  // on a light page it yields white, which the filter then inverts to black. A black mirror on a
  // white app, and every test that only checks computed styles still passes.
  it("uses literal dark-space colours, never theme tokens", () => {
    const pre = mirror("hello");
    expect(pre.className).toContain("bg-[#0a0a0a]");
    expect(pre.className).toContain("text-[#fafafa]");
    expect(pre.className).not.toMatch(/\bbg-background\b/);
    expect(pre.className).not.toMatch(/\btext-foreground\b/);
  });

  it("keeps muted rule glyphs on a literal dark-space grey", () => {
    const pre = mirror("├────────────┤\n");
    const span = [...pre.querySelectorAll("span")].find((s) => s.textContent?.includes("─"));
    expect(span).toBeDefined();
    expect(span!.style.color).toBe("rgb(161, 161, 161)"); // #a1a1a1, --muted-foreground's dark half
  });

  it("emits palette variables for indexed colour so the 16 slots stay themeable", () => {
    const pre = mirror(`${ESC}[31mred${ESC}[0m`);
    const span = [...pre.querySelectorAll("span")].find((s) => s.textContent === "red");
    expect(span!.style.color).toBe("var(--ansi-1)");
  });
});
