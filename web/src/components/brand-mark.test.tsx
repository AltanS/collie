import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetDesign, setDesignMark } from "@/lib/design";
import { collieMark, markPaper } from "@/test/collie-mark";

import { MARK_IDS } from "@/lib/mark-ids";

import { BrandMark, FallBackToCollie, preloadMark } from "./brand-mark";

// The host of the header logo. Collie is eager; the others are chunks that arrive on demand, and until
// then the host draws an empty box of the mark's own size so the header never shifts. The generated
// files are replaced here by a marker each, so the cases ask which mark was chosen and not how it draws
// (mark-conformance.test.tsx renders the real ones).

vi.mock("./kawaii-mark", () => ({
  KawaiiMark: ({ state, beads }: { state?: string; beads?: string }) => (
    <span data-mock="kawaii" data-state={state} data-beads={beads} />
  ),
}));
vi.mock("./kawaii-tilt-mark", () => ({ KawaiiTiltMark: () => <span data-mock="kawaii-tilt" /> }));
vi.mock("./pixel-mark", () => ({ PixelMark: () => <span data-mock="pixel" /> }));

const drawn = (root: ParentNode) => root.querySelector("[data-mock]")?.getAttribute("data-mock") ?? null;

const pending = (root: ParentNode) => root.querySelector<HTMLElement>('[data-slot="brand-mark-pending"]');

beforeEach(() => {
  localStorage.clear();
  __resetDesign();
});

describe("BrandMark", () => {
  it("draws the Collie mark at once, with no box and no wait, when nothing names another", () => {
    const { container } = render(<BrandMark size={44} weight="header" />);
    expect(collieMark(container)).not.toBeNull();
    expect(pending(container)).toBeNull();
  });

  it("forwards the contract's props to the Collie mark", () => {
    const { container } = render(<BrandMark size={44} weight="header" state="loading" paper="red" className="x" />);
    const svg = collieMark(container);
    expect(svg?.getAttribute("data-state")).toBe("loading");
    expect(svg?.classList.contains("x")).toBe(true);
    expect(markPaper(container)).toBe("red");
  });

  // Each chunk is waited for once per module: `React.lazy` keeps what it resolved, so the empty box is
  // only observable the first time a mark is drawn. One case per mark, each the first to draw it.
  it("holds an empty box of the Collie mark's default size for Kawaii until its chunk arrives, then draws it", async () => {
    const { container } = render(<BrandMark mark="kawaii" />);
    const box = pending(container);
    expect(box).not.toBeNull();
    expect(box?.getAttribute("aria-hidden")).toBe("true");
    expect(box?.style.width).toBe("32px");
    expect(box?.style.height).toBe("32px");
    expect(box?.childElementCount).toBe(0);
    expect(box?.textContent).toBe("");
    await waitFor(() => expect(drawn(container)).toBe("kawaii"));
    expect(pending(container)).toBeNull();
    expect(collieMark(container)).toBeNull();
  });

  it("holds an empty size x size box for Pixel until its chunk arrives, then draws it", async () => {
    const { container } = render(<BrandMark mark="pixel" size={44} />);
    const box = pending(container);
    expect(box).not.toBeNull();
    expect(box?.getAttribute("aria-hidden")).toBe("true");
    expect(box?.style.width).toBe("44px");
    expect(box?.style.height).toBe("44px");
    expect(box?.childElementCount).toBe(0);
    await waitFor(() => expect(drawn(container)).toBe("pixel"));
    expect(pending(container)).toBeNull();
  });

  it("holds an empty box for Kawaii Tilt until its chunk arrives, then draws it", async () => {
    const { container } = render(<BrandMark mark="kawaii-tilt" size={36} />);
    expect(pending(container)?.style.width).toBe("36px");
    await waitFor(() => expect(drawn(container)).toBe("kawaii-tilt"));
    expect(pending(container)).toBeNull();
  });

  it("draws the mark the `mark` prop names, whatever the device chose", () => {
    setDesignMark("kawaii");
    const { container } = render(<BrandMark mark="collie" size={28} />);
    expect(collieMark(container)).not.toBeNull();
    expect(drawn(container)).toBeNull();
    expect(pending(container)).toBeNull();
  });

  it("follows the device choice when `mark` is not given, live", async () => {
    const { container } = render(<BrandMark size={28} />);
    expect(pending(container)).toBeNull();
    act(() => setDesignMark("pixel"));
    await waitFor(() => expect(drawn(container)).toBe("pixel"));
    expect(collieMark(container)).toBeNull();
    act(() => setDesignMark("kawaii"));
    await waitFor(() => expect(drawn(container)).toBe("kawaii"));
    act(() => setDesignMark("kawaii-tilt"));
    await waitFor(() => expect(drawn(container)).toBe("kawaii-tilt"));
    act(() => setDesignMark("collie"));
    expect(drawn(container)).toBeNull();
    expect(collieMark(container)).not.toBeNull();
  });
});

describe("BrandMark, the chunked marks", () => {
  it("hands the state and the beads to the chosen mark, as the contract names them", async () => {
    const { container } = render(<BrandMark mark="kawaii" state="applying" beads="red" />);
    await waitFor(() => expect(drawn(container)).toBe("kawaii"));
    const mark = container.querySelector("[data-mock]");
    expect(mark?.getAttribute("data-state")).toBe("applying");
    expect(mark?.getAttribute("data-beads")).toBe("red");
  });
});

describe("FallBackToCollie", () => {
  it("draws the Collie mark, with the same props, when a chunked mark fails to load", () => {
    const Missing = (): never => {
      throw new Error("Failed to fetch dynamically imported module");
    };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <FallBackToCollie props={{ size: 40, weight: "header", state: "loading" }}>
        <Missing />
      </FallBackToCollie>,
    );
    quiet.mockRestore();
    const svg = collieMark(container);
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("width")).toBe("40");
    expect(svg?.getAttribute("data-state")).toBe("loading");
  });
});

describe("preloadMark", () => {
  it("resolves for every id, and does nothing for Collie", async () => {
    await expect(preloadMark("collie")).resolves.toBeUndefined();
    for (const id of MARK_IDS) await expect(preloadMark(id)).resolves.toBeUndefined();
  });
});

// The chunked marks must stay out of the entry bundle: a static import anywhere would pull a chunk into
// it. Only brand-mark.tsx may name them, and only as a dynamic import().
describe("the chunked marks", () => {
  const chunked = MARK_IDS.filter((id) => id !== "collie");

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : [];
    });
  }

  it("are every character but Collie, each with a generated file beside the host", () => {
    expect(chunked).toEqual(["kawaii", "kawaii-tilt", "pixel", "glass", "glass-front", "delft", "delft-front", "sheep"]);
    for (const id of chunked) expect(readFileSync(join(import.meta.dirname, `${id}-mark.tsx`), "utf8")).toContain("// generated: sha256=");
  });

  it("are imported dynamically by brand-mark.tsx and statically by nobody", () => {
    const root = join(import.meta.dirname, "..");
    const staticImport = new RegExp(`(?:^|\\n)\\s*(?:import|export)\\b[^;]*?\\bfrom\\s+["'][^"']*/(?:${chunked.join("|")})-mark["']`);
    const offenders = sources(root).filter((path) => staticImport.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
    const host = readFileSync(join(import.meta.dirname, "brand-mark.tsx"), "utf8");
    for (const id of chunked) expect(host).toContain(`import("./${id}-mark")`);
  });
});
