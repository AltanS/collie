import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WalkyHeldStrip } from "./walky-composer-strip";

afterEach(() => cleanup());

// The held mark above the box. Deliver now (prototype) joins it for a linked pane with exactly one message waiting.

const ID = "wt_dn0000000001";

describe("the held mark", () => {
  it("is one whole tap that opens the sheet, as it always was, for a pane that is not linked", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<WalkyHeldStrip count={1} onOpen={onOpen} deliverId={ID} onDeliverNow={vi.fn(async () => {})} />);
    expect(screen.queryByRole("button", { name: "Deliver now" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "1 message waits while you type" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("offers Deliver now for a linked pane with one message waiting, and calls back with its id", async () => {
    const user = userEvent.setup();
    const onDeliverNow = vi.fn(async () => {});
    const onOpen = vi.fn();
    render(<WalkyHeldStrip count={1} onOpen={onOpen} linked deliverId={ID} onDeliverNow={onDeliverNow} />);
    await user.click(screen.getByRole("button", { name: "Deliver now" }));
    expect(onDeliverNow).toHaveBeenCalledExactlyOnceWith(ID);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps the words as the tap that opens the sheet beside Deliver now", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<WalkyHeldStrip count={1} onOpen={onOpen} linked deliverId={ID} onDeliverNow={vi.fn(async () => {})} />);
    await user.click(screen.getByRole("button", { name: "1 message waits while you type" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("says on a second line that the person's text stays, beside the button", () => {
    render(<WalkyHeldStrip count={1} onOpen={vi.fn()} linked deliverId={ID} onDeliverNow={vi.fn(async () => {})} />);
    expect(screen.getByText("Your text stays in the box.")).toBeInTheDocument();
  });

  it("words the wait by its reason: the person's text, a running turn, or a mix as a plain count", () => {
    render(<WalkyHeldStrip count={1} kind="busy" onOpen={vi.fn()} />);
    expect(screen.getByRole("button", { name: "1 message waits for the agent to finish" })).toBeInTheDocument();
    cleanup();
    render(<WalkyHeldStrip count={2} kind="busy" onOpen={vi.fn()} />);
    expect(screen.getByRole("button", { name: "2 messages wait for the agent to finish" })).toBeInTheDocument();
    cleanup();
    render(<WalkyHeldStrip count={3} kind="other" onOpen={vi.fn()} />);
    expect(screen.getByRole("button", { name: "3 messages wait" })).toBeInTheDocument();
    cleanup();
    render(<WalkyHeldStrip count={1} kind="other" onOpen={vi.fn()} />);
    expect(screen.getByRole("button", { name: "1 message waits" })).toBeInTheDocument();
  });

  it("offers no Deliver now for a wait on a running turn, even when linked and alone", () => {
    render(<WalkyHeldStrip count={1} kind="busy" onOpen={vi.fn()} linked deliverId={ID} onDeliverNow={vi.fn(async () => {})} />);
    expect(screen.queryByRole("button", { name: "Deliver now" })).toBeNull();
    expect(screen.getByRole("button", { name: "1 message waits for the agent to finish" })).toBeInTheDocument();
  });

  it("is drawn as today with more than one message, linked or not", () => {
    render(<WalkyHeldStrip count={3} onOpen={vi.fn()} linked deliverId={ID} onDeliverNow={vi.fn(async () => {})} />);
    expect(screen.queryByRole("button", { name: "Deliver now" })).toBeNull();
    expect(screen.getByRole("button", { name: "3 messages wait while you type" })).toBeInTheDocument();
  });

  it("is disabled while the call is in flight, and says why when it fails", async () => {
    const user = userEvent.setup();
    let fail: (reason: Error) => void = () => {};
    const onDeliverNow = vi.fn(() => new Promise<void>((_resolve, reject) => (fail = reject)));
    render(<WalkyHeldStrip count={1} onOpen={vi.fn()} linked deliverId={ID} onDeliverNow={onDeliverNow} />);
    const button = screen.getByRole("button", { name: "Deliver now" });
    await user.click(button);
    expect(button).toBeDisabled();
    await user.click(button);
    expect(onDeliverNow).toHaveBeenCalledTimes(1);
    fail(new Error("The agent did not take it."));
    expect(await screen.findByText("Not delivered. The message still waits and your text is unchanged. The agent did not take it.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Deliver now" })).toBeEnabled());
  });

  it("a message that no longer waited at the tap is no failure: the button frees and no failure line shows", async () => {
    const user = userEvent.setup();
    const onDeliverNow = vi.fn(async () => "gone" as const);
    render(<WalkyHeldStrip count={1} onOpen={vi.fn()} linked deliverId={ID} onDeliverNow={onDeliverNow} />);
    await user.click(screen.getByRole("button", { name: "Deliver now" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Deliver now" })).toBeEnabled());
    expect(onDeliverNow).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Not delivered/)).toBeNull();
  });
});
