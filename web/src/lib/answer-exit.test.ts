import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { askExitKey, cardExitKey, exitOfAsk, exitOfGuard, holdExitKey } from "./answer-exit";
import { parseAnsi } from "./ansi";
import { splitLines } from "./blocks";
import { buildBlocks } from "./harness";
import type { Ask } from "./surface/surface";

// M102 spec 10: which endings of an answer open the exit, and the key that binds an exit to ONE dialog.

const PANES = join(import.meta.dirname, "..", "fixtures", "panes");
const PERMISSION = readFileSync(join(PANES, "claude--permission-bash.txt"), "utf8");
const blocksOf = (text: string) => buildBlocks(splitLines(parseAnsi(text)), { agent: "claude", grammars: true, nativeMirror: false });

describe("exitOfAsk: the dead ends open the exit, the settled endings do not", () => {
  it("a no_plan refusal opens the no-plan exit", () => {
    expect(exitOfAsk({ status: "refused", reason: "no_plan", detail: null })).toBe("no_plan");
  });

  it("a stale_surface refusal opens the refused exit", () => {
    expect(exitOfAsk({ status: "refused", reason: "stale_surface", detail: null })).toBe("refused");
  });

  it("unknown and error open their own exits", () => {
    expect(exitOfAsk({ status: "unknown", detail: null })).toBe("unknown");
    expect(exitOfAsk({ status: "error", error: "timed out" })).toBe("error");
  });

  it("changed, mismatch, gone, desk and sent open none", () => {
    expect(exitOfAsk({ status: "changed", ask: null, why: "ask_changed" })).toBeNull();
    expect(exitOfAsk({ status: "mismatch", ask: null })).toBeNull();
    expect(exitOfAsk({ status: "gone" })).toBeNull();
    expect(exitOfAsk({ status: "desk", detail: null })).toBeNull();
    expect(exitOfAsk({ status: "sent" })).toBeNull();
  });
});

describe("exitOfGuard: the guarded key route", () => {
  it("a refusal and an error open the exit, a send does not", () => {
    expect(exitOfGuard("changed")).toBe("changed");
    expect(exitOfGuard("error")).toBe("error");
    expect(exitOfGuard("sent")).toBeNull();
  });
});

describe("the exit's key", () => {
  it("holds while a row above the dialog ticks", () => {
    const before = PERMISSION;
    const after = PERMISSION.replace("Sautéed for 5s", "Sautéed for 9s");
    expect(after).not.toBe(before);
    const key = cardExitKey(blocksOf(before));
    expect(key).not.toBeNull();
    expect(cardExitKey(blocksOf(after))).toBe(key);
  });

  it("changes for the same question about another command", () => {
    const other = PERMISSION.replaceAll("mkfifo fixture-fifo", "touch other-file");
    expect(cardExitKey(blocksOf(other))).not.toBe(cardExitKey(blocksOf(PERMISSION)));
  });

  it("is null with no dialog card on screen", () => {
    expect(cardExitKey(blocksOf("  plain transcript text\n"))).toBeNull();
  });

  it("a hold keys on its ask id, and a Surface ask on its words, not its id or hash", () => {
    expect(holdExitKey("ask-1")).not.toBe(holdExitKey("ask-2"));
    const ask: Ask = { id: "ask-a", kind: "permission", options: [{ id: "1", label: "Yes" }, { id: "2", label: "No" }], channel: "keys", hash: "0a0a0a" };
    expect(askExitKey({ ...ask, id: "ask-b", hash: "0b0b0b" })).toBe(askExitKey(ask));
    expect(askExitKey({ ...ask, options: [{ id: "1", label: "Allow" }] })).not.toBe(askExitKey(ask));
  });
});
