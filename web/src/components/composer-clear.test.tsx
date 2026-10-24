import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ComponentProps } from "react";

import type { JsonValue } from "@/lib/json";
import { markLive, resetLiveness } from "@/lib/liveness";
import { clearStatus } from "@/lib/status";
import { server } from "@/test/setup";
import { wayOutCase } from "@/test/way-out-states";
import type { WayOutState } from "@/lib/way-out";
import { Composer } from "./composer";

// ADR 0116, the Clear paragraph: the Keys board's Clear button empties the harness's box in one tap. It is
// offered only while the Surface reads a draft and no dialog, and the link is up; the tap posts one request
// id to `/api/pane/:id/clear` and the receipt shows under the box, in the notice a Stop and a send's refusal use.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
});
afterEach(() => cleanup());

const PANE = "w1:p1";

function mount(state: WayOutState) {
  const c = wayOutCase(state);
  if (!c.offline) markLive(PANE, Date.now() - c.readAgeMs);
  const props: ComponentProps<typeof Composer> = {
    paneId: PANE,
    agent: "claude",
    isShell: false,
    gone: c.gone,
    readOnly: c.readOnly,
    surface: c.surface,
    unreachableNote: c.unreachableNote,
    stale: c.offline,
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false },
    display: { open: false, onToggle: () => undefined },
    onSent: () => undefined,
    screen: { on: false, onToggle: () => undefined },
  };
  const router = createMemoryRouter([{ path: "/", element: <Composer {...props} /> }]);
  return render(<RouterProvider router={router} />);
}

function serveClear(receipt: JsonValue, status = 200, hold?: Promise<void>) {
  const posted: JsonValue[] = [];
  server.use(
    http.post(/\/api\/pane\/[^/]+\/clear$/, async ({ request }) => {
      // SAFETY: the phone's own JSON.stringify body is JSON, a JsonValue.
      posted.push((await request.json()) as JsonValue);
      if (hold !== undefined) await hold;
      return HttpResponse.json(receipt, { status });
    }),
  );
  return posted;
}

const openKeys = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Keys" }));
  return screen.getByRole("button", { name: "Clear the input box" });
};

describe("the Keys board's Clear button", () => {
  it("is greyed in place when the box reads empty, and a tap posts nothing", async () => {
    const user = userEvent.setup();
    const posted = serveClear({ requestId: "echo-0001", outcome: "cleared" });
    mount("free");
    const clear = await openKeys(user);
    expect(clear).toBeDisabled();
    await user.click(clear);
    expect(posted).toHaveLength(0);
  });

  it("is greyed while a dialog owns the keys, and while the link is down", async () => {
    const user = userEvent.setup();
    mount("ask");
    expect(await openKeys(user)).toBeDisabled();
    cleanup();
    mount("offline");
    expect(await openKeys(user)).toBeDisabled();
  });

  it("is enabled when the box holds a draft, shows its word and reaches 44px", async () => {
    const user = userEvent.setup();
    mount("draft");
    const clear = await openKeys(user);
    expect(clear).toBeEnabled();
    expect(clear).toHaveTextContent("Clear");
    // 36px drawn, 4px of reach above and below: 44px to tap.
    expect(clear).toHaveClass("h-9");
    expect(clear.className).toContain("before:-inset-y-[4px]");
  });

  it("one tap, no arm: posts one fresh request id alone and tells the receipt under the box", async () => {
    const user = userEvent.setup();
    const posted = serveClear({ requestId: "echo-0001", outcome: "cleared" });
    mount("draft");
    await user.click(await openKeys(user));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ requestId: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/) });
    expect(await screen.findByText("Box cleared.")).toBeInTheDocument();
  });

  it("takes no second tap while the request is in flight", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const posted = serveClear({ requestId: "echo-0001", outcome: "cleared" }, 200, held);
    mount("draft");
    const clear = await openKeys(user);
    await user.click(clear);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(clear).toBeDisabled();
    await user.click(clear);
    release();
    expect(await screen.findByText("Box cleared.")).toBeInTheDocument();
    expect(posted).toHaveLength(1);
  });

  it("tells a refusal in its own words", async () => {
    const user = userEvent.setup();
    serveClear({ requestId: "echo-0002", outcome: "refused", reason: "press_failed" });
    mount("draft");
    await user.click(await openKeys(user));
    expect(await screen.findByText("The box did not clear. What is left was not touched.")).toBeInTheDocument();
  });

  it("says an older machine cannot clear yet when its route answers a bare 404", async () => {
    const user = userEvent.setup();
    server.use(http.post(/\/api\/pane\/[^/]+\/clear$/, () => HttpResponse.json({ error: "not found" }, { status: 404 })));
    mount("draft");
    await user.click(await openKeys(user));
    expect(await screen.findByText("This machine cannot clear from the phone yet. Update it.")).toBeInTheDocument();
  });

  it("says the answer was lost when the lead timed out (504): the box may have cleared", async () => {
    const user = userEvent.setup();
    serveClear({ code: "write_outcome_unknown", error: "no answer" }, 504);
    mount("draft");
    await user.click(await openKeys(user));
    expect(await screen.findByText("No answer came back. The box may have cleared. Check the pane before you tap Clear again.")).toBeInTheDocument();
  });
});
