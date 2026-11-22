// The Send Protocol on a Codex footer row that loses words when the box gets its first character (#847).
// Codex draws `? for shortcuts` on its footer row with other segments after wide spacing (a warning, a
// goal notice). At the first character it hides the shortcut text and leaves the rest standing. Three
// times a row left that way matched no hint pattern and the probe failed: the 0.166 warning row, the
// goal usage-limit notice, and the goal-achieved notice of #847. The profile now says its hint rows may
// lose text (`idle.volatile.below.losesText`): a row under the box whose words are the words of an S0
// hint row with some left out, in order, is no new row. The proofs here run on real captures only; the
// pure word rule is pinned on neutral words.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Profile } from "../../web/src/lib/surface/profile.ts";
import { excusedBelow, lostWordsOnly } from "./protocol.ts";
import { FakePane, rig, surfaceFixture, useScratchDir } from "./protocol.rig.ts";

useScratchDir();

// eslint-disable-next-line no-control-regex
const plain = (row: string): string => row.replace(/\u001b\[[0-9;:?]*[ -/]*[@-~]/gu, "");
const capture = (name: string): string[] => readFileSync(join(import.meta.dirname, "..", "..", "web", "src", "fixtures", "panes", name), "utf8").replace(/\n$/u, "").split("\n");

/**
 * A pane drawn from captures: `empty` while the box is empty, `typed` (its box row redrawn) while the box
 * holds text. `typed` null keeps the empty screen, its box row redrawn.
 */
function capturedPane(empty: readonly string[], typed: readonly string[] | null, box = ""): FakePane {
  const holding = typed ?? empty;
  const at = holding.findLastIndex((row) => plain(row).startsWith("› "));
  const fake = new FakePane("codex");
  fake.box = box;
  fake.render = () => (fake.box !== "" ? holding.map((row, i) => (i === at ? `\u001b[1m›\u001b[0m ${fake.box}` : row)) : empty).join("\n");
  return fake;
}

/** A test-local copy of the Codex profile with the hint patterns that `drop` names taken out. */
const withoutHints =
  (drop: (hint: string) => boolean, losesText = true) =>
  (profile: Profile): Profile => {
    const { losesText: _flag, ...below } = profile.idle.volatile.below;
    void _flag;
    const hints = (profile.idle.volatile.below.hints ?? []).filter((hint) => !drop(hint));
    return { ...profile, idle: { ...profile.idle, volatile: { ...profile.idle.volatile, below: losesText ? { ...below, losesText: true, hints } : { ...below, hints } } } };
  };
const warningHint = (hint: string): boolean => hint.includes("⚠");

describe("a Codex hint row that loses words at the first character (#847), on the real 0.166 captures", () => {
  const warningEmpty = (): string[] => capture("codex--v0166-warning-art-empty--w120.txt");
  const warningTyped = (): string[] => capture("codex--v0166-warning-typed--w120.txt");

  test("the profile sets the rule", async () => {
    const { loadProfiles } = await import("../../web/src/lib/surface/profile.ts");
    expect(loadProfiles().get("codex")?.idle.volatile.below.losesText).toBe(true);
  });

  test("with no warning pattern the lone warning row is the S0 hint row less its shortcut text: the probe passes by the rule alone and Tab sends", async () => {
    const fake = capturedPane(warningEmpty(), warningTyped());
    const answer = await rig({ pane: fake, harness: "codex", version: "0.166.0", edit: withoutHints(warningHint) }).send("reply with one word: ready");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Tab"] });
    expect(fake.transcript.at(-1)).toBe("› reply with one word: ready");
  });

  test("a command goes in the same way: its probe and its S1 read the one count", async () => {
    const fake = capturedPane(warningEmpty(), warningTyped());
    const answer = await rig({ pane: fake, harness: "codex", version: "0.166.0", edit: withoutHints(warningHint) }).send("/status", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
  });

  test("a profile without the rule refuses the same screens as before", async () => {
    const fake = capturedPane(warningEmpty(), warningTyped());
    const answer = await rig({ pane: fake, harness: "codex", version: "0.166.0", edit: withoutHints(warningHint, false) }).send("reply with one word: ready");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe", "Backspace"] });
    expect(fake.keysSeen.filter((key) => key === "Tab" || key === "Enter")).toEqual([]);
  });

  test("a row that no S0 hint row gives fails: S0 shows only the shortcut hint, and the warning row stands there after the probe", async () => {
    const fake = capturedPane(capture("codex--v0166-art-empty--w120.txt"), warningTyped());
    const answer = await rig({ pane: fake, harness: "codex", version: "0.166.0", edit: withoutHints(warningHint) }).send("reply with one word: ready");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(fake.keysSeen.filter((key) => key === "Tab" || key === "Enter")).toEqual([]);
  });

  test("a real dialog after the probe still blocks: no submit key", async () => {
    const fake = capturedPane(warningEmpty(), capture("codex--approval-exec.txt"));
    const answer = await rig({ pane: fake, harness: "codex", version: "0.166.0" }).send("reply with one word: ready");
    expect(answer.receipt?.outcome).toBe("refused");
    expect(fake.keysSeen.filter((key) => key === "Tab" || key === "Enter")).toEqual([]);
  });

  test("a draft still blocks: the typed capture with its draft is refused draft_present and the draft stays", async () => {
    const fake = capturedPane(warningEmpty(), warningTyped(), "x");
    const answer = await rig({ pane: fake, harness: "codex", version: "0.166.0", edit: withoutHints(warningHint) }).send("reply with one word: ready");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    expect(fake.box).toBe("x");
    expect(fake.keysSeen.filter((key) => key === "Tab" || key === "Enter")).toEqual([]);
  });
});

describe("a Codex 0.163.0 footer row whose words change, not only go (#847)", () => {
  // The idle capture's hint row is `? for shortcuts` with the warning after wide spacing; with the probe
  // typed the row reads `tab to queue message`. Those words were never on the S0 row.
  const pane = (): FakePane => {
    const idle = surfaceFixture("codex--v0-163-0-idle-warning.txt")
      .replace("› Ask Codex to do anything", "\u001b[1m›\u001b[0m \u001b[2mAsk Codex to do anything\u001b[0m")
      .split("\n");
    return capturedPane(idle, surfaceFixture("codex--v0-163-0-in-turn-probe.txt").split("\n"));
  };

  test("with the queue hint taken out the changed row counts, and the probe fails as before", async () => {
    const fake = pane();
    const answer = await rig({ pane: fake, harness: "codex", version: "0.163.0", edit: withoutHints((hint) => hint.includes("queue message")) }).send("reply with one word: ready");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(fake.keysSeen.filter((key) => key === "Tab" || key === "Enter")).toEqual([]);
  });
});

describe("the word rule itself", () => {
  test("words left out, in order, at least one kept, is lost text", () => {
    expect(lostWordsOnly("  alpha beta    gamma delta", "        gamma delta")).toBe(true);
    expect(lostWordsOnly("alpha beta gamma", "alpha gamma")).toBe(true);
  });

  test("a word added, a word changed, the order turned, all words gone, or the same row is no lost text", () => {
    expect(lostWordsOnly("alpha beta gamma", "beta gamma epsilon")).toBe(false);
    expect(lostWordsOnly("alpha beta gamma", "beta gammas")).toBe(false);
    expect(lostWordsOnly("alpha beta (2s) gamma", "beta (3s) gamma")).toBe(false);
    expect(lostWordsOnly("alpha beta gamma", "gamma beta")).toBe(false);
    expect(lostWordsOnly("alpha beta gamma", "   ")).toBe(false);
    expect(lostWordsOnly("alpha beta gamma", "alpha beta gamma")).toBe(false);
  });

  test("each S0 hint row gives at most one later row, and a row no hint row gives still counts", () => {
    expect(excusedBelow(["alpha beta gamma"], ["gamma"])).toBe(1);
    expect(excusedBelow(["alpha beta gamma"], ["gamma", "beta"])).toBe(1);
    expect(excusedBelow(["alpha beta gamma", "alpha beta"], ["beta", "gamma"])).toBe(2);
    expect(excusedBelow(["alpha beta gamma"], ["delta"])).toBe(0);
    expect(excusedBelow([], ["gamma"])).toBe(0);
  });
});
