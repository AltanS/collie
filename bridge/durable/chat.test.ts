import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { adapterFor } from "../journal/registry.ts";
import { toPaneWire } from "../types.ts";
import { PANE, cleanups, until, item, world } from "./chat.rig.ts";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("Chat for a durable pane", () => {
  test("the route answers the program's items from the bridge-owned log, through the ordinary journal path", async () => {
    const { program, chat } = await world();
    program.appendEvent(PANE, item("u1", "user", "write the summary"));
    program.appendEvent(PANE, {
      type: "item",
      item: { id: "t1", kind: "tool", tool: { kind: "other", name: "write_note", summary: "path=/tmp/notes.txt" }, status: "running" },
    });
    program.appendEvent(PANE, item("r1", "reply", "Writing it now."));

    const body = await until(async () => {
      const got = await chat();
      return got.available && got.upserts.length === 3 ? got : null;
    }, "three items in Chat");

    expect(body.upserts.map((entry) => [entry.uuid, entry.role])).toEqual([
      ["u1", "user"],
      ["t1", "assistant"],
      ["r1", "assistant"],
    ]);
    const tool = body.upserts[1]?.parts[0];
    expect(tool).toMatchObject({ kind: "tool", name: "write_note" });
    expect(tool?.kind === "tool" && tool.result).toBeUndefined();
  });

  test("a durable pane names its session, so the phone is told it has history, and no other pane is touched", async () => {
    const { program, engine, journals, chat, logs } = await world();
    program.appendEvent(PANE, item("u1", "user", "hi"));
    await until(async () => {
      const got = await chat();
      return got.available ? got : null;
    }, "the pane in Chat");

    const pane = engine.current().agents.find((candidate) => candidate.paneId === PANE);
    expect(pane?.agent).toBe("durable");
    // The ref names the log FILE (M55): two programs may share a conversation id, never a log.
    expect(pane?.agentSession).toEqual({ kind: "path", value: logs.pathOf(PANE) });
    expect(adapterFor(journals, pane?.agent)?.agent).toBe("durable");
    // The session ref stays server-side, and `hasSession` tells the phone it may open History.
    const wire = pane === undefined ? null : toPaneWire(pane, (agent) => adapterFor(journals, agent) !== undefined);
    expect(wire).not.toBeNull();
    expect(wire?.hasSession).toBe(true);
    expect(JSON.stringify(wire)).not.toContain("agentSession");
  });
});

// The wiring that makes the tests above true in the running bridge, pinned by source: index.ts is
// the one place that builds both ends, and no test starts it.
describe("the bridge wires the log to both ends", () => {
  const src = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");

  test("each program's mux target names its own log folder, under the folder the journal registry reads", () => {
    expect(src).toContain("const logDir = sourceLogDir(cfg.stateDir, source.name);");
    expect(src).toContain("[DURABLE_LOG_DIR_OPTION]: logDir");
    expect(src).toContain("durable: [durableLogDir(cfg.stateDir)]");
  });
});
