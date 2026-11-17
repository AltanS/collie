import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CALM_HOLD_MS } from "@/hooks/use-bounded-hold";
import { __resetHarnessBar, setHarnessBarEnabled } from "@/lib/harness-bar-pref";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { server } from "@/test/setup";
import type { OperatorCommand } from "@/lib/types";
import { ARM_DWELL_MS, ARM_MS, STOP_HINT_MS, STOP_HOLD_MS } from "@/lib/arm";
import { accentFor, DurableBar, HarnessBar, ScreenStop } from "./harness-bar";
import { DURABLE_BAR, durableBarFor } from "@/lib/harness-bar";
import type { PaneAction } from "@/lib/types";

/** jsdom normalises a hex colour to `rgb(...)`; compare through the same normaliser on both sides. */
function normalizedColor(value: string): string {
  const probe = document.createElement("div");
  probe.style.color = value;
  return probe.style.color;
}

afterEach(() => __resetHarnessBar());

function op(row: Partial<OperatorCommand> & { command: string }): OperatorCommand {
  const out: OperatorCommand = {
    command: row.command,
    description: "Custom command",
    takesArg: false,
    argHint: "",
    confirm: row.confirm ?? false,
    bar: row.bar ?? false,
  };
  if (row.agent !== undefined) out.agent = row.agent;
  if (row.barLabel !== undefined) out.barLabel = row.barLabel;
  return out;
}

/** Resolves true — the bridge took the text, so the checkmark lands. */
const took = () => vi.fn(async () => true);
/** Resolves false — `send()` refused, so nothing should show a checkmark. */
const refused = () => vi.fn(async () => false);

describe("HarnessBar", () => {
  it("draws the focused harness's own commands and nothing else", () => {
    render(<HarnessBar agent="claude" onRun={took()} />);
    for (const label of ["Model", "Effort", "Compact", "Resume"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Tree" })).not.toBeInTheDocument();
  });

  it("renders nothing for an agent with no bar", () => {
    const { container } = render(<HarnessBar agent="hermes" onRun={took()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing while the per-device toggle is off", () => {
    setHarnessBarEnabled(false);
    const { container } = render(<HarnessBar agent="claude" onRun={took()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("fires a command item straight away and echoes a checkmark", async () => {
    const onRun = took();
    render(<HarnessBar agent="claude" onRun={onRun} />);
    await userEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(onRun).toHaveBeenCalledWith("/compact");
    // The ✓ replaces only the icon for ECHO_DONE_MS; the word "Compact" stays put.
    const button = screen.getByRole("button", { name: "Compact" });
    await waitFor(() => expect(button.querySelector('svg[data-icon="confirm"]')).toBeInTheDocument());
    expect(button).toHaveTextContent("Compact");
  });

  it("keeps the word under the ✓ so the belt does not move", async () => {
    const onRun = took();
    render(<HarnessBar agent="claude" onRun={onRun} />);
    const button = screen.getByRole("button", { name: "Compact" });
    const before = button.textContent;
    await userEvent.click(button);
    expect(onRun).toHaveBeenCalledWith("/compact");
    await waitFor(() => expect(button.querySelector('svg[data-icon="confirm"]')).toBeInTheDocument());
    // Same box, same word: only the icon swapped for the check.
    expect(button.textContent).toBe(before);
    expect(button).toHaveTextContent("Compact");
  });

  it("draws the done chip white with the harness accent on its border and word", async () => {
    const onRun = took();
    render(<HarnessBar agent="claude" onRun={onRun} />);
    const button = screen.getByRole("button", { name: "Compact" });
    await userEvent.click(button);
    await waitFor(() => expect(button.querySelector('svg[data-icon="confirm"]')).toBeInTheDocument());
    expect(button).toHaveClass("bg-white");
    expect(button).not.toHaveClass("bg-primary");
    const accent = accentFor("claude");
    expect(accent).toBeDefined();
    expect(normalizedColor(button.style.color)).toBe(normalizedColor(accent!));
    expect(normalizedColor(button.style.borderColor)).toBe(normalizedColor(accent!));
    // An idle sibling stays a plain ghost chip, never the white "done" ground.
    const idleSibling = screen.getByRole("button", { name: "Model" });
    expect(idleSibling).not.toHaveClass("bg-white");
  });

  it("sends Model bare and opens no sheet — the pane's own picker takes over", async () => {
    const onRun = took();
    render(<HarnessBar agent="claude" onRun={onRun} />);
    await userEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(onRun).toHaveBeenCalledWith("/model");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("sends Effort bare too, so the levels stay the harness's list and not ours", async () => {
    const onRun = took();
    render(<HarnessBar agent="claude" onRun={onRun} />);
    await userEvent.click(screen.getByRole("button", { name: "Effort" }));
    expect(onRun).toHaveBeenCalledWith("/effort");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("gives Codex no Effort button, because its /model picker sets both dials", () => {
    render(<HarnessBar agent="codex" onRun={took()} />);
    expect(screen.getByRole("button", { name: "Model" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Effort" })).not.toBeInTheDocument();
  });

  it("draws Muse's Model, Effort, Compact and Resume, and sends each bare", async () => {
    const onRun = took();
    render(<HarnessBar agent="muse" onRun={onRun} />);
    for (const label of ["Model", "Effort", "Compact", "Resume"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Tree" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Effort" }));
    expect(onRun).toHaveBeenCalledWith("/effort");
  });

  it("greys every button in place on a locked pane, rather than removing one", async () => {
    const onRun = took();
    render(<HarnessBar agent="claude" onRun={onRun} disabled />);
    const buttons = ["Model", "Effort", "Compact", "Resume"].map((n) =>
      screen.getByRole("button", { name: n }),
    );
    expect(buttons).toHaveLength(4);
    for (const b of buttons) expect(b).toBeDisabled();
    await userEvent.click(buttons[2]!, { pointerEventsCheck: 0 });
    expect(onRun).not.toHaveBeenCalled();
  });

  it("takes a tap on a working pane — there is no AgentStatus gate on this path", async () => {
    // The bar knows nothing about `status`, the same way the Agent palette does not. The only thing
    // that refuses is `send()` itself, which is what `onRun` stands for here.
    const onRun = took();
    render(<HarnessBar agent="claude" onRun={onRun} />);
    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onRun).toHaveBeenCalledWith("/resume");
  });

  it("shows no checkmark on a working pane whose send was refused, and keeps the label", async () => {
    const onRun = refused();
    render(<HarnessBar agent="claude" onRun={onRun} />);
    await userEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(onRun).toHaveBeenCalledWith("/compact");
    // Back to idle with its word, never a ✓: the echo only lands when `send()` resolved true.
    await waitFor(() => expect(screen.getByRole("button", { name: "Compact" })).toBeInTheDocument());
  });

  it("is accessible: a named group and a labelled button each, and nothing pops up", () => {
    render(<HarnessBar agent="claude" onRun={took()} />);
    expect(screen.getByRole("group", { name: "Harness shortcuts" })).toBeInTheDocument();
    for (const b of screen.getAllByRole("button")) {
      expect(b).toHaveAccessibleName();
      // No item opens anything: every one of them sends its command and the pane answers.
      expect(b).not.toHaveAttribute("aria-haspopup");
    }
  });

  it("two-taps an operator row that names a shipped dangerous command", async () => {
    const onRun = took();
    const mine = [op({ agent: "claude", command: "/clear", bar: true, barLabel: "Wipe" })];
    render(<HarnessBar agent="claude" mine={mine} onRun={onRun} />);
    const button = screen.getByRole("button", { name: "Wipe" });
    await userEvent.click(button);
    expect(onRun).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Tap again to confirm \/clear/ }));
    expect(onRun).toHaveBeenCalledWith("/clear");
  });

  it("prints an operator's own label as they typed it, never translated", () => {
    const mine = [op({ agent: "claude", command: "/statusline", bar: true, barLabel: "Status" })];
    render(<HarnessBar agent="claude" mine={mine} onRun={took()} />);
    expect(screen.getByRole("button", { name: "Status" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Model" })).not.toBeInTheDocument();
  });
});

// CALM LOAD (row 11): an operator who had `bar = true` rows waits for the config read, so the belt draws its
// harness section once, with their rows, instead of the shipped bar first.
describe("HarnessBar, the operator's rows on the first frame", () => {
  const KEY = "collie:shape:/:belt-operator-bar";
  const mine = [op({ command: "/standup", bar: true, barLabel: "Stand" })];

  beforeEach(() => {
    localStorage.clear();
    __resetOperatorCommands();
  });
  afterEach(() => localStorage.clear());

  /** The config read waits until `release()`. */
  function slowConfig() {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.get("/api/config", async () => {
        await gate;
        return HttpResponse.json({ push: false, vapidPublicKey: "" });
      }),
    );
    return release;
  }

  it("holds the section while the read runs, then draws the operator's rows and never the shipped bar", async () => {
    localStorage.setItem(KEY, "1");
    const release = slowConfig();
    const seen: string[] = [];
    const watch = new MutationObserver(() => seen.push(screen.queryByRole("button", { name: "Compact" }) === null ? "-" : "shipped"));
    const { container } = render(<HarnessBar agent="claude" mine={mine} onRun={took()} />);
    watch.observe(document.body, { childList: true, subtree: true });
    expect(container).toBeEmptyDOMElement();
    release();
    expect(await screen.findByRole("button", { name: "Stand" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Compact" })).toBeNull();
    expect(seen).not.toContain("shipped");
    expect(localStorage.getItem(KEY)).toBe("1");
    watch.disconnect();
  });

  it("draws the shipped bar at once for an operator with no memory of rows", () => {
    slowConfig();
    render(<HarnessBar agent="claude" onRun={took()} />);
    expect(screen.getByRole("button", { name: "Compact" })).toBeInTheDocument();
  });

  it("waits no longer than the bound, then draws the shipped bar", async () => {
    localStorage.setItem(KEY, "1");
    slowConfig();
    const { container } = render(<HarnessBar agent="claude" onRun={took()} />);
    expect(container).toBeEmptyDOMElement();
    expect(await screen.findByRole("button", { name: "Compact" }, { timeout: CALM_HOLD_MS * 4 })).toBeInTheDocument();
  });

  it("remembers that there were no rows once the read says so", async () => {
    localStorage.setItem(KEY, "1");
    render(<HarnessBar agent="claude" mine={[]} onRun={took()} />);
    expect(await screen.findByRole("button", { name: "Compact" })).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem(KEY)).toBe("0"));
  });
});

describe("DurableBar", () => {
  const state = (over: { steer?: Partial<Parameters<typeof DurableBar>[0]["state"]["steer"]>; stop?: Partial<Parameters<typeof DurableBar>[0]["state"]["stop"]> } = {}) => ({
    steer: { pressed: false, offered: true, onPressedChange: vi.fn(), ...over.steer },
    stop: { offered: true, busy: false, onStop: vi.fn(), ...over.stop },
  });

  it("draws Steer then Stop in the program's section, with its mark", () => {
    render(<DurableBar items={DURABLE_BAR} state={state()} />);
    const section = screen.getByRole("group", { name: "Harness shortcuts" });
    expect(section).toHaveAttribute("data-slot", "durable-bar");
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Steer", "Stop"]);
  });

  it("draws the Stop as a filled square, offered or dimmed", () => {
    const { rerender } = render(<DurableBar items={DURABLE_BAR} state={state()} />);
    const glyph = () => screen.getByRole("button", { name: "Stop the running turn" }).querySelector("svg[data-icon='stop']")!;
    expect(glyph().classList.contains("fill-current")).toBe(true);
    rerender(<DurableBar items={DURABLE_BAR} state={state({ stop: { offered: false } })} />);
    expect(glyph().classList.contains("fill-current")).toBe(true);
  });

  it("renders nothing for a program that declared neither", () => {
    const { container } = render(<DurableBar items={[]} state={state()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("dims a control that cannot act and keeps it drawn", async () => {
    const s = state({ steer: { offered: false, pressed: true }, stop: { offered: false } });
    render(<DurableBar items={DURABLE_BAR} state={s} />);
    const steer = screen.getByRole("button", { name: /Steer the running turn/ });
    const stop = screen.getByRole("button", { name: "Stop the running turn" });
    expect(steer).toBeDisabled();
    expect(steer).toHaveAttribute("aria-pressed", "false");
    expect(stop).toBeDisabled();
    await userEvent.setup().click(stop);
    expect(s.stop.onStop).not.toHaveBeenCalled();
  });

  it("taps through to the composer's handlers", async () => {
    const s = state();
    const user = userEvent.setup();
    render(<DurableBar items={DURABLE_BAR} state={s} />);
    await user.click(screen.getByRole("button", { name: /Steer the running turn/ }));
    expect(s.steer.onPressedChange).toHaveBeenCalledWith(true);
    await user.click(screen.getByRole("button", { name: "Stop the running turn" }));
    expect(s.stop.onStop).toHaveBeenCalledTimes(1);
  });

  it("greys both when the composer is locked", () => {
    render(<DurableBar items={DURABLE_BAR} state={state()} disabled />);
    for (const b of screen.getAllByRole("button")) expect(b).toBeDisabled();
  });

  it("shows a spinner while a stop is in flight", () => {
    render(<DurableBar items={DURABLE_BAR} state={state({ stop: { busy: true } })} />);
    expect(screen.getByRole("button", { name: "Stop the running turn" }).querySelector(".animate-spin")).not.toBeNull();
  });
});

describe("DurableBar, the program's own actions", () => {
  const listed: PaneAction[] = [
    { id: "escalate", label: "Escalate", icon: "flag" },
    { id: "pause", label: "Pause", icon: "pause", disabled: true },
    { id: "run", label: "Run", icon: "play", busy: true },
    { id: "plain", label: "Plain" },
  ];
  const items = durableBarFor(() => true, listed);
  const state = (running: string | null = null) => ({
    steer: { pressed: false, offered: true, onPressedChange: vi.fn() },
    stop: { offered: true, busy: false, onStop: vi.fn() },
    action: { running, onRun: vi.fn() },
  });

  it("draws them after Steer and Stop, in the program's order, each with its label", () => {
    render(<DurableBar items={items} state={state()} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Steer", "Stop", "Escalate", "Pause", "Run", "Plain"]);
  });

  it("draws an icon for a known name and none for an unknown one, and a spinner for a busy action", () => {
    render(<DurableBar items={items} state={state()} />);
    expect(screen.getByRole("button", { name: "Escalate" }).querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Plain" }).querySelector("svg")).toBeNull();
    expect(screen.getByRole("button", { name: "Run" }).querySelector(".animate-spin")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Escalate" }).querySelector(".animate-spin")).toBeNull();
  });

  it("dims a disabled or busy action and refuses its tap, and taps an available one through once", async () => {
    const s = state();
    const user = userEvent.setup();
    render(<DurableBar items={items} state={s} />);
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Pause" }));
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(s.action.onRun).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Escalate" }));
    expect(s.action.onRun).toHaveBeenCalledTimes(1);
    expect(s.action.onRun).toHaveBeenCalledWith(listed[0]);
  });

  it("shows the button whose tap is in flight as a spinner and refuses a second tap on it", async () => {
    const s = state("escalate");
    render(<DurableBar items={items} state={s} />);
    const button = screen.getByRole("button", { name: "Escalate" });
    expect(button).toBeDisabled();
    expect(button.querySelector(".animate-spin")).not.toBeNull();
    await userEvent.setup().click(button);
    expect(s.action.onRun).not.toHaveBeenCalled();
  });

  it("greys them when the composer is locked, and draws a section for a program that declared only actions", () => {
    const { rerender } = render(<DurableBar items={items} state={state()} disabled />);
    for (const b of screen.getAllByRole("button")) expect(b).toBeDisabled();
    rerender(<DurableBar items={durableBarFor((cap) => cap === "programActions", listed)} state={state()} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Escalate", "Pause", "Run", "Plain"]);
  });
});

// HOLD TO STOP (2026-11-16): a touch or a mouse holds the button for STOP_HOLD_MS. The two-tap arm stays
// for a click no pointer made (a key, a screen reader); the block below this one covers that path.
describe("ScreenStop, hold to stop", () => {
  afterEach(() => vi.useRealTimers());

  const stop = () => screen.getByRole("button", { name: /stop the turn/i });
  const down = () => fireEvent.pointerDown(stop(), { button: 0, clientX: 10, clientY: 10, pointerType: "touch" });
  const up = () => fireEvent.pointerUp(stop(), { button: 0, clientX: 10, clientY: 10, pointerType: "touch" });
  /** The click a browser raises after a pointer's press: `detail` counts the click, a key's is 0. */
  const pointerClick = () => fireEvent.click(stop(), { detail: 1 });

  it("stops once at the end of a full hold, with the finger still down, and the click of the lift adds nothing", async () => {
    vi.useFakeTimers();
    const onStop = vi.fn(async () => {});
    render(<ScreenStop paneId="w1:p1" running onStop={onStop} />);
    down();
    act(() => {
      vi.advanceTimersByTime(STOP_HOLD_MS - 1);
    });
    expect(onStop).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(onStop).toHaveBeenCalledTimes(1);
    up();
    pointerClick();
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(stop()).not.toHaveTextContent("Stop?");
  });

  it("shows the fill while the finger holds, and the word Hold", () => {
    vi.useFakeTimers();
    render(<ScreenStop paneId="w1:p1" running onStop={async () => {}} />);
    expect(document.querySelector("[data-slot='belt-stop-fill']")).toBeNull();
    down();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    const fill = document.querySelector<HTMLElement>("[data-slot='belt-stop-fill']")!;
    expect(fill).not.toBeNull();
    // The fill runs over exactly the time left to the Stop.
    expect(fill.style.animationDuration).toBe(`${String(STOP_HOLD_MS - 250)}ms`);
    expect(stop()).toHaveTextContent("Hold");
    up();
    expect(document.querySelector("[data-slot='belt-stop-fill']")).toBeNull();
  });

  it("a tap lifted too early stops nothing, arms nothing, and says Hold for a moment", () => {
    vi.useFakeTimers();
    const onStop = vi.fn(async () => {});
    render(<ScreenStop paneId="w1:p1" running onStop={onStop} />);
    down();
    act(() => {
      vi.advanceTimersByTime(120);
    });
    up();
    pointerClick();
    expect(onStop).not.toHaveBeenCalled();
    expect(stop()).toHaveTextContent("Hold");
    expect(screen.queryByRole("button", { name: /tap again/i })).toBeNull();
    // A second quick tap is one more too-short tap: it is never the old second tap.
    down();
    up();
    pointerClick();
    act(() => {
      vi.advanceTimersByTime(STOP_HOLD_MS * 2);
    });
    expect(onStop).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(STOP_HINT_MS);
    });
    expect(stop()).toHaveTextContent("Stop");
    expect(stop()).not.toHaveTextContent("Hold");
  });

  it("a hold that moves (the belt scrolls), leaves or is cancelled stops nothing", () => {
    vi.useFakeTimers();
    const onStop = vi.fn(async () => {});
    render(<ScreenStop paneId="w1:p1" running onStop={onStop} />);
    down();
    fireEvent.pointerMove(stop(), { clientX: 60, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(STOP_HOLD_MS);
    });
    down();
    fireEvent.pointerLeave(stop());
    act(() => {
      vi.advanceTimersByTime(STOP_HOLD_MS);
    });
    down();
    fireEvent.pointerCancel(stop());
    act(() => {
      vi.advanceTimersByTime(STOP_HOLD_MS);
    });
    expect(onStop).not.toHaveBeenCalled();
  });

  it("a phone's long-press menu is kept away and is no shortcut to the Stop", () => {
    vi.useFakeTimers();
    const onStop = vi.fn(async () => {});
    render(<ScreenStop paneId="w1:p1" running onStop={onStop} />);
    down();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => {
      stop().dispatchEvent(menu);
    });
    expect(menu.defaultPrevented).toBe(true);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("takes no hold while the turn is idle, while greyed, or while a Stop is in flight", async () => {
    vi.useFakeTimers();
    let finish: () => void = () => {};
    const onStop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender } = render(<ScreenStop paneId="w1:p1" running={false} onStop={onStop} />);
    down();
    act(() => {
      vi.advanceTimersByTime(STOP_HOLD_MS);
    });
    up();
    expect(onStop).not.toHaveBeenCalled();
    expect(stop()).not.toHaveTextContent("Hold");
    rerender(<ScreenStop paneId="w1:p1" running onStop={onStop} disabled />);
    down();
    act(() => {
      vi.advanceTimersByTime(STOP_HOLD_MS);
    });
    expect(onStop).not.toHaveBeenCalled();
    rerender(<ScreenStop paneId="w1:p1" running onStop={onStop} />);
    down();
    await act(async () => {
      vi.advanceTimersByTime(STOP_HOLD_MS);
    });
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(stop()).toHaveAttribute("aria-busy", "true");
    // A second hold while the first Stop is in flight presses nothing.
    down();
    await act(async () => {
      vi.advanceTimersByTime(STOP_HOLD_MS);
    });
    expect(onStop).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
    });
    expect(stop()).toHaveAttribute("aria-busy", "false");
  });

  it("the Hold hint ends when the turn ends and when the pane changes", () => {
    vi.useFakeTimers();
    const { rerender } = render(<ScreenStop paneId="w1:p1" running onStop={async () => {}} />);
    down();
    up();
    expect(stop()).toHaveTextContent("Hold");
    rerender(<ScreenStop paneId="w1:p1" running={false} onStop={async () => {}} />);
    expect(stop()).not.toHaveTextContent("Hold");
    rerender(<ScreenStop paneId="w1:p1" running onStop={async () => {}} />);
    down();
    up();
    expect(stop()).toHaveTextContent("Hold");
    rerender(<ScreenStop paneId="w1:p2" running onStop={async () => {}} />);
    expect(stop()).not.toHaveTextContent("Hold");
  });

  it("a turn that ends by itself under the finger is not stopped at the end of the hold, nor is the next one", async () => {
    vi.useFakeTimers();
    const onStop = vi.fn(async () => {});
    const { rerender } = render(<ScreenStop paneId="w1:p1" running onStop={onStop} />);
    down();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    rerender(<ScreenStop paneId="w1:p1" running={false} onStop={onStop} />);
    expect(document.querySelector("[data-slot='belt-stop-fill']")).toBeNull();
    // A new turn starts before the old hold's two seconds are up: the old press does not reach it.
    rerender(<ScreenStop paneId="w1:p1" running onStop={onStop} />);
    await act(async () => {
      vi.advanceTimersByTime(STOP_HOLD_MS);
    });
    expect(onStop).not.toHaveBeenCalled();
    up();
    // A fresh hold on the new turn works.
    down();
    await act(async () => {
      vi.advanceTimersByTime(STOP_HOLD_MS);
    });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("a hold on a pane that changes under the finger clears the fill and the word at the change, and sends no Stop", async () => {
    vi.useFakeTimers();
    const onStop = vi.fn(async () => {});
    const { rerender } = render(<ScreenStop paneId="w1:p1" running onStop={onStop} />);
    down();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(document.querySelector("[data-slot='belt-stop-fill']")).not.toBeNull();
    expect(stop()).toHaveTextContent("Hold");
    // The new pane runs a turn too: the old press is not for it.
    rerender(<ScreenStop paneId="w1:p2" running onStop={onStop} />);
    expect(document.querySelector("[data-slot='belt-stop-fill']")).toBeNull();
    expect(stop()).toHaveTextContent("Stop");
    expect(stop()).not.toHaveTextContent("Hold");
    expect(stop()).not.toHaveAttribute("data-holding");
    await act(async () => {
      vi.advanceTimersByTime(STOP_HOLD_MS);
    });
    expect(document.querySelector("[data-slot='belt-stop-fill']")).toBeNull();
    expect(onStop).not.toHaveBeenCalled();
    up();
    // A fresh hold on the new pane fills and stops again.
    down();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector("[data-slot='belt-stop-fill']")).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(STOP_HOLD_MS);
    });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("keeps every sizing class while it says Hold", () => {
    vi.useFakeTimers();
    render(<ScreenStop paneId="w1:p1" running onStop={async () => {}} />);
    const sizing = (cn: string) => cn.split(/\s+/).filter((c) => /^(h-|min-w-|px-|has-\[>svg\]:px-|gap-|text-\[length)/.test(c));
    const rest = sizing(stop().className);
    down();
    up();
    expect(sizing(stop().className)).toEqual(rest);
  });
});

// A KEY OR A SCREEN READER CANNOT HOLD: a click that no pointer made keeps the two-step arm below.
describe("ScreenStop (M68 spec 02)", () => {
  afterEach(() => vi.useRealTimers());

  const stop = () => screen.getByRole("button", { name: /stop the turn/i });

  it("draws one 44px-reach Stop button in the belt, named for a reader", () => {
    render(<ScreenStop paneId="w1:p1" running onStop={async () => {}} />);
    expect(stop()).toHaveAttribute("data-slot", "belt-stop");
    expect(stop()).toHaveTextContent("Stop");
    expect(stop().className).toContain("min-w-11");
  });

  // The outline square read as an empty checkbox, so the Stop draws a solid one (2026-11-16): live and dimmed alike.
  it("draws a filled square, live and dimmed", () => {
    const { rerender } = render(<ScreenStop paneId="w1:p1" running onStop={async () => {}} />);
    const glyph = () => stop().querySelector("svg[data-icon='stop']")!;
    expect(glyph().classList.contains("fill-current")).toBe(true);
    rerender(<ScreenStop paneId="w1:p1" running={false} onStop={async () => {}} />);
    expect(glyph().classList.contains("fill-current")).toBe(true);
    expect(stop().className.split(/\s+/)).toContain("opacity-50");
  });

  it("is live while the turn runs: full strength, no aria-disabled", () => {
    render(<ScreenStop paneId="w1:p1" running onStop={async () => {}} />);
    expect(stop()).not.toHaveAttribute("aria-disabled");
    expect(stop().className.split(/\s+/)).not.toContain("opacity-50");
  });

  // IDLE IS DIM, NOT ABSENT (DESIGN.md §2): the button keeps its place and its size, so the belt never reflows.
  it("stands dimmed while the turn is idle, in the focus order, and the tap sends no request and arms nothing", () => {
    const onStop = vi.fn(async () => {});
    const { rerender } = render(<ScreenStop paneId="w1:p1" running onStop={onStop} />);
    const live = stop().className;
    rerender(<ScreenStop paneId="w1:p1" running={false} onStop={onStop} />);
    expect(stop()).toHaveAttribute("aria-disabled", "true");
    expect(stop().className.split(/\s+/)).toContain("opacity-50");
    // Not the `disabled` attribute: a reader and the Tab key still reach it.
    expect(stop()).not.toBeDisabled();
    expect(stop()).toHaveTextContent("Stop");
    // Only the dim differs: every sizing class (height, min width, padding, gap, text) is the same in both states.
    const sizing = (cn: string) => cn.split(/\s+/).filter((c) => /^(h-|min-w-|px-|has-\[>svg\]:px-|gap-|text-\[length)/.test(c));
    expect(sizing(stop().className)).toEqual(sizing(live));
    fireEvent.click(stop());
    fireEvent.click(stop());
    expect(onStop).not.toHaveBeenCalled();
    expect(stop()).toHaveTextContent("Stop");
    expect(stop()).not.toHaveTextContent("Stop?");
    expect(screen.queryByRole("button", { name: /tap again/i })).toBeNull();
  });

  it("goes live again when the turn starts, and arms then stops as before", () => {
    const onStop = vi.fn(async () => {});
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const { rerender } = render(<ScreenStop paneId="w1:p1" running={false} onStop={onStop} />);
      rerender(<ScreenStop paneId="w1:p1" running onStop={onStop} />);
      expect(stop()).not.toHaveAttribute("aria-disabled");
      fireEvent.click(stop());
      expect(stop()).toHaveTextContent("Stop?");
      clock.mockReturnValue(1_000_000 + ARM_DWELL_MS);
      fireEvent.click(stop());
      expect(onStop).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("arms on the first tap without stopping anything", () => {
    const onStop = vi.fn(async () => {});
    render(<ScreenStop paneId="w1:p1" running onStop={onStop} />);
    fireEvent.click(stop());
    expect(onStop).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /tap again to stop the turn/i })).toHaveTextContent("Stop?");
  });

  it("disarms by itself after ARM_MS, and the next tap only arms again", () => {
    vi.useFakeTimers();
    const onStop = vi.fn(async () => {});
    render(<ScreenStop paneId="w1:p1" running onStop={onStop} />);
    fireEvent.click(stop());
    act(() => {
      vi.advanceTimersByTime(ARM_MS - 1);
    });
    expect(stop()).toHaveTextContent("Stop?");
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(stop()).toHaveTextContent("Stop");
    expect(stop()).not.toHaveTextContent("Stop?");
    fireEvent.click(stop());
    expect(onStop).not.toHaveBeenCalled();
  });

  it("runs the stop once on the second tap, shows busy, and ignores a third tap while it is in flight", async () => {
    let finish: () => void = () => {};
    const onStop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<ScreenStop paneId="w1:p1" running onStop={onStop} />);
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    fireEvent.click(stop());
    clock.mockReturnValue(1_000_000 + ARM_DWELL_MS);
    fireEvent.click(screen.getByRole("button", { name: /tap again/i }));
    clock.mockRestore();
    expect(onStop).toHaveBeenCalledTimes(1);
    const busy = screen.getByRole("button", { name: /stop the turn/i });
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    fireEvent.click(busy);
    expect(onStop).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
    });
    expect(stop()).toHaveAttribute("aria-busy", "false");
    expect(stop()).not.toBeDisabled();
  });

  it("does not arm on a greyed button, and drops an arm when it is greyed", () => {
    const onStop = vi.fn(async () => {});
    const { rerender } = render(<ScreenStop paneId="w1:p1" running onStop={onStop} />);
    fireEvent.click(stop());
    expect(stop()).toHaveTextContent("Stop?");
    rerender(<ScreenStop paneId="w1:p1" running onStop={onStop} disabled />);
    expect(stop()).toBeDisabled();
    expect(stop()).not.toHaveTextContent("Stop?");
  });

  // The arm dwell (counsel on the Edge 5 candidate): a second tap counts only ARM_DWELL_MS after the
  // arm. A tap inside it is the same touch landing twice: ignored, neither a Stop nor a disarm.
  it("ignores a second tap inside the dwell, and stops on a tap after it", () => {
    const onStop = vi.fn(async () => {});
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      render(<ScreenStop paneId="w1:p1" running onStop={onStop} />);
      fireEvent.click(stop());
      clock.mockReturnValue(1_000_000 + ARM_DWELL_MS - 1);
      fireEvent.click(stop());
      expect(onStop).not.toHaveBeenCalled();
      // Still armed: the tap was not a disarm.
      expect(stop()).toHaveTextContent("Stop?");
      clock.mockReturnValue(1_000_000 + ARM_DWELL_MS);
      fireEvent.click(stop());
      expect(onStop).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("an arm ends when the turn leaves running, and when the pane changes", () => {
    const onStop = vi.fn(async () => {});
    const { rerender } = render(<ScreenStop paneId="w1:p1" running onStop={onStop} />);
    fireEvent.click(stop());
    expect(stop()).toHaveTextContent("Stop?");
    rerender(<ScreenStop paneId="w1:p1" running={false} onStop={onStop} />);
    expect(stop()).not.toHaveTextContent("Stop?");
    expect(stop()).toHaveAttribute("aria-disabled", "true");

    rerender(<ScreenStop paneId="w1:p1" running onStop={onStop} />);
    fireEvent.click(stop());
    expect(stop()).toHaveTextContent("Stop?");
    rerender(<ScreenStop paneId="w1:p2" running onStop={onStop} />);
    expect(stop()).not.toHaveTextContent("Stop?");
    // The next tap on the new pane only arms.
    fireEvent.click(stop());
    expect(onStop).not.toHaveBeenCalled();
  });
});
