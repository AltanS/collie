// The slow cases of chat.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { afterEach, describe, expect, test } from "bun:test";
import { PANE, cleanups, until, item, world } from "./chat.rig.ts";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("Chat for a durable pane", () => {
  test("a later change reaches Chat in place, and a stop is drawn as a note", async () => {
    const { program, chat } = await world();
    program.appendEvent(PANE, item("u1", "user", "go"));
    program.appendEvent(PANE, {
      type: "item",
      item: { id: "t1", kind: "tool", tool: { kind: "other", name: "write_note", summary: "x" }, status: "running" },
    });
    await until(async () => {
      const got = await chat();
      return got.available && got.upserts.length === 2 ? got : null;
    }, "the first two items");

    program.appendEvent(PANE, {
      type: "item",
      item: { id: "t1", kind: "tool", tool: { kind: "other", name: "write_note", summary: "x", output: "ok" }, status: "done" },
    });
    program.appendEvent(PANE, { type: "settled", inputId: "in-1", status: "unanswered", reason: "aborted" });

    const body = await until(async () => {
      const got = await chat();
      if (!got.available) return null;
      return got.upserts.some((entry) => entry.uuid === "settled:in-1") ? got : null;
    }, "the stop note");

    const done = body.upserts.find((entry) => entry.uuid === "t1")?.parts[0];
    expect(done?.kind === "tool" && done.result).toEqual({ text: "ok" });
    expect(body.upserts.find((entry) => entry.uuid === "settled:in-1")?.parts).toEqual([{ kind: "text", text: "stopped" }]);
  });

  test("the history survives the program restarting", async () => {
    const { program, chat } = await world();
    program.appendEvent(PANE, item("u1", "user", "before the restart"));
    await until(async () => {
      const got = await chat();
      return got.available && got.upserts.length === 1 ? got : null;
    }, "the first item");

    // The program restarts: the new epoch's reset view still lists the item, and the cursor starts over.
    program.restart();
    program.appendEvent(PANE, item("r1", "reply", "after the restart"));
    const body = await until(async () => {
      const got = await chat();
      return got.available && got.upserts.some((entry) => entry.uuid === "r1") ? got : null;
    }, "the item after the restart");
    expect(body.upserts.map((entry) => entry.uuid)).toEqual(["u1", "r1"]);
  });
});
