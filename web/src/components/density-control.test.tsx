import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DensityControl } from "./density-control";
import { setDenseKeysEnabled, __resetDenseKeys } from "@/lib/density";

// The card is two decisions, and the second one only exists because of the first: the pin edge is a
// question about controls the dense layout puts on screen, so it must not be asked while that
// layout is off. Asserted through the accessible names an operator reads, not class names.
describe("DensityControl", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    __resetDenseKeys();
  });

  it("asks nothing about pin side until the dense layout is on", () => {
    render(<DensityControl />);
    expect(screen.getByRole("switch", { name: "Dense key surfaces" })).not.toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Side pins" })).toBeNull();
  });

  it("grows the pin-side row once the layout has pins to place", async () => {
    const user = userEvent.setup();
    render(<DensityControl />);

    await user.click(screen.getByRole("switch", { name: "Dense key surfaces" }));

    const group = screen.getByRole("radiogroup", { name: "Side pins" });
    expect(group).not.toBeNull();
    // Left is the shipped default: a left-held phone reaches that edge with the holding thumb.
    expect(screen.getByRole("radio", { name: "Left" }).getAttribute("aria-checked")).toBe("true");
  });

  it("takes the other edge and keeps it", async () => {
    const user = userEvent.setup();
    setDenseKeysEnabled(true);
    render(<DensityControl />);

    await user.click(screen.getByRole("radio", { name: "Right" }));

    expect(screen.getByRole("radio", { name: "Right" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Left" }).getAttribute("aria-checked")).toBe("false");
    // Persisted, not just held in the tree — the choice is a standing per-device preference.
    expect(localStorage.getItem("collie:pin-side:v1")).toContain("right");
  });

  it("takes the pin question away again when the layout goes back", async () => {
    const user = userEvent.setup();
    setDenseKeysEnabled(true);
    render(<DensityControl />);
    expect(screen.queryByRole("radiogroup", { name: "Side pins" })).not.toBeNull();

    await user.click(screen.getByRole("switch", { name: "Dense key surfaces" }));

    expect(screen.queryByRole("radiogroup", { name: "Side pins" })).toBeNull();
  });
});
