import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetEnterSendsStore, enterSendsChoice, setEnterSends } from "@/lib/enter-sends-store";
import { EnterSendsControl } from "./enter-sends-control";

beforeEach(() => __resetEnterSendsStore());
afterEach(() => {
  cleanup();
  __resetEnterSendsStore();
});

describe("EnterSendsControl", () => {
  it("shows off on a device that never chose, and a tap stores on", async () => {
    const user = userEvent.setup();
    render(<EnterSendsControl />);
    const sw = screen.getByRole("switch", { name: "Enter sends" });
    expect(sw).not.toBeChecked();
    expect(screen.getByText(/Enter always adds a new line/)).toBeInTheDocument();
    await user.click(sw);
    expect(sw).toBeChecked();
    expect(enterSendsChoice()).toBe("on");
  });

  it("stores off when it is turned off again, and follows a choice made elsewhere", async () => {
    const user = userEvent.setup();
    setEnterSends(true);
    render(<EnterSendsControl />);
    const sw = screen.getByRole("switch", { name: "Enter sends" });
    expect(sw).toBeChecked();
    await user.click(sw);
    expect(enterSendsChoice()).toBe("off");
    expect(sw).not.toBeChecked();
  });
});
