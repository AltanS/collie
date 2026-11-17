import { describe, expect, it, beforeEach, vi } from "vitest";

// The GENERIC dialog guard: what every *-action module now runs. The api layer is mocked so the pane
// can be made to drift (or to belong to another agent) between the render the user tapped and the
// read the guard takes; the adapters and the fixture corpus are the real thing.
vi.mock("./api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
}));

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { fetchPane, sendKeys } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines } from "./blocks";
import { dialogDetector, sendBoundKeys, sendGuardedKeys } from "./dialog-guard";
import { buildBlocks } from "./harness";
import { DIALOG_CONTRACT, dialogModelOf, type DialogKind, type DialogModels } from "./harness/dialog-contract";
import { submitPromptOption } from "./prompt-action";
import { verifyPromptBinding } from "../../../bridge/prompt-binding.ts";

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
      prompt: p,
      option: p.options[0]!,
    });

    expect(res).toEqual({ status: "sent" });
    // A framed dialog binds its own rows (`bindRegion`), the rest of the prompt models `signature`.
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", p.options[0]!.keys, undefined, p.bindRegion ?? p.signature);
  });

  it("refuses (and types nothing) when the pane belongs to an agent with no adapter", async () => {
    pane(permission);
    const p = prompt();

    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 200,
      detectedRevision: 0,
      agent: "codex",
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
        kind: "prompt-select",
        model: p,
      },
      p.options[0]!.keys,
    );

    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });
});

// Claude Code 2.1.296 draws a closing rule with the session name under some dialogs in a renamed
// session (claude/closing-rule.ts). The phone renders and the guard re-derives through the same
// adapter entry point, so both read the same rows: the model the user tapped and the model the guard
// derives from the fresh read are one dialog, and the region the first write is bound to is the text
// the bridge finds in the raw read, one row above its end.
describe("a dialog in a named session is tapped, guarded and bound like an unnamed one", () => {
  const NAMED: [DialogKind, string][] = [
    ["prompt-select", "claude-lab--ask-single-named-v2296--w82.txt"],
    ["multi-select", "claude-lab--ask-multi-named-v2296--w82.txt"],
    ["wizard", "claude-lab--ask-wizard-named-v2296--w82.txt"],
    ["wizard", "claude-lab--ask-wizard-review-named-v2296--w82.txt"],
    ["menu", "claude-lab--menu-config-panel-named-v2296--w82.txt"],
    ["prompt-select", "claude-lab--menu-resume-picker-named-v2296--w82.txt"],
  ];

  /** The phone's model: what `buildBlocks` renders from this read, taken the way the card does. */
  function rendered<K extends DialogKind>(kind: K, text: string): DialogModels[K] | null {
    const blocks = buildBlocks(lines(text), { agent: "claude" });
    for (const block of blocks.toReversed()) {
      const model = dialogModelOf(block, kind);
      if (model !== null) return model;
    }
    return null;
  }

  /** Whether the guard's commits comparator calls the fresh model the tapped one, and the region the
   *  first write is bound to. Generic in the kind, so the contract row keeps its own model type. */
  function guardVerdict<K extends DialogKind>(kind: K, name: string) {
    const text = fixture(name);
    const phone = rendered(kind, text);
    const fresh = dialogDetector(kind, "claude")(lines(text));
    expect(phone, "the phone lifts the dialog").not.toBeNull();
    expect(fresh, "the guard re-derives it").not.toBeNull();
    const row = DIALOG_CONTRACT[kind];
    return {
      same: row.commits(phone!, fresh!),
      sameRegion: row.region(phone!) === row.region(fresh!),
    };
  }

  it.each(NAMED)("%s: %s re-derives to the model the phone rendered", (kind, name) => {
    expect(guardVerdict(kind, name)).toEqual({ same: true, sameRegion: true });
  });

  it.each(NAMED)("%s: %s has the model of the same screen without the rule", (kind, name) => {
    const text = fixture(name);
    // The screen an unnamed session shows: the same bytes minus the final row.
    const unnamed = text.slice(0, text.lastIndexOf("\n"));
    expect(rendered(kind, text)).toEqual(rendered(kind, unnamed));
  });

  it("sends a bound tap on a named wizard step: the region is the signature, no rule in it", async () => {
    const text = fixture("claude-lab--ask-wizard-named-v2296--w82.txt");
    pane(text);
    const model = rendered("wizard", text)!;
    const res = await sendGuardedKeys(
      { paneId: "w1:p1", requestedLines: 200, detectedRevision: 0, agent: "claude", kind: "wizard", model },
      ["1"],
    );
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["1"], undefined, model.signature);
    expect(model.signature).not.toContain("capture lab");
    expect(model.signature.split("\n").some((row: string) => row.includes("capture lab"))).toBe(false);
  });

  it("refuses the tap when the named screen has moved on to a different step", async () => {
    pane(fixture("claude-lab--ask-wizard-review-named-v2296--w82.txt"));
    const model = rendered("wizard", fixture("claude-lab--ask-wizard-named-v2296--w82.txt"))!;
    const res = await sendGuardedKeys(
      { paneId: "w1:p1", requestedLines: 200, detectedRevision: 0, agent: "claude", kind: "wizard", model },
      ["1"],
    );
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });
});

// ADR 0080 point 7: a model that carries `styledSignature` has the guard bind its write to it too.
// A grammar with no style-only state sends the old four arguments, byte for byte.
describe("the guard binds a model's styledSignature as expected_styled", () => {
  const opencode = (name: string) => dialogDetector("prompt-select", "opencode")(lines(fixture(name)))!;
  const target = (model: ReturnType<typeof opencode>) => ({
    paneId: "w1:p1",
    requestedLines: 200,
    detectedRevision: 0,
    agent: "opencode",
    kind: "prompt-select" as const,
    model,
  });

  it("sends the styled lines of the FRESH read beside the text region", async () => {
    pane(fixture("oc--permission-bash.txt"));
    const p = opencode("oc--permission-bash.txt");
    expect(p.styledSignature).toBeDefined();

    expect(await sendGuardedKeys(target(p), p.options[0]!.keys)).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["Enter"], undefined, p.signature, p.styledSignature);
  });

  it("refuses a tap whose chip has since moved, though the text is identical", async () => {
    pane(fixture("oc--permission-bash--moved.txt"));
    const p = opencode("oc--permission-bash.txt");
    expect(await sendGuardedKeys(target(p), p.options[0]!.keys)).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("a model with no styledSignature sends exactly the old four arguments", async () => {
    pane(fixture("claude--permission-edit.txt"));
    const p = dialogDetector("prompt-select", "claude")(lines(fixture("claude--permission-edit.txt")))!;
    expect(p.styledSignature).toBeUndefined();
    await sendGuardedKeys({ ...target(p), agent: "claude" }, p.options[0]!.keys);
    expect(mockSendKeys.mock.calls[0]).toEqual(["w1:p1", p.options[0]!.keys, undefined, p.bindRegion ?? p.signature]);
  });
});

// A refused write says which check refused, for a person with the console open (never UI text).
describe("sendBoundKeys: the bridge's reason on a changed prompt", () => {
  const target = { paneId: "w1:p1" };

  it("puts the bridge's reason code on the result as `why`", async () => {
    mockSendKeys.mockResolvedValueOnce({ ok: false, code: "prompt_changed", error: "moved", reason: "style_not_found" });
    expect(await sendBoundKeys(target, ["Enter"], "region", "v1\nstyled")).toEqual({
      status: "changed",
      why: "bridge: style_not_found",
    });
  });

  it("is the bare `changed` of old when the body carries no reason (an older bridge)", async () => {
    mockSendKeys.mockResolvedValueOnce({ ok: false, code: "prompt_changed", error: "moved" });
    expect(await sendBoundKeys(target, ["Enter"], "region")).toEqual({ status: "changed" });
  });
});

// THE FIELD CASE (2026-11-16): a subagent's Bash permission dialog on a crew member (Claude Code
// 2.1.325, Herdr 0.9.5), while the main thread's own background Bash ticked a timer in a row ABOVE the
// dialog. Herdr 0.9.x reports a real pane revision that moves with every repaint, so the old guard's
// revision check refused every tap, and the old comparator refused it too, because the prompt's
// `signature` reads 40 rows above the first option. Nothing was sent, so no bridge logged a tap. The
// guard now refuses when the dialog the person saw is not the dialog on the screen now, and for no
// other reason.
describe("a row outside the dialog that ticks does not refuse the tap", () => {
  const BASE = fixture("claude-lab--permission-bash-subagent--w82.txt");
  const DETECTED = 12972;
  // eslint-disable-next-line no-control-regex -- the fixture is a raw pane read, ANSI and all
  const plain = (row: string) => row.replace(/\x1b\[[0-9;]*m/g, "");
  const rowsOf = (text: string) => text.split("\r\n");

  /** The screen with `rows` in place of the transcript row that matches `at`. */
  function withRows(text: string, at: (row: string) => boolean, rows: string[]): string {
    const all = rowsOf(text);
    const i = all.findIndex((row) => at(plain(row)));
    expect(i, "the row to replace is on the screen").toBeGreaterThanOrEqual(0);
    return [...all.slice(0, i), ...rows, ...all.slice(i + 1)].join("\r\n");
  }
  const waitingRow = (row: string) => row.includes("Waiting for 1 background agent");

  function freshRead(text: string, revision: number) {
    mockFetchPane.mockResolvedValue({ paneId: "w1:p1", text, truncated: false, revision });
  }
  const tapped = (text: string) => dialogDetector("prompt-select", "claude")(lines(text))!;
  const tapYes = (prompt: ReturnType<typeof tapped>, detectedRevision = DETECTED) =>
    submitPromptOption({ paneId: "w1:p1", requestedLines: 200, detectedRevision, agent: "claude", prompt, option: prompt.options[0]! });

  const TICKING: [string, string[], string[]][] = [
    [
      "a tool's timer",
      ["● Bash(sleep 600)", "  ⎿  Running… (4m 12s · timeout 10m)"],
      ["● Bash(sleep 600)", "  ⎿  Running… (4m 16s · timeout 10m)"],
    ],
    ["a spinner glyph", ["✻ Waiting for 1 background agent to finish"], ["✶ Waiting for 1 background agent to finish"]],
    ["a clock in a status row", ["✻ Churned for 4s · done 12:15 AM"], ["✻ Churned for 4s · done 12:16 AM"]],
  ];

  it.each(TICKING)("%s above the dialog, revision N+4: the tap sends the plan's keys once", async (_name, seen, now) => {
    const shown = withRows(BASE, waitingRow, seen);
    const fresh = withRows(BASE, waitingRow, now);
    const prompt = tapped(shown);
    // The changed row is inside the old comparison: the prompt's lookback signature differs. Before
    // this fix the tap was refused here even at an equal revision.
    expect(tapped(fresh).signature).not.toBe(prompt.signature);
    freshRead(fresh, DETECTED + 4);

    expect(await tapYes(prompt)).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledTimes(1);
    const [paneId, keys, scope, region] = mockSendKeys.mock.calls[0]!;
    expect([paneId, keys, scope]).toEqual(["w1:p1", ["1"], undefined]);
    // Bound to the dialog's own rows, so the bridge's re-read cannot fail on the next tick either.
    expect(region).toBe(tapped(fresh).bindRegion);
    expect(region).toMatch(/^─+\n Bash command/u);
    for (const row of [...seen, ...now]) expect(region).not.toContain(row.trim());
  });

  it("an identical screen at a moved revision sends", async () => {
    const prompt = tapped(BASE);
    freshRead(BASE, DETECTED + 4);
    expect(await tapYes(prompt)).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledTimes(1);
  });

  it("an identical screen at the same revision sends", async () => {
    const prompt = tapped(BASE);
    freshRead(BASE, DETECTED);
    expect(await tapYes(prompt)).toEqual({ status: "sent" });
  });

  it("another dialog with the same options but another command is refused, even at the same revision", async () => {
    const prompt = tapped(BASE);
    const other = withRows(BASE, (row) => row === " touch /tmp/claude-lab/project/sub-one.txt", [" rm -rf /tmp/claude-lab/project"]);
    const successor = tapped(other);
    // Same shape: question, labels and keys all match, only the command differs.
    expect(successor.question).toBe(prompt.question);
    expect(successor.options).toEqual(prompt.options);
    freshRead(other, DETECTED);
    expect(await tapYes(prompt)).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("another subject line (description) with the same command and options is refused", async () => {
    const prompt = tapped(BASE);
    const other = withRows(BASE, (row) => row === " Create empty file sub-one.txt", [" Create empty file sub-two.txt"]);
    freshRead(other, DETECTED + 1);
    expect(await tapYes(prompt)).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("a moved pointer is refused, as the contract says (the byte-faithful dialog rows carry it)", async () => {
    const prompt = tapped(BASE);
    const moved = withRows(
      withRows(BASE, (row) => row === " ❯ 1. Yes", ["   1. Yes"]),
      (row) => row.startsWith("   2. Yes, and always allow"),
      [" ❯ 2. Yes, and always allow access to /tmp/claude-lab/project from this project"],
    );
    expect(tapped(moved), "the moved screen still lifts").not.toBeNull();
    freshRead(moved, DETECTED);
    expect(await tapYes(prompt)).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("a dialog that is gone is refused", async () => {
    const prompt = tapped(BASE);
    const rows = rowsOf(BASE);
    const edge = rows.findIndex((row) => plain(row).startsWith("────"));
    freshRead([...rows.slice(0, edge), "● Done."].join("\r\n"), DETECTED + 4);
    expect(await tapYes(prompt)).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("bindRegion is the last rows of the signature, ending at the same row", () => {
    // `bindRegion` is a row suffix of `signature`, ending at the same row, so the bridge finds it
    // wherever it found `signature`.
    const prompt = tapped(BASE);
    expect(prompt.bindRegion).toBeDefined();
    expect(prompt.signature.endsWith(`\n${prompt.bindRegion!}`)).toBe(true);
  });
});

// Every Claude capture whose prompt binds its own rows: the bridge's own verifier finds that region in
// the raw read, so the narrower binding is never a new refusal.
describe("bindRegion binds on every real Claude capture through the bridge's verifier", () => {
  const names = readdirSync(PANES_DIR).filter((name) => name.startsWith("claude"));
  const bound = names.flatMap((name) => {
    const model = dialogDetector("prompt-select", "claude")(lines(fixture(name)));
    return model?.bindRegion === undefined ? [] : [[name, model] as const];
  });

  it("covers captures", () => {
    expect(bound.length).toBeGreaterThan(20);
  });

  it.each(bound)("%s", (name, model) => {
    expect(model.styledSignature).toBeUndefined();
    expect(model.bindColumns).toBeUndefined();
    expect(DIALOG_CONTRACT["prompt-select"].region(model)).toBe(model.bindRegion);
    expect(model.signature === model.bindRegion || model.signature.endsWith(`\n${model.bindRegion!}`)).toBe(true);
    expect(verifyPromptBinding(fixture(name), model.bindRegion!, undefined, undefined, model.bindTail).ok).toBe(true);
  });
});
