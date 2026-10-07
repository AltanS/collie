import { describe, expect, it } from "vitest";

import { fitPath } from "./fit-path";

const PATH = "src/components/ui/routes/changes.tsx";

describe("fitPath", () => {
  it("returns the path unchanged when it fits, to the character", () => {
    expect(fitPath(PATH, PATH.length)).toBe(PATH);
    expect(fitPath(PATH, 200)).toBe(PATH);
  });

  it("collapses the folders between the first and the last to one ellipsis", () => {
    expect(fitPath(PATH, PATH.length - 1)).toBe("src/…/routes/changes.tsx");
    expect(fitPath(PATH, "src/…/routes/changes.tsx".length)).toBe("src/…/routes/changes.tsx");
  });

  it("collapses nothing with two folders or fewer", () => {
    expect(fitPath("src/routes/changes.tsx", 21)).toBe("s/routes/changes.tsx");
    expect(fitPath("src/routes/changes.tsx", 19)).toBe("s/r/changes.tsx");
    expect(fitPath("src/routes/changes.tsx", 22)).toBe("src/routes/changes.tsx");
    expect(fitPath("src/changes.tsx", 14)).toBe("s/changes.tsx");
  });

  it("shortens the first folder to its first character, then the last", () => {
    expect(fitPath(PATH, "src/…/routes/changes.tsx".length - 1)).toBe("s/…/routes/changes.tsx");
    expect(fitPath(PATH, "s/…/routes/changes.tsx".length - 1)).toBe("s/…/r/changes.tsx");
    expect(fitPath(PATH, "s/…/r/changes.tsx".length)).toBe("s/…/r/changes.tsx");
  });

  it("falls back to the bare name, never cutting it", () => {
    expect(fitPath(PATH, "s/…/r/changes.tsx".length - 1)).toBe("changes.tsx");
    expect(fitPath(PATH, 3)).toBe("changes.tsx");
    expect(fitPath(PATH, 0)).toBe("changes.tsx");
  });

  it("returns the name for a path with no folder", () => {
    expect(fitPath("README.md", 3)).toBe("README.md");
    expect(fitPath("README.md", 20)).toBe("README.md");
  });

  it("never exceeds the budget unless the bare name alone does", () => {
    for (let budget = 12; budget <= PATH.length; budget++) {
      const out = fitPath(PATH, budget);
      expect(out.length <= budget || out === "changes.tsx").toBe(true);
      expect(out.endsWith("changes.tsx")).toBe(true);
    }
  });
});
