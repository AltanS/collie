import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { ComponentProps } from "react";

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

  // Guards the ONE-SPELLING half of ADR 0002 rule 2. `bg-background` would in fact work here — an
  // inherited light-dark() token resolves against THIS element's colour-scheme (dark), not the
  // root's — but the mirror deliberately keeps a single spelling so nobody has to know that to read
  // it. Mixing the two is the regression this catches; a computed-style test would not.
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

// URLs printed by an agent are plain characters — the mirror finds them and wraps those ranges in
// anchors. The invariants worth guarding are the ones a refactor would silently break: the text is
// still exactly what the terminal printed, and nothing but http(s) ever becomes an href.
describe("clickable links in the mirror", () => {
  function mirror(props: Partial<ComponentProps<typeof AnsiOutput>> & { text: string }) {
    const { container } = render(<AnsiOutput {...props} />);
    return container.querySelector("pre")!;
  }

  it("links a bare URL without changing the rendered text", () => {
    const pre = mirror({ text: "opened https://herdr.dev/docs ok\n" });
    const a = pre.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://herdr.dev/docs");
    expect(a.textContent).toBe("https://herdr.dev/docs");
    // The mirror must stay a faithful copy — the anchor adds structure, never characters.
    expect(pre.textContent).toBe("opened https://herdr.dev/docs ok\n");
  });

  it("opens in a new tab and severs the opener — these hrefs come from agent output", () => {
    const a = mirror({ text: "https://herdr.dev\n" }).querySelector("a")!;
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("never links a dangerous scheme", () => {
    const pre = mirror({ text: "javascript:alert(1) data:text/html,<script>x</script>\n" });
    expect(pre.querySelector("a")).toBeNull();
    expect(pre.querySelector("script")).toBeNull(); // text nodes only — the XSS boundary holds
  });

  // A URL that changes colour mid-way (an agent underlining just the path, say) is split across
  // segments. Each slice gets its own anchor, so the whole run is tappable and carries one href.
  it("links a URL that straddles an SGR change", () => {
    const pre = mirror({ text: `${ESC}[34mhttps://herdr.dev${ESC}[32m/docs${ESC}[0m\n` });
    const anchors = [...pre.querySelectorAll("a")];
    expect(anchors.length).toBeGreaterThan(1);
    expect(anchors.every((a) => a.getAttribute("href") === "https://herdr.dev/docs")).toBe(true);
    expect(anchors.map((a) => a.textContent).join("")).toBe("https://herdr.dev/docs");
  });

  // Find and links split the same coordinate space; the order they nest in is the easy thing to get
  // wrong, and getting it wrong drops one of them.
  it("still highlights a find match inside a link", () => {
    const pre = mirror({ text: "see https://herdr.dev/docs\n", query: "herdr" });
    const a = pre.querySelector("a")!;
    const hit = a.querySelector("[data-find-match]")!;
    expect(hit.textContent).toBe("herdr");
    expect(a.textContent).toBe("https://herdr.dev/docs");
  });

  // The underline inherits the agent's colour rather than pinning one, so it stays legible whatever
  // the pane printed and whichever theme is up.
  it("underlines in currentColor rather than a fixed colour", () => {
    const a = mirror({ text: "https://herdr.dev\n" }).querySelector("a")!;
    expect(a.className).toContain("underline");
    expect(a.className).not.toMatch(/decoration-\[#/);
  });

  // The tap-target pad must scale with the font-size control. jsdom has no layout, so this can only
  // guard the unit — but the unit is the whole point: a px pad tuned for 12px text reaches past the
  // neighbouring line's centre at 9px (the A− floor), and a tap on ordinary output opens a link.
  // Measured in Chrome at 9/12/16px: the padded box stays inside the 1.25 line-height at all three.
  it("sizes the link tap target in em, never px", () => {
    const a = mirror({ text: "https://herdr.dev\n" }).querySelector("a")!;
    expect(a.className).toContain("py-[0.35em]");
    expect(a.className).not.toMatch(/\bpy-\[[\d.]+px\]/);
  });
});
