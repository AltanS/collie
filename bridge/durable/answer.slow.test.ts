// The slow cases of answer.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDurableProgram, privateTestDir } from "../mux/durable/fixture.ts";
import { answerDigest, AnswerReceiptStore, type AnswerReceipt } from "./answer.ts";

const dirs: string[] = [];

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "collie-answer-"));
  dirs.push(dir);
  return privateTestDir(dir);
}

const programs: FakeDurableProgram[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const program of programs.splice(0)) await program.close();
});

describe("answer: the receipt store keeps a week, the newest thousand, and every young pending one", () => {
  test("pruned by age and count, never a pending receipt younger than a day", async () => {
    const dir = stateDir();
    let now = 30 * 24 * 60 * 60 * 1000;
    const store = new AnswerReceiptStore(dir, () => {}, () => now);
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const receipt = (n: number, at: number, state: AnswerReceipt["state"]): AnswerReceipt => ({
      requestId: uuid(n),
      at,
      paneId: "p",
      askId: "a",
      revision: 1,
      optionId: "o",
      digest: answerDigest("p", { requestId: uuid(0), askId: "a", revision: 1, optionId: "o" }),
      state,
    });
    await store.record(receipt(0, now - 8 * DAY, "taken"));
    expect(store.get(uuid(0))).toBeUndefined();
    // Two old open ones: a day and a half old goes with the count, an hour old stays.
    await store.record(receipt(1, now - 36 * HOUR, "unknown"));
    await store.record(receipt(2, now - HOUR, "pending"));
    for (let n = 3; n < 1003; n += 1) {
      now += 1;
      await store.record(receipt(n, now, "taken"));
    }
    expect(store.get(uuid(1))).toBeUndefined();
    expect(store.get(uuid(2))?.state).toBe("pending");
    expect(store.get(uuid(3))).toBeUndefined();
    expect(store.get(uuid(1002))).toBeDefined();
    const reborn = new AnswerReceiptStore(dir, () => {}, () => now);
    await reborn.load();
    expect(reborn.get(uuid(2))?.state).toBe("pending");
    expect(reborn.get(uuid(4))).toBeDefined();
  });
});

const HOUR = 60 * 60 * 1000;

const DAY = 24 * HOUR;

