import { readFileSync } from "node:fs";
import { join } from "node:path";

import { postAskAnswer } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines } from "./blocks";
import { answerAsk, cardHashOf } from "./dialog-ask";
import { readerBlocks } from "./surface/lift";
import type { Ask } from "./surface/surface";

vi.mock("./liveness", async (importOriginal) => ({ ...(await importOriginal<typeof import("./liveness")>()), isLive: () => true }));
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), postAskAnswer: vi.fn() }));

const OPTIONS = [{ id: "1", label: "Set as default" }, { id: "2", label: "Use this session only" }, { id: "3", label: "Cancel" }];
const menuAsk = (id: string, hash: string): Ask => ({ id, kind: "menu", options: OPTIONS, channel: "keys", hash });
const HELD = menuAsk("ask-held0000000000", "aaaaaaaaaaaaaa");
const TAP = { card: "menu", index: 1, label: "Use this session only" } as const;

describe("answerAsk with the card's hash (`seen`)", () => {
  const post = vi.mocked(postAskAnswer);
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ outcome: "sent", reason: null, ask: null, surface: null, detail: null, replayed: false });
  });

  it("the held ask has the card's hash: one post under it, no fresh read", async () => {
    const fresh = vi.fn();
    expect(await answerAsk({ paneId: "w1:p1", ask: HELD, tap: TAP, seen: HELD.hash, fresh })).toEqual({ status: "sent" });
    expect(fresh).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(HELD.id, { pane: "w1:p1", hash: HELD.hash, optionId: "2", origin: "person_tap" }, undefined);
  });

  it("the held ask is another state: the fresh ask with the card's hash is the one posted", async () => {
    const newer = menuAsk("ask-fresh000000000", "bbbbbbbbbbbbbb");
    const fresh = vi.fn(async () => newer);
    expect(await answerAsk({ paneId: "w1:p1", ask: HELD, tap: TAP, seen: newer.hash, fresh })).toEqual({ status: "sent" });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(newer.id, { pane: "w1:p1", hash: newer.hash, optionId: "2", origin: "person_tap" }, undefined);
  });

  it("the fresh ask is not the card's dialog either: nothing is posted, and the fresh ask comes back", async () => {
    const other = menuAsk("ask-other000000000", "cccccccccccccc");
    const result = await answerAsk({ paneId: "w1:p1", ask: HELD, tap: TAP, seen: "bbbbbbbbbbbbbb", fresh: async () => other });
    expect(result).toEqual({ status: "changed", ask: other, why: "card" });
    expect(post).not.toHaveBeenCalled();
  });

  it("a card whose dialog did not lift posts nothing and reads nothing", async () => {
    const fresh = vi.fn();
    expect(await answerAsk({ paneId: "w1:p1", ask: HELD, tap: TAP, seen: null, fresh })).toEqual({ status: "changed", ask: null, why: "card" });
    expect(fresh).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("cardHashOf", () => {
  const picker = readFileSync(join(import.meta.dirname, "..", "fixtures", "panes", "claude--menu-model-picker.txt"), "utf8");
  const blocks = readerBlocks(splitLines(parseAnsi(picker)), "claude");
  const menu = blocks.find((b) => b.kind === "menu");

  it("is the lifted hash for the card's own model, and null for any other model", () => {
    if (menu?.kind !== "menu") throw new Error("the fixture lifts no menu");
    expect(cardHashOf(blocks, menu.menu)).toMatch(/^[0-9a-f]{14}$/);
    expect(cardHashOf(blocks, { ...menu.menu })).toBeNull();
  });
});
