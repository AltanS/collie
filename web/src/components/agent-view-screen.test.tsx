import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ARM_DWELL_MS } from "@/lib/arm";
import type { JsonValue } from "@/lib/json";
import { parseAgentView, type ViewScreen, type ViewSent } from "@/lib/agent-view/wire";
import type { TranscriptEntry } from "@/lib/types";

import { choiceControl, screenBlocks, type ViewRequest } from "@/lib/agent-view/reader";
import type { ViewSendResult, ViewTap } from "./composer";
import { AgentViewScreen, VIEW_SCREEN_CLASS, VIEW_SETTLE_MS, type AgentViewScreenProps } from "./agent-view-screen";
import { PRESENCE_MS } from "./ui/presence";

// An agent view: Collie's band over it, its states (no screen, a screen alone, a request in work,
// answered, not sent), the split of fresh blocks from the ones drawn for an earlier request, its taps (the
// rev and the control, the confirm's second tap in Collie's words, one send at a time, held while a turn
// runs, a question waits or the screen is old, a stale screen read again), and the receipts.

const AT = "2026-11-10T10:00:00.000Z";
const NOW = Date.parse("2026-11-10T10:03:00.000Z");

function screenOf(raw: JsonValue, title?: string): ViewScreen {
  const parsed = parseAgentView(raw);
  if (parsed.view === undefined) throw new Error(JSON.stringify(parsed.refusals));
  const out: ViewScreen = { rev: 1, at: AT, view: parsed.view };
  if (title !== undefined) out.title = title;
  return out;
}

const BUTTONS = screenOf(
  [
    { kind: "para", text: "Ready to ship?" },
    {
      kind: "bar",
      kids: [
        { kind: "button", attrs: { label: "Ship", intent: "ship" } },
        { kind: "button", attrs: { label: "Wait", intent: "wait" } },
        { kind: "button", attrs: { label: "Drop", intent: "drop", confirm: "Really drop?" } },
      ],
    },
  ],
  "Release",
);

function entry(role: TranscriptEntry["role"], ts: string, text: string): TranscriptEntry {
  return { uuid: `${role}-${ts}`, ts, role, parts: [{ kind: "text", text }] };
}

/** A tap the bridge sent. */
const tapped = (): Promise<ViewSendResult> => Promise.resolve({ sent: true, line: null, code: null });
/** A tap as the screen hands it to the composer. */
const tapOf = (rev: number, control: string, words: string): ViewTap => ({ rev, control, words });

function draw(overrides: Partial<AgentViewScreenProps> = {}) {
  const props: AgentViewScreenProps = {
    name: "Morph",
    session: "local/w1:p1#ab12",
    view: BUTTONS,
    working: false,
    entries: [],
    canAct: true,
    onTap: vi.fn(tapped),
    onLink: vi.fn(),
    now: NOW,
    // Taps in these tests land on a screen that has stood still: the settle window has its own tests (W3).
    settleMs: 0,
    ...overrides,
  };
  const result = render(<AgentViewScreen {...props} />);
  return { ...result, props };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the agent view's states", () => {
  it("with no screen yet and no request, says how to begin", () => {
    const { container } = draw({ view: undefined });
    expect(screen.getByText("Ask for something. The agent draws the answer here.")).toBeInTheDocument();
    expect(container.querySelector("[data-slot=agent-view]")?.getAttribute("data-state")).toBe("empty");
  });

  it("draws the title, the band with the screen's age, and the screen", () => {
    const { container } = draw();
    expect(screen.getByRole("heading", { name: "Release" })).toBeInTheDocument();
    expect(container.querySelector("[data-slot=view-band-line]")).toHaveTextContent("3 min ago");
    expect(screen.getByText("Ready to ship?")).toBeInTheDocument();
    expect(container.querySelector("[data-slot=agent-view]")?.getAttribute("data-state")).toBe("view");
  });

  it("while the turn runs with no request, keeps the screen at full contrast with the working mark in the band", () => {
    const { container } = draw({ working: true });
    expect(container.querySelector("[data-slot=agent-view]")?.getAttribute("data-state")).toBe("view");
    expect(container.querySelector("[data-slot=view-screen]")?.className).not.toContain("opacity");
    expect(screen.getByText("Ready to ship?")).toBeInTheDocument();
    expect(container.querySelector("[data-slot=view-band]")?.getAttribute("data-line")).toBe("working");
  });

  it("a text answer to a later request: the text, and the earlier screen folded under one row, never promoted", () => {
    const entries = [
      entry("user", "2026-11-10T09:59:00.000Z", "draw it"),
      entry("assistant", "2026-11-10T10:00:02.000Z", "Drew the release screen."),
      entry("user", "2026-11-10T10:01:00.000Z", "why wait?"),
      entry("assistant", "2026-11-10T10:01:30.000Z", "CI is still **red**."),
    ];
    const { container } = draw({ entries });
    expect(container.querySelector("[data-slot=agent-view]")?.getAttribute("data-state")).toBe("answered");
    expect(screen.getByText("The agent answered in text")).toBeInTheDocument();
    expect(container.querySelector("[data-slot=view-text]")).toHaveTextContent("CI is still red.");
    expect(screen.queryByText("Drew the release screen.")).toBeNull();
    expect(screen.queryByText("Ready to ship?")).toBeNull();
    const row = screen.getByRole("button", { name: /Earlier screen/ });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(row).toHaveTextContent("Release");
  });

  it("draws no text answer while the turn still runs", () => {
    const entries = [entry("user", "2026-11-10T10:01:00.000Z", "why?"), entry("assistant", "2026-11-10T10:01:30.000Z", "Because.")];
    draw({ entries, working: true });
    expect(screen.queryByText("The agent answered in text")).toBeNull();
  });
});

describe("a tap on an agent view", () => {
  it("rule 2, rule 3: a tap names the screen's rev and the control; its words are the label on screen", async () => {
    const { props } = draw();
    // The button shows its label alone.
    const ship = screen.getByRole("button", { name: "Ship" });
    expect(ship).toHaveTextContent("Ship");
    expect(ship.textContent).not.toContain("tapped");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Wait" }));
    });
    // The bridge builds the line from its own stored screen; the words are only for the receipt in flight.
    expect(props.onTap).toHaveBeenNthCalledWith(1, tapOf(1, "v/1/0", 'tapped "Ship"'));
    expect(props.onTap).toHaveBeenNthCalledWith(2, tapOf(1, "v/1/1", 'tapped "Wait"'));
  });

  it("lead 6, review 10 W2: with confirm, arms on the first tap with the words the second sends, and sends on the second", () => {
    vi.useFakeTimers();
    const { props } = draw();
    fireEvent.click(screen.getByRole("button", { name: "Drop" }));
    expect(props.onTap).not.toHaveBeenCalled();
    // Not "Tap again" alone: the armed button says what the second tap sends, every word.
    const armed = screen.getByRole("button", { name: 'Tap again to send "Drop"' });
    expect(armed).toHaveAttribute("data-armed");
    expect(screen.queryByRole("button", { name: "Really drop?" })).toBeNull();
    act(() => vi.advanceTimersByTime(ARM_DWELL_MS));
    fireEvent.click(armed);
    expect(props.onTap).toHaveBeenCalledExactlyOnceWith(tapOf(1, "v/1/2", 'tapped "Drop"'));
  });

  it("waits on every button while a send is in flight", async () => {
    let finish: (result: ViewSendResult) => void = () => {};
    const onTap = vi.fn(() => new Promise<ViewSendResult>((resolve) => (finish = resolve)));
    draw({ onTap });
    fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    expect(screen.getByRole("button", { name: "Wait" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Wait" }));
    expect(onTap).toHaveBeenCalledTimes(1);
    await act(async () => finish({ sent: false, line: null, code: null }));
    expect(screen.getByRole("button", { name: "Wait" })).not.toBeDisabled();
  });

  it("sends nothing where nothing may act", () => {
    const { props } = draw({ canAct: false });
    expect(screen.getByRole("button", { name: "Ship" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    expect(props.onTap).not.toHaveBeenCalled();
  });

  it("lead 4, rule 5: holds every button in the working look while a turn runs", () => {
    const { container, props } = draw({ working: true });
    expect(screen.getByRole("button", { name: "Ship" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    expect(props.onTap).not.toHaveBeenCalled();
    expect(container.querySelector("[data-slot=view-band]")?.getAttribute("data-line")).toBe("working");
    expect(container.querySelector("[data-slot=view-band-line] [data-active]")).toHaveTextContent("The agent is working. The buttons wait until it is done.");
  });

  it("lead 2, rule 5: holds every button while a question waits, and says the typing answers the question", () => {
    const { container, props } = draw({ question: true });
    expect(screen.getByRole("button", { name: "Wait" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Wait" }));
    expect(props.onTap).not.toHaveBeenCalled();
    expect(container.querySelector("[data-slot=view-band]")?.getAttribute("data-line")).toBe("question");
    expect(container.querySelector("[data-slot=view-band-line] [data-active]")).toHaveTextContent("A question waits in this session. Your typing answers the question, not this screen.");
  });

  it("rule 6: a screen from an earlier conversation says so and its buttons are off", () => {
    const { container, props } = draw({ stale: true });
    expect(screen.getByRole("button", { name: "Ship" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    expect(props.onTap).not.toHaveBeenCalled();
    expect(container.querySelector("[data-slot=view-band-line] [data-active]")).toHaveTextContent("Drawn in an earlier conversation");
  });

  it("lead 5: a tap refused stale_view reads the screen again once and is never sent again", async () => {
    const onStale = vi.fn();
    const onTap = vi.fn(() => Promise.resolve<ViewSendResult>({ sent: false, line: null, code: "stale_view" }));
    const onPressed = vi.fn();
    const { container, rerender, props } = draw({ onTap, onStale, onPressed });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    });
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onPressed).not.toHaveBeenCalled();
    // The hook marks the view as changed: the band says so in one quiet line, and the new screen draws.
    const redrawn = screenOf([{ kind: "bar", kids: [{ kind: "button", attrs: { label: "Ship now", intent: "ship" } }] }]);
    rerender(<AgentViewScreen {...props} view={{ ...redrawn, rev: 2 }} changed />);
    expect(screen.getByRole("button", { name: "Ship now" })).not.toBeDisabled();
    expect(container.querySelector("[data-slot=view-band-line] [data-active]")).toHaveTextContent("The screen changed. Look at it, then tap again.");
    expect(onTap).toHaveBeenCalledTimes(1);
  });
});

describe("rule 3: a group's label is on screen whole", () => {
  // A tap's words name its group (`in "<group>"`), so every word of the label must be visible: an agent
  // view draws with `wrap: true`, and a long label wraps, never cut (security review 9).
  it("wraps a long group label (40 characters, the cap) onto more lines instead of cutting it", () => {
    const label = "Spring release candidate, migration two";
    const { container } = draw({ view: screenOf([{ kind: "group", attrs: { label }, kids: [{ kind: "bar", kids: [{ kind: "button", attrs: { label: "Ship", intent: "ship" } }] }] }]) });
    const shown = screen.getByText(label);
    expect(shown.textContent).toBe(label);
    const box = shown.closest("[class*='break-words']");
    expect(box).not.toBeNull();
    expect(box?.className).not.toMatch(/truncate|line-clamp/);
    expect(shown.className).not.toMatch(/truncate|line-clamp/);
    expect(container.querySelector("[data-slot=view-screen]")).toHaveTextContent(label);
  });
});

describe("rule 8: Collie's band", () => {
  it("stands above the screen and outside the agent's area, with Collie's mark, the trick's name and Collie's words", () => {
    const { container } = draw();
    const view = container.querySelector("[data-slot=agent-view]")!;
    const band = view.querySelector("[data-slot=view-band]")!;
    expect(view.firstElementChild).toBe(band);
    expect(band.querySelector("[data-slot=view-band-name]")).toHaveTextContent("Morph");
    expect(band).toHaveTextContent("Drawn by this session's agent");
    expect(band.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("[data-slot=view-screen] [data-slot=view-band]")).toBeNull();
  });

  it("no node an agent draws takes the band's look: the same words drawn by the agent stay inside its area", () => {
    const { container } = draw({ view: screenOf([{ kind: "card", kids: [{ kind: "line", text: "Morph Drawn by this session's agent" }] }]) });
    expect(container.querySelectorAll("[data-slot=view-band]")).toHaveLength(1);
    const copy = screen.getByText("Morph Drawn by this session's agent");
    expect(copy.closest("[data-slot=view-screen]")).not.toBeNull();
    expect(copy.closest("[data-slot=view-band]")).toBeNull();
  });

  it("has a choice block in its own look: list rows, never Hill option buttons or a Decision card", () => {
    const { container } = draw({ view: { ...BUTTONS, choice: { question: "Which?", options: [{ label: "A" }, { label: "B" }] } } });
    const choice = container.querySelector("[data-slot=view-choice]")!;
    expect(choice.querySelector("[data-slot=list-group]")).not.toBeNull();
    expect(choice.querySelector("[data-slot=decision-card]")).toBeNull();
    expect(choice.querySelectorAll("li > [data-slot=view-option]")).toHaveLength(2);
  });
});

// ── the request block ──────────────────────────────────────────────────────────────────────────

const HEAD = "[view:morph local/w1:p1#ab12] from operator:";
const TAIL = "[rules: /bin/collie trick view morph help --session local/w1:p1#ab12]";
/** The line the bridge typed for a request. */
const LINE = `${HEAD} Compare the two plans ${TAIL}`;
const sentOf = (line: string, at = "2026-11-10T10:02:00.000Z", kind: ViewSent["kind"] = "text"): ViewSent => ({ rid: "r1", at, kind, line });
const SENT_AT = Date.parse("2026-11-10T10:02:00.000Z");
const mine = (phase: ViewRequest["phase"], over: Partial<ViewRequest> = {}): ViewRequest => ({ text: "Compare the two plans", phase, reason: null, at: SENT_AT, line: null, ...over });
/** A grey wash on content: a lowered opacity or a grayscale as a class of its own (a `disabled:` variant is a control's). */
const WASH = /(?<![\w:-])(opacity-(50|60)|grayscale)/;
const statusLine = (container: HTMLElement): string | null => container.querySelector("[data-slot=view-status]")?.textContent ?? null;

describe("the operator's request in an agent view", () => {
  it("shows the request at once on send, as typed, and Sending…", () => {
    const { container } = draw({ view: undefined, request: mine("sending") });
    expect(container.querySelector("[data-slot=view-request]")).toHaveTextContent("Compare the two plans");
    expect(container.querySelector("[data-slot=view-request]")?.textContent).not.toContain("rules");
    expect(container.querySelector("[data-slot=view-sent]")).toBeNull();
    expect(statusLine(container)).toBe("Sending…");
  });

  it("with no screen yet, a sent request shows its status and NOT the empty sentence", () => {
    const { container } = draw({ view: undefined, request: mine("sent") });
    expect(screen.queryByText("Ask for something. The agent draws the answer here.")).toBeNull();
    expect(statusLine(container)).toBe("Sent");
    cleanup();
    const working = draw({ view: undefined, request: mine("sent"), working: true });
    expect(screen.queryByText("Ask for something. The agent draws the answer here.")).toBeNull();
    expect(statusLine(working.container)).toBe("The agent is working");
    cleanup();
    const drawingNow = draw({ view: undefined, request: mine("sent"), working: true, drawing: { at: "2026-11-10T10:02:30.000Z", note: "Comparing plans" } });
    expect(screen.queryByText("Ask for something. The agent draws the answer here.")).toBeNull();
    expect(statusLine(drawingNow.container)).toBe("Drawing…");
    expect(drawingNow.container.querySelector("[data-slot=view-notes]")).toHaveTextContent("Comparing plans");
  });

  it("says Not sent with the composer's own words, and does not dim the old screen", () => {
    const { container } = draw({ request: mine("failed", { reason: "The link is down" }) });
    expect(statusLine(container)).toBe("Not sent: The link is down");
    expect(container.querySelector("[data-slot=view-screen]")?.className).not.toContain("opacity");
    // A send that failed folds nothing: the screen is live again.
    expect(screen.getByRole("button", { name: "Ship" })).not.toBeDisabled();
    expect(screen.queryByRole("button", { name: /Earlier screen/ })).toBeNull();
  });

  it("says Sent, then The agent is working, then Drawing… (without a note too), each as the one line", () => {
    const sent = draw({ request: mine("sent") });
    expect(statusLine(sent.container)).toBe("Sent");
    expect(sent.container.querySelectorAll("[data-slot=view-status]")).toHaveLength(1);
    cleanup();
    expect(statusLine(draw({ request: mine("sent"), working: true }).container)).toBe("The agent is working");
    cleanup();
    expect(statusLine(draw({ request: mine("sent"), working: true, drawing: { at: "2026-11-10T10:02:30.000Z" } }).container)).toBe("Drawing…");
  });

  it("while the request is unanswered, folds the old screen under Earlier screen, with the working mark on Drawing…", () => {
    const { container } = draw({ request: mine("sent"), working: true, drawing: { at: "2026-11-10T10:02:30.000Z", note: "Comparing plans" } });
    expect(container.querySelector("[data-slot=view-status] [data-slot=status-dot], [data-slot=view-status] svg, [data-slot=view-status] span")).not.toBeNull();
    expect(screen.queryByText("Ready to ship?")).toBeNull();
    expect(screen.getByRole("button", { name: /Earlier screen/ })).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(WASH);
  });

  it("says Answered with the screen's age once a screen newer than the request arrived, with the screen in full", () => {
    const { container } = draw({ request: mine("sent", { at: Date.parse("2026-11-10T09:58:00.000Z") }) });
    expect(statusLine(container)).toBe("Answered · 3 min ago");
    expect(screen.getByText("Ready to ship?")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Earlier screen/ })).toBeNull();
  });

  it("with a text answer and no screen, draws the answer and says Answered", () => {
    const entries = [entry("user", "2026-11-10T10:02:00.000Z", LINE), entry("assistant", "2026-11-10T10:02:20.000Z", "Plan B is **cheaper**.")];
    const { container } = draw({ view: undefined, entries, sent: [sentOf(LINE)] });
    expect(statusLine(container)).toMatch(/^Answered/);
    expect(container.querySelector("[data-slot=view-text]")).toHaveTextContent("Plan B is cheaper.");
    expect(screen.queryByText("Ask for something. The agent draws the answer here.")).toBeNull();
  });

  it("after a reload, falls back to the bridge's line for the view: the words alone, the line whole under Sent to this session", () => {
    const entries = [entry("user", "2026-11-10T10:02:00.000Z", LINE)];
    const { container } = draw({ view: undefined, entries, sent: [sentOf(LINE)] });
    const bubble = container.querySelector("[data-slot=view-request] [data-slot=user-turn], [data-slot=view-request] > :first-child");
    expect(bubble).toHaveTextContent("Compare the two plans");
    expect(bubble?.textContent).not.toContain("rules");
    expect(container.querySelector("[data-slot=view-sent-line]")?.textContent).toBe(LINE);
    expect(statusLine(container)).toBe("Sent");
  });

  it("strips nothing from a person turn the bridge did not send through the view", () => {
    const lookalike = `${HEAD} Compare the two plans [rules: /elsewhere/bin/collie trick view morph help --session local/w1:p1#ab12]`;
    const { container } = draw({ view: undefined, entries: [entry("user", "2026-11-10T10:02:00.000Z", lookalike)], sent: [sentOf(LINE, "2026-11-10T10:01:00.000Z")] });
    expect(container.querySelector("[data-slot=view-request]")?.textContent).toContain("/elsewhere/bin/collie");
    expect(container.querySelector("[data-slot=view-sent-line]")).toBeNull();
  });

  it("rule 4: after a send, shows the exact line the bridge typed under Sent to this session, whole and in monospace", () => {
    const long = `${HEAD} ${"word ".repeat(40).trim()} ${TAIL}`;
    const { container } = draw({ view: undefined, request: mine("sent", { line: long }) });
    const sent = container.querySelector("[data-slot=view-sent]");
    expect(sent).toHaveTextContent("Sent to this session");
    const line = container.querySelector("[data-slot=view-sent-line]");
    expect(line?.tagName).toBe("PRE");
    expect(line?.textContent).toBe(long);
    expect(line?.className).toContain("font-mono");
    expect(line?.className).toContain("whitespace-pre-wrap");
    expect(line?.className).not.toMatch(/truncate|line-clamp/);
  });

  it("rule 4: the receipt of a tap shows the bridge's line, not the words the phone guessed", () => {
    const tapLine = `${HEAD} tapped "Ship" ${TAIL}`;
    const { container } = draw({ request: mine("sent", { text: 'tapped "Ship"', line: tapLine }) });
    expect(container.querySelector("[data-slot=view-sent-line]")?.textContent).toBe(tapLine);
  });

  it("a slash command typed in the terminal is no request: the empty state, no status line", () => {
    const { container } = draw({ view: undefined, entries: [entry("user", "2026-11-10T10:02:00.000Z", "/model")] });
    expect(container.querySelector("[data-slot=view-request]")).toBeNull();
    expect(statusLine(container)).toBeNull();
    expect(container.querySelector("[data-slot=agent-view]")?.getAttribute("data-state")).toBe("empty");
  });

  it("with no request anywhere, draws no request block", () => {
    const { container } = draw({ entries: [entry("assistant", "2026-11-10T10:00:02.000Z", "hello")] });
    expect(container.querySelector("[data-slot=view-request]")).toBeNull();
  });

  it("clamps a long request to four lines, and a tap opens it", () => {
    const text = "word ".repeat(60).trim();
    const { container } = draw({ view: undefined, request: mine("sent", { text }) });
    const clamped = () => container.querySelector("[data-slot=view-request] .line-clamp-4");
    expect(clamped()).not.toBeNull();
    fireEvent.click(container.querySelector("[data-slot=view-request] [role=button]")!);
    expect(clamped()).toBeNull();
    expect(container.querySelector("[data-slot=view-request] [role=button]")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("does not make a short request tappable", () => {
    const { container } = draw({ view: undefined, request: mine("sent") });
    expect(container.querySelector("[data-slot=view-request] [role=button]")).toBeNull();
    expect(container.querySelector("[data-slot=view-request] .line-clamp-4")).toBeNull();
  });
});

describe("a long line in a card", () => {
  const LONG = screenOf([
    { kind: "card", kids: [{ kind: "line", text: 'Now: a blue box "Starting…" sits in the input and the whole sentence runs on past the right edge of a phone' }] },
  ]);

  it("wraps and takes its own height: the screen container turns the sideways scroll and the fixed height off", () => {
    const { container } = draw({ view: LONG });
    const screenBox = container.querySelector("[data-slot=view-screen]");
    expect(screenBox?.className).toContain("[&_[data-trick-node=line]]:h-auto!");
    expect(screenBox?.className).toContain("[&_[data-trick-node=line]_span]:whitespace-pre-wrap");
    expect(screenBox?.className).toContain("[&_[data-trick-node=line]_span]:break-words");
    expect(VIEW_SCREEN_CLASS).toContain("aria-pressed=true");
    expect(container.querySelector("[data-trick-node=line]")).toHaveTextContent("sits in the input");
  });
});

describe("the operator's pick stays visible", () => {
  const bar = screenBlocks(BUTTONS)[1]!;

  it("marks the buttons it is given as pressed, filed under their block, and no other", () => {
    draw({ pressed: [`${bar.prefix}/1`] });
    expect(screen.getByRole("button", { name: "Wait" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Ship" })).not.toHaveAttribute("aria-pressed");
  });

  it("tells the hook the control, under its block, after a confirmed tap, and nothing after a failed one", async () => {
    const onPressed = vi.fn();
    draw({ onPressed, onTap: vi.fn(tapped) });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    });
    expect(onPressed).toHaveBeenCalledExactlyOnceWith(`${bar.prefix}/0`);
    cleanup();
    const failed = vi.fn();
    draw({ onPressed: failed, onTap: vi.fn(() => Promise.resolve<ViewSendResult>({ sent: false, line: null, code: "busy" })) });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Wait" }));
    });
    expect(failed).not.toHaveBeenCalled();
  });
});

describe("pictures and the decision block", () => {
  const MEDIA = [
    { id: "im_aaaaaaaaaaaaaaaa", kind: "image" as const, mime: "image/png" as const, bytes: 100, width: 390, height: 844, caption: "Now" },
    { id: "im_bbbbbbbbbbbbbbbb", kind: "image" as const, mime: "image/png" as const, bytes: 100, width: 390, height: 844, caption: "Compact" },
    { id: "im_cccccccccccccccc", kind: "image" as const, mime: "image/png" as const, bytes: 100, width: 390, height: 844, caption: "Tall" },
    { id: "im_dddddddddddddddd", kind: "image" as const, mime: "image/png" as const, bytes: 100, width: 800, height: 400, caption: "Loose" },
  ];

  function pictured(choice: ViewScreen["choice"]): ViewScreen {
    const parsed = parseAgentView([{ kind: "para", text: "The header" }, { kind: "image", attrs: { ref: "0" } }], "/view", { images: MEDIA.length });
    if (parsed.view === undefined) throw new Error(JSON.stringify(parsed.refusals));
    const out: ViewScreen = { rev: 4, at: AT, view: parsed.view, set: "dc_aaaaaaaaaaaa", media: MEDIA };
    if (choice !== undefined) out.choice = choice;
    return out;
  }

  const CHOICE: NonNullable<ViewScreen["choice"]> = {
    question: "Which header?",
    options: [
      { label: "Compact", detail: "One line", preview: 1 },
      { label: "Tall", confirm: "Sure?", preview: 2 },
    ],
    recommends: { option: 0, why: "More room for the list" },
  };

  it("places a picture by ref, and shows only the unplaced, unpreviewed one in the row", () => {
    const { container } = draw({ view: pictured(CHOICE) });
    // The view's picture: a frame that opens it at full size.
    expect(screen.getByRole("button", { name: "Open Now at full size" })).toBeInTheDocument();
    const strip = container.querySelector("[data-slot=image-strip]") ?? screen.getByRole("region", { name: "Images" });
    expect(strip.textContent).toContain("Loose");
    expect(strip.textContent).not.toContain("Compact");
  });

  it("draws the question, each option with its preview card, the star on the recommended one and its why", () => {
    const { container } = draw({ view: pictured(CHOICE) });
    expect(screen.getByText("Which header?")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-slot=view-option]")).toHaveLength(2);
    expect(container.querySelectorAll("[data-slot=view-option-preview]")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Open Compact at full size" })).toBeInTheDocument();
    const compact = screen.getByRole("button", { name: /^Compact/ });
    expect(compact.querySelector("[data-slot=view-recommended-mark]")).not.toBeNull();
    expect(screen.getByText("More room for the list")).toBeInTheDocument();
  });

  it("a pick sends picked with the label, holds the other option while in flight, and is marked after", async () => {
    let finish: (result: ViewSendResult) => void = () => undefined;
    const onTap = vi.fn(() => new Promise<ViewSendResult>((resolve) => (finish = resolve)));
    const onPressed = vi.fn();
    draw({ view: pictured(CHOICE), onTap, onPressed });
    fireEvent.click(screen.getByRole("button", { name: /^Compact/ }));
    expect(onTap).toHaveBeenCalledWith(tapOf(4, "choice/0", 'picked "Compact"'));
    expect(screen.getByRole("button", { name: /^Tall/ })).toBeDisabled();
    await act(async () => finish({ sent: true, line: null, code: null }));
    expect(onPressed).toHaveBeenCalledWith(choiceControl(CHOICE, 0));
  });

  it("lead 6: an option with confirm arms in Collie's words with the agent's line under them, then sends on the second tap", () => {
    vi.useFakeTimers();
    const onTap = vi.fn(tapped);
    draw({ view: pictured(CHOICE), onTap });
    fireEvent.click(screen.getByRole("button", { name: /^Tall/ }));
    expect(onTap).not.toHaveBeenCalled();
    const armed = screen.getByRole("button", { name: 'Tap again to send "Tall"' });
    expect(armed).toHaveAttribute("data-armed");
    expect(armed).toHaveTextContent("Sure?");
    act(() => vi.advanceTimersByTime(ARM_DWELL_MS));
    fireEvent.click(armed);
    expect(onTap).toHaveBeenCalledWith(tapOf(4, "choice/1", 'picked "Tall"'));
  });

  it("the picked option stays selected until the next screen", () => {
    draw({ view: pictured(CHOICE), pressed: [choiceControl(CHOICE, 1)] });
    expect(screen.getByRole("button", { name: /^Tall/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Compact/ })).toHaveAttribute("aria-pressed", "false");
  });
});

// ── blocks: fresh for this request, earlier ones folded ───────────────────────────────────────────

describe("fresh and earlier blocks", () => {
  const OLD = "2026-11-10T10:00:00.000Z";
  const NEW = "2026-11-10T10:02:30.000Z";
  const asked = mine("sent");

  function blocked(over: Partial<ViewScreen> = {}): ViewScreen {
    const parsed = parseAgentView([
      { kind: "para", text: "Old summary" },
      { kind: "bar", kids: [{ kind: "button", attrs: { label: "Old button", intent: "reply" } }] },
      { kind: "para", text: "New finding" },
    ]);
    if (parsed.view === undefined) throw new Error(JSON.stringify(parsed.refusals));
    return {
      rev: 5,
      at: NEW,
      title: "Plans",
      view: parsed.view,
      blocks: [
        { id: "summary", at: OLD },
        { id: "actions", at: OLD },
        { id: "finding", at: NEW },
      ],
      ...over,
    };
  }

  const openEarlier = () => {
    fireEvent.click(screen.getByRole("button", { name: /Earlier screen/ }));
    act(() => vi.runOnlyPendingTimers());
  };

  it("shows the blocks drawn for this request, and folds the earlier ones under one row with the title and the age", () => {
    vi.useFakeTimers();
    const { container } = draw({ view: blocked(), request: asked, working: true });
    expect(screen.getByText("New finding")).toBeInTheDocument();
    expect(screen.queryByText("Old summary")).toBeNull();
    const row = screen.getByRole("button", { name: /Earlier screen/ });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(row).toHaveTextContent("3 min ago");
    // The title belongs to the part with the answer: on top while anything is fresh.
    expect(screen.getByRole("heading", { name: "Plans" })).toBeInTheDocument();
    openEarlier();
    expect(container.querySelector("[data-slot=view-earlier-panel]")).toHaveTextContent("Earlier");
    expect(screen.getByText("Old summary")).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(WASH);
  });

  it("an earlier block's button sends nothing, sits out of reach, and keeps its look", () => {
    vi.useFakeTimers();
    const { container, props } = draw({ view: blocked(), request: asked, working: true });
    openEarlier();
    const old = screen.getByRole("button", { name: "Old button" });
    expect(old).not.toBeDisabled();
    expect(old.closest("[inert]")).not.toBeNull();
    fireEvent.click(old);
    expect(props.onTap).not.toHaveBeenCalled();
    expect(container.querySelector("[data-slot=view-earlier-blocks]")).not.toBeNull();
  });

  it("a kept block is fresh again: it leaves the fold for the answer", () => {
    const kept = blocked({ blocks: [{ id: "summary", at: NEW }, { id: "actions", at: OLD }, { id: "finding", at: NEW }] });
    draw({ view: kept, request: asked, working: true });
    expect(screen.getByText("Old summary")).toBeInTheDocument();
    expect(screen.getByText("New finding")).toBeInTheDocument();
  });

  it("the old screen folds when the send starts, and comes back live when it was not sent", () => {
    vi.useFakeTimers();
    const { rerender, props } = draw({ view: blocked({ blocks: [{ id: "summary", at: OLD }, { id: "actions", at: OLD }, { id: "finding", at: OLD }] }) });
    expect(screen.getByText("Old summary")).toBeInTheDocument();
    rerender(<AgentViewScreen {...props} request={mine("sending")} />);
    // It leaves with the presence collapse, then is gone from the answer.
    act(() => vi.advanceTimersByTime(PRESENCE_MS));
    expect(screen.queryByText("Old summary")).toBeNull();
    expect(screen.getByRole("button", { name: /Earlier screen/ })).toBeInTheDocument();
    rerender(<AgentViewScreen {...props} request={mine("failed", { reason: "No link" })} />);
    expect(screen.getByText("Old summary")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Old button" })).not.toBeDisabled();
    expect(screen.queryByRole("button", { name: /Earlier screen/ })).toBeNull();
  });

  it("a newer screen read while the agent works replaces the working one: its new block shows at once", () => {
    const first = blocked({ blocks: [{ id: "summary", at: OLD }, { id: "actions", at: OLD }, { id: "finding", at: OLD }] });
    const { rerender, props } = draw({ view: first, request: asked, working: true });
    expect(screen.queryByText("Fresh line")).toBeNull();
    const parsed = parseAgentView([
      { kind: "para", text: "Old summary" },
      { kind: "bar", kids: [{ kind: "button", attrs: { label: "Old button", intent: "reply" } }] },
      { kind: "para", text: "New finding" },
      { kind: "para", text: "Fresh line" },
    ]);
    if (parsed.view === undefined) throw new Error("bad view");
    rerender(<AgentViewScreen {...props} view={{ ...first, rev: 6, view: parsed.view, blocks: [...(first.blocks ?? []), { id: "fresh", at: NEW }] }} />);
    expect(screen.getByText("Fresh line")).toBeInTheDocument();
    expect(screen.queryByText("Old summary")).toBeNull();
  });

  it("a pending block shows its label and a calm placeholder while the agent works", () => {
    const parsed = parseAgentView([{ kind: "para", text: "Old summary" }, { kind: "spacer" }]);
    if (parsed.view === undefined) throw new Error("bad view");
    const { container } = draw({ view: { rev: 2, at: NEW, view: parsed.view, blocks: [{ id: "summary", at: OLD }, { id: "tests", at: NEW, pending: "Running the tests" }] }, request: asked, working: true });
    const pending = container.querySelector("[data-slot=view-pending]");
    expect(pending).toHaveTextContent("Running the tests");
    expect(pending?.querySelectorAll(".count-skeleton")).toHaveLength(2);
    expect(pending).toHaveAttribute("aria-busy", "true");
  });

  it("answered once the turn is over with a fresh block, never by an earlier one", () => {
    const { container } = draw({ view: blocked(), request: asked });
    expect(statusLine(container)).toBe("Answered · just now");
    cleanup();
    const stale = draw({ view: blocked({ blocks: [{ id: "summary", at: OLD }, { id: "actions", at: OLD }, { id: "finding", at: OLD }] }), request: asked });
    expect(statusLine(stale.container)).toBe("Sent");
  });

  it("lists the notes of this request under the line, newest last, older ones muted, four at most", () => {
    const notes = Array.from({ length: 5 }, (_, i) => ({ at: `2026-11-10T10:02:1${String(i)}.000Z`, note: `Step ${String(i)}` }));
    const { container } = draw({ view: blocked(), request: asked, working: true, drawing: { at: notes[4]!.at, notes: [{ at: OLD, note: "Before" }, ...notes] } });
    const shown = [...container.querySelectorAll("[data-slot=view-note]")];
    expect(shown.map((note) => note.textContent)).toEqual(["Step 1", "Step 2", "Step 3", "Step 4"]);
    expect(shown.at(-1)?.className).toContain("text-foreground");
    expect(shown[0]?.className).toContain("text-muted-foreground");
    expect(statusLine(container)).toBe("Drawing…");
  });
});

describe("the receipt of a pick, and a settled choice", () => {
  const MEDIA = [
    { id: "im_aaaaaaaaaaaaaaaa", kind: "image" as const, mime: "image/png" as const, bytes: 100, width: 390, height: 844, caption: "Compact" },
    { id: "im_bbbbbbbbbbbbbbbb", kind: "image" as const, mime: "image/png" as const, bytes: 100, width: 390, height: 844, caption: "Tall" },
  ];
  const CHOICE = { question: "Which header?", options: [{ label: "Compact", preview: 0 }, { label: "Tall", preview: 1 }] };
  const picked = (phase: ViewRequest["phase"], reason: string | null = null) => mine(phase, { text: 'picked "Compact"', reason });
  const asked: ViewScreen = { ...screenOf([{ kind: "para", text: "Two headers" }]), set: "dc_aaaaaaaaaaaa", media: MEDIA, choice: CHOICE, choiceAt: AT };

  it("stands in for the request bubble: the question, the label, the preview, and Sending… then the Answered badge", () => {
    const { container, rerender, props } = draw({ view: asked, request: picked("sending") });
    const receipt = container.querySelector("[data-slot=view-receipt]");
    expect(receipt).toHaveTextContent("Which header?");
    expect(container.querySelector("[data-slot=view-receipt-label]")).toHaveTextContent("Compact");
    expect(container.querySelector("[data-slot=view-receipt-preview]")).not.toBeNull();
    expect(container.querySelector("[data-slot=view-receipt-state] [data-slot=one-of-option][data-active], [data-slot=view-receipt-state]")).toHaveTextContent("Sending…");
    expect(container.querySelector("[data-slot=view-request] [data-slot=view-status]")).toBeNull();
    rerender(<AgentViewScreen {...props} request={picked("sent")} working />);
    expect(container.querySelector("[data-slot=view-receipt] [data-slot=view-answered-badge]")).toHaveTextContent("Answered");
    expect(container.querySelector("[data-slot=view-receipt]")?.getAttribute("data-phase")).toBe("sent");
    expect(statusLine(container)).toBe("The agent is working");
    expect(container.innerHTML).not.toMatch(WASH);
  });

  it("says Not sent with the reason, and the choice is live again", () => {
    const { container } = draw({ view: asked, request: picked("failed", "No link") });
    expect(container.querySelector("[data-slot=view-receipt]")?.getAttribute("data-phase")).toBe("failed");
    expect(container.querySelector("[data-slot=view-receipt-state]")).toHaveTextContent("Not sent: No link");
    expect(screen.getByRole("button", { name: /^Tall/ })).not.toBeDisabled();
  });

  it("a typed request keeps the chat bubble", () => {
    const { container } = draw({ view: asked, request: mine("sent") });
    expect(container.querySelector("[data-slot=view-receipt]")).toBeNull();
    expect(container.querySelector("[data-slot=view-request]")).toHaveTextContent("Compare the two plans");
  });

  it("a choice the agent sent with picked is settled: the pick marked with the badge, the others quiet rows, nothing to tap", () => {
    const { container } = draw({ view: { ...asked, choice: { ...CHOICE, picked: 1 } } });
    const done = container.querySelector("[data-slot=view-choice][data-done]");
    expect(done).not.toBeNull();
    expect(done?.querySelector("[data-slot=view-answered-badge]")).toHaveTextContent("Answered");
    const rows = [...container.querySelectorAll("[data-slot=view-option-done]")];
    expect(rows.map((row) => row.hasAttribute("data-picked"))).toEqual([false, true]);
    expect(rows[0]?.className).toContain("text-muted-foreground");
    expect(screen.queryByRole("button", { name: /^Tall/ })).toBeNull();
    expect(container.innerHTML).not.toMatch(WASH);
  });

  it("a choice the operator picked, in the Earlier fold, is settled on the pick with the mark kept", () => {
    vi.useFakeTimers();
    const { container } = draw({ view: asked, request: picked("sent"), pressed: [choiceControl(CHOICE, 0)] });
    fireEvent.click(screen.getByRole("button", { name: /Earlier screen/ }));
    act(() => vi.runOnlyPendingTimers());
    const done = container.querySelector("[data-slot=view-earlier-panel] [data-slot=view-choice][data-done]");
    expect(done).not.toBeNull();
    expect(done?.querySelector("[data-picked]")).toHaveTextContent("Compact");
  });
});

// ── review 10 (the web half's security read) ─────────────────────────────────────────────────────

/** Every element between `from` and the view's screen, `from` included: what decides whether its words show. */
function boxesUp(from: Element): Element[] {
  const out: Element[] = [];
  for (let at: Element | null = from; at !== null && at.getAttribute("data-slot") !== "view-screen"; at = at.parentElement) out.push(at);
  return out;
}

/**
 * Whether any box from `from` up cuts its words: to one line (an ellipsis, a clamp, no wrap) or to a fixed
 * height (`h-11`, an inline height). A box that clips (`overflow-hidden`) but grows with its words cuts nothing.
 */
function cutsWords(from: Element): boolean {
  return boxesUp(from).some((box) => /(^|\s)(truncate|line-clamp-\d|whitespace-nowrap|h-11)(\s|$)/u.test(box.className) || (box instanceof HTMLElement && box.style.height !== ""));
}

describe("review 10 W1: a button's label is shown whole", () => {
  // 24 CJK characters, the schema's cap for a label (the wire's 60 never binds), three buttons in a bar: at
  // 360 px each is a third wide (about seven CJK characters), so the label must
  // wrap and the button grow. A tap sends every word, so no word may sit past an ellipsis (rule 3).
  const long = "発".repeat(24);
  const view = screenOf([
    {
      kind: "bar",
      kids: [
        { kind: "button", attrs: { label: long, intent: "a" } },
        { kind: "button", attrs: { label: "Wait", intent: "b" } },
        { kind: "button", attrs: { label: "Drop", intent: "c" } },
      ],
    },
  ]);

  it("W1: a 24-character CJK label in a bar of three wraps, and its button grows", () => {
    draw({ view });
    // The label's cell and the busy cell (one grid, ui/one-of.tsx) both hold it: neither may cut it.
    const shown = screen.getAllByText(long);
    expect(shown.length).toBeGreaterThan(0);
    for (const words of shown) {
      expect(words.textContent).toBe(long);
      expect(words.className).toContain("whitespace-normal");
      expect(cutsWords(words)).toBe(false);
    }
    const button = screen.getByRole("button", { name: long });
    expect(button.className).toContain("min-h-11");
  });

  it("W1: a long label on a row's own button wraps too", () => {
    draw({ view: screenOf([{ kind: "list", kids: [{ kind: "row", text: "Deploy", kids: [{ kind: "button", attrs: { label: long, intent: "a" } }] }] }]) });
    for (const words of screen.getAllByText(long)) expect(cutsWords(words)).toBe(false);
  });
});

describe("review 10 W2: an armed button shows and announces the words its second tap sends", () => {
  const grouped = screenOf([
    {
      kind: "group",
      attrs: { label: "Release candidate" },
      kids: [{ kind: "bar", kids: [{ kind: "button", attrs: { label: "Drop", intent: "drop", confirm: "Sure?" } }] }],
    },
  ]);

  it("W2: the armed words name the label and the group, on the button and in a live region", () => {
    vi.useFakeTimers();
    const { container } = draw({ view: grouped });
    const words = 'Tap again to send "Drop" in "Release candidate"';
    const live = container.querySelector("[data-slot=view-armed-live]");
    expect(live).not.toBeNull();
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live?.textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Drop" }));
    const armed = screen.getByRole("button", { name: words });
    expect(armed).toHaveAttribute("data-armed");
    expect(armed).toHaveTextContent(words);
    expect(live?.textContent).toBe(words);
    // The button holds the whole sentence: nothing cuts it.
    for (const shown of screen.getAllByText(words)) expect(cutsWords(shown)).toBe(false);
  });
});

describe("review 10 W3: a control is inert until it has stood still for 500 ms", () => {
  /** The screen with its production settle window: the prop left out. */
  function drawSettling(overrides: Partial<AgentViewScreenProps> = {}) {
    const drawn = draw(overrides);
    const props: AgentViewScreenProps = { ...drawn.props };
    delete props.settleMs;
    drawn.rerender(<AgentViewScreen {...props} />);
    return { ...drawn, props };
  }

  it("W3: the window is 500 ms", () => {
    expect(VIEW_SETTLE_MS).toBe(500);
  });

  it("W3: a tap on a button that just mounted sends nothing; the same tap 500 ms later sends", () => {
    vi.useFakeTimers();
    const { props } = drawSettling();
    fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    act(() => vi.advanceTimersByTime(VIEW_SETTLE_MS - 1));
    fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    expect(props.onTap).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    expect(props.onTap).toHaveBeenCalledExactlyOnceWith(tapOf(1, "v/1/0", 'tapped "Ship"'));
  });

  it("W3: a confirm that just mounted does not arm", () => {
    vi.useFakeTimers();
    drawSettling();
    fireEvent.click(screen.getByRole("button", { name: "Drop" }));
    expect(screen.getByRole("button", { name: "Drop" })).not.toHaveAttribute("data-armed");
  });

  it("W3: a redraw that moves another button into the tapped spot makes it inert for 500 ms", () => {
    vi.useFakeTimers();
    const { props, rerender } = drawSettling();
    act(() => vi.advanceTimersByTime(VIEW_SETTLE_MS));
    // The agent redraws the bar with Drop first: the finger that went for Ship now lands on Drop.
    const moved = screenOf([
      { kind: "para", text: "Ready to ship?" },
      {
        kind: "bar",
        kids: [
          { kind: "button", attrs: { label: "Drop", intent: "drop" } },
          { kind: "button", attrs: { label: "Ship", intent: "ship" } },
        ],
      },
    ]);
    rerender(<AgentViewScreen {...props} view={{ ...moved, rev: 2 }} />);
    const first = screen.getAllByRole("button")[0];
    expect(first).toHaveAccessibleName("Drop");
    if (first === undefined) throw new Error("no button");
    fireEvent.click(first);
    act(() => vi.advanceTimersByTime(VIEW_SETTLE_MS - 1));
    fireEvent.click(first);
    expect(props.onTap).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    fireEvent.click(first);
    expect(props.onTap).toHaveBeenCalledExactlyOnceWith(tapOf(2, "v/1/0", 'tapped "Drop"'));
  });

  it("W3: a line arriving above the screen (the sent line) makes the buttons inert for 500 ms", () => {
    vi.useFakeTimers();
    const request: ViewRequest = { text: "go on", at: Date.parse(AT) - 60_000, phase: "sending", reason: null, line: null };
    const { props, rerender } = drawSettling({ request });
    act(() => vi.advanceTimersByTime(VIEW_SETTLE_MS));
    rerender(<AgentViewScreen {...props} request={{ ...request, phase: "sent", line: "[view:morph local/w1:p1#ab12] from operator: go on" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    expect(props.onTap).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(VIEW_SETTLE_MS));
    fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    expect(props.onTap).toHaveBeenCalledTimes(1);
  });

  it("W3: an option of the decision block that just mounted takes no pick", () => {
    vi.useFakeTimers();
    const view: ViewScreen = { ...BUTTONS, choice: { question: "Which?", options: [{ label: "Lean" }, { label: "Full" }] } };
    const { props } = drawSettling({ view });
    fireEvent.click(screen.getByRole("button", { name: "Lean" }));
    expect(props.onTap).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(VIEW_SETTLE_MS));
    fireEvent.click(screen.getByRole("button", { name: "Lean" }));
    expect(props.onTap).toHaveBeenCalledExactlyOnceWith(tapOf(1, "choice/0", 'picked "Lean"'));
  });
});

describe("review 10 W4: a linked run shows where it goes", () => {
  it("W4: a run with an href is followed by its host, as a link is", () => {
    const { container } = draw({ view: screenOf([{ kind: "para", kids: [{ kind: "run", text: "Read the notes", attrs: { href: "https://notes.example/x" } }] }]) });
    const anchor = screen.getByRole("link", { name: "Read the notes" });
    expect(anchor).toHaveAttribute("href", "https://notes.example/x");
    const host = container.querySelector("[data-trick-link-host]");
    expect(host?.textContent).toBe("notes.example");
  });

  it("W4: a host in another script shows as the browser reads it (punycode), whole", () => {
    const { container } = draw({ view: screenOf([{ kind: "para", kids: [{ kind: "run", text: "Notes", attrs: { href: "https://b\u00fccher.example/x" } }] }]) });
    expect(container.querySelector("[data-trick-link-host]")?.textContent).toBe("xn--bcher-kva.example");
  });
});
