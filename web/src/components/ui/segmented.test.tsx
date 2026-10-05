import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Segmented } from "./segmented";

const OPTIONS = [
  { value: "a", label: "First" },
  { value: "b", label: "Second" },
] as const;

afterEach(cleanup);

describe("Segmented", () => {
  it("is a radio group by default, with the selected value checked", () => {
    render(<Segmented options={OPTIONS} value="b" onChange={() => {}} label="Pick" />);
    expect(screen.getByRole("radiogroup", { name: "Pick" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Second" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "First" }).getAttribute("aria-checked")).toBe("false");
  });

  it("is a tab list when it switches screens", () => {
    render(<Segmented options={OPTIONS} value="a" onChange={() => {}} label="Pick" semantics="tabs" />);
    expect(screen.getByRole("tab", { name: "First" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Second" }).getAttribute("aria-selected")).toBe("false");
  });

  it("reports the tapped value", async () => {
    const onChange = vi.fn();
    render(<Segmented options={OPTIONS} value="a" onChange={onChange} label="Pick" />);
    await userEvent.click(screen.getByRole("radio", { name: "Second" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("reserves the same border on every segment, so a switch moves nothing", () => {
    const { rerender } = render(<Segmented options={OPTIONS} value="a" onChange={() => {}} label="Pick" />);
    const before = screen.getAllByRole("radio").map((b) => b.className.split(/\s+/).filter((c) => /^(border|px|min-h|font)/.test(c)));
    rerender(<Segmented options={OPTIONS} value="b" onChange={() => {}} label="Pick" />);
    const after = screen.getAllByRole("radio").map((b) => b.className.split(/\s+/).filter((c) => /^(border|px|min-h|font)/.test(c)));
    // Only colour classes (`border-foreground`, `border-border`) may differ, never a width or a weight.
    const boxClasses = (rows: string[][]) => rows.map((r) => r.filter((c) => !c.startsWith("border-")));
    expect(boxClasses(after)).toEqual(boxClasses(before));
    expect(boxClasses(after)[0]).toContain("border");
  });
});
