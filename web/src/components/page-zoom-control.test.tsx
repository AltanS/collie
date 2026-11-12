import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { PageZoomControl } from "./page-zoom-control";

afterEach(() => localStorage.clear());

const stored = () => JSON.parse(localStorage.getItem("collie:dash-prefs:v1") ?? "{}");

describe("PageZoomControl", () => {
  it("starts on, and a tap stores off", async () => {
    render(<PageZoomControl />);
    const toggle = screen.getByRole("switch", { name: "Pinch to zoom" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await userEvent.click(toggle);
    expect(stored().pageZoom).toBe(false);
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});
