import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { PairedDevices } from "@/components/paired-devices";
import { getDeviceToken, setDeviceToken, TOKEN_STORAGE_KEY } from "@/lib/pairing";
import type { DevicesData } from "@/lib/loaders";

// PairedDevices calls useRevalidator() to re-run the settings loader after a pair/revoke, and
// useLocation() to see whether it is the fragment the read-only strip linked to. Stub both (hoisted
// so the vi.mock factory can close over them) so the card renders bare, exactly as
// snooze-control.test.tsx does, and assert they get used.
const { revalidate, hash, search, setSearchParams } = vi.hoisted(() => ({
  revalidate: vi.fn(),
  hash: { current: "" },
  search: { current: "" },
  setSearchParams: vi.fn(),
}));
vi.mock("react-router", () => ({
  useRevalidator: () => ({ revalidate, state: "idle" }),
  useLocation: () => ({
    hash: hash.current,
    pathname: "/settings",
    search: search.current,
    state: null,
    key: "t",
  }),
  // The QR `collie pair` prints lands on `/settings?pair=<code>#paired-devices`, so the form reads
  // and then clears that one param. The setter records rather than navigates: what matters is that
  // the spent code leaves the URL, and that it leaves it by replacing the entry.
  useSearchParams: () => [
    new URLSearchParams(search.current),
    (next: URLSearchParams, opts?: { replace?: boolean }) => {
      search.current = next.toString() === "" ? "" : `?${next.toString()}`;
      setSearchParams(next, opts);
    },
  ],
}));

const UNPAIRED: DevicesData = { enforced: false, current: null, devices: [], error: false };
const PAIRED: DevicesData = {
  enforced: true,
  current: "my phone",
  devices: [{ label: "my phone", createdAt: 1_000, lastSeenAt: 2_000, current: true }],
  error: false,
};

beforeEach(() => {
  revalidate.mockClear();
  setSearchParams.mockClear();
  hash.current = "";
  search.current = "";
});

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

describe("PairedDevices — arriving from the QR", () => {
  // `?pair=<code>` is what the QR carries. The code is then already spelled, so the only thing left
  // to type is the device name — which is where the keyboard should open.
  test("prefills the code, upper-cased, scrolls the card in and puts focus on the name", () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    // Exactly what the QR carries: the param and NO fragment. `pair` alone has to move the card,
    // because a fragment would let the browser focus the card and undo this.
    search.current = "?pair=abcd2345";
    render(<PairedDevices data={UNPAIRED} />);

    expect(screen.getByLabelText(/pairing code/i)).toHaveValue("ABCD2345");
    expect(scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText(/name for this device/i));
    scrollIntoView.mockRestore();
  });

  test("the fragment WITHOUT a code still focuses the card, as the read-only strip needs", () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    hash.current = "#paired-devices";
    render(<PairedDevices data={UNPAIRED} />);

    expect(scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement).toBe(document.getElementById("paired-devices"));
    scrollIntoView.mockRestore();
  });

  test("a URL carrying both still lands on the name field", () => {
    // Collie never prints this one, but an operator can paste it together by hand. The code is
    // filled in either way, so the field is still the only thing left to do.
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    search.current = "?pair=abcd2345";
    hash.current = "#paired-devices";
    render(<PairedDevices data={UNPAIRED} />);

    expect(document.activeElement).toBe(screen.getByLabelText(/name for this device/i));
    scrollIntoView.mockRestore();
  });

  test("a spent code leaves the URL, so a reload cannot re-offer it", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/api/pair", () => HttpResponse.json({ token: "tok-secret", label: "my phone" })),
    );
    search.current = "?pair=abcd2345";
    render(<PairedDevices data={UNPAIRED} />);

    await user.type(screen.getByLabelText(/name for this device/i), "my phone");
    await user.click(screen.getByRole("button", { name: /pair this device/i }));

    await waitFor(() => expect(setSearchParams).toHaveBeenCalled());
    const [params, opts] = setSearchParams.mock.calls[0]!;
    expect(params.has("pair")).toBe(false);
    // Replace, not push: Back must not walk into the dead code either.
    expect(opts).toEqual({ replace: true });
    expect(search.current).toBe("");
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

describe("PairedDevices — the fragment the read-only strip links to", () => {
  // `read-only-banner.tsx` links to `/settings#paired-devices`. React Router navigates without a
  // document load, so the browser never resolves that fragment itself — this card has to. Settings
  // is a long page, and its top is the Theme card, several screens above the thing that was tapped.
  test("with the fragment it scrolls itself into view and takes focus", () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    hash.current = "#paired-devices";
    render(<PairedDevices data={PAIRED} />);

    const card = document.getElementById("paired-devices");
    expect(card).not.toBeNull();
    expect(scrollIntoView).toHaveBeenCalled();
    // Focus, not just scroll: a screen reader follows focus. tabIndex -1 keeps the card out of the
    // tab order while still letting it be focused programmatically.
    expect(document.activeElement).toBe(card);
    expect(card).toHaveAttribute("tabindex", "-1");
    scrollIntoView.mockRestore();
  });

  test("without the fragment it moves nothing", () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    render(<PairedDevices data={PAIRED} />);

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
    scrollIntoView.mockRestore();
  });
});
