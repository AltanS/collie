import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ARM_DWELL_MS } from "@/lib/arm";
import type { JsonValue } from "@/lib/json";
import { parseMorphView, type MorphView as MorphScreen } from "@/lib/morph/wire";
import type { TranscriptEntry } from "@/lib/types";

import { choiceControl, screenBlocks, type MorphRequest } from "@/lib/morph/reader";
import { MORPH_SCREEN_CLASS, MorphView, type MorphViewProps } from "./morph-view";
import { PRESENCE_MS } from "./ui/presence";

// The Morph body: its states (no screen, a screen alone, a request in work, answered, not sent), the split
// of fresh blocks from the ones drawn for an earlier request, its taps (the value or the label, the
// confirm's second tap, one send at a time), and the receipt of a pick.

const AT = "2026-11-10T10:00:00.000Z";
const NOW = Date.parse("2026-11-10T10:03:00.000Z");

function screenOf(raw: JsonValue, title?: string): MorphScreen {
  const parsed = parseMorphView(raw);
  if (parsed.view === undefined) throw new Error(JSON.stringify(parsed.refusals));
  const out: MorphScreen = { rev: 1, at: AT, view: parsed.view };
  if (title !== undefined) out.title = title;
  return out;
}

const BUTTONS = screenOf(
  [
    { kind: "para", text: "Ready to ship?" },
    {
      kind: "bar",
      kids: [
        { kind: "button", attrs: { label: "Ship", intent: "ship", value: "Ship it now" } },
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

function draw(overrides: Partial<MorphViewProps> = {}) {
  const props: MorphViewProps = {
    session: "local/w1:p1#ab12",
    view: BUTTONS,
    working: false,
    entries: [],
    canAct: true,
    onSend: vi.fn(() => Promise.resolve(true)),
    onLink: vi.fn(),
    now: NOW,
    ...overrides,
  };
  const result = render(<MorphView {...props} />);
  return { ...result, props };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the Morph body's states", () => {
  it("with no screen yet and no request, says how to begin", () => {
    const { container } = draw({ view: undefined });
    expect(screen.getByText("Ask for something. The agent draws the answer here.")).toBeInTheDocument();
    expect(container.querySelector("[data-slot=morph-view]")?.getAttribute("data-state")).toBe("empty");
  });

  it("draws the title, the caption with the screen's age, and the screen", () => {
    const { container } = draw();
    expect(screen.getByRole("heading", { name: "Release" })).toBeInTheDocument();
    expect(screen.getByText("Drawn by the agent · 3 min ago")).toBeInTheDocument();
    expect(screen.getByText("Ready to ship?")).toBeInTheDocument();
    expect(container.querySelector("[data-slot=morph-view]")?.getAttribute("data-state")).toBe("view");
  });

  it("while the turn runs with no request, keeps the screen at full contrast with the working mark", () => {
    const { container } = draw({ working: true });
    expect(container.querySelector("[data-slot=morph-view]")?.getAttribute("data-state")).toBe("view");
    expect(container.querySelector("[data-slot=morph-screen]")?.className).not.toContain("opacity");
    expect(screen.getByText("Ready to ship?")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Still working…");
  });

  it("a text answer to a later request: the text, and the earlier screen folded under one row, never promoted", () => {
    const entries = [
      entry("user", "2026-11-10T09:59:00.000Z", "draw it"),
      entry("assistant", "2026-11-10T10:00:02.000Z", "Drew the release screen."),
      entry("user", "2026-11-10T10:01:00.000Z", "why wait?"),
      entry("assistant", "2026-11-10T10:01:30.000Z", "CI is still **red**."),
    ];
    const { container } = draw({ entries });
    expect(container.querySelector("[data-slot=morph-view]")?.getAttribute("data-state")).toBe("answered");
    expect(screen.getByText("The agent answered in text")).toBeInTheDocument();
    expect(container.querySelector("[data-slot=morph-text]")).toHaveTextContent("CI is still red.");
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

describe("a tap on the Morph screen", () => {
  it("sends tapped with the label, and the value after a colon", async () => {
    const { props } = draw();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Wait" }));
    });
    expect(props.onSend).toHaveBeenNthCalledWith(1, 'tapped "Ship": Ship it now');
    expect(props.onSend).toHaveBeenNthCalledWith(2, 'tapped "Wait"');
  });

  it("with confirm, arms on the first tap and sends on the second", () => {
    vi.useFakeTimers();
    const { props } = draw();
    fireEvent.click(screen.getByRole("button", { name: "Drop" }));
    expect(props.onSend).not.toHaveBeenCalled();
    const armed = screen.getByRole("button", { name: "Really drop?" });
    act(() => vi.advanceTimersByTime(ARM_DWELL_MS));
    fireEvent.click(armed);
    expect(props.onSend).toHaveBeenCalledExactlyOnceWith('tapped "Drop"');
  });

  it("waits on every button while a send is in flight", async () => {
    let finish: (sent: boolean) => void = () => {};
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    draw({ onSend });
    fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    expect(screen.getByRole("button", { name: "Wait" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Wait" }));
    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => finish(false));
    expect(screen.getByRole("button", { name: "Wait" })).not.toBeDisabled();
  });

  it("sends nothing where nothing may act", () => {
    const { props } = draw({ canAct: false });
    expect(screen.getByRole("button", { name: "Ship" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    expect(props.onSend).not.toHaveBeenCalled();
  });
});

// ── the request block ──────────────────────────────────────────────────────────────────────────

const HEAD = "[morph] from operator:";
const HINT = "[rules: /bin/collie morph help --session local/w1:p1#ab12]";
const SENT_AT = Date.parse("2026-11-10T10:02:00.000Z");
const mine = (phase: MorphRequest["phase"], over: Partial<MorphRequest> = {}): MorphRequest => ({ text: "Compare the two plans", phase, reason: null, at: SENT_AT, ...over });
/** A grey wash on content: a lowered opacity or a grayscale as a class of its own (a `disabled:` variant is a control's). */
const WASH = /(?<![\w:-])(opacity-(50|60)|grayscale)/;
const statusLine = (container: HTMLElement): string | null => container.querySelector("[data-slot=morph-status]")?.textContent ?? null;

describe("the operator's request in the Morph body", () => {
  it("shows the request at once on send, with no head and no hint in it, and Sending…", () => {
    const { container } = draw({ view: undefined, request: mine("sending"), head: HEAD, hint: HINT });
    expect(container.querySelector("[data-slot=morph-request]")).toHaveTextContent("Compare the two plans");
    expect(container.querySelector("[data-slot=morph-request]")?.textContent).not.toContain("rules");
    expect(container.querySelector("[data-slot=morph-request]")?.textContent).not.toContain("[morph]");
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
    const morphing = draw({ view: undefined, request: mine("sent"), working: true, drawing: { at: "2026-11-10T10:02:30.000Z", note: "Comparing plans" } });
    expect(screen.queryByText("Ask for something. The agent draws the answer here.")).toBeNull();
    expect(statusLine(morphing.container)).toBe("Morphing…");
    expect(morphing.container.querySelector("[data-slot=morph-notes]")).toHaveTextContent("Comparing plans");
  });

  it("says Not sent with the composer's own words, and does not dim the old screen", () => {
    const { container } = draw({ request: mine("failed", { reason: "The link is down" }) });
    expect(statusLine(container)).toBe("Not sent: The link is down");
    expect(container.querySelector("[data-slot=morph-screen]")?.className).not.toContain("opacity");
    // A send that failed folds nothing: the screen is live again.
    expect(screen.getByRole("button", { name: "Ship" })).not.toBeDisabled();
    expect(screen.queryByRole("button", { name: /Earlier screen/ })).toBeNull();
  });

  it("says Sent, then The agent is working, then Morphing… (without a note too), each as the one line", () => {
    const sent = draw({ request: mine("sent") });
    expect(statusLine(sent.container)).toBe("Sent");
    expect(sent.container.querySelectorAll("[data-slot=morph-status]")).toHaveLength(1);
    cleanup();
    expect(statusLine(draw({ request: mine("sent"), working: true }).container)).toBe("The agent is working");
    cleanup();
    expect(statusLine(draw({ request: mine("sent"), working: true, drawing: { at: "2026-11-10T10:02:30.000Z" } }).container)).toBe("Morphing…");
  });

  it("while the request is unanswered, folds the old screen under Earlier screen, with the working mark on Morphing…", () => {
    const { container } = draw({ request: mine("sent"), working: true, drawing: { at: "2026-11-10T10:02:30.000Z", note: "Comparing plans" } });
    expect(container.querySelector("[data-slot=morph-status] [data-slot=status-dot], [data-slot=morph-status] svg, [data-slot=morph-status] span")).not.toBeNull();
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
    const entries = [entry("user", "2026-11-10T10:02:00.000Z", `${HEAD} Compare the two plans ${HINT}`), entry("assistant", "2026-11-10T10:02:20.000Z", "Plan B is **cheaper**.")];
    const { container } = draw({ view: undefined, entries, head: HEAD, hint: HINT });
    expect(statusLine(container)).toMatch(/^Answered/);
    expect(container.querySelector("[data-slot=morph-text]")).toHaveTextContent("Plan B is cheaper.");
    expect(screen.queryByText("Ask for something. The agent draws the answer here.")).toBeNull();
  });

  it("after a reload, falls back to the latest person turn of the chat, its head and hint stripped", () => {
    const entries = [entry("user", "2026-11-10T10:02:00.000Z", `${HEAD} Compare the two plans ${HINT}`)];
    const { container } = draw({ view: undefined, entries, head: HEAD, hint: HINT });
    expect(container.querySelector("[data-slot=morph-request]")).toHaveTextContent("Compare the two plans");
    expect(container.querySelector("[data-slot=morph-request]")?.textContent).not.toContain("rules");
    expect(statusLine(container)).toBe("Sent");
  });

  it("strips a hint whose wording changed since the send", () => {
    const entries = [entry("user", "2026-11-10T10:02:00.000Z", `${HEAD} Compare the two plans [rules: /old/bin/collie morph help --session local/w1:p1#ab12]`)];
    const { container } = draw({ view: undefined, entries, head: HEAD, hint: HINT });
    expect(container.querySelector("[data-slot=morph-request]")?.textContent).not.toContain("rules");
  });

  it("a slash command typed in the terminal is no request: the empty state, no status line", () => {
    const { container } = draw({ view: undefined, entries: [entry("user", "2026-11-10T10:02:00.000Z", "/model")] });
    expect(container.querySelector("[data-slot=morph-request]")).toBeNull();
    expect(statusLine(container)).toBeNull();
    expect(container.querySelector("[data-slot=morph-view]")?.getAttribute("data-state")).toBe("empty");
  });

  it("with no request anywhere, draws no request block", () => {
    const { container } = draw({ entries: [entry("assistant", "2026-11-10T10:00:02.000Z", "hello")] });
    expect(container.querySelector("[data-slot=morph-request]")).toBeNull();
  });

  it("clamps a long request to four lines, and a tap opens it", () => {
    const text = "word ".repeat(60).trim();
    const { container } = draw({ view: undefined, request: mine("sent", { text }) });
    const clamped = () => container.querySelector("[data-slot=morph-request] .line-clamp-4");
    expect(clamped()).not.toBeNull();
    fireEvent.click(container.querySelector("[data-slot=morph-request] [role=button]")!);
    expect(clamped()).toBeNull();
    expect(container.querySelector("[data-slot=morph-request] [role=button]")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("does not make a short request tappable", () => {
    const { container } = draw({ view: undefined, request: mine("sent") });
    expect(container.querySelector("[data-slot=morph-request] [role=button]")).toBeNull();
    expect(container.querySelector("[data-slot=morph-request] .line-clamp-4")).toBeNull();
  });
});

describe("a long line in a card", () => {
  const LONG = screenOf([
    { kind: "card", kids: [{ kind: "line", text: 'Now: a blue box "Starting…" sits in the input and the whole sentence runs on past the right edge of a phone' }] },
  ]);

  it("wraps and takes its own height: the screen container turns the sideways scroll and the fixed height off", () => {
    const { container } = draw({ view: LONG });
    const screenBox = container.querySelector("[data-slot=morph-screen]");
    expect(screenBox?.className).toContain("[&_[data-trick-node=line]]:h-auto!");
    expect(screenBox?.className).toContain("[&_[data-trick-node=line]_span]:whitespace-pre-wrap");
    expect(screenBox?.className).toContain("[&_[data-trick-node=line]_span]:break-words");
    expect(MORPH_SCREEN_CLASS).toContain("aria-pressed=true");
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
    draw({ onPressed, onSend: vi.fn(() => Promise.resolve(true)) });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    });
    expect(onPressed).toHaveBeenCalledExactlyOnceWith(`${bar.prefix}/0`);
    cleanup();
    const failed = vi.fn();
    draw({ onPressed: failed, onSend: vi.fn(() => Promise.resolve(false)) });
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

  function pictured(choice: MorphScreen["choice"]): MorphScreen {
    const parsed = parseMorphView([{ kind: "para", text: "The header" }, { kind: "image", attrs: { ref: "0" } }], "/view", { images: MEDIA.length });
    if (parsed.view === undefined) throw new Error(JSON.stringify(parsed.refusals));
    const out: MorphScreen = { rev: 4, at: AT, view: parsed.view, set: "dc_aaaaaaaaaaaa", media: MEDIA };
    if (choice !== undefined) out.choice = choice;
    return out;
  }

  const CHOICE: NonNullable<MorphScreen["choice"]> = {
    question: "Which header?",
    options: [
      { label: "Compact", detail: "One line", value: "Use the compact header.", preview: 1 },
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
    expect(container.querySelectorAll("[data-slot=morph-option-card]")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Open Compact at full size" })).toBeInTheDocument();
    expect(container.querySelector("[data-slot=morph-choice-options]")?.getAttribute("data-layout")).toBe("side");
    const compact = screen.getByRole("button", { name: /^Compact/ });
    expect(compact.querySelector("[data-slot=morph-recommended-mark]")).not.toBeNull();
    expect(screen.getByText("More room for the list")).toBeInTheDocument();
  });

  it("a pick sends picked with the value, holds the other option while in flight, and is marked after", async () => {
    let finish: (sent: boolean) => void = () => undefined;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const onPressed = vi.fn();
    draw({ view: pictured(CHOICE), onSend, onPressed });
    fireEvent.click(screen.getByRole("button", { name: /^Compact/ }));
    expect(onSend).toHaveBeenCalledWith('picked "Compact": Use the compact header.');
    expect(screen.getByRole("button", { name: /^Tall/ })).toBeDisabled();
    await act(async () => finish(true));
    expect(onPressed).toHaveBeenCalledWith(choiceControl(CHOICE, 0));
  });

  it("an option with confirm needs two taps; a pick without a value sends the label alone", () => {
    vi.useFakeTimers();
    const onSend = vi.fn(() => Promise.resolve(true));
    draw({ view: pictured(CHOICE), onSend });
    fireEvent.click(screen.getByRole("button", { name: /^Tall/ }));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sure?: tap again to confirm" })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(ARM_DWELL_MS));
    fireEvent.click(screen.getByRole("button", { name: "Sure?: tap again to confirm" }));
    expect(onSend).toHaveBeenCalledWith('picked "Tall"');
  });

  it("the picked option stays selected until the next screen", () => {
    draw({ view: pictured(CHOICE), pressed: [choiceControl(CHOICE, 1)] });
    expect(screen.getByRole("button", { name: /^Tall/ }).className).toContain("bg-primary/10");
  });

  it("stacks options when a text would not stay readable side by side", () => {
    const long = { ...CHOICE, options: [CHOICE.options[0]!, { label: "Tall", detail: "A title, a subtitle and the search field under them, all in view", preview: 2 }] };
    const { container } = draw({ view: pictured(long) });
    expect(container.querySelector("[data-slot=morph-choice-options]")?.getAttribute("data-layout")).toBe("stack");
  });
});

// ── blocks: fresh for this request, earlier ones folded ───────────────────────────────────────────

describe("fresh and earlier blocks", () => {
  const OLD = "2026-11-10T10:00:00.000Z";
  const NEW = "2026-11-10T10:02:30.000Z";
  const asked = mine("sent");

  function blocked(over: Partial<MorphScreen> = {}): MorphScreen {
    const parsed = parseMorphView([
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
    expect(container.querySelector("[data-slot=morph-earlier-panel]")).toHaveTextContent("Earlier");
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
    expect(props.onSend).not.toHaveBeenCalled();
    expect(container.querySelector("[data-slot=morph-earlier-blocks]")).not.toBeNull();
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
    rerender(<MorphView {...props} request={mine("sending")} />);
    // It leaves with the presence collapse, then is gone from the answer.
    act(() => vi.advanceTimersByTime(PRESENCE_MS));
    expect(screen.queryByText("Old summary")).toBeNull();
    expect(screen.getByRole("button", { name: /Earlier screen/ })).toBeInTheDocument();
    rerender(<MorphView {...props} request={mine("failed", { reason: "No link" })} />);
    expect(screen.getByText("Old summary")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Old button" })).not.toBeDisabled();
    expect(screen.queryByRole("button", { name: /Earlier screen/ })).toBeNull();
  });

  it("a newer screen read while the agent works replaces the working one: its new block shows at once", () => {
    const first = blocked({ blocks: [{ id: "summary", at: OLD }, { id: "actions", at: OLD }, { id: "finding", at: OLD }] });
    const { rerender, props } = draw({ view: first, request: asked, working: true });
    expect(screen.queryByText("Fresh line")).toBeNull();
    const parsed = parseMorphView([
      { kind: "para", text: "Old summary" },
      { kind: "bar", kids: [{ kind: "button", attrs: { label: "Old button", intent: "reply" } }] },
      { kind: "para", text: "New finding" },
      { kind: "para", text: "Fresh line" },
    ]);
    if (parsed.view === undefined) throw new Error("bad view");
    rerender(<MorphView {...props} view={{ ...first, rev: 6, view: parsed.view, blocks: [...(first.blocks ?? []), { id: "fresh", at: NEW }] }} />);
    expect(screen.getByText("Fresh line")).toBeInTheDocument();
    expect(screen.queryByText("Old summary")).toBeNull();
  });

  it("a pending block shows its label and a calm placeholder while the agent works", () => {
    const parsed = parseMorphView([{ kind: "para", text: "Old summary" }, { kind: "spacer" }]);
    if (parsed.view === undefined) throw new Error("bad view");
    const { container } = draw({ view: { rev: 2, at: NEW, view: parsed.view, blocks: [{ id: "summary", at: OLD }, { id: "tests", at: NEW, pending: "Running the tests" }] }, request: asked, working: true });
    const pending = container.querySelector("[data-slot=morph-pending]");
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
    const shown = [...container.querySelectorAll("[data-slot=morph-note]")];
    expect(shown.map((note) => note.textContent)).toEqual(["Step 1", "Step 2", "Step 3", "Step 4"]);
    expect(shown.at(-1)?.className).toContain("text-foreground");
    expect(shown[0]?.className).toContain("text-muted-foreground");
    expect(statusLine(container)).toBe("Morphing…");
  });
});

describe("the receipt of a pick, and a settled choice", () => {
  const MEDIA = [
    { id: "im_aaaaaaaaaaaaaaaa", kind: "image" as const, mime: "image/png" as const, bytes: 100, width: 390, height: 844, caption: "Compact" },
    { id: "im_bbbbbbbbbbbbbbbb", kind: "image" as const, mime: "image/png" as const, bytes: 100, width: 390, height: 844, caption: "Tall" },
  ];
  const CHOICE = { question: "Which header?", options: [{ label: "Compact", value: "Use the compact header.", preview: 0 }, { label: "Tall", preview: 1 }] };
  const picked = (phase: MorphRequest["phase"], reason: string | null = null) => mine(phase, { text: 'picked "Compact": Use the compact header.', reason });
  const asked: MorphScreen = { ...screenOf([{ kind: "para", text: "Two headers" }]), set: "dc_aaaaaaaaaaaa", media: MEDIA, choice: CHOICE, choiceAt: AT };

  it("stands in for the request bubble: the question, the label, the preview, and Sending… then the Answered badge", () => {
    const { container, rerender, props } = draw({ view: asked, request: picked("sending") });
    const receipt = container.querySelector("[data-slot=morph-receipt]");
    expect(receipt).toHaveTextContent("Which header?");
    expect(container.querySelector("[data-slot=morph-receipt-label]")).toHaveTextContent("Compact");
    expect(container.querySelector("[data-slot=morph-receipt-preview]")).not.toBeNull();
    expect(container.querySelector("[data-slot=morph-receipt-state] [data-slot=one-of-option][data-active], [data-slot=morph-receipt-state]")).toHaveTextContent("Sending…");
    expect(container.querySelector("[data-slot=morph-request] [data-slot=morph-status]")).toBeNull();
    rerender(<MorphView {...props} request={picked("sent")} working />);
    expect(container.querySelector("[data-slot=morph-receipt] [data-slot=morph-answered-badge]")).toHaveTextContent("Answered");
    expect(container.querySelector("[data-slot=morph-receipt]")?.getAttribute("data-phase")).toBe("sent");
    expect(statusLine(container)).toBe("The agent is working");
    expect(container.innerHTML).not.toMatch(WASH);
  });

  it("says Not sent with the reason, and the choice is live again", () => {
    const { container } = draw({ view: asked, request: picked("failed", "No link") });
    expect(container.querySelector("[data-slot=morph-receipt]")?.getAttribute("data-phase")).toBe("failed");
    expect(container.querySelector("[data-slot=morph-receipt-state]")).toHaveTextContent("Not sent: No link");
    expect(screen.getByRole("button", { name: /^Tall/ })).not.toBeDisabled();
  });

  it("a typed request keeps the chat bubble", () => {
    const { container } = draw({ view: asked, request: mine("sent") });
    expect(container.querySelector("[data-slot=morph-receipt]")).toBeNull();
    expect(container.querySelector("[data-slot=morph-request]")).toHaveTextContent("Compare the two plans");
  });

  it("a choice the agent sent with picked is settled: the pick marked with the badge, the others quiet rows, nothing to tap", () => {
    const { container } = draw({ view: { ...asked, choice: { ...CHOICE, picked: 1 } } });
    const done = container.querySelector("[data-slot=morph-choice][data-done]");
    expect(done).not.toBeNull();
    expect(done?.querySelector("[data-slot=morph-answered-badge]")).toHaveTextContent("Answered");
    const rows = [...container.querySelectorAll("[data-slot=morph-option-done]")];
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
    const done = container.querySelector("[data-slot=morph-earlier-panel] [data-slot=morph-choice][data-done]");
    expect(done).not.toBeNull();
    expect(done?.querySelector("[data-picked]")).toHaveTextContent("Compact");
  });
});
