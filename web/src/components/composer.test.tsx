import { useState } from "react";
import type { ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

// Drives `terminalDraft` dynamically, the way the parent (useStableTerminalDraft) would across polls:
// a hidden control input sets the draft atomically (empty string → null, i.e. the line cleared) while
// the test types into the composer's own textarea. `initialDraft` seeds the mount-time draft.
function renderDraftHarness(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const { terminalDraft: initialDraft = null, ...rest } = overrides;
  function Harness() {
    const [draft, setDraft] = useState<string | null>(initialDraft);
    const props: ComponentProps<typeof Composer> = {
      paneId: "w1:p1",
      agent: "claude",
      isShell: false,
      gone: false,
      readOnly: false,
      text: "pane output",
      prefs: { wrap: true, fontSize: 11, rawTerminal: false },
      setWrap: vi.fn(),
      stepFontSize: vi.fn(),
      setRawTerminal: vi.fn(),
      onSent: vi.fn(),
      ...rest,
      terminalDraft: draft,
    };
    return (
      <>
        <input
          data-testid="draft-control"
          defaultValue={initialDraft ?? ""}
          onChange={(e) => setDraft(e.target.value === "" ? null : e.target.value)}
        />
        <Composer {...props} />
      </>
    );
  }
  const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
  render(<RouterProvider router={router} />);
}

const setTerminalDraft = (value: string) =>
  fireEvent.change(screen.getByTestId("draft-control"), { target: { value } });

describe("Composer — stranded-draft auto-adoption", () => {
  it("auto-adopts a stranded draft into the empty composer, text only (no keys to the terminal)", async () => {
    const keyCalls: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async () => {
        keyCalls.push("keys");
        return HttpResponse.json({ ok: true });
      }),
    );
    renderDraftHarness({ terminalDraft: "adopt me" });
    const box = screen.getByPlaceholderText(/type a reply/i);

    // The draft appears IN the editor — no chip (redundant) and no terminal writes at adopt time.
    await waitFor(() => expect(box).toHaveValue("adopt me"));
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();
    expect(keyCalls).toEqual([]);
  });

  it("does NOT adopt when the composer already has text — shows the recovery chip instead", async () => {
    const user = userEvent.setup();
    renderDraftHarness();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "my own text");
    setTerminalDraft("leftover"); // a draft strands while the user is mid-compose

    expect(box).toHaveValue("my own text"); // the user's text is untouched
    expect(await screen.findByText(/draft in terminal/i)).toBeInTheDocument(); // chip, not adoption
  });

  it("syncs an adopted draft in place when the terminal draft changes (still unedited)", async () => {
    renderDraftHarness({ terminalDraft: "first" });
    const box = screen.getByPlaceholderText(/type a reply/i);
    await waitFor(() => expect(box).toHaveValue("first"));

    setTerminalDraft("second");
    await waitFor(() => expect(box).toHaveValue("second"));
  });

  it("clears the composer when an adopted draft vanishes from the terminal (submitted/cleared there)", async () => {
    renderDraftHarness({ terminalDraft: "ephemeral" });
    const box = screen.getByPlaceholderText(/type a reply/i);
    await waitFor(() => expect(box).toHaveValue("ephemeral"));

    setTerminalDraft(""); // → null: the "❯" line was cleared/submitted in the terminal
    await waitFor(() => expect(box).toHaveValue(""));
  });

  it("detaches the moment the user edits the adopted text — later terminal changes don't overwrite it", async () => {
    const user = userEvent.setup();
    renderDraftHarness({ terminalDraft: "draft" });
    const box = screen.getByPlaceholderText(/type a reply/i);
    await waitFor(() => expect(box).toHaveValue("draft"));

    await user.type(box, "!"); // "draft!" → the user owns it now
    expect(box).toHaveValue("draft!");

    setTerminalDraft("changed"); // a NEW distinct draft → chip path, NOT a silent overwrite
    expect(await screen.findByText(/draft in terminal/i)).toBeInTheDocument();
    expect(box).toHaveValue("draft!");
  });

  it("clearing the adopted text by hand counts as a dismiss — the same draft does not re-adopt, a new one does", async () => {
    const user = userEvent.setup();
    renderDraftHarness({ terminalDraft: "sticky" });
    const box = screen.getByPlaceholderText(/type a reply/i);
    await waitFor(() => expect(box).toHaveValue("sticky"));

    await user.clear(box); // clear by hand → dismiss "sticky"
    expect(box).toHaveValue("");
    // "sticky" is still stranded on the terminal, but a dismissed draft must not re-adopt…
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument(); // empty input → no chip either
    await new Promise((r) => setTimeout(r, 20));
    expect(box).toHaveValue("");

    // …while a NEW, distinct stranded draft is fair game again.
    setTerminalDraft("fresh");
    await waitFor(() => expect(box).toHaveValue("fresh"));
  });

  it("send() still fires the terminal pre-clear for an auto-adopted draft (sent once, no duplication)", async () => {
    const user = userEvent.setup();
    const callOrder: string[] = [];
    let sentKeys: string[] | null = null;
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        sentKeys = ((await request.json()) as { keys: string[] }).keys;
        callOrder.push("keys");
        return HttpResponse.json({ ok: true });
      }),
      http.post(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        callOrder.push(`reply:${((await request.json()) as { text: string }).text}`);
        return HttpResponse.json({ ok: true });
      }),
    );
    renderDraftHarness({ terminalDraft: "adopted line" });
    const box = screen.getByPlaceholderText(/type a reply/i);
    await waitFor(() => expect(box).toHaveValue("adopted line"));

    await user.click(screen.getByRole("button", { name: "Send" }));

    // The stranded line is swept (ctrl+k + backspaces) BEFORE the reply, so the text lands once.
    await waitFor(() => expect(callOrder).toEqual(["keys", "reply:adopted line"]));
    expect(sentKeys![0]).toBe("ctrl+k");
    await waitFor(() => expect(box).toHaveValue("")); // cleared after send
  });

  it("adopts without stealing focus (no keyboard pop)", async () => {
    renderDraftHarness({ terminalDraft: "quiet adopt" });
    const box = screen.getByPlaceholderText(/type a reply/i);
    await waitFor(() => expect(box).toHaveValue("quiet adopt"));
    expect(box).not.toHaveFocus();
  });

  it("read-only device: adopts the stranded draft as display-only text, writing nothing to the terminal", async () => {
    const keyCalls: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async () => {
        keyCalls.push("keys");
        return HttpResponse.json({ ok: true });
      }),
    );
    renderDraftHarness({ terminalDraft: "read only draft", readOnly: true });
    const box = screen.getByPlaceholderText(/read-only/i);

    await waitFor(() => expect(box).toHaveValue("read only draft"));
    expect(box).toBeDisabled(); // still locked — can't edit or send
    expect(keyCalls).toEqual([]); // text-only: a read-only device never writes to the terminal
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();
  });
});

describe("Composer — terminal-draft recovery chip (non-empty composer fallback)", () => {
  it("does not render the chip when there's no stranded draft", () => {
    renderComposer({ terminalDraft: null });
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();
  });

  it("'Edit here' clears the terminal line with backspaces and appends the draft to the existing text", async () => {
    const user = userEvent.setup();
    let sentKeys: string[] | null = null;
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        sentKeys = ((await request.json()) as { keys: string[] }).keys;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderDraftHarness();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "my note"); // composer non-empty → chip path, not adoption
    setTerminalDraft("recover me");
    await user.click(await screen.findByRole("button", { name: /edit here/i }));

    // One Backspace per code point plus the 8-key overshoot clears the "❯" line.
    await waitFor(() => expect(sentKeys).not.toBeNull());
    expect(sentKeys!.every((k) => k === "Backspace")).toBe(true);

    // …and the draft appends on a new line below the user's existing text, with the chip gone.
    await waitFor(() => expect(box).toHaveValue("my note\nrecover me"));
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();
  });

  it("dismiss (X) hides the chip for that draft", async () => {
    const user = userEvent.setup();
    renderDraftHarness();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "typing");
    setTerminalDraft("dismiss me");
    expect(await screen.findByText(/draft in terminal/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /dismiss terminal draft/i }));
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();
  });
});

// Mitigation A for the in-flight self-race: the composer knows what it just sent, so when the SAME
// text shows up on the terminal's "❯" line moments later (our own reply before the bridge's pending
// Enter lands), it must NOT be treated as a stranded draft — no chip, and no destructive clear-prefix
// on the next Send. A harness lets the test flip `terminalDraft` after a send, the way the parent
// would once the mirror echoes the in-flight text back.
describe("Composer — in-flight echo suppression (match-last-sent)", () => {
  function EchoHarness({ echoValue }: { echoValue: string }) {
    const [draft, setDraft] = useState<string | null>(null);
    const props: ComponentProps<typeof Composer> = {
      paneId: "w1:p1",
      agent: "claude",
      isShell: false,
      gone: false,
      readOnly: false,
      text: "pane output",
      terminalDraft: draft,
      prefs: { wrap: true, fontSize: 11, rawTerminal: false },
      setWrap: vi.fn(),
      stepFontSize: vi.fn(),
      setRawTerminal: vi.fn(),
      onSent: vi.fn(),
    };
    return (
      <>
        <button onClick={() => setDraft(echoValue)}>__set-draft</button>
        <Composer {...props} />
      </>
    );
  }

  function renderEcho(echoValue: string) {
    const router = createMemoryRouter([
      { path: "/", element: <EchoHarness echoValue={echoValue} /> },
    ]);
    render(<RouterProvider router={router} />);
  }

  it("suppresses the chip AND skips the clear-prefix when the draft matches what we just sent", async () => {
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
    renderEcho("/rename");
    const box = screen.getByPlaceholderText(/type a reply/i);

    // Send "/rename"; the composer remembers it.
    await user.type(box, "/rename");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callLog).toContain("reply:/rename"));

    // The mirror now echoes the in-flight "/rename" back onto the ❯ line — no stranded-draft chip.
    await user.click(screen.getByRole("button", { name: "__set-draft" }));
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();

    // A follow-up send must NOT fire the destructive ctrl+k/backspace clear-prefix against our own
    // in-flight reply — it goes straight to reply.
    await user.type(box, "next message");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callLog).toContain("reply:next message"));
    expect(callLog).not.toContain("keys");
    expect(callLog.filter((e) => e.startsWith("reply:"))).toEqual([
      "reply:/rename",
      "reply:next message",
    ]);
  });

  it("still treats a genuinely different stranded draft as real (auto-adopts it; the next Send pre-clears)", async () => {
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
    renderEcho("someone else's leftover");
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callLog).toContain("reply:hello"));

    // A draft that is NOT what we just sent is a real stranded draft — not suppressed. The composer
    // is now empty, so it AUTO-ADOPTS (rather than showing a chip).
    await user.click(screen.getByRole("button", { name: "__set-draft" }));
    await waitFor(() => expect(box).toHaveValue("someone else's leftover"));
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();

    // Sending the adopted draft fires the destructive clear-prefix first (it's a real stranded line).
    callLog.length = 0;
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callLog).toContain("reply:someone else's leftover"));
    expect(callLog).toContain("keys");
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
