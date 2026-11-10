import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ARM_DWELL_MS } from "@/lib/arm";
import type { JsonValue } from "@/lib/json";
import { parseMorphView, type MorphView as MorphScreen } from "@/lib/morph/wire";
import type { TranscriptEntry } from "@/lib/types";

import { MorphView, type MorphViewProps } from "./morph-view";

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
  it("with no screen yet, says how to begin", () => {
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
  it("sends the button's value, else its label", async () => {
    const { props } = draw();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Wait" }));
    });
    expect(props.onSend).toHaveBeenNthCalledWith(1, "Ship it now");
    expect(props.onSend).toHaveBeenNthCalledWith(2, "Wait");
  });

  it("with confirm, arms on the first tap and sends on the second", () => {
    vi.useFakeTimers();
    const { props } = draw();
    fireEvent.click(screen.getByRole("button", { name: "Drop" }));
    expect(props.onSend).not.toHaveBeenCalled();
    const armed = screen.getByRole("button", { name: "Really drop?" });
    act(() => vi.advanceTimersByTime(ARM_DWELL_MS));
    fireEvent.click(armed);
    expect(props.onSend).toHaveBeenCalledExactlyOnceWith("Drop");
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
