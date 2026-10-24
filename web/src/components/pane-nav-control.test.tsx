import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { PaneNavControl } from "./pane-nav-control";

afterEach(() => localStorage.clear());

const stored = () => JSON.parse(localStorage.getItem("collie:display-prefs:v4") ?? "{}");

describe("PaneNavControl", () => {
  it("starts on Two fingers, stores each choice per device, and reads it back on the next mount", async () => {
    const { unmount } = render(<PaneNavControl />);
    expect(screen.getByRole("radiogroup", { name: "Pane navigation" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Two fingers", "Joystick", "Off"]);
    expect(screen.getByRole("radio", { name: "Two fingers" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/hold one finger on the chat or the terminal/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Joystick" }));
    expect(stored().paneNav).toBe("joystick");
    unmount();

    const again = render(<PaneNavControl />);
    expect(screen.getByRole("radio", { name: "Joystick" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "Off" }));
    expect(stored().paneNav).toBe("off");
    again.unmount();

    render(<PaneNavControl />);
    expect(screen.getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true");
  });

  it("reads an unknown stored value as Two fingers", () => {
    localStorage.setItem("collie:display-prefs:v4", JSON.stringify({ paneNav: "swipe" }));
    render(<PaneNavControl />);
    expect(screen.getByRole("radio", { name: "Two fingers" })).toHaveAttribute("aria-checked", "true");
  });
});
