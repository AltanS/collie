import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { ChangesControl } from "./changes-control";

afterEach(() => localStorage.clear());

const stored = () => JSON.parse(localStorage.getItem("collie:dash-prefs:v1") ?? "{}");

describe("ChangesControl", () => {
  it("starts on, at two levels, and stores a new depth", async () => {
    render(<ChangesControl />);
    expect(screen.getByRole("switch", { name: "Look for repos inside this folder" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "2 levels" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "4 levels" }));
    expect(stored().changesDepth).toBe(4);
    expect(screen.getByRole("radio", { name: "4 levels" })).toHaveAttribute("aria-checked", "true");
  });

  it("disables the depth choice, without clearing it, while the switch is off", async () => {
    render(<ChangesControl />);
    await userEvent.click(screen.getByRole("switch", { name: "Look for repos inside this folder" }));
    expect(stored().changesNested).toBe(false);
    for (const name of ["1 level", "2 levels", "3 levels", "4 levels"]) {
      expect(screen.getByRole("radio", { name })).toBeDisabled();
    }
    expect(screen.getByRole("radio", { name: "2 levels" })).toHaveAttribute("aria-checked", "true");
  });
});
