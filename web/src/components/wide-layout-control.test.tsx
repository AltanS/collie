import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetWideLayoutStore } from "@/lib/wide-layout-store";

import { WideLayoutControl } from "./wide-layout-control";

beforeEach(() => __resetWideLayoutStore());
afterEach(() => __resetWideLayoutStore());

const stored = () => localStorage.getItem("collie:wide-layout-mode:v1");

describe("WideLayoutControl", () => {
  it("starts on Auto, stores Off, and reads it back on the next mount", async () => {
    const { unmount } = render(<WideLayoutControl />);
    expect(screen.getByRole("radiogroup", { name: "Large-screen layout" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Auto" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/at least 600 px wide and 480 px tall/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Off" }));
    expect(stored()).toBe("off");
    expect(screen.getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true");
    unmount();

    render(<WideLayoutControl />);
    expect(screen.getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "Auto" }));
    expect(stored()).toBe("auto");
  });
});
