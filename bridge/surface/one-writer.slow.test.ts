// The slow cases of one-writer.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck } from "../mux/types.ts";
import { sendReplySteps } from "../server.ts";
import { gateFor } from "./key-gate.ts";
import { PaneLockFiles } from "./pane-lock.ts";

let dir: string;

const living = new Set<number>();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "one-writer-"));
  living.clear();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function lockOf(pid: number): PaneLockFiles {
  living.add(pid);
  return new PaneLockFiles({ dir, scope: "tmux\u0000", pid, alive: (p) => living.has(p), startOf: (p) => `s${String(p)}` });
}

describe("the key gate shares the pane lock", () => {
  test("the old reply steps (a launcher line, a dialog field) type nothing while another bridge holds the pane", async () => {
    const typed: string[] = [];
    const client = { typeText: (_pane: string, text: string) => (typed.push(text), Promise.resolve(muxAck())), writeKeys: () => Promise.resolve(muxAck()) };
    gateFor(client).share(lockOf(101));
    const other = lockOf(202);
    other.take("%1", "their-send", Date.now() + 30_000);
    const refused = await sendReplySteps(client, "%1", "make test", true, ["Enter"]);
    expect(refused.ok).toBe(false);
    expect(refused.textDelivered).toBe(false);
    expect(typed).toEqual([]);
    other.release("%1", "their-send");
    expect((await sendReplySteps(client, "%1", "make test", true, ["Enter"])).ok).toBe(true);
    expect(typed).toEqual(["make test"]);
  });
});
