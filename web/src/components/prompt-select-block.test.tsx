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
  signature: "which-color-theme-region",
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
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["1", "Enter"], undefined);
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
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["1"], undefined);
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

  it("passes on a 304 whose revision matches AND whose cached text re-derives the same menu", async () => {
    // fetchPane's 304 path returns the cached body (text included), so the re-derivation — which
    // now runs on EVERY path because Herdr 0.7.x's revision is a stub — sees the full buffer.
    const model = fixtureModel("claude--permission-bash.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--permission-bash.txt"),
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
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["2"], undefined);
  });

  it("rejects a 304 with MATCHING (stub) revisions when the cached text no longer shows the menu", async () => {
    // The live hole found on 2026-07-05: Herdr 0.7.x returns revision 0 for every read, so the
    // revision gate is inert — a frozen tap whose confirm-fetch 304s against an advanced cache
    // must still be caught by re-deriving the menu from the cached (= latest) text.
    const model = fixtureModel("claude--permission-bash.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--done.txt"), // menu is long gone; agent moved on
      truncated: false,
      revision: 0, // stub revision — matches detectedRevision, provides no protection
      notModified: true,
    });
    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 0,
      prompt: model,
      option: model.options[1]!,
    });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
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
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["1", "Enter"], undefined);
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

// H1 regression (pre-release review): promptsEqual used to compare only family/question/labels, so
// two edit-permission prompts with the same shape but a DIFFERENT subject (a second edit to the same
// file) were "equal" — a frozen tap on prompt A could approve prompt B the user never saw. The region
// `signature` (which folds in the subject above the options) now distinguishes them.
describe("submitPromptOption — same-shaped successor prompt (H1)", () => {
  const RULE = "─".repeat(30);
  const promptFor = (subject: string) =>
    [RULE, `  ${subject}`, RULE, " Do you want to proceed?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel · Tab to amend"].join("\n");
  const modelFor = (subject: string) => {
    const m = detectPromptSelect(splitLines(parseAnsi(promptFor(subject))));
    if (!m) throw new Error("synthetic permission prompt did not detect");
    return m;
  };

  it("rejects the tap when only the subject changed (identical question + labels)", async () => {
    const promptA = modelFor("write hello.txt");
    // The pane advanced: A was answered elsewhere and a same-shaped B is now on screen (stub rev 0).
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: promptFor("delete production.db"),
      truncated: false,
      revision: 0,
    });
    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 0,
      prompt: promptA,
      option: promptA.options[0]!,
    });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("still sends when the whole region (subject included) is unchanged", async () => {
    const same = promptFor("write hello.txt");
    const promptA = modelFor("write hello.txt");
    mockFetchPane.mockResolvedValue({ paneId: "w1:p1", text: same, truncated: false, revision: 0 });
    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 0,
      prompt: promptA,
      option: promptA.options[0]!,
    });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["1"], undefined);
  });
});
