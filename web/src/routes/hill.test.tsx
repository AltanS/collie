import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { __resetHill, __settleHill, syncHill } from "@/lib/hill/store";
import { asJsonString, parseJsonObject } from "@/lib/json";
import { withHeaderHost } from "@/test/header-host";
import { hillDecision, hillReceipt } from "@/test/hill-fixtures";
import { server } from "@/test/setup";

import { HillRoute } from "./hill";

// The route `/hill` (M96): the header with the count, the cards from the store, Back up to the
// Dashboard, and an answer that reaches the bridge and comes back as the card's receipt.

function renderHill(entry = "/hill") {
  const router = createMemoryRouter(
    [
      { path: "/hill", element: withHeaderHost(<HillRoute />) },
      { path: "/", element: <div data-testid="home" /> },
    ],
    { initialEntries: ["/", entry], initialIndex: 1 },
  );
  render(<RouterProvider router={router} />);
  return router;
}

async function hillHolds(open: ReturnType<typeof hillDecision>[]) {
  server.use(http.get("/api/hill", () => HttpResponse.json({ v: 1, rev: 1, open, closed: [] })));
  await act(async () => {
    syncHill(1);
    await __settleHill();
  });
}

beforeEach(() => __resetHill());
afterEach(() => __resetHill());

describe("the hill route", () => {
  it("shows the title and how many are open, and how many of them are Now", async () => {
    await hillHolds([hillDecision({ priority: "now" }), hillDecision(), hillDecision()]);
    renderHill();
    expect(await screen.findByRole("heading", { name: "Hill" })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="hill-count"]')).toHaveTextContent("3 open · 1 now");
    expect(document.querySelectorAll('[data-slot="decision-card"]')).toHaveLength(3);
  });

  it("shows the clear hill, and All clear in the count line, when nothing is open", async () => {
    renderHill();
    await screen.findByRole("heading", { name: "Hill" });
    expect(document.querySelector('[data-slot="hill-count"]')).toHaveTextContent("All clear");
    expect(document.querySelector('[data-slot="hill-empty"]')).toHaveTextContent("The hill is clear.");
  });

  it("goes back up to the Dashboard", async () => {
    const router = renderHill();
    await userEvent.click(await screen.findByRole("button", { name: "Back to the Dashboard" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("sends an answer and shows its receipt on the card", async () => {
    const decision = hillDecision();
    await hillHolds([decision]);
    let node = "";
    server.use(
      http.post("/api/hill/answer", async ({ request }) => {
        const body = parseJsonObject(await request.text()) ?? {};
        node = asJsonString(body.node) ?? "";
        return HttpResponse.json({ ...hillReceipt(), rid: asJsonString(body.rid) ?? "" });
      }),
    );
    renderHill();
    const option = await waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>('[data-slot="decision-option"][data-intent="no"]');
      if (el === null) throw new Error("no option yet");
      return el;
    });
    await userEvent.click(option);
    await waitFor(() => expect(document.querySelector('[data-slot="decision-receipt"]')).toHaveTextContent("Sent to collie lead"));
    expect(node).toBe(`hill/${decision.id}`);
  });
});
