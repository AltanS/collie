import type { ComponentProps } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { clearStatus, useStatus } from "@/lib/status";
import { server } from "@/test/setup";
import { Composer } from "./composer";

// Composer owns the send flow (draft → api.sendReply → clear/error) plus the destructive-command
// two-tap guard. It uses useRevalidator, so it needs a data router like AgentChat's tests.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => clearStatus());

function renderComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1",
    agent: "claude",
    isShell: false,
    gone: false,
    readOnly: false,
    text: "pane output",
    terminalDraft: null,
    prefs: { wrap: true, fontSize: 11, rawTerminal: false },
    setWrap: vi.fn(),
    stepFontSize: vi.fn(),
    setRawTerminal: vi.fn(),
    onSent: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: <Composer {...props} /> }]);
  render(<RouterProvider router={router} />);
  return props;
}

function StatusSentinel() {
  const status = useStatus();
  return <div data-testid="status">{status?.text ?? ""}</div>;
}

describe("Composer — send", () => {
  it("sends non-destructive input on the first tap and clears the draft", async () => {
    const user = userEvent.setup();
    const props = renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "looks good");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(box).toHaveValue(""));
    expect(props.onSent).toHaveBeenCalled();
  });

  it("clears the terminal line with ctrl+k and backspaces before sendReply when a draft is stranded", async () => {
    const user = userEvent.setup();
    const callOrder: string[] = [];
    let sentKeys: string[] | null = null;
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        const body = (await request.json()) as { keys: string[] };
        sentKeys = body.keys;
        callOrder.push("keys");
        return HttpResponse.json({ ok: true });
      }),
      http.post(/\/api\/pane\/[^/]+\/reply$/, async () => {
        callOrder.push("reply");
        return HttpResponse.json({ ok: true });
      }),
    );
    renderComposer({ terminalDraft: "leftover" });
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "new message");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(callOrder).toEqual(["keys", "reply"]));
    expect(sentKeys![0]).toBe("ctrl+k");
    expect(sentKeys).toHaveLength([..."leftover"].length + 9);
    expect(sentKeys!.slice(1).every((k) => k === "Backspace")).toBe(true);
  });

  it("does not call keys before reply when terminalDraft is null", async () => {
    const user = userEvent.setup();
    const callOrder: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async () => {
        callOrder.push("keys");
        return HttpResponse.json({ ok: true });
      }),
      http.post(/\/api\/pane\/[^/]+\/reply$/, async () => {
        callOrder.push("reply");
        return HttpResponse.json({ ok: true });
      }),
    );
    renderComposer({ terminalDraft: null });
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(callOrder).toEqual(["reply"]));
  });

  it("sequential sends with no stranded draft do not call keys before reply", async () => {
    const user = userEvent.setup();
    const callLog: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async () => {
        callLog.push("keys");
        return HttpResponse.json({ ok: true });
      }),
      http.post(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        const body = (await request.json()) as { text: string };
        callLog.push(`reply:${body.text}`);
        return HttpResponse.json({ ok: true });
      }),
    );
    renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "first");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callLog).toContain("reply:first"));

    await user.type(box, "second");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callLog).toContain("reply:second"));

    expect(callLog.filter((e) => e.startsWith("reply:"))).toEqual(["reply:first", "reply:second"]);
    expect(callLog).not.toContain("keys");
  });

  it("keeps the draft and shows the partial-failure message when textDelivered is true", async () => {
    const user = userEvent.setup();
    const partialError = "typed into the pane but not submitted — check the pane before resending";
    server.use(
      http.post(/\/api\/pane\/[^/]+\/reply$/, () =>
        HttpResponse.json({ ok: false, textDelivered: true, error: partialError }),
      ),
    );
    const props: ComponentProps<typeof Composer> = {
      paneId: "w1:p1",
      agent: "claude",
      isShell: false,
      gone: false,
      readOnly: false,
      text: "pane output",
      terminalDraft: null,
      prefs: { wrap: true, fontSize: 11, rawTerminal: false },
      setWrap: vi.fn(),
      stepFontSize: vi.fn(),
      setRawTerminal: vi.fn(),
      onSent: vi.fn(),
    };
    const router = createMemoryRouter([
      {
        path: "/",
        element: (
          <>
            <StatusSentinel />
            <Composer {...props} />
          </>
        ),
      },
    ]);
    render(<RouterProvider router={router} />);
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "almost sent");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(box).toHaveValue("almost sent"));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent(partialError));
    expect(props.onSent).not.toHaveBeenCalled();
  });
});

describe("Composer — destructive-input confirm", () => {
  it("holds a destructive command for a second tap, then sends", async () => {
    const user = userEvent.setup();
    const props = renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "rm -rf node_modules");

    // First tap: the Send button flips to a "Really send?" confirm — nothing is sent yet.
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByRole("button", { name: /really send/i })).toBeInTheDocument();
    expect(box).toHaveValue("rm -rf node_modules"); // draft kept
    expect(props.onSent).not.toHaveBeenCalled();

    // Second tap confirms: now it actually sends and clears.
    await user.click(screen.getByRole("button", { name: /really send/i }));
    await waitFor(() => expect(box).toHaveValue(""));
    expect(props.onSent).toHaveBeenCalled();
  });

  it("does not arm the confirm for innocent input", async () => {
    const user = userEvent.setup();
    renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "run the sudoku solver"); // "sudo" look-alike must not trip the guard
    await user.click(screen.getByRole("button", { name: "Send" }));

    // Sent straight away — no "Really send?" ever appeared, and the draft cleared.
    expect(screen.queryByRole("button", { name: /really send/i })).not.toBeInTheDocument();
    await waitFor(() => expect(box).toHaveValue(""));
  });
});

describe("Composer — terminal-draft recovery chip", () => {
  it("does not render the chip when there's no stranded draft", () => {
    renderComposer({ terminalDraft: null });
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();
  });

  it("recovers the draft: clears the terminal line with backspaces and populates the textarea", async () => {
    const user = userEvent.setup();
    let sentKeys: string[] | null = null;
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        const body = (await request.json()) as { keys: string[] };
        sentKeys = body.keys;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderComposer({ terminalDraft: "recover me" });

    // The chip surfaces the stranded draft with its recovery affordance.
    expect(screen.getByText(/draft in terminal/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /edit here/i }));

    // One Backspace per code point plus the 8-key overshoot clears the "❯" line.
    await waitFor(() => expect(sentKeys).not.toBeNull());
    expect(sentKeys).toHaveLength([..."recover me"].length + 8);
    expect(sentKeys!.every((k) => k === "Backspace")).toBe(true);

    // …and the draft lands in the composer for editing, with the chip gone.
    const box = screen.getByPlaceholderText(/type a reply/i);
    await waitFor(() => expect(box).toHaveValue("recover me"));
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();
  });

  it("dismiss hides the chip for that draft", async () => {
    const user = userEvent.setup();
    renderComposer({ terminalDraft: "dismiss me" });
    expect(screen.getByText(/draft in terminal/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /dismiss terminal draft/i }));
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();
  });
});

describe("Composer — quick keys / image attach", () => {
  it("shows the attach button on the reply-input row without the quick-key strip being visible", async () => {
    const user = userEvent.setup();
    renderComposer();

    // The quick-key strip only renders once composerFocused && keyboardOpen — keyboardOpen defaults
    // to false in jsdom (no visualViewport resize fires), so none of its keys are present here.
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tab" })).not.toBeInTheDocument();

    // The attach button now lives on the always-visible reply-input row instead of the strip.
    const attach = screen.getByRole("button", { name: "Attach image" });
    expect(attach).toBeEnabled();
    await user.click(attach); // clickable without throwing (opens the hidden file input)
  });

  it("does not render digit shortcut buttons in the composer (they live on the Keys dock's 123 tab)", () => {
    renderComposer();
    for (const d of ["1", "2", "3", "4", "5"]) {
      expect(screen.queryByRole("button", { name: d })).not.toBeInTheDocument();
    }
  });
});

describe("Composer — keys dock (in-flow, not an overlay)", () => {
  it("tapping Keys docks the NavTray in the normal flow (no fixed overlay) and toggles it closed", async () => {
    const user = userEvent.setup();
    renderComposer();

    const keys = screen.getByRole("button", { name: "Keys" });
    expect(keys).toHaveAttribute("aria-expanded", "false");
    // Closed by default — the tray isn't mounted.
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();

    await user.click(keys);
    expect(keys).toHaveAttribute("aria-expanded", "true");

    // The NavTray is now mounted (its Esc key is a good witness)…
    const esc = screen.getByRole("button", { name: "Esc" });
    expect(esc).toBeInTheDocument();
    // …and it is IN-FLOW, not inside a fixed overlay/dialog (the BottomSheet's covering role="dialog").
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(esc.closest('[aria-modal="true"]')).toBeNull();
    expect(esc.closest(".fixed")).toBeNull();

    // Tapping Keys again closes the dock (single-valued drawer toggle).
    await user.click(keys);
    expect(keys).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
  });

  it("the dock's own X close button dismisses it", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.click(screen.getByRole("button", { name: "Keys" }));
    expect(screen.getByRole("button", { name: "Esc" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close Keys" }));
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
  });

  it("routes a docked key press through pane.send_keys", async () => {
    const user = userEvent.setup();
    let sentKeys: string[] | null = null;
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        const body = (await request.json()) as { keys: string[] };
        sentKeys = body.keys;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderComposer();

    await user.click(screen.getByRole("button", { name: "Keys" }));
    await user.click(screen.getByRole("button", { name: "Esc" }));

    await waitFor(() => expect(sentKeys).toEqual(["Escape"]));
  });
});

describe("Composer — quick dock (in-flow, matches the keys dock)", () => {
  it("tapping Quick docks the reply grids in the normal flow (no fixed overlay) and toggles it closed", async () => {
    const user = userEvent.setup();
    renderComposer();

    const quick = screen.getByRole("button", { name: "Quick" });
    expect(quick).toHaveAttribute("aria-expanded", "false");
    // Closed by default — none of the quick replies are mounted.
    expect(screen.queryByRole("button", { name: "yes" })).not.toBeInTheDocument();

    await user.click(quick);
    expect(quick).toHaveAttribute("aria-expanded", "true");

    // The reply grid is now mounted ("yes" is a good witness)…
    const yes = screen.getByRole("button", { name: "yes" });
    expect(yes).toBeInTheDocument();
    // …and it is IN-FLOW like the keys dock, not inside a BottomSheet's covering role="dialog".
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(yes.closest('[aria-modal="true"]')).toBeNull();
    expect(yes.closest(".fixed")).toBeNull();

    // Tapping Quick again closes the dock (single-valued drawer toggle).
    await user.click(quick);
    expect(quick).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "yes" })).not.toBeInTheDocument();
  });

  it("opening Quick closes an open Keys dock (shared single-valued drawer)", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.click(screen.getByRole("button", { name: "Keys" }));
    expect(screen.getByRole("button", { name: "Esc" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Quick" }));
    // Keys unmounts, Quick mounts — only one dock at the single placement site.
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "yes" })).toBeInTheDocument();
  });

  it("the dock's own X close button dismisses it", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.click(screen.getByRole("button", { name: "Quick" }));
    expect(screen.getByRole("button", { name: "yes" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close Quick" }));
    expect(screen.queryByRole("button", { name: "yes" })).not.toBeInTheDocument();
  });

  it("a quick-action tap sends its text through the reply path and closes the dock", async () => {
    const user = userEvent.setup();
    let replyText: string | null = null;
    server.use(
      http.post(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        const body = (await request.json()) as { text: string };
        replyText = body.text;
        return HttpResponse.json({ ok: true });
      }),
    );
    const props = renderComposer();

    await user.click(screen.getByRole("button", { name: "Quick" }));
    await user.click(screen.getByRole("button", { name: "continue" }));

    await waitFor(() => expect(replyText).toBe("continue"));
    expect(props.onSent).toHaveBeenCalled();
    // fire() closes the dock after sending.
    expect(screen.queryByRole("button", { name: "continue" })).not.toBeInTheDocument();
  });
});
