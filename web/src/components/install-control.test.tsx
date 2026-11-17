import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COLLAPSE_MS } from "@/components/ui/collapse";
import { readAnswer, writeAnswer } from "@/lib/remembered-shape";
import { INSTALL_WAIT_MS, InstallControl } from "./install-control";
import { __resetInstall, installsViaShareSheet } from "@/lib/install";

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

  it("renders the share-sheet hint on iOS — prose, no button, since no offer can ever arrive there", () => {
    render(<InstallControl shareSheet />);
    expect(screen.getByText(/tap Share in the browser, then/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("lets an offer win over the hint — a browser that CAN prompt shows one card, the button", async () => {
    render(<InstallControl shareSheet />);
    window.dispatchEvent(offerEvent());
    await screen.findByRole("button", { name: "Install" });
    expect(screen.queryByText(/tap Share in the browser, then/)).not.toBeInTheDocument();
  });
});

// CALM LOAD. The offer lands after the first paint on a cold open. A device that was offered it last time
// draws the card's place from the first frame, as the real card made `invisible`, and shows it in the
// same box when the offer lands. jsdom has no layout, so the cases read the DOM: the same element
// before and after, and the class that holds the place.
describe("InstallControl, the place of the card", () => {
  afterEach(() => vi.useRealTimers());

  it("holds the card's place from the first frame when the last visit was offered the install", async () => {
    writeAnswer("settings-install-card", true);
    const { container } = render(<InstallControl />);
    const card = container.querySelector('[data-place="held"]');
    expect(card).not.toBeNull();
    expect(card?.classList.contains("invisible")).toBe(true);
    // The real card's words are in it, so the box is as tall as the card at this width and in this language.
    expect(card).toHaveTextContent("Install the app");

    window.dispatchEvent(offerEvent());
    await screen.findByRole("button", { name: "Install" });
    // The same element, now visible: nothing was inserted, so nothing below it moved.
    const shown = container.querySelector('[data-slot="card"]');
    expect(shown).toBe(card);
    expect(shown?.classList.contains("invisible")).toBe(false);
    expect(container.querySelector('[data-place="held"]')).toBeNull();
    expect(readAnswer("settings-install-card")).toBe(true);
  });

  it("holds nothing on a device with no memory of an offer, or one that remembers none", () => {
    const { container, unmount } = render(<InstallControl />);
    expect(container.querySelector('[data-slot="card"]')).toBeNull();
    unmount();
    writeAnswer("settings-install-card", false);
    const again = render(<InstallControl />);
    expect(again.container.querySelector('[data-slot="card"]')).toBeNull();
  });

  it("gives the place back after the wait when no offer comes, once, and remembers that", async () => {
    vi.useFakeTimers();
    writeAnswer("settings-install-card", true);
    const { container } = render(<InstallControl />);
    expect(container.querySelector('[data-place="held"]')).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INSTALL_WAIT_MS - 1);
    });
    expect(container.querySelector('[data-place="held"]')).not.toBeNull();
    expect(readAnswer("settings-install-card")).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(readAnswer("settings-install-card")).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COLLAPSE_MS + 50);
    });
    expect(container.querySelector('[data-slot="card"]')).toBeNull();
  });

  it("keeps the iOS hint as it was: known at first render, never held", () => {
    writeAnswer("settings-install-card", true);
    const { container } = render(<InstallControl shareSheet />);
    expect(container.querySelector('[data-place="held"]')).toBeNull();
    expect(screen.getByText(/tap Share in the browser, then/)).toBeInTheDocument();
  });
});

describe("installsViaShareSheet", () => {
  it("wants an Apple touch device in a browser tab — every other combination is someone else's case", () => {
    expect(installsViaShareSheet(true, true, false)).toBe(true); // iPhone/iPad, in Safari
    expect(installsViaShareSheet(true, true, true)).toBe(false); // already installed and running
    expect(installsViaShareSheet(false, true, false)).toBe(false); // desktop Mac — no touch half
    expect(installsViaShareSheet(true, false, false)).toBe(false); // touch laptop — no Apple half
  });
});
