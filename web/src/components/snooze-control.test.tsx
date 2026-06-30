import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { SnoozeControl } from "@/components/snooze-control";

// SnoozeControl calls useRevalidator() to refresh the snapshot after a change. Stub it (hoisted so
// the vi.mock factory can close over it) so the component renders bare, and assert it gets called.
const { revalidate } = vi.hoisted(() => ({ revalidate: vi.fn() }));
vi.mock("react-router", () => ({
  useRevalidator: () => ({ revalidate, state: "idle" }),
}));

let lastBody: { snoozedUntil: number | null } | undefined;
beforeEach(() => {
  revalidate.mockClear();
  lastBody = undefined;
  server.use(
    http.post("/api/notifications/snooze", async ({ request }) => {
      lastBody = (await request.json()) as { snoozedUntil: number | null };
      return HttpResponse.json(lastBody);
    }),
  );
});

describe("SnoozeControl", () => {
  test("offers presets when not snoozed and snoozes for a future deadline", async () => {
    const user = userEvent.setup();
    const before = Date.now();
    render(<SnoozeControl snoozedUntil={null} />);

    expect(screen.getByText(/pause all push/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "1h" }));

    await waitFor(() => expect(lastBody).toBeDefined());
    // ~1h in the future (allow a generous lower bound to avoid clock-flake).
    expect(lastBody!.snoozedUntil).toBeGreaterThan(before + 59 * 60_000);
    expect(revalidate).toHaveBeenCalled();
  });

  test("shows the deadline and resumes when snoozed", async () => {
    const user = userEvent.setup();
    render(<SnoozeControl snoozedUntil={Date.now() + 60 * 60_000} />);

    expect(screen.getByText(/snoozed until/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "1h" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /resume now/i }));

    await waitFor(() => expect(lastBody).toBeDefined());
    expect(lastBody!.snoozedUntil).toBeNull();
    expect(revalidate).toHaveBeenCalled();
  });
});
