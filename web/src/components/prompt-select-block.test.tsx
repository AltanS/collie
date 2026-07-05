import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The whole prompt-select feature end to end: the presentational component, the shared race guard
// (submitPromptOption), and the wired tap (component → injected handler → api). The api layer is
// mocked so we can drive fresh-fetch revision/menu outcomes precisely; the detector and status
// channel are the real thing.
vi.mock("@/lib/api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
}));

import { fetchPane, sendKeys } from "@/lib/api";
import { parseAnsi } from "@/lib/ansi";
import { splitLines, type PromptModel, type PromptOption } from "@/lib/blocks";
import { detectPromptSelect } from "@/lib/grammar/prompt-select";
import { submitPromptOption } from "@/lib/prompt-action";
import { clearStatus, setStatus, useStatus } from "@/lib/status";
import { PromptSelectBlock } from "./prompt-select-block";

const mockFetchPane = vi.mocked(fetchPane);
const mockSendKeys = vi.mocked(sendKeys);

// Anchored on this file's directory (not `new URL(import.meta.url)`, which Vite rewrites to an asset).
const PANES_DIR = join(import.meta.dirname, "..", "fixtures", "panes");
const fixtureText = (name: string) => readFileSync(join(PANES_DIR, name), "utf8");
function fixtureModel(name: string): PromptModel {
  const model = detectPromptSelect(splitLines(parseAnsi(fixtureText(name))));
  if (!model) throw new Error(`fixture ${name} did not detect a prompt`);
  return model;
}

beforeEach(() => {
  clearStatus();
  mockFetchPane.mockReset();
  mockSendKeys.mockReset();
  mockSendKeys.mockResolvedValue({ ok: true });
});

const selectModel: PromptModel = {
  question: "Which color theme should the dashboard use?",
  family: "select",
  options: [
    { label: "Red", description: "A warm, high-energy theme", keys: ["1", "Enter"] },
    { label: "Green", keys: ["2", "Enter"] },
  ],
};

describe("PromptSelectBlock — presentation", () => {
  it("renders each option as a focusable button, labelled by the question", () => {
    render(<PromptSelectBlock prompt={selectModel} onAction={vi.fn()} />);
    expect(
      screen.getByRole("group", { name: "Which color theme should the dashboard use?" }),
    ).toBeInTheDocument();
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Red/ })).toBeInTheDocument();
    // Description renders as a secondary text node (not markup).
    expect(screen.getByText("A warm, high-energy theme")).toBeInTheDocument();
    buttons[0]!.focus();
    expect(buttons[0]).toHaveFocus();
  });

  it("calls onAction with the tapped option", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<PromptSelectBlock prompt={selectModel} onAction={onAction} />);
    await user.click(screen.getByRole("button", { name: /Green/ }));
    expect(onAction).toHaveBeenCalledWith(selectModel.options[1]);
  });

  it("disables every button when disabled (read-only device / gone pane)", () => {
    render(<PromptSelectBlock prompt={selectModel} onAction={vi.fn()} disabled />);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });
});

describe("submitPromptOption — race guard + per-family keystroke recipe", () => {
  it("select family: sends digit THEN Enter when the fresh menu matches", async () => {
    const model = fixtureModel("claude--select-menu.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--select-menu.txt"),
      truncated: false,
      revision: 7,
    });
    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 7,
      prompt: model,
      option: model.options[0]!,
    });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["1", "Enter"]);
  });

  it("permission family: sends the digit ALONE (a trailing Enter would leak)", async () => {
    const model = fixtureModel("claude--permission-edit.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--permission-edit.txt"),
      truncated: false,
      revision: 3,
    });
    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 3,
      prompt: model,
      option: model.options[0]!,
    });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["1"]);
  });

  it("rejects (no send) when the fresh revision differs", async () => {
    const model = fixtureModel("claude--select-menu.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--select-menu.txt"),
      truncated: false,
      revision: 99, // moved on since the menu was detected against revision 7
    });
    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 7,
      prompt: model,
      option: model.options[0]!,
    });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("rejects (no send) when the fresh buffer resolves to a different menu", async () => {
    const model = fixtureModel("claude--select-menu.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--permission-edit.txt"), // same revision, different dialog
      truncated: false,
      revision: 7,
    });
    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 7,
      prompt: model,
      option: model.options[0]!,
    });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("passes on a 304 whose revision still matches (only the re-derivation is skipped)", async () => {
    const model = fixtureModel("claude--permission-bash.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: "",
      truncated: false,
      revision: 42, // the cached body's revision — matches what the menu was detected against
      notModified: true,
    });
    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 42,
      prompt: model,
      option: model.options[1]!,
    });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["2"]);
  });

  it("rejects a 304 whose revision differs — 'not modified' only means unchanged since the LAST POLL", async () => {
    // Background polling advances the ETag cache while a frozen mirror stands still, so a 304 must
    // NOT bypass the revision check: the tap was made against an older (frozen) snapshot.
    const model = fixtureModel("claude--permission-bash.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: "",
      truncated: false,
      revision: 43, // the cache moved on; the user tapped the menu detected at revision 42
      notModified: true,
    });
    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 42,
      prompt: model,
      option: model.options[1]!,
    });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("surfaces the bridge error when sendKeys fails", async () => {
    const model = fixtureModel("claude--select-menu.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--select-menu.txt"),
      truncated: false,
      revision: 5,
    });
    mockSendKeys.mockResolvedValue({ ok: false, error: "agent busy" });
    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 5,
      prompt: model,
      option: model.options[0]!,
    });
    expect(res).toEqual({ status: "error", error: "agent busy" });
  });
});

// A miniature of AgentChat's handler + status surface, so the wired tap is exercised through the
// real component and the "menu changed" notice pattern the app uses.
function StatusSentinel() {
  const status = useStatus();
  return <div data-testid="status">{status?.text ?? ""}</div>;
}

function Harness({ prompt, detectedRevision }: { prompt: PromptModel; detectedRevision: number }) {
  async function onAction(option: PromptOption) {
    const result = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision,
      prompt,
      option,
    });
    if (result.status === "sent") setStatus("Sent", "success");
    else if (result.status === "changed") setStatus("Menu changed — refreshing", "warn");
    else setStatus(result.error, "error");
  }
  return (
    <>
      <PromptSelectBlock prompt={prompt} onAction={onAction} />
      <StatusSentinel />
    </>
  );
}

describe("PromptSelectBlock — wired tap (component → handler → api)", () => {
  it("tapping an option runs the guard, sends its keys, and confirms", async () => {
    const model = fixtureModel("claude--select-menu.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--select-menu.txt"),
      truncated: false,
      revision: 4,
    });
    const user = userEvent.setup();
    render(<Harness prompt={model} detectedRevision={4} />);

    await user.click(screen.getByRole("button", { name: /Red/ }));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("Sent"));
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["1", "Enter"]);
  });

  it("a stale tap surfaces a 'menu changed' notice and sends nothing", async () => {
    const model = fixtureModel("claude--select-menu.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--permission-edit.txt"), // the pane moved to a different dialog
      truncated: false,
      revision: 4,
    });
    const user = userEvent.setup();
    render(<Harness prompt={model} detectedRevision={4} />);

    await user.click(screen.getByRole("button", { name: /Green/ }));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("Menu changed"));
    expect(mockSendKeys).not.toHaveBeenCalled();
  });
});
