import { describe, expect, it, beforeEach, vi } from "vitest";

// The GENERIC dialog guard: what every *-action module now runs. The api layer is mocked so the pane
// can be made to drift (or to belong to another agent) between the render the user tapped and the
// read the guard takes; the adapters and the fixture corpus are the real thing.
vi.mock("./api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fetchPane, sendKeys } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines } from "./blocks";
import { dialogDetector, sendGuardedKeys } from "./dialog-guard";
import { submitPromptOption } from "./prompt-action";

const mockFetchPane = vi.mocked(fetchPane);
const mockSendKeys = vi.mocked(sendKeys);

const PANES_DIR = join(import.meta.dirname, "..", "fixtures", "panes");
const fixture = (name: string) => readFileSync(join(PANES_DIR, name), "utf8");
const lines = (text: string) => splitLines(parseAnsi(text));

beforeEach(() => {
  vi.clearAllMocks();
  mockSendKeys.mockResolvedValue({ ok: true });
});

function pane(text: string) {
  mockFetchPane.mockResolvedValue({ paneId: "w1:p1", text, truncated: false, revision: 0 });
}

describe("dialogDetector — re-derivation goes through the agent's adapter", () => {
  const permission = fixture("claude--permission-edit.txt");

  it("finds the tail block of the asked-for kind", () => {
    const model = dialogDetector("prompt-select", "claude")(lines(permission));
    expect(model?.family).toBe("permission");
    expect(model?.signature.length).toBeGreaterThan(0);
  });

  it("returns null for a kind this screen doesn't carry", () => {
    expect(dialogDetector("menu", "claude")(lines(permission))).toBeNull();
  });

  // Fail-CLOSED: an agent with no adapter has no verified grammar, so nothing may be re-derived from
  // its buffer — and nothing typed into it. Before the guard went through the registry, each action
  // module re-derived with Claude's detector regardless of whose pane it was.
  it("re-derives NOTHING for an agent with no adapter", () => {
    expect(dialogDetector("prompt-select", "codex")(lines(permission))).toBeNull();
    expect(dialogDetector("prompt-select", undefined)(lines(permission))).toBeNull();
  });
});

describe("the guard refuses when the fresh screen isn't the tapped dialog", () => {
  const permission = fixture("claude--permission-edit.txt");
  const prompt = () => dialogDetector("prompt-select", "claude")(lines(permission))!;

  it("sends when the screen is unchanged", async () => {
    pane(permission);
    const p = prompt();

    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 200,
      detectedRevision: 0,
      agent: "claude",
      canWrite: () => true,
      prompt: p,
      option: p.options[0]!,
    });

    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", p.options[0]!.keys, undefined, p.signature);
  });

  it("does not write when recording starts while its fresh read is pending", async () => {
    const p = prompt();
    let resolveFresh!: (value: { paneId: string; text: string; truncated: boolean; revision: number }) => void;
    mockFetchPane.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFresh = resolve;
      }),
    );
    let voiceBusy = false;

    const action = submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 200,
      detectedRevision: 0,
      agent: "claude",
      canWrite: () => !voiceBusy,
      prompt: p,
      option: p.options[0]!,
    });
    expect(mockFetchPane).toHaveBeenCalledTimes(1);

    // The action began idle, but its fresh-read guard has not settled when recording takes ownership.
    voiceBusy = true;
    resolveFresh({ paneId: "w1:p1", text: permission, truncated: false, revision: 0 });

    await expect(action).resolves.toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("refuses (and types nothing) when the pane belongs to an agent with no adapter", async () => {
    pane(permission);
    const p = prompt();

    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 200,
      detectedRevision: 0,
      agent: "codex",
      canWrite: () => true,
      prompt: p,
      option: p.options[0]!,
    });

    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  // The adapter's ARBITRATION is inherited, not re-litigated: a screen a more specific grammar now
  // claims no longer carries a prompt-select block, so the tap is refused rather than re-parsed
  // through the grammar that lost.
  it("refuses when another grammar now claims the tail", async () => {
    pane(fixture("claude--wizard-q1.txt"));
    const p = prompt();

    const res = await sendGuardedKeys(
      {
        paneId: "w1:p1",
        requestedLines: 200,
        detectedRevision: 0,
        agent: "claude",
        canWrite: () => true,
        kind: "prompt-select",
        model: p,
      },
      p.options[0]!.keys,
    );

    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });
});
