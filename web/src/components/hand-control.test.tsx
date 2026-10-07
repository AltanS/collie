import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { HandControl } from "./hand-control";

afterEach(() => localStorage.clear());

const stored = () => JSON.parse(localStorage.getItem("collie:display-prefs:v4") ?? "{}");

describe("HandControl", () => {
  it("starts on Right, stores the hand of the choice, and reads it back on the next mount", async () => {
    const { unmount } = render(<HandControl />);
    expect(screen.getByRole("radiogroup", { name: "Hand" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Right" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "Left" }));
    expect(stored().hand).toBe("left");
    expect(screen.getByRole("radio", { name: "Left" })).toHaveAttribute("aria-checked", "true");
    unmount();

    render(<HandControl />);
    expect(screen.getByRole("radio", { name: "Left" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "Right" }));
    expect(stored().hand).toBe("right");
  });
});
