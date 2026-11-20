import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetActionsPaletteStore, isActionsPaletteOn } from "@/lib/actions-palette-store";

import { ActionsPaletteControl } from "./actions-palette-control";

beforeEach(() => __resetActionsPaletteStore());
afterEach(() => __resetActionsPaletteStore());

describe("ActionsPaletteControl", () => {
  it("starts on, says what off does, and a tap writes the store", async () => {
    render(<ActionsPaletteControl />);
    const toggle = screen.getByRole("switch", { name: "Actions palette" });
    expect(toggle).toBeChecked();
    expect(screen.getByText("One searchable list of commands and panes. Off: the button and the shortcut open the pane list.")).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(isActionsPaletteOn()).toBe(false);
    expect(screen.getByRole("switch", { name: "Actions palette" })).not.toBeChecked();
    await userEvent.click(screen.getByRole("switch", { name: "Actions palette" }));
    expect(isActionsPaletteOn()).toBe(true);
  });
});
