import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { type DevicesData } from "@/lib/loaders";
import { withHeaderHost } from "@/test/header-host";
import { SettingsRoute } from "./settings";
import { usePushControl } from "@/hooks/use-push";

vi.mock("@/hooks/use-push", () => ({ usePushControl: vi.fn() }));

beforeEach(() => {
  vi.mocked(usePushControl).mockReturnValue({
    state: { availability: "ready", subscribed: false, userDisabled: true },
    busy: false,
    setEnabled: vi.fn().mockResolvedValue({ ok: true }),
  });
});

// Settings' HEADER, and only its header.
//
// This route used to hand-roll its own `<header>` beneath a comment claiming "one header treatment
// app-wide". It was not one: the hand-rolled bar carried no <AlphaBar/> and had its own padding
// recipe, so it stood 20px short of every other route's header and silently dropped the "you are on
// a prerelease build" strip on the way in. It fills the one hoisted header shell now, and these cases pin
// that — a false comment in the code is worse than no comment, so the claim is asserted rather than
// written down.

const NO_DEVICES: DevicesData = { enforced: false, current: null, devices: [], error: false };

function renderSettings() {
  const router = createMemoryRouter(
    [
      { path: "/settings", loader: () => NO_DEVICES, element: withHeaderHost(<SettingsRoute />) },
      { path: "/", element: <div data-testid="home" /> },
    ],
    { initialEntries: ["/settings"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("SettingsRoute — the shared header shell", () => {
  it("mounts exactly one header, and it is the shell that carries the prerelease strip", async () => {
    // vitest's define stamps BUILD.version as "0.0.0-test", which IS a prerelease — so the real
    // shell shows the strip here. A hand-rolled header cannot.
    renderSettings();
    expect(await screen.findByText(/TEST/)).toBeInTheDocument();
    expect(document.querySelectorAll("header")).toHaveLength(1);
  });

  it("leads with a 44px back button where every other route puts the Collie mark", async () => {
    renderSettings();
    const back = await screen.findByRole("button", { name: "Back" });
    expect(back.className).toContain("size-11");
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    // The mark is NOT here — this route leads with the way out, not with the way home.
    expect(screen.queryByRole("button", { name: /^Collie/ })).toBeNull();
  });
});

// ── THE FOOTER, AFTER THE UPDATE CHIP LEFT IT (M16/01) ──────────────────────────────────────────
//
// Settings used to end with three update surfaces for one subject. Updating has a page of its own
// now, so this page keeps one row that links to it — and the footer keeps the build stamp, which is
// a diagnostic and was never an update surface.
describe("SettingsRoute — the update surfaces", () => {
  it("keeps the build stamp and drops the footer update chip", async () => {
    renderSettings();
    // The build stamp is the vitest define — `v<version> · <sha> · <time> UTC`.
    expect(await screen.findByText(/^v0\.0\.0-test · .* UTC$/)).toBeInTheDocument();
    // Nothing on this page nudges an update any more: no chip line, no copyable command.
    expect(screen.queryByText(/Bridge restart needed/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Copy command/ })).toBeNull();
  });

  it("holds exactly one Updates row, and neither the card nor the check control", async () => {
    renderSettings();
    const rows = await screen.findAllByRole("button", { name: /Updates/ });
    expect(rows).toHaveLength(1);
    // Both of those live on /settings/updates now.
    expect(screen.queryByText("Update Collie")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
  });
});

describe("SettingsRoute — recovering push setup", () => {
  it("shows a thrown setup error and lets the user retry", async () => {
    const setEnabled = vi.fn()
      .mockRejectedValueOnce(new Error("Registration failed - push service error"))
      .mockResolvedValueOnce({ ok: true });
    vi.mocked(usePushControl).mockReturnValue({
      state: { availability: "ready", subscribed: false, userDisabled: true },
      busy: false, setEnabled,
    });
    renderSettings();
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
    renderSettings();
    expect(await screen.findByRole("switch", { name: "Push notifications" })).toBeEnabled();
    expect(screen.getByText(/Could not check notification setup/)).toBeInTheDocument();
  });

  it("keeps a denied browser permission from being treated as a transient failure", async () => {
    vi.mocked(usePushControl).mockReturnValue({
      state: { availability: "denied", subscribed: false, userDisabled: true },
      busy: false, setEnabled: vi.fn().mockResolvedValue({ ok: true }),
    });
    renderSettings();
    expect(await screen.findByRole("switch", { name: "Push notifications" })).toBeDisabled();
  });
});
