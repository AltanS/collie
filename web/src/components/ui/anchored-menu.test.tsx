import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AnchoredMenu } from "./anchored-menu";

// The counterpart to sheet.test.tsx. What is pinned here is the reason this exists at all: it must
// not cover the control that opened it, and it must not dim the page — both of which a bottom sheet
// does, and both of which made a press highlight on a bottom-edge control invisible.

describe("AnchoredMenu", () => {
  it("renders nothing while closed", () => {
    render(
      <AnchoredMenu open={false} onClose={() => {}} label="Attach">
        <button type="button">Photos</button>
      </AnchoredMenu>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("grows UPWARD from its anchor, so the trigger below it stays visible", () => {
    // The whole point. `bottom-full` is what puts the panel above the anchor rather than over it.
    render(
      <AnchoredMenu open onClose={() => {}} label="Attach">
        <button type="button">Photos</button>
      </AnchoredMenu>,
    );
    const panel = screen.getByRole("dialog");
    expect(panel.className).toMatch(/(^|\s)bottom-full(\s|$)/);
    expect(panel.className).toMatch(/(^|\s)absolute(\s|$)/);
  });

  it("its dismiss surface is transparent — a scrim would take back the visibility it exists to give", () => {
    render(
      <AnchoredMenu open onClose={() => {}} label="Attach">
        <button type="button">Photos</button>
      </AnchoredMenu>,
    );
    const surface = screen.getByRole("button", { name: "Attach" });
    expect(surface.className).not.toMatch(/bg-/);
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <AnchoredMenu open onClose={onClose} label="Attach">
        <button type="button">Photos</button>
      </AnchoredMenu>,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismisses only on a press AND release that both land on the surface", async () => {
    // The release of the very tap that OPENED the menu lands on this surface, so a bare click
    // handler would close it again inside one gesture — the rule BottomSheet's backdrop follows.
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <AnchoredMenu open onClose={onClose} label="Attach">
        <button type="button">Photos</button>
      </AnchoredMenu>,
    );
    const surface = screen.getByRole("button", { name: "Attach" });
    surface.click(); // a click with no pointerdown of its own — the opening gesture's release
    expect(onClose).not.toHaveBeenCalled();

    await user.click(surface);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("takes focus so a keyboard lands inside it", () => {
    render(
      <AnchoredMenu open onClose={() => {}} label="Attach">
        <button type="button">Photos</button>
      </AnchoredMenu>,
    );
    expect(screen.getByRole("dialog")).toHaveFocus();
  });
});
