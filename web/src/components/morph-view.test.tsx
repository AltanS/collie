import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ARM_DWELL_MS } from "@/lib/arm";
import type { JsonValue } from "@/lib/json";
import { parseMorphView, type MorphView as MorphScreen } from "@/lib/morph/wire";
import type { TranscriptEntry } from "@/lib/types";

import type { MorphRequest } from "@/lib/morph/reader";
import { MORPH_SCREEN_CLASS, MorphView, type MorphViewProps } from "./morph-view";

// The Morph body: its three states (no screen, the turn running, a text answer after the screen) and its
// taps (the value or the label, the confirm's second tap, one send at a time).

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

  it("while the turn runs, keeps the screen dimmed with the working mark", () => {
    const { container } = draw({ working: true });
    expect(container.querySelector("[data-slot=morph-view]")?.getAttribute("data-state")).toBe("working");
    expect(container.querySelector("[data-slot=morph-screen]")?.className).toContain("opacity-60");
    expect(screen.getByText("Ready to ship?")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Still working…");
  });

  it("draws the agent's text answer to a later request under the screen", () => {
    const entries = [
      entry("user", "2026-11-10T09:59:00.000Z", "draw it"),
      entry("assistant", "2026-11-10T10:00:02.000Z", "Drew the release screen."),
      entry("user", "2026-11-10T10:01:00.000Z", "why wait?"),
      entry("assistant", "2026-11-10T10:01:30.000Z", "CI is still **red**."),
    ];
    const { container } = draw({ entries });
    expect(container.querySelector("[data-slot=morph-view]")?.getAttribute("data-state")).toBe("text");
    expect(screen.getByText("The agent answered in text")).toBeInTheDocument();
    expect(container.querySelector("[data-slot=morph-text]")).toHaveTextContent("CI is still red.");
    expect(screen.queryByText("Drew the release screen.")).toBeNull();
    expect(screen.getByText("Ready to ship?")).toBeInTheDocument();
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
    expect(statusLine(morphing.container)).toBe("Morphing… Comparing plans");
  });

  it("says Not sent with the composer's own words, and does not dim the old screen", () => {
    const { container } = draw({ request: mine("failed", { reason: "The link is down" }) });
    expect(statusLine(container)).toBe("Not sent: The link is down");
    expect(container.querySelector("[data-slot=morph-screen]")?.className).not.toContain("opacity-60");
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

  it("keeps the old screen dimmed while the request is unanswered, with the working mark on Morphing…", () => {
    const { container } = draw({ request: mine("sent"), working: true, drawing: { at: "2026-11-10T10:02:30.000Z", note: "Comparing plans" } });
    expect(container.querySelector("[data-slot=morph-screen]")?.className).toContain("opacity-60");
    expect(container.querySelector("[data-slot=morph-status] [data-slot=status-dot], [data-slot=morph-status] svg, [data-slot=morph-status] span")).not.toBeNull();
    expect(screen.getByText("Ready to ship?")).toBeInTheDocument();
  });

  it("says Answered with the screen's age once a screen newer than the request arrived, and stops dimming", () => {
    const { container } = draw({ request: mine("sent", { at: Date.parse("2026-11-10T09:58:00.000Z") }) });
    expect(statusLine(container)).toBe("Answered · 3 min ago");
    expect(container.querySelector("[data-slot=morph-screen]")?.className).not.toContain("opacity-60");
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
  it("marks the buttons it is given as pressed, and no other", () => {
    draw({ pressed: ["v/1/1"] });
    expect(screen.getByRole("button", { name: "Wait" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Ship" })).not.toHaveAttribute("aria-pressed");
  });

  it("tells the hook the control after a confirmed tap, and nothing after a failed one", async () => {
    const onPressed = vi.fn();
    draw({ onPressed, onSend: vi.fn(() => Promise.resolve(true)) });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    });
    expect(onPressed).toHaveBeenCalledExactlyOnceWith("v/1/0");
    cleanup();
    const failed = vi.fn();
    draw({ onPressed: failed, onSend: vi.fn(() => Promise.resolve(false)) });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Wait" }));
    });
    expect(failed).not.toHaveBeenCalled();
  });
});
