import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
  sendReply: vi.fn(),
  textBeforeLastSend: vi.fn(),
}));

import { fetchPane, sendKeys } from "../../api";
import { parseAnsi } from "../../ansi";
import { splitLines, type PromptModel } from "../../blocks";
import { submitPromptOption } from "../../prompt-action";
import { kiroAdapter } from "./index";

const PANES = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const load = (name: string): string => readFileSync(join(PANES, name), "utf8");
const allowText = load("kiro--v3-approval-allow-w120.txt");
const denyText = load("kiro--v3-approval-deny-w120.txt");
const promptOf = (text: string): PromptModel => {
  const block = kiroAdapter.buildBlocks(splitLines(parseAnsi(text))).find((candidate) => candidate.kind === "prompt-select");
  if (block?.kind !== "prompt-select") throw new Error("Expected captured approval");
  return block.prompt;
};
const pane = (text: string, revision = 0) => ({ paneId: "scratch", text, truncated: false, revision });
const mockRead = vi.mocked(fetchPane);
const mockKeys = vi.mocked(sendKeys);
const args = (prompt: PromptModel, index: number) => {
  const option = prompt.options[index];
  if (option === undefined) throw new Error("Missing option");
  return {
    paneId: "scratch",
    requestedLines: 40,
    detectedRevision: 0,
    agent: "kiro",
    prompt,
    option,
    sleep: async () => undefined,
  };
};

beforeEach(() => {
  mockRead.mockReset();
  mockKeys.mockReset();
  mockKeys.mockResolvedValue({ ok: true });
});

describe("Kiro uses the existing guarded prompt actions", () => {
  it("binds approve-once Enter to the exact captured screen", async () => {
    // Given: the real Allow state is unchanged on a fresh read.
    const prompt = promptOf(allowText);
    mockRead.mockResolvedValue(pane(allowText));
    // When: the shared prompt action chooses Allow.
    const result = await submitPromptOption(args(prompt, 0));
    // Then: only Enter is sent, with the captured request as the bridge binding.
    expect(result).toEqual({ status: "sent" });
    expect(mockKeys.mock.calls).toEqual([["scratch", ["Enter"], undefined, prompt.signature]]);
  });

  it("walks to Deny, reads the selected row back, and binds Enter to that read", async () => {
    // Given: the entry read points at Allow and the verification read points at Deny.
    const initial = promptOf(allowText);
    const landed = promptOf(denyText);
    mockRead.mockResolvedValueOnce(pane(allowText)).mockResolvedValue(pane(denyText));
    // When: the same shared prompt action chooses Deny.
    const result = await submitPromptOption(args(initial, 1));
    // Then: the arrows and commit are separate writes bound to their own verified states.
    expect(result).toEqual({ status: "sent" });
    expect(mockKeys.mock.calls).toEqual([
      ["scratch", ["Down", "Down"], undefined, initial.signature],
      ["scratch", ["Enter"], undefined, landed.signature],
    ]);
    expect(mockRead).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["the selected row moved", denyText],
    ["the resource changed", allowText.replace("collie_approve_once_probe", "collie_stale_probe")],
    ["the panel was cancelled", load("kiro--v3-idle-w120.txt")],
    ["the editor took focus", load("kiro--v3-approval-edit-w120.txt")],
  ])("sends no key when %s before entry", async (_reason, fresh) => {
    // Given: the tapped model is the real Allow state, but the fresh screen differs.
    const prompt = promptOf(allowText);
    mockRead.mockResolvedValue(pane(fresh));
    // When: the shared prompt action attempts the approval.
    const result = await submitPromptOption(args(prompt, 0));
    // Then: the stale click emits nothing, even with the same stub revision.
    expect(result.status).toBe("changed");
    expect(mockKeys).not.toHaveBeenCalled();
  });

  it("withholds Enter when the next request replaces the dialog during the walk", async () => {
    // Given: the initial screen passes, but the poll sees a new request with the same layout.
    const prompt = promptOf(allowText);
    mockRead.mockResolvedValueOnce(pane(allowText)).mockResolvedValue(pane(denyText.replace("collie_approve_once_probe", "collie_successor_probe")));
    // When: a Deny walk is in flight.
    const result = await submitPromptOption(args(prompt, 1));
    // Then: only the already authorized arrows were sent; no request was answered.
    expect(result.status).toBe("changed");
    expect(mockKeys.mock.calls).toEqual([["scratch", ["Down", "Down"], undefined, prompt.signature]]);
  });

  it("withholds Enter when the pointer never reaches Deny", async () => {
    // Given: every poll remains on Allow.
    const prompt = promptOf(allowText);
    mockRead.mockResolvedValue(pane(allowText));
    // When: a Deny walk times out.
    const result = await submitPromptOption(args(prompt, 1));
    // Then: no commit leaks through the timeout.
    expect(result).toEqual({ status: "changed", why: "timeout" });
    expect(mockKeys.mock.calls).toEqual([["scratch", ["Down", "Down"], undefined, prompt.signature]]);
  });

  it("sends the proven Escape key through the same guard", async () => {
    // Given: the captured approval is unchanged.
    const prompt = promptOf(allowText);
    mockRead.mockResolvedValue(pane(allowText));
    // When: the printed Close action is chosen.
    const result = await submitPromptOption(args(prompt, 2));
    // Then: Escape is bound to that panel rather than sent blindly.
    expect(result).toEqual({ status: "sent" });
    expect(mockKeys.mock.calls).toEqual([["scratch", ["Escape"], undefined, prompt.signature]]);
  });

  it("stops after a bridge binding refusal", async () => {
    // Given: the client read matches but the bridge's last read has changed.
    const prompt = promptOf(allowText);
    mockRead.mockResolvedValue(pane(allowText));
    mockKeys.mockResolvedValue({ ok: false, error: "prompt changed", code: "prompt_changed" });
    // When: Deny begins its guarded walk.
    const result = await submitPromptOption(args(prompt, 1));
    // Then: no unbound retry or Enter follows the refused arrows.
    expect(result.status).toBe("changed");
    expect(mockKeys).toHaveBeenCalledTimes(1);
    expect(mockRead).toHaveBeenCalledTimes(1);
  });
});


describe("complete filesystem subjects use the universal guarded action", () => {
  it.each(["read", "write", "replace", "read-wrapped"])("%s binds Allow once and a one-arrow Deny walk", async (stem) => {
    // Given: captured Allow and Deny states from one file operation.
    const initialText = load(`kiro--v3-${stem}-allow-w60.txt`);
    const movedText = load(`kiro--v3-${stem}-deny-w60.txt`);
    const initial = promptOf(initialText);
    const moved = promptOf(movedText);
    mockRead.mockResolvedValue(pane(initialText));
    // When: Allow once is chosen, then a separate Deny action walks and checks its pointer.
    expect(await submitPromptOption(args(initial, 0))).toEqual({ status: "sent" });
    expect(mockKeys.mock.calls).toEqual([["scratch", ["Enter"], undefined, initial.signature]]);
    mockKeys.mockClear();
    mockRead.mockResolvedValueOnce(pane(initialText)).mockResolvedValue(pane(movedText));
    const result = await submitPromptOption(args(initial, 1));
    // Then: the range/diff preview and the actual selected row bind both writes.
    expect(result).toEqual({ status: "sent" });
    expect(mockKeys.mock.calls).toEqual([
      ["scratch", ["Down"], undefined, initial.signature],
      ["scratch", ["Enter"], undefined, moved.signature],
    ]);
  });

  it("withholds Enter when a successor replacement targets the same file", async () => {
    // Given: two real requests whose approval panels are identical but whose edits differ.
    const initialText = load("kiro--v3-replace-allow-w120.txt");
    const successorText = load("kiro--v3-replace-denied-request-deny-w120.txt");
    const initial = promptOf(initialText);
    mockRead.mockResolvedValueOnce(pane(initialText)).mockResolvedValue(pane(successorText));
    // When: Deny is walking toward its selected row.
    const result = await submitPromptOption(args(initial, 1));
    // Then: the changed diff prevents Enter from answering the successor.
    expect(result.status).toBe("changed");
    expect(mockKeys.mock.calls).toEqual([["scratch", ["Down"], undefined, initial.signature]]);
  });

  it("refuses a file decision when an unread MCP request succeeds it", async () => {
    // Given: the detected file panel is replaced by a real MCP approval.
    const initial = promptOf(load("kiro--v3-read-allow-w120.txt"));
    mockRead.mockResolvedValue(pane(load("kiro--v3-mcp-allow-w120.txt")));
    // When: the prior card tries to Allow once.
    const result = await submitPromptOption(args(initial, 0));
    // Then: no arrow, approval or fallback transport writes into the new request.
    expect(result.status).toBe("changed");
    expect(mockKeys).not.toHaveBeenCalled();
  });
});
