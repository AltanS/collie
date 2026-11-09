import { render, screen } from "@testing-library/react";

import { collieMark, markIsLive, markPaper, markState } from "@/test/collie-mark";

import { CollieMark } from "./collie-mark";

// The Collie mark's own drawing, as opposed to the contract every mark meets (mark-conformance.test.tsx
// runs that over the registry) and to what any screen does with it. Only what is specific to this
// drawing is pinned here.
describe("CollieMark", () => {
  it("is still at rest and live while loading, and says so on its root", () => {
    const { container, rerender } = render(<CollieMark />);
    expect(markState(container)).toBe("rest");
    expect(markIsLive(container)).toBe(false);
    rerender(<CollieMark state="loading" />);
    expect(markState(container)).toBe("loading");
    expect(markIsLive(container)).toBe(true);
    expect(container.querySelectorAll("svg")).toHaveLength(1);
  });

  // Issue 748, ADR 0138 amendment: the ball's texture rolls inside a mask, the one part of any mark that
  // costs the main thread a paint per frame. At the slow paces it holds; the beads drift on the compositor.
  it("pauses the masked texture roll at the slow paces and keeps it in the live states", () => {
    const { container, rerender } = render(<CollieMark />);
    const svg = container.querySelector("svg");
    const sheet = container.querySelector("style")?.textContent ?? "";
    expect(sheet).toContain("[data-mark][data-slow] .cm-roll,");
    expect(container.querySelector(".cm-roll")).not.toBeNull();
    expect(svg?.hasAttribute("data-slow")).toBe(true);
    rerender(<CollieMark state="loading" />);
    expect(svg?.hasAttribute("data-slow")).toBe(false);
  });

  it("hides one side of a bead pair at rest via opacity=\"0\"", () => {
    // Near and far are two copies of every bead (front-of-head vs behind-it); exactly one of each
    // pair is drawn with opacity="0" so only one is visible at a time, at rest as much as loading.
    const { container } = render(<CollieMark />);
    const hidden = collieMark(container)?.querySelectorAll('[opacity="0"]');
    expect(hidden).not.toBeNull();
    expect(hidden?.length ?? 0).toBeGreaterThan(0);
  });

  it("forwards className to the element", () => {
    const { container } = render(<CollieMark className="transition-opacity" />);
    expect(collieMark(container)?.getAttribute("class")).toContain("transition-opacity");
  });

  it("hands the caller's paper to the knockout, never the built-in default", () => {
    // The knockout is what makes a near-side bead read as being IN FRONT of the head. It has to be
    // the colour of whatever the mark sits on, so the caller's value must reach the element.
    const { container } = render(<CollieMark paper="var(--muted)" />);
    expect(markPaper(container)).toBe("var(--muted)");
  });

  it("carries every per-instance difference on the element, so two marks never fight", () => {
    // A <style> inside an inline SVG is DOCUMENT-scoped: if the rules themselves differed per
    // instance, a resting mark and a loading one on the same page would overwrite each other.
    const { container } = render(
      <div>
        <CollieMark />
        <CollieMark state="loading" />
      </div>,
    );
    const marks = [...container.querySelectorAll<SVGSVGElement>("svg")];
    expect(marks.map((m) => m.getAttribute("data-state"))).toStrictEqual(["rest", "loading"]);
    const sheets = [...container.querySelectorAll("svg > style")].map((s) => s.textContent);
    expect(sheets[0]).toBe(sheets[1]);
  });

  it("is decorative unless given a title, and an image when it has one", () => {
    const { rerender } = render(<CollieMark />);
    expect(screen.queryByRole("img")).toBeNull();
    rerender(<CollieMark title="Collie" />);
    expect(screen.getByRole("img", { name: "Collie" })).toBeInTheDocument();
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
