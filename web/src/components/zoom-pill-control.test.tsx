import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { ZoomPillControl } from "./zoom-pill-control";

afterEach(() => localStorage.clear());

const stored = () => JSON.parse(localStorage.getItem("collie:dash-prefs:v1") ?? "{}");

describe("ZoomPillControl", () => {
  it("starts on Screen view, stores nothing until a tap, and stores the choice of a tap", async () => {
    render(<ZoomPillControl />);
    expect(screen.getByRole("radiogroup", { name: "Zoom pill" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Screen view" })).toHaveAttribute("aria-checked", "true");
    expect(stored().zoomPill).toBeUndefined();
    await userEvent.click(screen.getByRole("radio", { name: "Off" }));
    expect(stored().zoomPill).toBe("off");
    expect(screen.getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "Screen view" }));
    expect(stored().zoomPill).toBe("screen");
  });

  it("shows a stored Off", () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ zoomPill: "off" }));
    render(<ZoomPillControl />);
    expect(screen.getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true");
  });
});
