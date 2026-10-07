import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { testFileOpener } from "@/test/file-links";

import { FileLinksProvider } from "./file-links";
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

// A path the agent printed is a link in a card's Terminal view too (ADR 0088), found per row.
describe("RawMirror file paths", () => {
  const mirror = (text: string, opened: string[]) =>
    render(
      <FileLinksProvider value={testFileOpener(opened)}>
        <RawMirror lines={splitLines(parseAnsi(text))} />
      </FileLinksProvider>,
    );

  it("a row with a path under the root wraps it in a link that keeps the agent's colours", () => {
    const opened: string[] = [];
    const text = "  \x1b[32m+ edited src/cart.ts:7\x1b[0m done\nnext row";
    const { container } = mirror(text, opened);
    const link = container.querySelector("a")!;
    expect(link.textContent).toBe("src/cart.ts:7");
    // The green the agent printed, on the link's own text as on the words before it.
    expect(link.querySelector("span")?.getAttribute("style")).toContain("--ansi-2");
    // The rows read exactly as the terminal printed them.
    expect(container.querySelector("pre")!.textContent).toBe("  + edited src/cart.ts:7 done\nnext row");
    fireEvent.click(link);
    expect(opened).toEqual(["/pane/w1%3Ap1/changes/files?path=src%2Fcart.ts&line=7"]);
  });

  it("a path outside the root stays plain text", () => {
    const { container } = mirror("cat /etc/hosts and ~/.ssh/config", []);
    expect(container.querySelector("a")).toBeNull();
  });

  it("with no opener, nothing is a link", () => {
    const { container } = render(<RawMirror lines={splitLines(parseAnsi("see src/cart.ts"))} />);
    expect(container.querySelector("a")).toBeNull();
  });
});
