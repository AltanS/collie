import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SearchField } from "./search-field";

function Harness() {
  const [value, setValue] = useState("");
  return <SearchField value={value} onChange={setValue} placeholder="Find a thing" label="Find" />;
}

describe("SearchField", () => {
  it("is a named text field with the keyboard's corrections off", () => {
    render(<Harness />);
    const field = screen.getByRole("textbox", { name: "Find" });
    expect(field).toHaveAttribute("placeholder", "Find a thing");
    expect(field).toHaveAttribute("autocorrect", "off");
    expect(field).toHaveAttribute("spellcheck", "false");
    expect(field).toHaveAttribute("inputmode", "search");
  });

  it("hands each edit to the caller as the whole new text", async () => {
    render(<Harness />);
    const field = screen.getByRole("textbox");
    await userEvent.type(field, "git");
    expect(field).toHaveValue("git");
  });
});
