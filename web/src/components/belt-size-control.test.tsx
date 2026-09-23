import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { BeltSizeControl } from "./belt-size-control";

afterEach(() => localStorage.clear());

const stored = () => JSON.parse(localStorage.getItem("collie:dash-prefs:v1") ?? "{}");

describe("BeltSizeControl", () => {
  it("starts on Default and stores the scale of the choice", async () => {
    render(<BeltSizeControl />);
    expect(screen.getByRole("radiogroup", { name: "Action belt size" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Default" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "Larger" }));
    expect(stored().beltScale).toBe(1.5);
    expect(screen.getByRole("radio", { name: "Larger" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "Large" }));
    expect(stored().beltScale).toBe(1.3);
  });
});
