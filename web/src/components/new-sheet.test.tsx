import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { clearStatus } from "@/lib/status";
import type { Launcher } from "@/lib/types";
import { NewSheet } from "./new-sheet";

// The rows and their gates. The route-level behaviour (when the button is drawn, the hand-off to the
// new-space sheet, the saved copy) is pinned in routes/home-new-button.test.tsx.

const peek: Launcher = { command: "rumen-peek", label: "Runs & quota" };

function mount(over: Partial<Parameters<typeof NewSheet>[0]> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    launchers: [peek],
    scope: {},
    canSpace: true,
    canBranch: true,
    onLaunch: vi.fn(),
    onSpace: vi.fn(),
    onBranch: vi.fn(),
    ...over,
  };
  const view = render(<NewSheet {...props} />);
  return { props, ...view };
}

const sheet = () => screen.getByRole("dialog");

afterEach(() => clearStatus());

describe("NewSheet", () => {
  it("is one sheet titled New with Agent, Space and Agent on a branch", () => {
    mount();
    expect(screen.getByRole("dialog", { name: "New" })).toBeInTheDocument();
    const rows = within(sheet()).getAllByRole("button").map((b) => b.textContent);
    expect(rows).toEqual(expect.arrayContaining(["Agent", "Space", "Agent on a branch"]));
  });

  it.each([
    ["launchers", { launchers: [] }, "Agent"],
    ["createSpace", { canSpace: false }, "Space"],
    ["a repo to branch from", { canBranch: false }, "Agent on a branch"],
  ])("hides the row its flow cannot serve: no %s", (_what, over, gone) => {
    mount(over);
    expect(within(sheet()).queryByRole("button", { name: gone })).toBeNull();
    // …and keeps the other two.
    for (const name of ["Agent", "Space", "Agent on a branch"]) {
      if (name !== gone) expect(within(sheet()).getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("Space and Agent on a branch close the sheet first, then hand over", async () => {
    const { props } = mount();
    await userEvent.click(within(sheet()).getByRole("button", { name: "Space" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onSpace).toHaveBeenCalledTimes(1);
    await userEvent.click(within(sheet()).getByRole("button", { name: "Agent on a branch" }));
    expect(props.onClose).toHaveBeenCalledTimes(2);
    expect(props.onBranch).toHaveBeenCalledTimes(1);
  });

  it("Agent is a second level with a Back row, and a launcher row closes then launches", async () => {
    const { props } = mount();
    await userEvent.click(within(sheet()).getByRole("button", { name: "Agent" }));
    expect(screen.getByRole("dialog", { name: "Agent" })).toBeInTheDocument();
    expect(within(sheet()).queryByRole("button", { name: "Space" })).toBeNull();
    // Back returns to the three rows.
    await userEvent.click(within(sheet()).getByRole("button", { name: "Back" }));
    expect(screen.getByRole("dialog", { name: "New" })).toBeInTheDocument();
    await userEvent.click(within(sheet()).getByRole("button", { name: "Agent" }));
    await userEvent.click(within(sheet()).getByRole("button", { name: /Runs & quota/ }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onLaunch).toHaveBeenCalledWith("rumen-peek");
  });

  it("every opening starts at the three rows, whatever level the last one closed on", async () => {
    const { props, rerender } = mount();
    await userEvent.click(within(sheet()).getByRole("button", { name: "Agent" }));
    rerender(<NewSheet {...props} open={false} />);
    rerender(<NewSheet {...props} open />);
    expect(screen.getByRole("dialog", { name: "New" })).toBeInTheDocument();
  });
});
