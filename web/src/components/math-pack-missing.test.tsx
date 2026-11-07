import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setDesignMath } from "@/lib/design";
import { __resetMathEngines, loadMathEngine } from "@/lib/math/engine";

import { MarkdownText } from "./markdown-text";

// ADR 0132: the engines are a pack the host downloads. A device that chose KaTeX on a host with no
// pack (never downloaded, removed, or lost with an update) asks for `/math/katex/…` and gets a 404.
// The import fails, and Chat must still draw every formula as the source the agent wrote, never a
// broken or empty message.
vi.mock("@/lib/math/katex", () => {
  throw new Error("Failed to fetch dynamically imported module: http://phone.test/math/katex/katex-x.js");
});
vi.mock("@/lib/clipboard", () => ({ canCopyText: () => true, copyText: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/status", () => ({ setStatus: vi.fn() }));

afterEach(() => {
  cleanup();
  setDesignMath("off");
  __resetMathEngines();
});

describe("a chosen engine the host does not serve", () => {
  it("leaves every formula as its source and the rest of the message as it was", async () => {
    setDesignMath("katex");
    expect(await loadMathEngine("katex")).toBeNull();
    const { container } = render(<MarkdownText text={"The energy is $E = mc^2$, and **that** is all.\n\n$$a^2 + b^2 = c^2$$"} />);
    await waitFor(() => expect(container.textContent).toContain("$E = mc^2$"));
    expect(container.textContent).toContain("$$a^2 + b^2 = c^2$$");
    expect(container.querySelector("strong")?.textContent).toBe("that");
    expect(container.querySelector("math")).toBeNull();
  });
});
