import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { PAGE_ZOOM_OFF_ATTR, pageZoomAllowed, setPageZoomAllowed } from "@/lib/page-zoom";
import { PageZoomControl } from "./page-zoom-control";

afterEach(() => {
  localStorage.clear();
  setPageZoomAllowed(true);
});

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

  it("tells the page guard at once: the root attribute and the cached answer follow the switch", async () => {
    render(<PageZoomControl />);
    const toggle = screen.getByRole("switch", { name: "Pinch to zoom" });
    await userEvent.click(toggle);
    expect(pageZoomAllowed()).toBe(false);
    expect(document.documentElement).toHaveAttribute(PAGE_ZOOM_OFF_ATTR);
    await userEvent.click(toggle);
    expect(pageZoomAllowed()).toBe(true);
    expect(document.documentElement).not.toHaveAttribute(PAGE_ZOOM_OFF_ATTR);
  });
});
