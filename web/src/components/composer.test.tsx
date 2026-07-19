import { useState } from "react";
import type { ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { clearStatus, useStatus } from "@/lib/status";
import { isReloadHeld, __resetReloadGuard } from "@/lib/reload-guard";
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
    rawTerminalDraft: null,
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
    // The pre-clear keys on the RAW line (the actual current "❯" content), independent of whether the
    // draft ever stabilised into a visible preview — a stranded raw draft is still swept before send.
    renderComposer({ terminalDraft: null, rawTerminalDraft: "leftover" });
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
      rawTerminalDraft: null,
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

// Drives the composer's TWO draft props the way the parent does across polls: `rawTerminalDraft` is
// the live per-poll line, `terminalDraft` is its 1.5s-stabilised twin (useStableTerminalDraft). Two
// hidden controls set them independently (empty string → null), so a test can model a raw-only blip,
// a stabilised draft, live host typing (raw changes while stable lags), and the line clearing — all
// without real timers. `initialDraft` seeds a fully-stranded draft (raw + stable) at mount.
function renderDraftHarness(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const { terminalDraft: initialDraft = null, ...rest } = overrides;
  function Harness() {
    const [raw, setRaw] = useState<string | null>(initialDraft);
    const [stable, setStable] = useState<string | null>(initialDraft);
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
      terminalDraft: stable,
      rawTerminalDraft: raw,
    };
    return (
      <>
        <input
          data-testid="raw-control"
          defaultValue={initialDraft ?? ""}
          onChange={(e) => setRaw(e.target.value === "" ? null : e.target.value)}
        />
        <input
          data-testid="stable-control"
          defaultValue={initialDraft ?? ""}
          onChange={(e) => setStable(e.target.value === "" ? null : e.target.value)}
        />
        <Composer {...props} />
      </>
    );
  }
  const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
  render(<RouterProvider router={router} />);
}

// The raw line updated this poll (may differ from the stabilised value while the host is typing).
const setRawDraft = (value: string) =>
  fireEvent.change(screen.getByTestId("raw-control"), { target: { value } });
// The stabilised value promoting/clearing (what gates the preview's appearance).
const setStableDraft = (value: string) =>
  fireEvent.change(screen.getByTestId("stable-control"), { target: { value } });
// A draft that has BOTH appeared and passed the 1.5s stability gate — raw and stable carry it.
const strandDraft = (value: string) => {
  setRawDraft(value);
  setStableDraft(value);
};

// The composer input is EXCLUSIVELY phone-owned: a terminal draft is never written into it by a poll.
// The reported bug was the reverse — b9603e9's auto-adopt kept re-syncing the field to the draft, so
// while the host was typing the input flickered fill→clear→fill. These pin that it can never happen.
describe("Composer — input is phone-owned (never auto-written by the terminal draft)", () => {
  it("never writes the draft into the input across appear → stabilise → live typing → vanish", async () => {
    renderDraftHarness();
    const box = screen.getByPlaceholderText(/type a reply/i);
    expect(box).toHaveValue("");

    setRawDraft("d"); // a raw draft appears (one poll) — input untouched
    expect(box).toHaveValue("");

    setStableDraft("d"); // it stabilises (the preview may show) — input still untouched
    await screen.findByText(/draft in terminal/i);
    expect(box).toHaveValue("");

    // Live host typing: a distinct raw draft every poll. The input never oscillates.
    for (const t of ["dr", "dra", "draf", "draft", "draft "]) {
      setRawDraft(t);
      expect(box).toHaveValue("");
    }

    setRawDraft(""); // the host line clears — input stays empty
    expect(box).toHaveValue("");
  });

  it("leaves the user's own typed text intact while a draft appears, streams, and vanishes", async () => {
    const user = userEvent.setup();
    renderDraftHarness();
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "my mobile message");

    strandDraft("host draft"); // a draft strands while the user is mid-compose
    await screen.findByText(/draft in terminal/i);
    expect(box).toHaveValue("my mobile message");

    setRawDraft("host draft grows"); // host keeps typing — preview follows, input does not
    expect(box).toHaveValue("my mobile message");

    setRawDraft(""); // host line clears
    expect(box).toHaveValue("my mobile message");
  });
});

describe("Composer — terminal-draft preview", () => {
  it("does not render the preview when there is no stranded draft", () => {
    renderComposer({ terminalDraft: null, rawTerminalDraft: null });
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();
  });

  it("appears only after the draft stabilises — a raw-only blip never flashes it", async () => {
    renderDraftHarness();
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();

    setRawDraft("blip"); // raw only (not yet stable) → no preview
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();

    setStableDraft("blip"); // stabilised → the preview promotes
    expect(await screen.findByText(/draft in terminal/i)).toBeInTheDocument();
    expect(screen.getByText("blip")).toBeInTheDocument();
  });

  it("tracks the raw draft live once shown — host typing streams into the preview text", async () => {
    renderDraftHarness();
    strandDraft("foo");
    expect(await screen.findByText("foo")).toBeInTheDocument();

    // Raw updates every poll; the stabilised value lags, but the preview text follows the raw line.
    setRawDraft("foobar");
    expect(await screen.findByText("foobar")).toBeInTheDocument();
    expect(screen.queryByText("foo")).not.toBeInTheDocument();

    setRawDraft("foobar baz");
    expect(await screen.findByText("foobar baz")).toBeInTheDocument();
  });

  it("unmounts when the raw draft goes null (submitted or cleared on the host)", async () => {
    renderDraftHarness();
    strandDraft("gone soon");
    await screen.findByText(/draft in terminal/i);

    setRawDraft(""); // → null: the host line was cleared/submitted
    await waitFor(() => expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument());
  });

  it("dismiss hides it; the same draft never re-shows, a distinct one does", async () => {
    const user = userEvent.setup();
    renderDraftHarness();
    strandDraft("dismiss me");
    await screen.findByText(/draft in terminal/i);

    await user.click(screen.getByRole("button", { name: /dismiss terminal draft/i }));
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();

    // The SAME text is still on the host line — it must not re-surface.
    strandDraft("dismiss me");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();

    // A genuinely different draft is fair game again.
    strandDraft("something new");
    expect(await screen.findByText(/draft in terminal/i)).toBeInTheDocument();
    expect(screen.getByText("something new")).toBeInTheDocument();
  });

  it("Take over copies the CURRENT draft into the composer, marks it handled, and hides the preview", async () => {
    const user = userEvent.setup();
    const keyCalls: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async () => {
        keyCalls.push("keys");
        return HttpResponse.json({ ok: true });
      }),
    );
    renderDraftHarness();
    strandDraft("take me over");
    await screen.findByText(/draft in terminal/i);
    const box = screen.getByPlaceholderText(/type a reply/i);
    expect(box).toHaveValue(""); // never auto-written before the deliberate takeover

    await user.click(screen.getByRole("button", { name: /take over/i }));
    expect(box).toHaveValue("take me over"); // the text lands, one-shot
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument(); // preview hidden
    expect(keyCalls).toEqual([]); // takeover writes NOTHING to the terminal
  });

  it("after Take over, a divergent host draft honestly re-shows the preview with the new text", async () => {
    const user = userEvent.setup();
    renderDraftHarness();
    strandDraft("original");
    await screen.findByText(/draft in terminal/i);

    await user.click(screen.getByRole("button", { name: /take over/i }));
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();

    // The host keeps typing → a DIFFERENT draft → the preview returns with the new text.
    strandDraft("original plus more");
    expect(await screen.findByText(/draft in terminal/i)).toBeInTheDocument();
    expect(screen.getByText("original plus more")).toBeInTheDocument();
  });

  it("send after Take over pre-clears the host line exactly once, then clears the composer", async () => {
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
    renderDraftHarness();
    strandDraft("adopted line");
    await screen.findByText(/draft in terminal/i);

    await user.click(screen.getByRole("button", { name: /take over/i }));
    const box = screen.getByPlaceholderText(/type a reply/i);
    expect(box).toHaveValue("adopted line");

    // The host line still holds the draft (takeover never touched it), so Send sweeps it once first.
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callOrder).toEqual(["keys", "reply:adopted line"]));
    expect(sentKeys![0]).toBe("ctrl+k");
    await waitFor(() => expect(box).toHaveValue("")); // cleared after send
  });

  it("read-only device: shows the preview and allows Take over (local copy), writing nothing to the terminal", async () => {
    const user = userEvent.setup();
    const keyCalls: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async () => {
        keyCalls.push("keys");
        return HttpResponse.json({ ok: true });
      }),
    );
    renderDraftHarness({ readOnly: true });
    strandDraft("read only draft");
    expect(await screen.findByText(/draft in terminal/i)).toBeInTheDocument();
    const box = screen.getByPlaceholderText(/read-only/i);
    expect(box).toHaveValue(""); // never auto-written

    await user.click(screen.getByRole("button", { name: /take over/i }));
    expect(box).toHaveValue("read only draft"); // local copy landed
    expect(box).toBeDisabled(); // still locked — can't edit or send
    expect(keyCalls).toEqual([]); // no terminal writes at all
  });
});

// Mitigation A for the in-flight self-race: the composer knows what it just sent, so when the SAME
// text shows up on the terminal's "❯" line moments later (our own reply before the bridge's pending
// Enter lands), it must NOT be treated as a stranded draft — no chip, and no destructive clear-prefix
// on the next Send. A harness lets the test flip `terminalDraft` after a send, the way the parent
// would once the mirror echoes the in-flight text back.
describe("Composer — in-flight echo suppression (match-last-sent)", () => {
  function EchoHarness({ echoValue }: { echoValue: string }) {
    // The echo lands on BOTH the raw and the stabilised line at once (a persistent echo is stable).
    const [draft, setDraft] = useState<string | null>(null);
    const props: ComponentProps<typeof Composer> = {
      paneId: "w1:p1",
      agent: "claude",
      isShell: false,
      gone: false,
      readOnly: false,
      text: "pane output",
      terminalDraft: draft,
      rawTerminalDraft: draft,
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

  it("still treats a genuinely different stranded draft as real (previews it; Take over + Send pre-clears)", async () => {
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

    // A draft that is NOT what we just sent is a real stranded draft — not suppressed. It shows in the
    // preview (never auto-written into the now-empty input).
    await user.click(screen.getByRole("button", { name: "__set-draft" }));
    expect(await screen.findByText(/draft in terminal/i)).toBeInTheDocument();
    expect(box).toHaveValue("");

    // Take it over, then send: the real stranded line is pre-cleared before the reply.
    callLog.length = 0;
    await user.click(screen.getByRole("button", { name: /take over/i }));
    expect(box).toHaveValue("someone else's leftover");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callLog).toContain("reply:someone else's leftover"));
    expect(callLog).toContain("keys");
  });
});

// The no-service-worker self-updater must never reload over unsent work. The composer holds a reload
// (lib/reload-guard) while its phone-owned input has REAL text or an upload is in flight — but a
// terminal draft alone is SAFE (it lives on the "❯" line and its preview re-derives after a reload),
// so it must NOT hold, or a stranded draft would wedge the update forever.
describe("Composer — reload-guard hold (no-SW self-update safety gate)", () => {
  beforeEach(() => __resetReloadGuard());

  it("holds a reload while the composer has unsent text, releases when it's cleared", async () => {
    const user = userEvent.setup();
    renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);
    expect(isReloadHeld()).toBe(false);

    await user.type(box, "half-written thought");
    expect(isReloadHeld()).toBe(true);

    await user.clear(box);
    expect(isReloadHeld()).toBe(false);
  });

  it("a terminal draft alone (preview only, empty input) does NOT hold — it re-derives after a reload", async () => {
    renderDraftHarness();
    strandDraft("just a preview");
    await screen.findByText(/draft in terminal/i);
    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue(""); // nothing phone-owned to lose
    expect(isReloadHeld()).toBe(false);
  });

  it("holds while an image upload is in flight, releases once it settles", async () => {
    // Failing upload keeps the input empty (a successful one appends the returned path, which then
    // legitimately holds as real unsent text) — so the release is observable in isolation.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, async () => {
        await gate;
        return HttpResponse.json({ ok: false, error: "upload failed" });
      }),
    );
    renderComposer();
    expect(isReloadHeld()).toBe(false);

    const file = new File(["x"], "shot.png", { type: "image/png" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(isReloadHeld()).toBe(true)); // uploading → held
    release();
    await waitFor(() => expect(isReloadHeld()).toBe(false)); // settled, input still empty → released
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
