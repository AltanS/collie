import { describe, expect, it } from "vitest";

import { lineText } from "../blocks";
import { fixtureRows, idleFor } from "../../test/surface-corpus";
import { own } from "../../test/surface-fold";
import { loadProfiles } from "./profile";
import { askOf, isFree } from "./surface";

// The harness lab on Grok Build 1.0.77 (2026-11-16): screens captured in a scratch tmux at 61, 80 and
// 120 columns, and the queued row from a scratch Herdr session, each read here the way the shadow
// reads a live pane. Every row is what the screen showed; the lab checked each one by eye.
const PROFILE = loadProfiles().get("grok")!;

const READS: readonly (readonly [string, { turn: string; modal: string; composer: string }, string | null])[] = [
  ["grok--v1.0.77-idle-optin--w120.txt", { turn: "idle", modal: "none", composer: "empty" }, ""],
  ["grok--v1.0.77-done--w120.txt", { turn: "idle", modal: "none", composer: "empty" }, ""],
  // A draft of three rows and more read as a pointed list (modal unreadable) before `ownPrompt`.
  ["grok--v1.0.77-draft-wrapped--w61.txt", { turn: "idle", modal: "none", composer: "draft" }, "This is a long lab draft that should wrap across more than one row in the input box of Grok Build so the reader has to join the continuation rows into a single draft line again, ok"],
  ["grok--v1.0.77-draft-wrapped--w80.txt", { turn: "idle", modal: "none", composer: "draft" }, "This is a long lab draft that should wrap across more than one row in the input box of Grok Build so the reader has to join the continuation rows into a single draft line again, ok"],
  ["grok--v1.0.77-draft-six-rows--w120.txt", { turn: "idle", modal: "none", composer: "draft" }, `${"word ".repeat(120).trim()}`],
  ["grok--v1.0.77-draft-lines--w61.txt", { turn: "idle", modal: "none", composer: "draft" }, "first line second line 1. fourth"],
  // 1.0.77 folds a paste of four lines or more into `[Pasted: N lines]`, with a colon.
  ["grok--v1.0.77-paste-fold--w120.txt", { turn: "idle", modal: "none", composer: "draft" }, "[Pasted: 30 lines]"],
  // `/stat` typed; Grok paints the rest of `/statusline` after it in grey (`idle.inlineHint`).
  ["grok--v1.0.77-slash-ghost--w120.txt", { turn: "idle", modal: "none", composer: "draft" }, "/stat"],
  // The hint row under the box says `Ctrl+c:cancel` in a turn since 1.0.77 (was `Esc:cancel`).
  ["grok--v1.0.77-running--w120.txt", { turn: "running", modal: "none", composer: "empty" }, ""],
  ["grok--v1.0.77-running-draft--w120.txt", { turn: "running", modal: "none", composer: "draft" }, "Answer with the single word ping."],
  ["grok--v1.0.77-queued--w120.txt", { turn: "running", modal: "none", composer: "empty" }, ""],
  ["grok--v1.0.77-settings--w61.txt", { turn: "unknown", modal: "unreadable", composer: "unknown" }, null],
];

describe("Grok Build 1.0.77 screens (harness lab 2026-11-16)", () => {
  it.each(READS)("%s reads as the screen showed", (name, claim, draft) => {
    const read = own(name);
    expect(read.surface).toMatchObject(claim);
    if (draft === null) expect(read.frame).toBeNull();
    else expect(read.frame?.interior.text, name).toBe(draft);
  });

  it("the trust prompt and the model list still lift as asks", () => {
    expect(askOf(own("grok--v1.0.77-trust--w80.txt").surface.modal)?.options.map((o) => o.label)).toEqual(["Yes, proceed", "No, quit"]);
    const picker = askOf(own("grok--v1.0.77-model-picker--w61.txt").surface.modal);
    expect(picker?.kind).toBe("question");
    expect(picker?.options.map((o) => o.label).slice(0, 4)).toEqual(["Grok 4.7 (current)", "Grok 4.7 Fast", "Grok 4.6", "Grok 4.5"]);
  });

  it("only the idle screens read free", () => {
    const free = READS.map(([name]) => name).filter((name) => isFree(own(name).surface));
    expect(free).toEqual(["grok--v1.0.77-idle-optin--w120.txt", "grok--v1.0.77-done--w120.txt"]);
  });

  it("the collapse pattern takes the 1.0.77 fold and the older one", () => {
    const fold = new RegExp(PROFILE.collapse!.pattern, "u");
    expect(fold.test("[Pasted: 30 lines]")).toBe(true);
    expect(fold.test("[Pasted 3003 chars]")).toBe(true);
    expect(fold.test("[Pastedx]")).toBe(false);
  });

  it("the queued row of the Herdr capture is the text under `▾ Queued 1`", () => {
    const queued = PROFILE.keys.queuedRow!;
    const texts = fixtureRows("grok--v1.0.77-queued--w120.txt").map((row) => lineText(row).trimEnd());
    const hint = texts.findIndex((text) => new RegExp(queued.hint, "u").test(text));
    expect(hint).toBeGreaterThan(0);
    expect(new RegExp(queued.pattern, "u").exec(texts[hint + 1]!)?.groups?.text).toBe("Answer with the single word pong.");
    expect(PROFILE.keys.enterWhileRunning).toBe("queues");
  });

  it("the ghost colour is the one the capture paints after `/stat`", () => {
    expect(idleFor("grok")!.inlineHint?.fg).toEqual(["rgb(108,108,108)"]);
  });
});
