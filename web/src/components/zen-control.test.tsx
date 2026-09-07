import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ZenControl } from "@/components/zen-control";
import { __resetZen, autoZenEnabled, setAutoZenEnabled, zenEnabled } from "@/lib/zen";

// The card carries two switches at two levels: zen's availability, and the rotation sub-row it
// governs. The pairing is the whole point of the shape, so these cases hold the two rules the shape
// promises — the sub-row is dead while the header is off, and the header cannot edit what the
// sub-row remembers. Both read the module store back, not just the rendered switch, because the
// stored bit is what survives the reload.

describe("ZenControl", () => {
  beforeEach(() => __resetZen());
  afterEach(() => __resetZen());

  test("opens with zen off and the rotation row disabled", () => {
    render(<ZenControl />);
    expect(screen.getByRole("switch", { name: /zen/i })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: /landscape/i })).toBeDisabled();
  });

  test("the header switch turns zen on, which frees the rotation row", async () => {
    const user = userEvent.setup();
    render(<ZenControl />);

    await user.click(screen.getByRole("switch", { name: /zen/i }));

    expect(zenEnabled()).toBe(true);
    expect(screen.getByRole("switch", { name: /landscape/i })).toBeEnabled();
  });

  test("a disabled rotation row cannot be toggled, so no hidden choice is made", async () => {
    const user = userEvent.setup();
    render(<ZenControl />);

    await user.click(screen.getByRole("switch", { name: /landscape/i }));

    expect(autoZenEnabled()).toBe(false); // untouched default, not a flip
  });

  test("the rotation row keeps its stored value while the header is cycled", async () => {
    const user = userEvent.setup();
    setAutoZenEnabled(true); // the operator who asked for zen on a turn of the phone
    render(<ZenControl />);

    const header = screen.getByRole("switch", { name: /zen/i });
    await user.click(header); // on
    expect(screen.getByRole("switch", { name: /landscape/i })).toBeChecked();

    await user.click(header); // off again
    await user.click(header); // and on

    expect(autoZenEnabled()).toBe(true);
    expect(screen.getByRole("switch", { name: /landscape/i })).toBeChecked();
  });

  test("the rotation row writes its own bit once zen is available", async () => {
    const user = userEvent.setup();
    render(<ZenControl />);

    await user.click(screen.getByRole("switch", { name: /zen/i }));
    await user.click(screen.getByRole("switch", { name: /landscape/i }));

    expect(autoZenEnabled()).toBe(true);
    expect(zenEnabled()).toBe(true);
  });
});
