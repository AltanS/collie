import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetHarnessBar, setHarnessBarEnabled } from "@/lib/harness-bar-pref";
import type { OperatorCommand } from "@/lib/types";
import { accentFor, DurableBar, HarnessBar } from "./harness-bar";
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
    const { container } = render(<HarnessBar agent="grok" onRun={took()} />);
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
    await waitFor(() => expect(button.querySelector("svg.lucide-check")).toBeInTheDocument());
    expect(button).toHaveTextContent("Compact");
  });

  it("keeps the word under the ✓ so the belt does not move", async () => {
    const onRun = took();
    render(<HarnessBar agent="claude" onRun={onRun} />);
    const button = screen.getByRole("button", { name: "Compact" });
    const before = button.textContent;
    await userEvent.click(button);
    expect(onRun).toHaveBeenCalledWith("/compact");
    await waitFor(() => expect(button.querySelector("svg.lucide-check")).toBeInTheDocument());
    // Same box, same word: only the icon swapped for the check.
    expect(button.textContent).toBe(before);
    expect(button).toHaveTextContent("Compact");
  });

  it("draws the done chip white with the harness accent on its border and word", async () => {
    const onRun = took();
    render(<HarnessBar agent="claude" onRun={onRun} />);
    const button = screen.getByRole("button", { name: "Compact" });
    await userEvent.click(button);
    await waitFor(() => expect(button.querySelector("svg.lucide-check")).toBeInTheDocument());
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
