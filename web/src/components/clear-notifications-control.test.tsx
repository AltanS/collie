import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { ClearNotificationsControl } from "@/components/clear-notifications-control";
import type { DeviceCleanup } from "@/lib/clear-notifications";
import { currentStatus } from "@/lib/status";

// The control asks the bridge to clear, then does this device's half with the slots the bridge
// answered (lib/clear-notifications.ts, tested on its own). Every outcome is said in the card, in a
// notice under the button, because Settings mounts no floating status. Queries stay inside the
// render's own container (DESIGN.md §9).
const { revalidate, clearDevice } = vi.hoisted(() => ({
  revalidate: vi.fn(),
  clearDevice: vi.fn(async (_slots: readonly string[]): Promise<DeviceCleanup> => ({
    notifications: "done",
    countStore: "done",
  })),
}));
vi.mock("react-router", () => ({
  useRevalidator: () => ({ revalidate, state: "idle" }),
}));
vi.mock("@/lib/clear-notifications", async (original) => ({
  ...(await original<typeof import("@/lib/clear-notifications")>()),
  clearDeviceNotifications: clearDevice,
}));

beforeEach(() => {
  revalidate.mockClear();
  clearDevice.mockClear();
  server.use(http.post("/api/notifications/clear", () => HttpResponse.json({ clearedSlots: ["collie:herd:w1:p2"] })));
});

function mount() {
  const { container } = render(<ClearNotificationsControl />);
  const card = within(container);
  return { card, button: card.getByRole("button", { name: "Clear all" }), live: card.getByRole("status") };
}

const BOTH = "Cleared, but this device could not close its notifications or update its icon count. Tap again.";

describe("ClearNotificationsControl", () => {
  test("clears on the bridge, then on this device with what it cleared, and says so in the card", async () => {
    const user = userEvent.setup();
    const { card, button, live } = mount();
    expect(card.getByText(/agents waiting on you stay/i)).toBeInTheDocument();

    await user.click(button);

    await waitFor(() => expect(live).toHaveTextContent("Notifications cleared."));
    expect(card.getAllByText("Notifications cleared.")).toHaveLength(2); // the notice, and the live line
    expect(clearDevice).toHaveBeenCalledWith(["collie:herd:w1:p2"]);
    expect(revalidate).toHaveBeenCalled();
    expect(button).toBeEnabled();
    // Said once, in the card; nothing on a floating channel this page does not mount.
    expect(currentStatus()).toBeNull();
  });

  test("is busy, for a screen reader too, while the bridge has not answered", async () => {
    let answer = () => {};
    server.use(
      http.post("/api/notifications/clear", async () => {
        await new Promise<void>((resolve) => (answer = resolve));
        return HttpResponse.json({ clearedSlots: [] });
      }),
    );
    const user = userEvent.setup();
    const { button, live } = mount();
    await user.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));
    expect(button).toBeDisabled();
    expect(live).toHaveTextContent("Clearing…");
    answer();
    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "false"));
  });

  test("a refused clear touches nothing on this device and says why in the card", async () => {
    server.use(http.post("/api/notifications/clear", () => HttpResponse.json({ error: "boom" }, { status: 500 })));
    const user = userEvent.setup();
    const { button, live } = mount();

    await user.click(button);

    await waitFor(() => expect(live.textContent).not.toBe(""));
    expect(live).not.toHaveTextContent("Notifications cleared.");
    expect(clearDevice).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
    expect(button).toBeEnabled();
    expect(currentStatus()).toBeNull();
  });

  test.each([
    [{ notifications: "failed", countStore: "done" }, "Cleared, but this device could not close its notifications. Tap again."],
    [{ notifications: "done", countStore: "failed" }, "Cleared, but this device could not update its icon count. Tap again."],
    [{ notifications: "absent", countStore: "failed" }, "Cleared, but this device could not update its icon count. Tap again."],
    [{ notifications: "failed", countStore: "failed" }, BOTH],
  ] satisfies [DeviceCleanup, string][])("says which half of this device's clear was refused: %o", async (outcome, words) => {
    clearDevice.mockResolvedValueOnce(outcome);
    const user = userEvent.setup();
    const { button, live } = mount();
    await user.click(button);
    await waitFor(() => expect(live).toHaveTextContent(words));
  });

  test("a capability this browser lacks is not a failure", async () => {
    clearDevice.mockResolvedValueOnce({ notifications: "absent", countStore: "absent" });
    const user = userEvent.setup();
    const { button, live } = mount();
    await user.click(button);
    await waitFor(() => expect(live).toHaveTextContent("Notifications cleared."));
  });

  test("settles after the bridge cleared even when this device's half throws", async () => {
    clearDevice.mockRejectedValueOnce(new Error("unexpected"));
    const user = userEvent.setup();
    const { button, live } = mount();
    await user.click(button);
    await waitFor(() => expect(live).toHaveTextContent(BOTH));
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("aria-busy", "false");
    expect(revalidate).toHaveBeenCalled();
  });

  test("a second tap after a partial failure tries again and says the new outcome", async () => {
    clearDevice.mockResolvedValueOnce({ notifications: "failed", countStore: "done" });
    const user = userEvent.setup();
    const { button, live } = mount();
    await user.click(button);
    await waitFor(() => expect(live).toHaveTextContent(/could not close its notifications/));

    await user.click(button);

    await waitFor(() => expect(live).toHaveTextContent("Notifications cleared."));
    expect(clearDevice).toHaveBeenCalledTimes(2);
  });

  test("the outcome sits under the button, never in its row, and the button keeps the 44px floor", async () => {
    clearDevice.mockResolvedValueOnce({ notifications: "failed", countStore: "failed" });
    const user = userEvent.setup();
    const { card, button, live } = mount();
    await user.click(button);
    await waitFor(() => expect(live).toHaveTextContent(BOTH));
    // The row holds the button and its spinner slot only, so a wrapped outcome cannot grow it.
    expect(within(button.parentElement!).queryByText(BOTH)).toBeNull();
    expect(card.getAllByText(BOTH)).toHaveLength(2);
    expect(button).toHaveClass("h-11");
    expect(button).not.toHaveClass("h-8");
  });
});
