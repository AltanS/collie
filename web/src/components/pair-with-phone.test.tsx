import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { approveLink, clockOf, PairWithPhone, PairWithPhoneView, type PairPhoneState } from "@/components/pair-with-phone";
import { resetBasePathForTests } from "@/lib/base-path";
import { getDeviceToken } from "@/lib/pairing";

// The new device's block (ADR 0139): each state of the pure view, then the container against a fake
// bridge: the request, the QR link, the poll with its secret in a header, and every way it ends.

const NOOP = () => {};
const ID = "AbCdEfGhIjKlMnOpQrStUv";
const SECRET = "SeCrEtSeCrEtSeCrEtSeCr";

function view(state: PairPhoneState) {
  return render(<PairWithPhoneView state={state} onStart={NOOP} onCancel={NOOP} />);
}

afterEach(() => {
  document.head.querySelector('meta[name="collie-base"]')?.remove();
  resetBasePathForTests();
});

describe("PairWithPhoneView, each state", () => {
  it("idle: names the block and offers one button", () => {
    view({ kind: "idle" });
    expect(screen.getByRole("heading", { name: "Pair this device with your phone" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pair with your phone" })).toBeEnabled();
  });

  it("starting: the button waits", () => {
    view({ kind: "starting" });
    expect(screen.getByRole("button", { name: "Pair with your phone" })).toBeDisabled();
  });

  it("waiting: the QR, the code in large type, the countdown and Cancel", () => {
    view({ kind: "waiting", code: "K7MP2Q", link: "https://collie.example/pair/approve?r=x", remainingMs: 94_000 });
    const qr = screen.getByRole("img", { name: "QR code for your phone" });
    expect(qr.tagName.toLowerCase()).toBe("svg");
    expect(qr.getAttribute("viewBox")).toMatch(/^0 0 \d+ \d+$/);
    expect(qr.querySelector("path")?.getAttribute("fill")).toBe("currentColor");
    expect(screen.getByText("K7MP2Q")).toHaveClass("text-4xl");
    expect(screen.getByRole("timer")).toHaveTextContent("Ends in 1:34");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("approved: says so while the page reloads", () => {
    view({ kind: "approved", label: "Chrome on Linux" });
    expect(screen.getByRole("status")).toHaveTextContent("Paired as Chrome on Linux. Opening Collie.");
  });

  it.each([
    [{ kind: "refused" } as const, "The phone did not let this device in.", "Show a new code"],
    [{ kind: "expired" } as const, "The code ran out.", "Show a new code"],
    [{ kind: "rate-limited", retryAfterSeconds: 312 } as const, "Too many codes. Try again in 5:12.", "Try again"],
    [{ kind: "error" } as const, "Could not reach Collie. Try again.", "Try again"],
  ])("%j: the sentence and the way on", (state, line, action) => {
    view(state);
    expect(screen.getByRole("status")).toHaveTextContent(line);
    expect(screen.getByRole("button", { name: action })).toBeInTheDocument();
  });

  it("no paired device: names `collie pair`, literal, and offers no button", () => {
    view({ kind: "no-approver" });
    expect(screen.getByText("collie pair").tagName.toLowerCase()).toBe("code");
    expect(screen.getByText(/No device is paired yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("refused before pairing: says a phone cannot fix it, and offers no button", () => {
    view({ kind: "refused-before" });
    expect(screen.getByText("Collie refuses this browser before pairing. A phone cannot fix that.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("spells the clock as m:ss and never below zero", () => {
    expect(clockOf(120_000)).toBe("2:00");
    expect(clockOf(61_001)).toBe("1:02");
    expect(clockOf(9_000)).toBe("0:09");
    expect(clockOf(-5)).toBe("0:00");
  });
});

describe("the QR link", () => {
  it("is this origin, the app's mount and the approver path with the public id alone", () => {
    expect(approveLink(ID)).toBe(`${window.location.origin}/pair/approve?r=${ID}`);
    const meta = document.createElement("meta");
    meta.name = "collie-base";
    meta.content = "/collie/";
    document.head.append(meta);
    resetBasePathForTests();
    expect(approveLink(ID)).toBe(`${window.location.origin}/collie/pair/approve?r=${ID}`);
  });
});

/** A fake bridge: one request, then the poll answers from `polls` in turn (the last one repeats). */
function bridge(polls: readonly (() => Response)[], cancels: { url: string; header: string | null }[] = []) {
  const seen: { url: string; header: string | null }[] = [];
  let n = 0;
  server.use(
    http.post("/api/pair/request", () =>
      HttpResponse.json({ publicId: ID, pollSecret: SECRET, code: "K7MP2Q", expiresAt: Date.now() + 120_000, expiresInMs: 120_000 }),
    ),
    http.get("/api/pair/request/:id", ({ request }) => {
      seen.push({ url: request.url, header: request.headers.get("x-collie-pair-poll") });
      const answer = polls[Math.min(n, polls.length - 1)]!;
      n++;
      return answer();
    }),
    http.delete("/api/pair/request/:id", ({ request }) => {
      cancels.push({ url: request.url, header: request.headers.get("x-collie-pair-poll") });
      return HttpResponse.json({ state: "cancelled" });
    }),
  );
  return seen;
}

const WAITING = () => HttpResponse.json({ state: "waiting", expiresInMs: 100_000 });

describe("PairWithPhone against a bridge", () => {
  it("shows the code and QR, polls with the secret in a header, then stores the token once and reloads", async () => {
    const user = userEvent.setup();
    const onPaired = vi.fn();
    const seen = bridge([WAITING, () => HttpResponse.json({ state: "approved", token: "tok-new-device", label: "Chrome on Linux" })]);
    const { container } = render(<PairWithPhone onPaired={onPaired} pollMs={10} />);

    await user.click(screen.getByRole("button", { name: "Pair with your phone" }));
    expect(await screen.findByText("K7MP2Q")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "QR code for your phone" })).toBeInTheDocument();

    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
    expect(getDeviceToken()).toBe("tok-new-device");
    expect(screen.getByRole("status")).toHaveTextContent("Paired as Chrome on Linux.");

    // The secret rode the header and never the URL; the id is the only thing in the path.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const call of seen) {
      expect(call.header).toBe(SECRET);
      expect(call.url).toContain(`/api/pair/request/${ID}`);
      expect(call.url).not.toContain(SECRET);
    }
    // And it is kept in memory only: not in storage, not in the page.
    expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(SECRET);
    expect(container.innerHTML).not.toContain(SECRET);
    // Polling stopped with the answer.
    const after = seen.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(seen.length).toBe(after);
  });

  it("a refusal ends it; Show a new code asks again", async () => {
    const user = userEvent.setup();
    bridge([() => HttpResponse.json({ state: "refused" })]);
    render(<PairWithPhone onPaired={NOOP} pollMs={10} />);
    await user.click(screen.getByRole("button", { name: "Pair with your phone" }));
    expect(await screen.findByText("The phone did not let this device in.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show a new code" }));
    expect(await screen.findByText("K7MP2Q")).toBeInTheDocument();
  });

  it("an id the bridge no longer knows reads as expired", async () => {
    const user = userEvent.setup();
    bridge([() => HttpResponse.json({ error: "not found" }, { status: 404 })]);
    render(<PairWithPhone onPaired={NOOP} pollMs={10} />);
    await user.click(screen.getByRole("button", { name: "Pair with your phone" }));
    expect(await screen.findByText("The code ran out.")).toBeInTheDocument();
  });

  it("Cancel ends the request on the bridge with the secret in a header, and stops the poll", async () => {
    const user = userEvent.setup();
    const cancels: { url: string; header: string | null }[] = [];
    const seen = bridge([WAITING], cancels);
    render(<PairWithPhone onPaired={NOOP} pollMs={10} />);
    await user.click(screen.getByRole("button", { name: "Pair with your phone" }));
    await screen.findByText("K7MP2Q");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Pair with your phone" })).toBeInTheDocument();
    await waitFor(() => expect(cancels).toHaveLength(1));
    expect(cancels[0]!.header).toBe(SECRET);
    expect(cancels[0]!.url).toContain(`/api/pair/request/${ID}`);
    expect(cancels[0]!.url).not.toContain(SECRET);
    const after = seen.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(seen.length).toBe(after);
  });

  it("leaving the screen ends the open request too", async () => {
    const user = userEvent.setup();
    const cancels: { url: string; header: string | null }[] = [];
    bridge([WAITING], cancels);
    const { unmount } = render(<PairWithPhone onPaired={NOOP} pollMs={10} />);
    await user.click(screen.getByRole("button", { name: "Pair with your phone" }));
    await screen.findByText("K7MP2Q");
    unmount();
    await waitFor(() => expect(cancels).toHaveLength(1));
    expect(cancels[0]!.header).toBe(SECRET);
  });

  it("an answered request is not cancelled when the block goes away", async () => {
    const user = userEvent.setup();
    const cancels: { url: string; header: string | null }[] = [];
    bridge([() => HttpResponse.json({ state: "approved", token: "tok-new-device", label: "desk" })], cancels);
    const onPaired = vi.fn();
    const { unmount } = render(<PairWithPhone onPaired={onPaired} pollMs={10} />);
    await user.click(screen.getByRole("button", { name: "Pair with your phone" }));
    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
    unmount();
    await new Promise((r) => setTimeout(r, 30));
    expect(cancels).toEqual([]);
  });

  it.each([
    [409, { error: "no-approver" }, "No device is paired yet"],
    [429, { error: "rate-limited", retryAfter: 90 }, "Too many codes. Try again in 1:30."],
  ])("a %i on the request shows its own state", async (status, body, line) => {
    const user = userEvent.setup();
    server.use(http.post("/api/pair/request", () => HttpResponse.json(body, { status })));
    render(<PairWithPhone onPaired={NOOP} />);
    await user.click(screen.getByRole("button", { name: "Pair with your phone" }));
    expect(await screen.findByText(new RegExp(line.replace(/[.?]/g, "\\$&")))).toBeInTheDocument();
  });

  it("a 403 from the access check says pairing cannot fix it", async () => {
    const user = userEvent.setup();
    server.use(http.post("/api/pair/request", () => new HttpResponse("identity required", { status: 403 })));
    render(<PairWithPhone onPaired={NOOP} />);
    await user.click(screen.getByRole("button", { name: "Pair with your phone" }));
    expect(await screen.findByText(/A phone cannot fix that/)).toBeInTheDocument();
  });

  it("an unreachable bridge says so and offers Try again", async () => {
    const user = userEvent.setup();
    server.use(http.post("/api/pair/request", () => HttpResponse.error()));
    render(<PairWithPhone onPaired={NOOP} />);
    await user.click(screen.getByRole("button", { name: "Pair with your phone" }));
    const status = await screen.findByRole("status");
    expect(within(status).getByText("Could not reach Collie. Try again.")).toBeInTheDocument();
  });
});
