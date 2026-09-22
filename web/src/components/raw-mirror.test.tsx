import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { RawMirror } from "./raw-mirror";

// The raw region under a lifted card is the same pane rows at the same 1.25 leading as the mirror,
// so a Powerline cap or a block there is a quarter of a row short too (lib/cell-glyphs.ts). A card's
// Terminal view that brought the step back would undo the mirror's fix exactly when a dialog lifts.
describe("RawMirror", () => {
  it("paints cell-filling characters and leaves the text as the terminal printed it", () => {
    const text = "\ue0b6CL\ue0b4 5h \u2588\u2588 91%";
    const { container } = render(<RawMirror lines={splitLines(parseAnsi(text))} />);

    expect(container.querySelectorAll(".cell-glyph")).toHaveLength(4);
    expect(container.querySelector("pre")!.textContent).toBe(text);
  });
});
