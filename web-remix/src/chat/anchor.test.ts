/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import { mergeChat, EMPTY_CHAT_WINDOW } from "@web/lib/chat-window";
import type { ChatEntry } from "@web/lib/types";

import { anchorOf, restoredTop, type BlockBox } from "./anchor";

const box = (key: string, top: number, height = 100): BlockBox => ({ key, top, bottom: top + height });

describe("anchorOf", () => {
  test("takes the first block still in view, even if only its tail shows", () => {
    // The scroller's top is at 50; block b's tail (bottom 60) is the first thing under it.
    const blocks = [box("a", -80, 90), box("b", -30, 90), box("c", 60)];
    expect(anchorOf(blocks, 50, 700)).toEqual({ key: "b", offset: -80, fromBottom: 700 });
  });
  test("a block exactly above the top is not in view", () => {
    expect(anchorOf([box("a", -100), box("b", 0)], 0, 5)?.key).toBe("b");
  });
  test("no block, no anchor", () => {
    expect(anchorOf([], 0, 0)).toBeNull();
    expect(anchorOf([box("a", -500)], 0, 0)).toBeNull();
  });
});

describe("restoredTop", () => {
  const anchor = { key: "b", offset: 20, fromBottom: 900 };

  test("moves by the block's drift: older turns landed above, the block went down 1200", () => {
    const now = { scrollTop: 300, scrollHeight: 3000, containerTop: 0, blocks: [box("a", 0), box("b", 1220)] };
    expect(restoredTop(anchor, now)).toBe(300 + 1200);
  });
  test("the browser's own scroll anchoring already held it: no drift, no write", () => {
    const now = { scrollTop: 1500, scrollHeight: 3000, containerTop: 0, blocks: [box("b", 20)] };
    expect(restoredTop(anchor, now)).toBe(1500);
  });
  test("a stand-in resized under the block: the drift follows the block, not the bottom", () => {
    // Distance from the bottom would say 3000 - 900 = 2100; the block says it is 80 px lower than held.
    const now = { scrollTop: 1500, scrollHeight: 3000, containerTop: 0, blocks: [box("b", 100)] };
    expect(restoredTop(anchor, now)).toBe(1580);
  });
  test("a scroller whose top is not 0 is measured against its own top", () => {
    const now = { scrollTop: 10, scrollHeight: 900, containerTop: 60, blocks: [box("b", 380)] };
    expect(restoredTop(anchor, now)).toBe(10 + (380 - 60 - 20));
  });
  test("a block that is gone falls back to the distance from the bottom", () => {
    const now = { scrollTop: 0, scrollHeight: 3000, containerTop: 0, blocks: [box("zz", 0)] };
    expect(restoredTop(anchor, now)).toBe(2100);
  });
});

// Load older's merge is web's pure `mergeChat`: older pages go in by `seq`, keyed by `uuid`, and a turn
// the page repeats is written over, not doubled.
describe("an older page merges by key", () => {
  const turn = (n: number): ChatEntry => ({ uuid: `u${String(n)}`, seq: n, ts: "2026-10-06T10:00:00.000Z", role: "user", parts: [{ kind: "text", text: `turn ${String(n)}` }] });
  const live = mergeChat(EMPTY_CHAT_WINDOW, {
    outcome: "body",
    body: { paneId: "w1:p1", available: true, page: "live", gen: 1, rev: 1, head: 12, oldest: 11, hasOlder: true, upserts: [turn(11), turn(12)], queued: [] },
  });

  test("prepends in seq order and does not double a repeated turn", () => {
    const merged = mergeChat(live, { outcome: "body", body: { paneId: "w1:p1", available: true, page: "older", gen: 1, hasOlder: true, upserts: [turn(9), turn(10), turn(11)] } });
    expect(merged.entries.map((e) => e.uuid)).toEqual(["u9", "u10", "u11", "u12"]);
    expect(merged.oldest).toBe(9);
    expect(merged.hasOlder).toBe(true);
  });
  test("the same page twice changes nothing more", () => {
    const page = { outcome: "body" as const, body: { paneId: "w1:p1", available: true as const, page: "older" as const, gen: 1, hasOlder: false, upserts: [turn(9), turn(10)] } };
    const once = mergeChat(live, page);
    const twice = mergeChat(once, page);
    expect(twice.entries.map((e) => e.uuid)).toEqual(["u9", "u10", "u11", "u12"]);
    expect(twice.hasOlder).toBe(false);
  });
});
