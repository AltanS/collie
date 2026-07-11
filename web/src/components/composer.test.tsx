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

  it("clears the terminal line with backspaces before sendReply when a draft is stranded", async () => {
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
    expect(sentKeys).toHaveLength([..."leftover"].length + 8);
    expect(sentKeys!.every((k) => k === "Backspace")).toBe(true);
  });

  it("clears the terminal line before each send so sequential sends do not accumulate", async () => {
    const user = userEvent.setup();
    const callLog: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        const body = (await request.json()) as { keys: string[] };
        callLog.push(`keys:${body.keys.length}`);
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
    expect(callLog[callLog.length - 1]).toBe("reply:second");
    expect(callLog[callLog.length - 1]).not.toContain("first");
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

  it("does not render digit shortcut buttons in the composer (they live on the Keys sheet's 123 tab)", () => {
    renderComposer();
    for (const d of ["1", "2", "3", "4", "5"]) {
      expect(screen.queryByRole("button", { name: d })).not.toBeInTheDocument();
    }
  });
});
