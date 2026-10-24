import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ComponentProps } from "react";

import type { JsonValue } from "@/lib/json";
import { markLive, resetLiveness } from "@/lib/liveness";
import { clearStatus } from "@/lib/status";
import { server } from "@/test/setup";
import { wayOutCase } from "@/test/way-out-states";
import type { WayOutState } from "@/lib/way-out";
import type { Surface } from "@/lib/surface/surface";
import { CLEAR_NOTE_MS, Composer } from "./composer";

// ADR 0116, the Clear paragraph: the Keys board's Clear button empties the harness's box in one tap. It is
// offered only while the Surface reads a draft and no dialog, and the link is up; the tap posts one request
// id to `/api/pane/:id/clear`. The receipt floats above the belt with the other floating notices (ADR 0061), so
// it moves neither the composer nor the belt; a `cleared` receipt that carries the cleared text offers Restore.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
});
afterEach(() => cleanup());

const PANE = "w1:p1";

/** The Surface the mounted composer reads; tests move it the way the next poll would. */
let moveSurface: (next: Surface) => void = () => undefined;

function mount(state: WayOutState) {
  const c = wayOutCase(state);
  function Pane(props: ComponentProps<typeof Composer>) {
    const [surface, setSurface] = useState(props.surface);
    moveSurface = setSurface;
    return <Composer {...props} surface={surface} />;
  }
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
  const router = createMemoryRouter([{ path: "/", element: <Pane {...props} /> }]);
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

  it("one tap, no arm: posts one fresh request id alone and floats the receipt above the belt", async () => {
    const user = userEvent.setup();
    const posted = serveClear({ requestId: "echo-0001", outcome: "cleared" });
    mount("draft");
    await user.click(await openKeys(user));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ requestId: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/) });
    const said = await screen.findByText("Box cleared.");
    // In the floating group, not the send notice in the composer's flow: nothing moves.
    expect(said.closest("[data-slot='floating-cards']")).not.toBeNull();
    expect(document.querySelector("[data-slot='composer-refusal']")).toBeNull();
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

/** The keys route's posts, by body. */
function serveKeys(ok = true) {
  const posted: JsonValue[] = [];
  server.use(
    http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
      // SAFETY: the phone's own JSON.stringify body is JSON, a JsonValue.
      posted.push((await request.json()) as JsonValue);
      return HttpResponse.json(ok ? { ok: true } : { ok: false, error: "refused", code: "keys.send_failed" });
    }),
  );
  return posted;
}

const DRAFT = "a long thought\nwith a break";
const FREE = wayOutCase("free").surface;
const DRAFTED = wayOutCase("draft").surface;

describe("Restore after a Clear", () => {
  async function clearIt(user: ReturnType<typeof userEvent.setup>, receipt: JsonValue = { requestId: "echo-0001", outcome: "cleared", draft: DRAFT }) {
    serveClear(receipt);
    mount("draft");
    await user.click(await openKeys(user));
    await screen.findByText("Box cleared.");
  }
  const restore = () => screen.queryByRole("button", { name: "Type the cleared text back into the box" });

  it("is offered beside the notice once a read shows the box empty, with a 44px reach", async () => {
    const user = userEvent.setup();
    await clearIt(user);
    // The read from before the Clear still shows the draft: no Restore onto it yet.
    expect(restore()).toBeNull();
    act(() => moveSurface({ ...FREE, revision: 3 }));
    const button = await screen.findByRole("button", { name: "Type the cleared text back into the box" });
    expect(button).toHaveTextContent("Restore");
    const card = button.closest<HTMLElement>("[data-slot='clear-notice']");
    expect(card).not.toBeNull();
    expect(within(card!).getByText("Box cleared.")).toBeInTheDocument();
    expect(button.className).toContain("before:-inset-y-[11px]");
  });

  it("types the text back through the keys route as a person's taps, with no Enter, once", async () => {
    const user = userEvent.setup();
    const keys = serveKeys();
    await clearIt(user);
    act(() => moveSurface({ ...FREE, revision: 3 }));
    await user.click(await screen.findByRole("button", { name: "Type the cleared text back into the box" }));
    await waitFor(() => expect(keys).toHaveLength(1));
    expect(keys[0]).toEqual({ keys: expect.any(Array) });
    // SAFETY: the line above checked the body is `{ keys: [...] }`; the phone sends key strings only.
    const sent = (keys[0] as { keys: string[] }).keys;
    expect(sent.join("")).toBe("aSpacelongSpacethoughtSpacewithSpaceaSpacebreak");
    expect(sent).not.toContain("Enter");
    // One Restore per Clear: the notice and its offer are gone.
    await waitFor(() => expect(screen.queryByText("Box cleared.")).toBeNull());
    expect(restore()).toBeNull();
  });

  it("is not offered for a receipt with no text, a refusal, or while a dialog is up", async () => {
    const user = userEvent.setup();
    await clearIt(user, { requestId: "echo-0001", outcome: "cleared" });
    act(() => moveSurface({ ...FREE, revision: 3 }));
    expect(restore()).toBeNull();
    cleanup();
    await clearIt(user);
    act(() => moveSurface(wayOutCase("ask").surface));
    expect(restore()).toBeNull();
  });

  it("ends when a read after the Clear shows a draft in the box again", async () => {
    const user = userEvent.setup();
    await clearIt(user);
    act(() => moveSurface({ ...FREE, revision: 3 }));
    await screen.findByRole("button", { name: "Type the cleared text back into the box" });
    act(() => moveSurface({ ...DRAFTED, revision: 4 }));
    await waitFor(() => expect(screen.queryByText("Box cleared.")).toBeNull());
    expect(restore()).toBeNull();
  });

  it("ends after two minutes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await clearIt(user);
      act(() => moveSurface({ ...FREE, revision: 3 }));
      await screen.findByRole("button", { name: "Type the cleared text back into the box" });
      act(() => {
        vi.advanceTimersByTime(CLEAR_NOTE_MS + 10);
      });
      expect(screen.queryByText("Box cleared.")).toBeNull();
      expect(restore()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a refusal from the keys route gives the offer back, since nothing was typed", async () => {
    const user = userEvent.setup();
    serveKeys(false);
    await clearIt(user);
    act(() => moveSurface({ ...FREE, revision: 3 }));
    await user.click(await screen.findByRole("button", { name: "Type the cleared text back into the box" }));
    expect(await screen.findByRole("button", { name: "Type the cleared text back into the box" })).toBeEnabled();
  });
});
