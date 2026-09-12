import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetHarnessBar, setHarnessBarEnabled } from "@/lib/harness-bar-pref";
import type { OperatorCommand } from "@/lib/types";
import { HarnessBar } from "./harness-bar";

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
    // The ✓ replaces the label for ECHO_DONE_MS, so the button's text is gone while it shows.
    await waitFor(() => expect(screen.queryByText("Compact")).not.toBeInTheDocument());
  });

  it("opens a chooser rather than firing, then sends the picked argument", async () => {
    const onRun = took();
    render(<HarnessBar agent="claude" onRun={onRun} />);
    await userEvent.click(screen.getByRole("button", { name: "Effort" }));
    expect(onRun).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "high" }));
    expect(onRun).toHaveBeenCalledWith("/effort high");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("sends the bare command for an option whose arg is empty", async () => {
    const onRun = took();
    render(<HarnessBar agent="claude" onRun={onRun} />);
    await userEvent.click(screen.getByRole("button", { name: "Model" }));
    await userEvent.click(screen.getByRole("button", { name: "Pick in Claude" }));
    expect(onRun).toHaveBeenCalledWith("/model");
  });

  it("picks nothing when the chooser is dismissed", async () => {
    const onRun = took();
    render(<HarnessBar agent="claude" onRun={onRun} initialOpen="effort" />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onRun).not.toHaveBeenCalled();
  });

  it("opens on initialOpen, which is the playground and test seam", () => {
    render(<HarnessBar agent="claude" onRun={took()} initialOpen="model" />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pick in Claude" })).toBeInTheDocument();
  });

  it("tells a Codex operator where the effort dial went, inside the Model sheet", () => {
    render(<HarnessBar agent="codex" onRun={took()} initialOpen="model" />);
    expect(screen.getByText(/reasoning effort inside this same picker/i)).toBeInTheDocument();
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

  it("is accessible: a named group, a labelled button each, and a focused chooser", async () => {
    render(<HarnessBar agent="claude" onRun={took()} />);
    const group = screen.getByRole("group", { name: "Harness shortcuts" });
    expect(group).toBeInTheDocument();
    for (const b of screen.getAllByRole("button")) {
      expect(b).toHaveAccessibleName();
    }
    expect(screen.getByRole("button", { name: "Model" })).toHaveAttribute(
      "aria-haspopup",
      "dialog",
    );
    expect(screen.getByRole("button", { name: "Compact" })).not.toHaveAttribute("aria-haspopup");

    await userEvent.click(screen.getByRole("button", { name: "Model" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // useDialogFocus moves focus into the panel, so a reader lands inside the sheet.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
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
