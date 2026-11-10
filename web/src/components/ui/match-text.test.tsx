import { render } from "@testing-library/react";

import { MatchText, type MatchRange } from "./match-text";

function drawn(text: string, ranges?: readonly MatchRange[], className?: string) {
  const { container } = render(
    <p>
      <MatchText text={text} ranges={ranges} className={className} />
    </p>,
  );
  const p = container.querySelector("p")!;
  const marks = [...p.querySelectorAll("mark")].map((m) => m.textContent);
  return { p, marks };
}

describe("MatchText", () => {
  it("draws the bare string with no range, one text node in the caller's element", () => {
    for (const ranges of [undefined, []] as const) {
      const { p, marks } = drawn("collie-workspace", ranges);
      expect(p.innerHTML).toBe("collie-workspace");
      expect(p.childNodes).toHaveLength(1);
      expect(marks).toEqual([]);
    }
  });

  it("marks one range", () => {
    const { p, marks } = drawn("collie-workspace", [[0, 6]]);
    expect(marks).toEqual(["collie"]);
    expect(p.innerHTML).toBe("<mark class=\"rounded-sm bg-find text-inherit\">collie</mark>-workspace");
  });

  it("marks three ranges, with the plain text between them kept", () => {
    const { p, marks } = drawn("collie-workspace", [
      [0, 1],
      [7, 8],
      [12, 16],
    ]);
    expect(marks).toEqual(["c", "w", "pace"]);
    expect(p.textContent).toBe("collie-workspace");
  });

  it("draws a mark with the ground, the rounding and the inherited ink, and no weight, size, padding or border", () => {
    const { p } = drawn("fix-748", [[0, 3]], "extra");
    const cls = p.querySelector("mark")!.className.split(" ");
    expect(cls).toEqual(["rounded-sm", "bg-find", "text-inherit", "extra"]);
    expect(cls.some((c) => /^(font|text-\[|text-(xs|sm|base|lg)|p[xytblr]?-|border)/.test(c))).toBe(false);
  });

  it("clamps a range that runs past the end", () => {
    const { p, marks } = drawn("abc", [[1, 99]]);
    expect(marks).toEqual(["bc"]);
    expect(p.textContent).toBe("abc");
  });

  it("clamps a range that begins before the start or past the end of the text", () => {
    expect(drawn("abc", [[-5, 2]]).marks).toEqual(["ab"]);
    const past = drawn("abc", [[7, 9]]);
    expect(past.marks).toEqual([]);
    expect(past.p.innerHTML).toBe("abc");
  });

  it("drops an empty or backwards range", () => {
    const { p, marks } = drawn("abc", [
      [1, 1],
      [2, 0],
    ]);
    expect(marks).toEqual([]);
    expect(p.innerHTML).toBe("abc");
  });

  it("never throws on overlapping or unsorted input and keeps the text whole", () => {
    const { p, marks } = drawn("abcdef", [
      [1, 4],
      [2, 5],
      [0, 2],
      [5, 6],
    ]);
    expect(marks).toEqual(["bcd", "e", "f"]);
    expect(p.textContent).toBe("abcdef");
  });

  it("has text content equal to the input for any ranges", () => {
    const text = "Straße café #12 fix/748";
    for (const ranges of [[[0, 1]], [[3, 9], [10, 11]], [[0, text.length]], [[5, 5]]] as const) {
      expect(drawn(text, ranges).p.textContent).toBe(text);
    }
  });

  it("draws an empty text as nothing", () => {
    const { p, marks } = drawn("", [[0, 3]]);
    expect(p.innerHTML).toBe("");
    expect(marks).toEqual([]);
  });
});
