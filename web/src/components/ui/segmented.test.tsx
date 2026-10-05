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

  it("reports a different segment and stays quiet for the selected one", async () => {
    const onChange = vi.fn();
    render(<Segmented options={OPTIONS} value="a" onChange={onChange} label="Pick" />);
    await userEvent.click(screen.getByRole("radio", { name: "First" }));
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("radio", { name: "Second" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("carries numeric values through unchanged", async () => {
    const onChange = vi.fn();
    const numbers = [
      { value: 5, label: "5 min" },
      { value: 10, label: "10 min" },
      { value: 30, label: "30 min" },
    ];
    render(<Segmented options={numbers} value={10} onChange={onChange} label="For" />);
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    await userEvent.click(screen.getByRole("radio", { name: "30 min" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(30);
  });

  it("disables every segment together", () => {
    render(<Segmented options={OPTIONS} value="a" onChange={() => {}} label="Pick" disabled />);
    for (const radio of screen.getAllByRole("radio")) expect(radio.hasAttribute("disabled")).toBe(true);
  });

  it("draws a mark after a label, said in words to a screen reader", () => {
    const marked = [
      { value: "a", label: "Status" },
      { value: "b", label: "Alerts", mark: "alert firing" },
    ];
    render(<Segmented options={marked} value="a" onChange={() => {}} label="View" semantics="tabs" />);
    const tab = screen.getByRole("tab", { name: "Alerts, alert firing" });
    expect(tab.querySelector('[data-slot="segmented-mark"]')).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("tab", { name: "Status" }).querySelector('[data-slot="segmented-mark"]')).toBeNull();
  });

  it("keeps the 44px floor on every segment, selected or not", () => {
    render(<Segmented options={OPTIONS} value="a" onChange={() => {}} label="Pick" />);
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio.className).toContain("min-h-11");
      expect(radio.className).toMatch(/(^|\s)border(\s|$)/);
    }
  });
});
