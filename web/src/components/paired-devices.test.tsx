import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { PairedDevices } from "@/components/paired-devices";
import { getDeviceToken, setDeviceToken, TOKEN_STORAGE_KEY } from "@/lib/pairing";
import type { DevicesData } from "@/lib/loaders";

// PairedDevices calls useRevalidator() to re-run the settings loader after a pair/revoke. Stub it
// (hoisted so the vi.mock factory can close over it) so the card renders bare, exactly as
// snooze-control.test.tsx does, and assert it gets called.
const { revalidate } = vi.hoisted(() => ({ revalidate: vi.fn() }));
vi.mock("react-router", () => ({
  useRevalidator: () => ({ revalidate, state: "idle" }),
}));

const UNPAIRED: DevicesData = { enforced: false, current: null, devices: [], error: false };
const PAIRED: DevicesData = {
  enforced: true,
  current: "my phone",
  devices: [{ label: "my phone", createdAt: 1_000, lastSeenAt: 2_000, current: true }],
  error: false,
};

beforeEach(() => revalidate.mockClear());

describe("PairedDevices — pairing", () => {
  test("a successful pair stores the token exactly once and revalidates", async () => {
    const user = userEvent.setup();
    let body: { code?: string; label?: string } | undefined;
    server.use(
      http.post<never, { code?: string; label?: string }>("/api/pair", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ token: "tok-secret", label: "my phone" });
      }),
    );
    render(<PairedDevices data={UNPAIRED} />);

    await user.type(screen.getByLabelText(/pairing code/i), "abcd2345");
    await user.type(screen.getByLabelText(/name for this device/i), "my phone");
    await user.click(screen.getByRole("button", { name: /pair this device/i }));

    // The code is uppercased as typed — the operator reads it off a terminal, the phone keyboard
    // does not have to cooperate.
    await waitFor(() => expect(body).toEqual({ code: "ABCD2345", label: "my phone" }));
    expect(getDeviceToken()).toBe("tok-secret");
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("tok-secret");
    expect(revalidate).toHaveBeenCalled();
  });

  test("a bad-code failure shows the actionable sentence and stores nothing", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/api/pair", () => HttpResponse.json({ error: "bad-code" }, { status: 400 })),
    );
    render(<PairedDevices data={UNPAIRED} />);

    await user.type(screen.getByLabelText(/pairing code/i), "WRONG123");
    await user.type(screen.getByLabelText(/name for this device/i), "my phone");
    await user.click(screen.getByRole("button", { name: /pair this device/i }));

    expect(await screen.findByText(/that code doesn’t match/i)).toBeInTheDocument();
    expect(getDeviceToken()).toBeNull();
    expect(revalidate).not.toHaveBeenCalled();
  });

  test("no-pending names the command that mints a code", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/api/pair", () => HttpResponse.json({ error: "no-pending" }, { status: 400 })),
    );
    render(<PairedDevices data={UNPAIRED} />);

    await user.type(screen.getByLabelText(/pairing code/i), "ABCD2345");
    await user.type(screen.getByLabelText(/name for this device/i), "my phone");
    await user.click(screen.getByRole("button", { name: /pair this device/i }));

    expect(await screen.findByText(/no pairing code is waiting.*bin\/collie pair/i)).toBeInTheDocument();
  });

  test("the paired state names this device and drops the pairing form", () => {
    setDeviceToken("tok-secret");
    render(<PairedDevices data={PAIRED} />);

    expect(screen.getByText(/this device is paired as/i)).toBeInTheDocument();
    // Its label reads twice — once as "you are this one", once as its row in the registry.
    expect(screen.getAllByText("my phone")).toHaveLength(2);
    expect(screen.getByText("This device")).toBeInTheDocument();
    expect(screen.queryByLabelText(/pairing code/i)).not.toBeInTheDocument();
  });

  test("a device holding a token the registry doesn't recognise is offered the form again", () => {
    setDeviceToken("stale-token");
    render(<PairedDevices data={{ ...PAIRED, current: null }} />);

    expect(screen.getByLabelText(/pairing code/i)).toBeInTheDocument();
  });
});

describe("PairedDevices — revoking", () => {
  test("revoke takes two taps, calls the endpoint and revalidates", async () => {
    const user = userEvent.setup();
    setDeviceToken("tok-secret");
    let body: { label?: string } | undefined;
    server.use(
      http.post<never, { label?: string }>("/api/devices/revoke", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ enforced: false, current: null, devices: [] });
      }),
    );
    render(<PairedDevices data={PAIRED} />);

    await user.click(screen.getByRole("button", { name: /revoke my phone/i }));
    // The second tap names the consequence for the phone you're holding.
    await user.click(screen.getByRole("button", { name: /unpair this phone/i }));

    await waitFor(() => expect(body).toEqual({ label: "my phone" }));
    expect(revalidate).toHaveBeenCalled();
    // Self-revocation drops the local token — keeping it would leave a credential that only 403s.
    expect(getDeviceToken()).toBeNull();
  });

  test("revoking another device keeps this one's token", async () => {
    const user = userEvent.setup();
    setDeviceToken("tok-secret");
    const data: DevicesData = {
      enforced: true,
      current: "my phone",
      devices: [
        { label: "my phone", createdAt: 1_000, lastSeenAt: 2_000, current: true },
        { label: "old tablet", createdAt: 500, lastSeenAt: 600, current: false },
      ],
      error: false,
    };
    let body: { label?: string } | undefined;
    server.use(
      http.post<never, { label?: string }>("/api/devices/revoke", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...data, devices: [data.devices[0]!] });
      }),
    );
    render(<PairedDevices data={data} />);

    await user.click(screen.getByRole("button", { name: /revoke old tablet/i }));
    await user.click(screen.getByRole("button", { name: /^revoke$/i }));

    await waitFor(() => expect(body).toEqual({ label: "old tablet" }));
    expect(getDeviceToken()).toBe("tok-secret");
  });
});
