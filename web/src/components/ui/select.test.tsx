import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Select } from "./select";

describe("Select", () => {
  it("is a native select with the name it was given, and reports a pick", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select aria-label="Pick" value="a" onChange={(e) => onChange(e.target.value)}>
        <option value="a">Alpha</option>
        <option value="b">Beta</option>
      </Select>,
    );
    const select = screen.getByRole("combobox", { name: "Pick" });
    expect(select.tagName).toBe("SELECT");
    expect(select).toHaveValue("a");
    await user.selectOptions(select, "b");
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("draws its own chevron, removes the engine's caret, and keeps the 44px floor", () => {
    render(
      <Select aria-label="Pick" defaultValue="a">
        <option value="a">Alpha</option>
      </Select>,
    );
    const select = screen.getByRole("combobox");
    expect(select).toHaveClass("appearance-none", "h-11");
    expect(select.parentElement?.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("puts a lead glyph in front of the text, inert and hidden from the accessibility tree", () => {
    render(
      <Select aria-label="Pick" defaultValue="a" lead={<i data-testid="lead" />}>
        <option value="a">Alpha</option>
      </Select>,
    );
    expect(screen.getByRole("combobox")).toHaveClass("pl-8");
    expect(screen.getByTestId("lead").parentElement).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("lead").parentElement).toHaveClass("pointer-events-none");
  });

  it("gives its box to the caller's class, so a row can make it flexible or compact", () => {
    render(
      <Select aria-label="Pick" className="min-w-0 flex-1" defaultValue="a">
        <option value="a">Alpha</option>
      </Select>,
    );
    expect(screen.getByRole("combobox").closest('[data-slot="select"]')).toHaveClass("min-w-0", "flex-1");
  });
});
