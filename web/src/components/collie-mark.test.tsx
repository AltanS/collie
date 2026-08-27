import { render, screen } from "@testing-library/react";

import { collieMark, markAccent, markIsLive, markPaper } from "@/test/collie-mark";

import { CollieMark } from "./collie-mark";

// The mark's own contract, as opposed to what any screen does with it. Everything pinned here is
// load-bearing and none of it is obvious from the generated geometry.
//
// jsdom has no `Element.prototype.getAnimations` (checked directly — it is `undefined` under the
// jsdom + Vitest setup this suite runs in), so none of these tests can ask "is the CSS animation
// actually running". Instead they assert the two things that drive it: the `cm-live` class (what
// turns the animation on in the stylesheet's `.cm-live .cm-near .cm-b0 { animation: … }` rules) and
// the `opacity="0"` attribute the generator puts on whichever bead copy is hidden at rest.
describe("CollieMark", () => {
  it("is still at rest — no cm-live class — and gains it while loading", () => {
    const { container, rerender } = render(<CollieMark />);
    expect(collieMark(container)?.classList.contains("cm-live")).toBe(false);
    expect(markIsLive(container)).toBe(false);
    rerender(<CollieMark loading />);
    expect(collieMark(container)?.classList.contains("cm-live")).toBe(true);
    expect(markIsLive(container)).toBe(true);
    expect(container.querySelectorAll("svg")).toHaveLength(1);
  });

  it("hides one side of a bead pair at rest via opacity=\"0\"", () => {
    // Near and far are two copies of every bead (front-of-head vs behind-it); exactly one of each
    // pair is drawn with opacity="0" so only one is visible at a time, at rest as much as blooming.
    const { container } = render(<CollieMark />);
    const mark = collieMark(container);
    const hidden = mark?.querySelectorAll('[opacity="0"]');
    expect(hidden).not.toBeNull();
    expect(hidden?.length ?? 0).toBeGreaterThan(0);
    for (const bead of hidden ?? []) {
      expect(bead.getAttribute("opacity")).toBe("0");
    }
  });

  it("blooms in COLOUR too, not only by turning on", () => {
    // The regression this exists to stop: a version that changed nothing but whether it turns.
    // Under `prefers-reduced-motion` the turning stops dead (see below), so if the accents did not
    // also come up to full chroma, `loading` would say nothing at all to a reduced-motion reader.
    const { container, rerender } = render(<CollieMark />);
    const resting = markAccent(container);
    expect(resting).not.toBe("");
    rerender(<CollieMark loading />);
    expect(markAccent(container)).not.toBe(resting);
  });

  it("forwards className to the element, so a host can mute or size the mark", () => {
    const { container } = render(<CollieMark className="opacity-40 grayscale" />);
    expect(collieMark(container)?.getAttribute("class")).toBe("opacity-40 grayscale");
  });

  it("hands the caller's paper to the knockout, never the built-in default", () => {
    // The knockout is what makes a near-side bead read as being IN FRONT of the head. It has to be
    // the colour of whatever the mark sits on, so the caller's value must reach the element.
    const { container } = render(<CollieMark paper="var(--muted)" />);
    expect(markPaper(container)).toBe("var(--muted)");
  });

  it("carries every per-instance difference on the element, so two marks never fight", () => {
    // A <style> inside an inline SVG is DOCUMENT-scoped: if the rules themselves differed per
    // instance, a resting mark and a blooming one on the same page would overwrite each other.
    const { container } = render(
      <div>
        <CollieMark />
        <CollieMark loading />
      </div>,
    );
    const marks = [...container.querySelectorAll<SVGSVGElement>("svg")];
    expect(marks.map((m) => m.classList.contains("cm-live"))).toStrictEqual([false, true]);
    const sheets = [...container.querySelectorAll("svg > style")].map((s) => s.textContent);
    expect(sheets[0]).toBe(sheets[1]);
  });

  it("is decorative unless given a title, and an image when it has one", () => {
    const { rerender } = render(<CollieMark />);
    expect(screen.queryByRole("img")).toBeNull();
    rerender(<CollieMark title="Collie" />);
    expect(screen.getByRole("img", { name: "Collie" })).toBeInTheDocument();
  });

  it("stops every bead under prefers-reduced-motion", () => {
    // Survives the copy from the generator: without this rule the orbit keeps turning for a reader
    // who asked the whole OS for stillness. It stops the MOTION only — the accent colours are
    // variables, not animations, which is why the bloom still reads.
    const { container } = render(<CollieMark loading />);
    const css = collieMark(container)?.querySelector("style")?.textContent ?? "";
    const reduce = /prefers-reduced-motion: reduce\)\{([^{]*)\{animation:none!important\}\}/.exec(css);
    expect(reduce).not.toBeNull();
    const stopped = (reduce?.[1] ?? "").split(",");
    expect(stopped).toContain(".cm-b");

    // Checked by DERIVING the animated classes rather than by pinning the list. The mark has gained
    // moving parts twice — the beads' own turn, then a tumbling rock and a turning sun — and a test
    // that spells out the selectors fails on the addition instead of on the thing that would matter,
    // which is a new moving part that nobody remembered to stop.
    const animated = [...css.matchAll(/\.cm-live [^{]*?(\.[\w-]+)\{[^}]*animation:/g)].map((m) => m[1]);
    expect(animated.length).toBeGreaterThan(0);
    for (const cls of new Set(animated)) {
      expect(stopped.some((s) => cls.startsWith(s))).toBe(true);
    }
  });

  it("crops to the header weight's own viewBox, not the full mark's", () => {
    // Below about 80px the full mark's ring and beads thin past a pixel, so the header weight crops
    // to different geometry with its own viewBox rather than just scaling the same artwork down.
    const { container, rerender } = render(<CollieMark />);
    const fullViewBox = collieMark(container)?.getAttribute("viewBox");
    rerender(<CollieMark weight="header" />);
    expect(collieMark(container)?.getAttribute("viewBox")).not.toBe(fullViewBox);
  });
});
