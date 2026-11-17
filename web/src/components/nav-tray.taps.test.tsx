import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearStatus, currentStatus } from "@/lib/status";
import { expectTapAnswers } from "@/test/tap-guard";
import { NavTray } from "./nav-tray";

// M102 spec 11, "No tap vanishes", the Keys pad: a key that cannot act keeps its place and its tap, and the
// tap says why. Every case drives a control in a state and asks the guard that the tap answered.

beforeEach(() => clearStatus());
afterEach(() => cleanup());

const noop = () => Promise.resolve();

describe("NavTray taps", () => {
  it("no tap vanishes: a chord the multiplexer refuses names the key and sends nothing", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(() => Promise.resolve(true));
    render(<NavTray onSend={onSend} unsupportedKeys={["Up"]} />);
    const up = screen.getByRole("button", { name: "Up" });
    expect(up).toHaveAttribute("aria-disabled", "true");
    await expectTapAnswers(() => user.click(up));
    expect(currentStatus()?.text).toBe("This terminal does not take Up.");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("no tap vanishes: a refused Ctrl preset answers too, and so does a refused digit", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(() => Promise.resolve(true));
    render(<NavTray onSend={onSend} unsupportedKeys={["c", "5"]} />);
    await user.click(screen.getByRole("button", { name: "Presets" }));
    await expectTapAnswers(() => user.click(screen.getByRole("button", { name: "Ctrl+C" })));
    await user.click(screen.getByRole("button", { name: "123" }));
    await expectTapAnswers(() => user.click(screen.getByRole("button", { name: "5" })));
    expect(currentStatus()?.text).toBe("This terminal does not take 5.");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("no tap vanishes: with the link down a line at the top of the pad says why every key waits", () => {
    const { rerender } = render(<NavTray onSend={vi.fn()} />);
    expect(screen.queryByText("No link to the bridge. Keys cannot go out now.")).toBeNull();
    rerender(<NavTray onSend={vi.fn()} disabled />);
    expect(screen.getByText("No link to the bridge. Keys cannot go out now.")).toBeInTheDocument();
    // Geometry: every key is still drawn in place.
    expect(screen.getByRole("button", { name: "Esc" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Enter" })).toBeInTheDocument();
  });

  it("no tap vanishes: Clear with no draft says the box is empty", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn(noop);
    render(<NavTray onSend={vi.fn()} clearBox={{ available: false, unavailable: "empty", onClear }} />);
    await expectTapAnswers(() => user.click(screen.getByRole("button", { name: "Clear the input box" })));
    expect(currentStatus()?.text).toBe("The agent's box is empty. There is nothing to clear.");
    expect(onClear).not.toHaveBeenCalled();
  });

  it("no tap vanishes: Clear under a dialog says to answer the dialog first", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn(noop);
    render(<NavTray onSend={vi.fn()} clearBox={{ available: false, unavailable: "dialog", onClear }} />);
    await expectTapAnswers(() => user.click(screen.getByRole("button", { name: "Clear the input box" })));
    expect(currentStatus()?.text).toBe("A dialog is open. Answer it first, then clear.");
    expect(onClear).not.toHaveBeenCalled();
  });

  it("no tap vanishes: Clear with the link down says the link is down", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn(noop);
    render(<NavTray onSend={vi.fn()} disabled clearBox={{ available: true, onClear }} />);
    await expectTapAnswers(() => user.click(screen.getByRole("button", { name: "Clear the input box" })));
    expect(currentStatus()?.text).toBe("No link to the bridge. Keys cannot go out now.");
    expect(onClear).not.toHaveBeenCalled();
  });

  it("no tap vanishes: a key that can act still sends, and Clear with a draft still posts", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(() => Promise.resolve(true));
    const onClear = vi.fn(noop);
    render(<NavTray onSend={onSend} clearBox={{ available: true, onClear }} />);
    await user.click(screen.getByRole("button", { name: "Up" }));
    expect(onSend).toHaveBeenCalledWith(["Up"]);
    await user.click(screen.getByRole("button", { name: "Clear the input box" }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});
