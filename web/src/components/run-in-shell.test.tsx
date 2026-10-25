import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { StartAsk, StartOutcome } from "@/hooks/use-spaces";

import { MarkdownText } from "./markdown-text";
import { RunInShellProvider, type RunBeside } from "./run-in-shell";

// The load-bearing rules: only a pane's chat offers a run, only for a one-line shell block, never
// without a confirm, and a retry after an unconfirmed start reuses its request id.

const BESIDE: RunBeside = { paneId: "w7:p8", workspaceId: "w7", cwd: "/home/you/app" };
const REPLY = "Run this:\n\n```bash\nsudo systemctl restart docker\n```\n\nand this:\n\n```bash\ncd app\nnpm test\n```";

function setup(outcomes: StartOutcome[], beside: RunBeside | null = BESIDE) {
  const asks: StartAsk[] = [];
  const start = vi.fn(async (ask: StartAsk): Promise<StartOutcome> => {
    asks.push(ask);
    return outcomes.shift() ?? { kind: "done" };
  });
  render(
    <RunInShellProvider beside={beside ?? undefined} folder="~/app" scope={undefined} start={start}>
      <MarkdownText text={REPLY} />
    </RunInShellProvider>,
  );
  return { asks, start };
}

const runButtons = () => screen.queryAllByRole("button", { name: "Run in shell" });

describe("Run in shell", () => {
  it("offers a run on the one-line shell block only", () => {
    setup([]);
    expect(runButtons()).toHaveLength(1);
  });

  it("offers nothing where the screen gives no pane to run beside", () => {
    setup([], null);
    expect(runButtons()).toHaveLength(0);
  });

  it("offers nothing without the provider at all", () => {
    render(<MarkdownText text={REPLY} />);
    expect(runButtons()).toHaveLength(0);
  });

  it("asks first, showing the line and the folder, then starts a tab beside the pane", async () => {
    const { asks, start } = setup([{ kind: "done" }]);
    fireEvent.click(runButtons()[0]!);
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByTestId("run-in-shell-command").textContent).toBe("sudo systemctl restart docker");
    expect(screen.getByText("~/app")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(asks[0]).toMatchObject({
      what: { kind: "run", line: "sudo systemctl restart docker" },
      cwd: "/home/you/app",
      beside: { paneId: "w7:p8", workspaceId: "w7" },
    });
    await waitFor(() => expect(screen.queryByTestId("run-in-shell-command")).toBeNull());
  });

  it("cancel runs nothing", () => {
    const { start } = setup([]);
    fireEvent.click(runButtons()[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(start).not.toHaveBeenCalled();
  });

  it("an unconfirmed start stays open, and Try again sends the same request", async () => {
    const { asks } = setup([{ kind: "unknown" }, { kind: "done" }]);
    fireEvent.click(runButtons()[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    const retry = await screen.findByRole("button", { name: "Try again" });
    fireEvent.click(retry);
    await waitFor(() => expect(asks).toHaveLength(2));
    expect(asks[1]!.requestId).toBe(asks[0]!.requestId);
  });
});
