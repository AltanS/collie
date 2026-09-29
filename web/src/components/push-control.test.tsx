import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { PushControl } from "./push-control";
import { usePushControl } from "@/hooks/use-push";

vi.mock("@/hooks/use-push", () => ({ usePushControl: vi.fn() }));

// Recovering push setup. These cases moved here with the row itself when Settings became an index
// of four pages: the switch is a component now, mounted by the Alerts section, and a case that
// mounts a whole route to reach one switch tests the route's card list as much as the switch.
//
// What they pin is the difference between a failure you can retry and one you cannot. The browser
// owns that answer (`availability`), and getting it wrong either hides a working button or offers
// one that can never succeed.
describe("PushControl — recovering push setup", () => {
  beforeEach(() => {
    vi.mocked(usePushControl).mockReturnValue({
      state: { availability: "ready", subscribed: false, userDisabled: true },
      busy: false,
      setEnabled: vi.fn().mockResolvedValue({ ok: true }),
    });
  });

  it("shows a thrown setup error and lets the user retry", async () => {
    const setEnabled = vi.fn()
      .mockRejectedValueOnce(new Error("Registration failed - push service error"))
      .mockResolvedValueOnce({ ok: true });
    vi.mocked(usePushControl).mockReturnValue({
      state: { availability: "ready", subscribed: false, userDisabled: true },
      busy: false, setEnabled,
    });
    render(<PushControl />);
    const toggle = await screen.findByRole("switch", { name: "Push notifications" });
    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toHaveTextContent("push service error");
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(setEnabled).toHaveBeenCalledTimes(2);
  });

  it("keeps the toggle retryable when configuration could not be checked", async () => {
    vi.mocked(usePushControl).mockReturnValue({
      state: { availability: "unavailable", subscribed: false, userDisabled: true },
      busy: false, setEnabled: vi.fn().mockResolvedValue({ ok: true }),
    });
    render(<PushControl />);
    expect(await screen.findByRole("switch", { name: "Push notifications" })).toBeEnabled();
    expect(screen.getByText(/Could not check notification setup/)).toBeInTheDocument();
  });

  it("keeps a denied browser permission from being treated as a transient failure", async () => {
    vi.mocked(usePushControl).mockReturnValue({
      state: { availability: "denied", subscribed: false, userDisabled: true },
      busy: false, setEnabled: vi.fn().mockResolvedValue({ ok: true }),
    });
    render(<PushControl />);
    expect(await screen.findByRole("switch", { name: "Push notifications" })).toBeDisabled();
  });
});
