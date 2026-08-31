import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InstallControl } from "./install-control";
import { __resetInstall } from "@/lib/install";

// The card exists exactly while the browser's install offer does. The offer is a nonstandard event
// this file has to counterfeit: a plain Event carrying `prompt` and `userChoice`, which is the same
// structural shape lib/install.ts trusts in the real browser.

function offerEvent(prompt = vi.fn().mockResolvedValue(undefined)) {
  return Object.assign(new Event("beforeinstallprompt"), {
    prompt,
    userChoice: Promise.resolve({ outcome: "accepted" as const }),
  });
}

beforeEach(() => {
  __resetInstall();
});

describe("InstallControl", () => {
  it("renders nothing while the browser has made no offer", () => {
    render(<InstallControl />);
    expect(screen.queryByText("Install the app")).not.toBeInTheDocument();
  });

  it("appears when the offer lands, and spends it on the button", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    render(<InstallControl />);

    window.dispatchEvent(offerEvent(prompt));
    const button = await screen.findByRole("button", { name: "Install" });

    await userEvent.setup().click(button);
    expect(prompt).toHaveBeenCalledTimes(1);
    // Single-use: the offer is off the table the moment it is spent, so the card leaves — through
    // Collapse, hence the waitFor rather than a synchronous assertion.
    await waitFor(() => expect(screen.queryByText("Install the app")).not.toBeInTheDocument());
  });

  it("leaves when the app gets installed through any other path", async () => {
    render(<InstallControl />);
    window.dispatchEvent(offerEvent());
    await screen.findByText("Install the app");

    window.dispatchEvent(new Event("appinstalled"));
    await waitFor(() => expect(screen.queryByText("Install the app")).not.toBeInTheDocument());
  });
});
