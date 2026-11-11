import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { getDeviceToken, setDeviceToken } from "@/lib/pairing";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";

import { askerName, PairApproveRoute, PairApproveView, type PairApproveActions, type PairApproveState } from "./pair-approve";

// The approver's page (ADR 0139): each state of the pure view, then the route against a fake bridge.
// The rules it carries: an unpaired browser is offered nothing and reads nothing; the three codes are
// real buttons named by the code; there is no plain Yes; a tap sends the code and the name; a wrong
// tap and Not my device end the request.

const ID = "AbCdEfGhIjKlMnOpQrStUv";
const TOKEN = "tok-approver-0123456789abcdef";
const CHOICES = ["K7MP2Q", "D4XW9H", "R2TN6F"];

const OPEN: PairApproveState = {
  kind: "open",
  asker: "Chrome on Linux",
  route: "tailnet",
  choices: CHOICES,
  remainingMs: 94_000,
  name: "Chrome on Linux",
  nameError: false,
  busy: false,
};

function actions(): PairApproveActions {
  return { onPick: vi.fn(), onRefuse: vi.fn(), onName: vi.fn(), onRetry: vi.fn(), onDone: vi.fn() };
}

describe("PairApproveView, each state", () => {
  it("open: the question, the asker, the route, the countdown, the name, three code buttons and Not my device", async () => {
    const user = userEvent.setup();
    const a = actions();
    render(<PairApproveView state={OPEN} actions={a} />);
    expect(screen.getByRole("heading", { name: "Give this device access?" })).toBeInTheDocument();
    expect(screen.getByText("Chrome on Linux", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("Asks over your tailnet")).toBeInTheDocument();
    expect(screen.getByRole("timer")).toHaveTextContent("Ends in 1:34");
    expect(screen.getByRole("textbox", { name: "Name for the new device" })).toHaveValue("Chrome on Linux");
    const group = screen.getByRole("group", { name: "Tap the code that shows on the other screen." });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(CHOICES);
    for (const code of CHOICES) expect(within(group).getByRole("button", { name: code })).toBeEnabled();
    // No free Yes: the only buttons are the three codes and Not my device.
    expect(screen.getAllByRole("button")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: /yes|allow|approve/i })).toBeNull();

    await user.click(within(group).getByRole("button", { name: "D4XW9H" }));
    expect(a.onPick).toHaveBeenCalledWith("D4XW9H");
    await user.click(screen.getByRole("button", { name: "Not my device" }));
    expect(a.onRefuse).toHaveBeenCalledTimes(1);
  });

  it("open and busy: every answer waits", () => {
    render(<PairApproveView state={{ ...OPEN, busy: true }} actions={actions()} />);
    for (const b of screen.getAllByRole("button")) expect(b).toBeDisabled();
  });

  it("a refused name says what fits and marks the field", () => {
    render(<PairApproveView state={{ ...OPEN, name: "", nameError: true }} actions={actions()} />);
    const field = screen.getByRole("textbox", { name: "Name for the new device" });
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("Use 1 to 48 characters, with no hidden characters.");
  });

  it.each([
    [{ kind: "approved", label: "Chrome on Linux" } as const, "Chrome on Linux can now use Collie.", "Done"],
    [{ kind: "wrong-code" } as const, "That code does not match. Start again on the other device.", "Done"],
    [{ kind: "declined" } as const, "Done. That device was not let in.", "Done"],
    [{ kind: "gone" } as const, "This request has ended. Start again on the other device.", "Done"],
    [{ kind: "answered" } as const, "This request was already answered.", "Done"],
    [{ kind: "error" } as const, "Could not reach Collie. Try again.", "Try again"],
  ])("%j: the sentence and one way on", (state, line, action) => {
    render(<PairApproveView state={state} actions={actions()} />);
    expect(screen.getByRole("status")).toHaveTextContent(line);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([action]);
  });

  it.each([
    [{ kind: "not-paired" } as const, "This device is not paired. Only a paired device can let another one in."],
    [{ kind: "forbidden" } as const, "This device cannot let others in. It needs full access."],
  ])("%j: says so and offers nothing", (state, line) => {
    render(<PairApproveView state={state} actions={actions()} />);
    expect(screen.getByRole("status")).toHaveTextContent(line);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("loading: a spinner with a name", () => {
    render(<PairApproveView state={{ kind: "loading" }} actions={actions()} />);
    expect(screen.getByRole("img", { name: "Pair a device" })).toBeInTheDocument();
  });

  it("names the asker from whichever half the bridge knew", () => {
    expect(askerName("Chrome", "Linux")).toBe("Chrome on Linux");
    expect(askerName("Firefox", null)).toBe("Firefox");
    expect(askerName(null, "Android")).toBe("Android");
    expect(askerName(null, null)).toBeNull();
  });
});

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: "/", element: <p>Dashboard</p> },
      { path: "/pair/approve", element: withHeaderHost(<PairApproveRoute />) },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const OPEN_WIRE = {
  browser: "Chrome",
  os: "Linux",
  route: "loopback",
  forwardedFrom: "tailnet",
  choices: CHOICES,
  expiresAt: Date.now() + 94_000,
  expiresInMs: 94_000,
};

describe("PairApproveRoute against a bridge", () => {
  it("an unpaired browser is told so and reads nothing", async () => {
    const read = vi.fn();
    server.use(http.get("/api/pair/approve/:id", () => (read(), HttpResponse.json(OPEN_WIRE))));
    renderAt(`/pair/approve?r=${ID}`);
    expect(await screen.findByText(/This device is not paired/)).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("reads the request with this device's token, shows the route a front door passed on, and sends the tapped code with the name", async () => {
    setDeviceToken(TOKEN);
    const user = userEvent.setup();
    let auth: string | null = null;
    let sent: unknown;
    server.use(
      http.get("/api/pair/approve/:id", ({ request, params }) => {
        auth = request.headers.get("authorization");
        expect(params.id).toBe(ID);
        return HttpResponse.json(OPEN_WIRE);
      }),
      http.post("/api/pair/approve/:id", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ state: "approved", label: "desk" });
      }),
    );
    renderAt(`/pair/approve?r=${ID}`);
    const group = await screen.findByRole("group", { name: "Tap the code that shows on the other screen." });
    expect(auth).toBe(`Bearer ${TOKEN}`);
    expect(screen.getByText("Asks over your tailnet")).toBeInTheDocument();
    const name = screen.getByRole("textbox", { name: "Name for the new device" });
    await user.clear(name);
    await user.type(name, "  desk ");
    await user.click(within(group).getByRole("button", { name: "R2TN6F" }));
    expect(await screen.findByText("desk can now use Collie.")).toBeInTheDocument();
    expect(sent).toEqual({ code: "R2TN6F", label: "desk" });
    // The approver keeps its own token; it is never handed the new one.
    expect(getDeviceToken()).toBe(TOKEN);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("Dashboard")).toBeInTheDocument();
  });

  it("a wrong code ends it with the bridge's word", async () => {
    setDeviceToken(TOKEN);
    const user = userEvent.setup();
    server.use(
      http.get("/api/pair/approve/:id", () => HttpResponse.json(OPEN_WIRE)),
      http.post("/api/pair/approve/:id", () => HttpResponse.json({ state: "refused", reason: "wrong-code" })),
    );
    renderAt(`/pair/approve?r=${ID}`);
    await user.click(await screen.findByRole("button", { name: "K7MP2Q" }));
    expect(await screen.findByText("That code does not match. Start again on the other device.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "K7MP2Q" })).toBeNull();
  });

  it("Not my device sends a refusal and nothing else", async () => {
    setDeviceToken(TOKEN);
    const user = userEvent.setup();
    let sent: unknown;
    server.use(
      http.get("/api/pair/approve/:id", () => HttpResponse.json(OPEN_WIRE)),
      http.post("/api/pair/approve/:id", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ state: "refused", reason: "refused" });
      }),
    );
    renderAt(`/pair/approve?r=${ID}`);
    await user.click(await screen.findByRole("button", { name: "Not my device" }));
    expect(await screen.findByText("Done. That device was not let in.")).toBeInTheDocument();
    expect(sent).toEqual({ refuse: true });
  });

  it("a blank name is refused here, before anything is sent", async () => {
    setDeviceToken(TOKEN);
    const user = userEvent.setup();
    const answer = vi.fn();
    server.use(
      http.get("/api/pair/approve/:id", () => HttpResponse.json(OPEN_WIRE)),
      http.post("/api/pair/approve/:id", () => (answer(), HttpResponse.json({ state: "approved", label: "x" }))),
    );
    renderAt(`/pair/approve?r=${ID}`);
    await user.clear(await screen.findByRole("textbox", { name: "Name for the new device" }));
    await user.click(screen.getByRole("button", { name: "K7MP2Q" }));
    expect(screen.getByText("Use 1 to 48 characters, with no hidden characters.")).toBeInTheDocument();
    expect(answer).not.toHaveBeenCalled();
  });

  it("a name the bridge refuses keeps the request open, with the field marked", async () => {
    setDeviceToken(TOKEN);
    const user = userEvent.setup();
    server.use(
      http.get("/api/pair/approve/:id", () => HttpResponse.json(OPEN_WIRE)),
      http.post("/api/pair/approve/:id", () => HttpResponse.json({ error: "bad-label" }, { status: 400 })),
    );
    renderAt(`/pair/approve?r=${ID}`);
    await user.click(await screen.findByRole("button", { name: "K7MP2Q" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name for the new device" })).toHaveAttribute("aria-invalid", "true"));
    expect(screen.getByRole("button", { name: "K7MP2Q" })).toBeEnabled();
  });

  it.each([
    [404, () => HttpResponse.json({ error: "gone" }, { status: 404 }), "This request has ended. Start again on the other device."],
    [409, () => HttpResponse.json({ error: "answered" }, { status: 409 }), "This request was already answered."],
    [403, () => new HttpResponse("device not authorised", { status: 403 }), "This device cannot let others in. It needs full access."],
  ])("a %i on the read shows its own state", async (_status, reply, line) => {
    setDeviceToken(TOKEN);
    server.use(http.get("/api/pair/approve/:id", reply));
    renderAt(`/pair/approve?r=${ID}`);
    expect(await screen.findByText(line)).toBeInTheDocument();
  });

  it("a token the bridge no longer knows ends this browser's pairing and offers nothing", async () => {
    setDeviceToken(TOKEN);
    server.use(http.get("/api/pair/approve/:id", () => new HttpResponse("device not paired", { status: 403 })));
    renderAt(`/pair/approve?r=${ID}`);
    expect(await screen.findByText(/This device is not paired/)).toBeInTheDocument();
  });

  it("a link with no request id says the request has ended", async () => {
    setDeviceToken(TOKEN);
    renderAt("/pair/approve");
    expect(await screen.findByText("This request has ended. Start again on the other device.")).toBeInTheDocument();
  });
});
