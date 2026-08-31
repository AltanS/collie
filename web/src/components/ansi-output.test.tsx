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

  // The colour lives on the SEGMENT span, and a no-wrap line wraps its segments in a clipping
  // inline-block span — so the query has to reach the leaf, not whatever element happens to contain
  // the glyph first. A frame row is a no-wrap line (blocks.ts FRAME_ROW), which is how this stopped
  // matching what it meant to match.
  const leafSpan = (pre: HTMLElement, has: string) =>
    [...pre.querySelectorAll("span")].find(
      (s) => s.textContent?.includes(has) && s.querySelector("span") === null,
    );

  const MUTED_RULE_COLOUR = "rgb(161, 161, 161)"; // #a1a1a1, --muted-foreground's dark half

  it("keeps muted rule glyphs on a literal dark-space grey", () => {
    const span = leafSpan(mirror("├────────────┤\n"), "─");
    expect(span).toBeDefined();
    expect(span!.style.color).toBe(MUTED_RULE_COLOUR);
  });

  // The frame row keeps BOTH properties at once: clipped to one visual line, and still painted the
  // muted grey. The clipping wrapper must not swallow the segment styling on its way in.
  it("renders a frame row on one clipped line without losing the muted colour", () => {
    const pre = mirror("├────────────┤\n");
    const clip = [...pre.querySelectorAll("span")].find((s) => s.className.includes("overflow-hidden"));

    expect(clip).toBeDefined();
    expect(clip!.className).toContain("whitespace-pre");
    expect(leafSpan(pre, "─")!.style.color).toBe(MUTED_RULE_COLOUR);
  });

  it("emits palette variables for indexed colour so the 16 slots stay themeable", () => {
    const pre = mirror(`${ESC}[31mred${ESC}[0m`);
    const span = [...pre.querySelectorAll("span")].find((s) => s.textContent === "red");
    expect(span!.style.color).toBe("var(--ansi-1)");
  });
});

// Wrap defaults ON (#53): the mirror is mostly agent prose and a phone shows far fewer columns than
// the desktop width panes are spawned at. The no-wrap branch is still the right rendering for TUI
// tables and box drawing, but it is now reachable ONLY through the View toggle — so it is exactly
// the kind of code a later refactor can drop without any test noticing.
describe("mirror line wrapping", () => {
  function preFor(props: Partial<ComponentProps<typeof AnsiOutput>>) {
    const { container } = render(<AnsiOutput text="a very long line" {...props} />);
    return container.querySelector("pre")!;
  }

  it("wraps by default rather than making the block a horizontal panner", () => {
    const cls = preFor({}).className;
    expect(cls).toContain("whitespace-pre-wrap");
    expect(cls).not.toContain("overflow-x-auto");
  });

  it("still pans, column-faithful, when wrap is turned off", () => {
    const cls = preFor({ wrap: false }).className;
    expect(cls).toContain("whitespace-pre");
    expect(cls).toContain("overflow-x-auto");
    expect(cls).not.toContain("whitespace-pre-wrap");
  });

  it("keeps a marked ANSI border to one clipped row without changing its text, styles, links, or find offsets", () => {
    const border = `  ${"─".repeat(20)}  `;
    const text = `ordinary prose\n${ESC}[41m${border.slice(0, 12)}${ESC}[44m${border.slice(12)}${ESC}[0m\nsee https://herdr.dev/docs\n`;
    const { container } = render(<AnsiOutput text={text} query="───" />);
    const pre = container.querySelector("pre")!;
    const clipped = pre.querySelector("span.inline-block")!;

    expect(clipped.className).toContain("max-w-full");
    expect(clipped.className).toContain("overflow-hidden");
    // `overflow-hidden` gives an inline-block a bottom-edge baseline; align it to the line box's
    // bottom so the border keeps the terminal grid's one-row line advance.
    expect(clipped.className).toContain("align-bottom");
    expect(clipped.className).toContain("whitespace-pre");
    expect(clipped.className).not.toContain("whitespace-nowrap");
    expect(clipped.className).toContain("break-normal");
    expect(clipped.textContent).toBe(border);
    expect(clipped.children).toHaveLength(2);
    // SAFETY: `children` is typed `Element`, but the mirror renders every segment as a <span> with
    // an inline style — which is exactly what these two lines assert. Two assertions, two reasons,
    // same reason.
    const [first, second] = [clipped.children[0] as HTMLElement, clipped.children[1] as HTMLElement];
    expect(first.style.backgroundColor).toBe("var(--ansi-1)");
    expect(second.style.backgroundColor).toBe("var(--ansi-4)");
    expect(clipped.querySelector("[data-find-match]")).not.toBeNull();
    expect(pre.querySelector("a")?.textContent).toBe("https://herdr.dev/docs");
    expect(pre.textContent).toBe(`ordinary prose\n${border}\nsee https://herdr.dev/docs\n`);
  });

  it("clips a plain border only while wrapping, leaving ordinary output and wrap-off panning alone", () => {
    const border = `  ${"─".repeat(20)}  `;
    const { container: plain } = render(<AnsiOutput text={`${border}\n`} />);
    expect(plain.querySelector("span.inline-block")?.textContent).toBe(border);

    const { container: wrapped } = render(<AnsiOutput text={`unbroken-${"x".repeat(40)}\n`} />);
    const wrappedPre = wrapped.querySelector("pre")!;
    expect(wrappedPre.className).toContain("break-words");
    expect(wrappedPre.querySelector("span.inline-block")).toBeNull();

    const { container: panned } = render(<AnsiOutput text={`${border}\n`} wrap={false} />);
    const pannedPre = panned.querySelector("pre")!;
    expect(pannedPre.className).toContain("overflow-x-auto");
    expect(pannedPre.querySelector("span.inline-block")).toBeNull();
    expect(pannedPre.textContent).toBe(`${border}\n`);
  });
  it("clips Codex's labelled rules and tags only its terminal-wide user fill for mobile transparency", () => {
    const user = `${ESC}[48;2;240;240;240m› submitted message${" ".repeat(32)}${ESC}[0m`;
    const diff = `${ESC}[48;2;33;58;43m+ semantic diff${ESC}[0m`;
    const rule = `─ Worked for 31m ${"─".repeat(32)}`;
    const { container } = render(<AnsiOutput text={`${user}\n${diff}\n${rule}\n`} agent="codex" />);
    const userSpan = container.querySelector(".terminal-mobile-transparent-bg") as HTMLElement;

    expect(userSpan.textContent).toContain("submitted message");
    // Desktop keeps Codex's native fill; the max-width CSS rule overrides it only on a phone.
    expect(userSpan.style.backgroundColor).toBe("rgb(240, 240, 240)");
    const diffSpan = [...container.querySelectorAll("span")].find((node) =>
      node.textContent?.includes("semantic diff"),
    )!;
    expect(diffSpan.classList.contains("terminal-mobile-transparent-bg")).toBe(false);
    expect(diffSpan.getAttribute("style")).toContain("rgb(33, 58, 43)");
    expect(container.querySelector("span.inline-block")?.textContent).toBe(rule);
  });

  it("does not suppress the same ANSI background for an unknown agent", () => {
    const user = `${ESC}[48;2;240;240;240mordinary terminal output${ESC}[0m`;
    const { container } = render(<AnsiOutput text={user} agent="shell" />);
    expect(container.querySelector(".terminal-mobile-transparent-bg")).toBeNull();
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
  // The padded box deliberately OVERLAPS its neighbours (~22px against a 15px line advance); what
  // must hold is that it never reaches the neighbouring line's centre, which only an em value keeps
  // true across the A+/A- range. See the LINK_CLASS comment for the full argument.
  it("sizes the link tap target in em, never px", () => {
    const a = mirror({ text: "https://herdr.dev\n" }).querySelector("a")!;
    expect(a.className).toContain("py-[0.35em]");
    expect(a.className).not.toMatch(/\bpy-\[[\d.]+px\]/);
  });
});
