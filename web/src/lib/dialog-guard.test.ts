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
import { verifyPromptBinding, verifyPromptParts } from "../../../bridge/prompt-binding.ts";
import { liftDialog, readerBlocks } from "./surface/lift";

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

// The rest of the ticking-row family (follow-up of 2026-11-17): Claude's preview question, agy's
// prompts, the plan approval whose subject sits above its rule, and Claude's self-answer countdown.
describe("ticking rows, plan approvals and the countdown, on the phone and in the ask id", () => {
  // eslint-disable-next-line no-control-regex -- the fixtures are raw pane reads, ANSI and all
  const plain = (row: string) => row.replace(/\x1b\[[0-9;]*m/g, "");
  /** The screen with `rows` inserted right above the first row that matches `at`. */
  function insertAbove(text: string, at: (row: string) => boolean, rows: string[]): string {
    const sep = text.includes("\r\n") ? "\r\n" : "\n";
    const all = text.split(sep);
    const i = all.findIndex((row) => at(plain(row)));
    expect(i, "the anchor row is on the screen").toBeGreaterThan(0);
    return [...all.slice(0, i), ...rows, ...all.slice(i)].join(sep);
  }
  const TICK = (t: string) => [`● Bash(sleep 600)`, `  ⎿  Running… (${t} · timeout 10m)`];
  const lift = (text: string, agent: string) => liftDialog(readerBlocks(lines(text), agent))!;

  describe("Claude's preview question", () => {
    const BASE = fixture("claude--select-preview.txt");
    const rule = (row: string) => row.startsWith("────");
    const model = (text: string) => dialogDetector("preview-select", "claude")(lines(text))!;
    const shown = insertAbove(BASE, rule, TICK("4m 12s"));
    const fresh = insertAbove(BASE, rule, TICK("4m 16s"));

    it("a timer above the rule is the same dialog to the tap and the ask id, and outside the bound region", () => {
      const c = DIALOG_CONTRACT["preview-select"];
      expect(c.commits(model(shown), model(fresh))).toBe(true);
      expect(c.region(model(fresh))).toMatch(/^─+\n ☐ Design/u);
      expect(c.region(model(fresh))).not.toContain("Running");
      expect(lift(fresh, "claude").hash).toBe(lift(shown, "claude").hash);
      expect(lift(fresh, "claude").region).toBe(lift(shown, "claude").region);
    });

    it("another question under the same options is another dialog", () => {
      const other = fresh.replaceAll("Which widget design should we use?", "Which widget design should we drop?");
      expect(DIALOG_CONTRACT["preview-select"].commits(model(shown), model(other))).toBe(false);
      expect(lift(other, "claude").hash).not.toBe(lift(shown, "claude").hash);
    });
  });

  describe("agy's permission", () => {
    const BASE = fixture("agy--permission-bash.txt");
    const title = (row: string) => row === "Command";
    const shown = insertAbove(BASE, title, TICK("4m 12s"));
    const fresh = insertAbove(BASE, title, TICK("4m 16s"));
    const tapped = (text: string) => dialogDetector("prompt-select", "agy")(lines(text))!;
    const tap = (prompt: ReturnType<typeof tapped>) =>
      submitPromptOption({ paneId: "w1:p1", requestedLines: 200, detectedRevision: 7, agent: "agy", prompt, option: prompt.options[0]! });

    it("a timer above the dialog, revision moved: the tap sends once, bound to the dialog's own rows", async () => {
      const prompt = tapped(shown);
      expect(tapped(fresh).signature).not.toBe(prompt.signature);
      mockFetchPane.mockResolvedValue({ paneId: "w1:p1", text: fresh, truncated: false, revision: 11 });
      expect(await tap(prompt)).toEqual({ status: "sent" });
      expect(mockSendKeys).toHaveBeenCalledTimes(1);
      const sent = mockSendKeys.mock.calls[0]![3];
      // One string, not the list form: agy's dialog holds no row that redraws by itself.
      expect(Array.isArray(sent)).toBe(false);
      const region = String(sent);
      expect(region).toMatch(/^Command\n─+\n/u);
      expect(region).not.toContain("Running");
      expect(verifyPromptBinding(fresh, region).ok).toBe(true);
      expect(lift(fresh, "agy").hash).toBe(lift(shown, "agy").hash);
    });

    it("another command under the same options is refused, and is another ask", async () => {
      const prompt = tapped(shown);
      const other = fresh.split("\n").map((row) => (plain(row).trimEnd() === "   ls -la /tmp" ? "   rm -rf /tmp" : row)).join("\n");
      expect(other).not.toBe(fresh);
      mockFetchPane.mockResolvedValue({ paneId: "w1:p1", text: other, truncated: false, revision: 7 });
      expect(await tap(prompt)).toEqual({ status: "changed" });
      expect(mockSendKeys).not.toHaveBeenCalled();
      expect(lift(other, "agy").hash).not.toBe(lift(shown, "agy").hash);
    });
  });

  describe("a plan approval, whose plan sits above the rule that tops the question", () => {
    const BASE = fixture("claude-lab--plan-approval--w82.txt");
    const REVISED = BASE.replace("the heading and prior three lines untouched.", "the heading and prior three lines rewritten.");
    const tapped = (text: string) => dialogDetector("prompt-select", "claude")(lines(text))!;

    it("carries no bindRegion: the rows under the rule do not hold the plan", () => {
      expect(tapped(BASE).askRegion).toBeTruthy();
      expect(tapped(BASE).bindRegion).toBeUndefined();
    });

    it("a revised plan in the same file is refused on the phone and is another ask", async () => {
      expect(REVISED).not.toBe(BASE);
      const prompt = tapped(BASE);
      mockFetchPane.mockResolvedValue({ paneId: "w1:p1", text: REVISED, truncated: false, revision: 0 });
      const res = await submitPromptOption({ paneId: "w1:p1", requestedLines: 200, detectedRevision: 0, agent: "claude", prompt, option: prompt.options[1]! });
      expect(res).toEqual({ status: "changed" });
      expect(mockSendKeys).not.toHaveBeenCalled();
      expect(lift(REVISED, "claude").hash).not.toBe(lift(BASE, "claude").hash);
    });
  });

  describe("Claude's self-answer countdown inside the dialog", () => {
    const BG = fixture("claude--v2303-permission-bash-bg-agent-rm--w160.txt");
    const sentence = (clock: string) =>
      `⚠ Claude Code will automatically deny this request in ${clock}, to avoid blocking progress on an unattended session`;
    /** The capture with the countdown under its explanation row, as the owner's phone showed it. */
    function countdown(clock: string): string {
      const rows = BG.split("\n");
      const at = rows.findIndex((row) => row.includes("Dangerous rm operation"));
      expect(at).toBeGreaterThan(0);
      rows.splice(at + 1, 0, ` \u001b[0m\u001b[2m│\u001b[0m \u001b[38;2;255;193;7m${sentence(clock)}\u001b[0m\r`);
      return rows.join("\n");
    }
    const tapped = (text: string) => dialogDetector("prompt-select", "claude")(lines(text))!;

    it("the clock moving between the tap and the reads refuses nothing, and the bridge finds both parts at any clock", async () => {
      const prompt = tapped(countdown("1:20"));
      expect(prompt.bindParts).toHaveLength(2);
      const [head, rest] = prompt.bindParts!;
      expect(head).toContain("level.py;");
      expect(rest).toBe(prompt.bindRegion);
      expect(rest).toContain("Do you want to proceed?");
      for (const part of prompt.bindParts!) expect(part).not.toContain("automatically deny");
      mockFetchPane.mockResolvedValue({ paneId: "w1:p1", text: countdown("1:19"), truncated: false, revision: 9 });
      const res = await submitPromptOption({ paneId: "w1:p1", requestedLines: 200, detectedRevision: 8, agent: "claude", prompt, option: prompt.options[0]! });
      expect(res).toEqual({ status: "sent" });
      const parts = mockSendKeys.mock.calls[0]![3];
      if (!Array.isArray(parts)) throw new Error("a dialog with a clock binds a list");
      expect(parts).toEqual(prompt.bindParts);
      // The bridge re-reads a moment later: the clock has moved again, and both parts still bind.
      for (const clock of ["0:59", "0:05", "about 45 seconds"]) expect(verifyPromptParts(countdown(clock), parts).ok).toBe(true);
      // Another command under the same countdown, question and options: the first part is not there.
      expect(verifyPromptParts(countdown("1:20").replace("level.py;", "level.sh;"), parts)).toEqual({ ok: false, reason: "not_found" });
    });

    it("Claude Code 2.1.330's block/holding-up countdown binds two parts and lets the tap pass as the clock ticks", async () => {
      const blockSentence = (clock: string) =>
        `⚠ Claude Code will automatically block this request in ${clock}, to avoid holding up an unattended session`;
      const blockScreen = (clock: string) => {
        const rows = BG.split("\n");
        const at = rows.findIndex((row) => row.includes("Dangerous rm operation"));
        expect(at).toBeGreaterThan(0);
        rows.splice(at + 1, 0, ` \u001b[0m\u001b[2m│\u001b[0m \u001b[38;2;255;193;7m${blockSentence(clock)}\u001b[0m\r`);
        return rows.join("\n");
      };
      const prompt = tapped(blockScreen("1:20"));
      expect(prompt.bindParts).toHaveLength(2);
      for (const part of prompt.bindParts!) expect(part).not.toContain("automatically block");
      mockFetchPane.mockResolvedValue({ paneId: "w1:p1", text: blockScreen("1:19"), truncated: false, revision: 9 });
      const res = await submitPromptOption({ paneId: "w1:p1", requestedLines: 200, detectedRevision: 8, agent: "claude", prompt, option: prompt.options[0]! });
      expect(res).toEqual({ status: "sent" });
      for (const clock of ["0:59", "0:05", "about 45 seconds"]) expect(verifyPromptParts(blockScreen(clock), prompt.bindParts!).ok).toBe(true);
      expect(verifyPromptParts(blockScreen("1:20").replace("level.py;", "level.sh;"), prompt.bindParts!)).toEqual({ ok: false, reason: "not_found" });
    });

    it("a bridge that does not know the list refuses it, and the tap is a shown error with nothing retried", async () => {
      const prompt = tapped(countdown("1:20"));
      mockFetchPane.mockResolvedValue({ paneId: "w1:p1", text: countdown("1:19"), truncated: false, revision: 9 });
      // Every bridge from 1.0.0 to 1.29.0-edge.3 answers a non-string `expected_prompt` with this 400.
      mockSendKeys.mockRejectedValueOnce(new Error("400 bad expected_prompt"));
      const res = await submitPromptOption({ paneId: "w1:p1", requestedLines: 200, detectedRevision: 8, agent: "claude", prompt, option: prompt.options[0]! });
      expect(res.status).toBe("error");
      expect(mockSendKeys).toHaveBeenCalledTimes(1);
    });

    it("another command under the same countdown is still refused on the phone", async () => {
      const prompt = tapped(countdown("1:20"));
      const other = countdown("1:19").replace("level.py;", "level.sh;");
      expect(other).not.toBe(countdown("1:19"));
      mockFetchPane.mockResolvedValue({ paneId: "w1:p1", text: other, truncated: false, revision: 9 });
      const res = await submitPromptOption({ paneId: "w1:p1", requestedLines: 200, detectedRevision: 8, agent: "claude", prompt, option: prompt.options[0]! });
      expect(res).toEqual({ status: "changed" });
    });
  });
});
