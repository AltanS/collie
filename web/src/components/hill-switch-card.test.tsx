import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { HillSwitchCard, HillSwitchControl } from "@/components/hill-switch-card";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { clearStatus, currentStatus } from "@/lib/status";
import { server } from "@/test/setup";

// Settings → Alerts → The Hill (bridge/hill/switch.ts): one row, drawn from the snapshot's `hillOff`
// in the root data, a tap that writes `POST /api/hill/switch` and reads the snapshot again, and a
// refusal that puts the switch back and says so.

/** The row under a root route whose loader answers `data`, which a test may change before a revalidation. */
function renderRow(first: Partial<HomeData>) {
  const holder = { data: first };
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", loader: () => holder.data, element: <HillSwitchControl /> }], { initialEntries: ["/"] });
  render(<RouterProvider router={router} />);
  return holder;
}

afterEach(() => clearStatus());

describe("the Hill's row in Settings", () => {
  it("names the switch and says what off does, in one row", () => {
    render(<HillSwitchCard on disabled={false} onToggle={() => {}} />);
    expect(screen.getByText("The Hill")).toBeInTheDocument();
    expect(screen.getByText("Agents and tricks ask you here. Off: they cannot post, and the Hill leaves the bar.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "The Hill" })).toBeChecked();
  });

  it("reads on when the snapshot carries no hillOff", async () => {
    renderRow({});
    expect(await screen.findByRole("switch", { name: "The Hill" })).toBeChecked();
  });

  it("a tap off writes { on: false }, holds the position, and the read snapshot agrees", async () => {
    let posted = "";
    server.use(
      http.post("/api/hill/switch", async ({ request }) => {
        posted = await request.text();
        return HttpResponse.json({ on: false });
      }),
    );
    const holder = renderRow({});
    const sw = await screen.findByRole("switch", { name: "The Hill" });
    holder.data = { hillOff: true };
    await userEvent.click(sw);
    await waitFor(() => expect(posted).toBe('{"on":false}'));
    await waitFor(() => expect(screen.getByRole("switch", { name: "The Hill" })).not.toBeChecked());
  });

  it("starts off with hillOff, and a tap on writes { on: true }", async () => {
    let posted = "";
    server.use(
      http.post("/api/hill/switch", async ({ request }) => {
        posted = await request.text();
        return HttpResponse.json({ on: true });
      }),
    );
    const holder = renderRow({ hillOff: true });
    const sw = await screen.findByRole("switch", { name: "The Hill" });
    expect(sw).not.toBeChecked();
    holder.data = {};
    await userEvent.click(sw);
    await waitFor(() => expect(posted).toBe('{"on":true}'));
    await waitFor(() => expect(screen.getByRole("switch", { name: "The Hill" })).toBeChecked());
  });

  it("a refused write puts the switch back and says so on the status line", async () => {
    server.use(http.post("/api/hill/switch", () => new HttpResponse("the Hill's switch could not be saved on this machine; nothing changed", { status: 503 })));
    renderRow({});
    await userEvent.click(await screen.findByRole("switch", { name: "The Hill" }));
    await waitFor(() => expect(currentStatus()).toMatchObject({ text: "Could not switch the Hill. Try again.", tone: "error" }));
    expect(screen.getByRole("switch", { name: "The Hill" })).toBeChecked();
  });

  it("a device that may only read sees the switch, disabled", async () => {
    renderRow({ device: { enforced: true, device: "tablet", authorized: false } });
    expect(await screen.findByRole("switch", { name: "The Hill" })).toBeDisabled();
  });
});
