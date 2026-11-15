import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { PaneOrderControl } from "./pane-order-control";
import { currentLastViewed, recordLastViewed } from "@/lib/last-viewed";

afterEach(() => localStorage.clear());

const stored = () => JSON.parse(localStorage.getItem("collie:dash-prefs:v1") ?? "{}");

describe("PaneOrderControl", () => {
  it("starts on Place with Last viewed off, and stores the choice", async () => {
    // Place by DEFAULT, which is the half of ADR 0071 that matters most: an install nobody has told
    // otherwise keeps ADR 0063's order, and activity is only ever the operator's own request.
    render(<PaneOrderControl />);
    expect(screen.getByRole("radio", { name: "Place" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Last viewed in Switch pane" })).not.toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "Activity" }));
    expect(stored().paneOrder).toBe("activity");
    expect(screen.getByRole("radio", { name: "Activity" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "Place" }));
    expect(stored().paneOrder).toBe("place");
  });

  it("toggles Last viewed anytime, even outside Place order, and clears stored trail when turned off", async () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneOrder: "activity" }));
    render(<PaneOrderControl />);

    const toggle = screen.getByRole("switch", { name: "Last viewed in Switch pane" });
    expect(toggle).toBeEnabled();
    expect(toggle).not.toBeChecked();

    await userEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(stored().switcherLastViewed).toBe(true);

    recordLastViewed("w1:p1", "collie");
    expect(currentLastViewed()).toHaveLength(1);

    await userEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(stored().switcherLastViewed).toBe(false);
    expect(currentLastViewed()).toEqual([]);
    expect(localStorage.getItem("collie:last-viewed:v1")).toBeNull();
  });

  it("reads back the value the pane switcher's own toggle wrote", () => {
    // ONE stored value, two places to change it. This is the card a person finds when they go
    // looking for the setting they tapped inside a pane.
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneOrder: "activity" }));
    render(<PaneOrderControl />);
    expect(screen.getByRole("radio", { name: "Activity" })).toHaveAttribute("aria-checked", "true");
  });
});
