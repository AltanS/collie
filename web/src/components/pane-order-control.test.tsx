import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { PaneOrderControl } from "./pane-order-control";

afterEach(() => localStorage.clear());

const stored = () => JSON.parse(localStorage.getItem("collie:dash-prefs:v1") ?? "{}");

describe("PaneOrderControl", () => {
  it("starts on Place and stores the choice", async () => {
    // Place by DEFAULT, which is the half of ADR 0071 that matters most: an install nobody has told
    // otherwise keeps ADR 0063's order, and activity is only ever the operator's own request.
    render(<PaneOrderControl />);
    expect(screen.getByRole("radio", { name: "Place" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "Activity" }));
    expect(stored().paneOrder).toBe("activity");
    expect(screen.getByRole("radio", { name: "Activity" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "Place" }));
    expect(stored().paneOrder).toBe("place");
  });

  it("reads back the value the pane switcher's own toggle wrote", () => {
    // ONE stored value, two places to change it. This is the card a person finds when they go
    // looking for the setting they tapped inside a pane.
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneOrder: "activity" }));
    render(<PaneOrderControl />);
    expect(screen.getByRole("radio", { name: "Activity" })).toHaveAttribute("aria-checked", "true");
  });
});
