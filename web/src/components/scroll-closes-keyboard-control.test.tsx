import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { ScrollClosesKeyboardControl } from "./scroll-closes-keyboard-control";

afterEach(() => localStorage.clear());

const stored = () => JSON.parse(localStorage.getItem("collie:dash-prefs:v1") ?? "{}");

describe("ScrollClosesKeyboardControl", () => {
  it("starts on, and a tap stores off", async () => {
    render(<ScrollClosesKeyboardControl />);
    const toggle = screen.getByRole("switch", { name: "Scroll closes the keyboard" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await userEvent.click(toggle);
    expect(stored().scrollClosesKeyboard).toBe(false);
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});
