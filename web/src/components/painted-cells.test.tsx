import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWideCells } from "./painted-cells";

describe("renderWideCells", () => {
  it("gives each wide piece the decoration of the link around it", () => {
    // An underline does not propagate into an inline-block child, and each wide piece is one.
    const { container } = render(
      <a href="/docs" className="underline">
        {renderWideCells("docs/한글.md")}
      </a>,
    );
    const cells = [...container.querySelectorAll<HTMLElement>('[class~="w-[2ch]"]')];

    expect(cells.map((cell) => cell.textContent)).toEqual(["한", "글"]);
    for (const cell of cells) expect(cell.className).toContain("[text-decoration:inherit]");
  });
});
