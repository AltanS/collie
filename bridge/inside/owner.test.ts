// The owner rule of M99 spec 04: one owner per ask kind, and the fallback when the part goes away.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { liftDialog, readerBlocks } from "../../web/src/lib/surface/lift.ts";
import { AskBook } from "../surface/ask.ts";
import { ownerHold, ownsAsk } from "./owner.ts";
import { PART_IDLE_MS, PartRegistry } from "./registry.ts";
import { parseHello, type Hello } from "./wire.ts";
import type { JsonObject } from "../../web/src/lib/json.ts";

const PANE = { session: "main", paneId: "%1" };
const BASH = readFileSync(join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes", "claude--permission-bash.txt"), "utf8");
const dialog = () => liftDialog(readerBlocks(splitLines(parseAnsi(BASH)), "claude"));

function helloOf(fields: JsonObject = {}): Hello {
  const parsed = parseHello(JSON.stringify({ wire: 1, harness: "fake", pid: 4242, pidStartTime: 7, capabilities: ["send", "wake"], asks: ["permission"], ...fields }));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed;
}

function rig() {
  let now = 1000;
  const registry = new PartRegistry({ now: () => now, log: () => undefined });
  const book = new AskBook(() => now, "salt");
  book.ownsPermission = (paneId) => ownsAsk(registry.partOf({ session: "main", paneId }), "permission", true);
  return { registry, book, advance: (ms: number) => (now += ms) };
}

describe("ownsAsk", () => {
  test("a bound part that declared the kind owns it; another kind stays with the screen", () => {
    const part = { asks: new Set(["permission"] as const) };
    expect(ownsAsk(part, "permission", true)).toBe(true);
    expect(ownsAsk(part, "question", true)).toBe(false);
  });

  test("no part, or no hold card in the session: the screen reader owns it", () => {
    expect(ownsAsk(null, "permission", true)).toBe(false);
    expect(ownsAsk({ asks: new Set(["permission"] as const) }, "permission", false)).toBe(false);
  });
});

describe("the screen reader under the rule", () => {
  test("no part: the permission dialog is a keys ask, as before", () => {
    const r = rig();
    expect(r.book.publish(PANE.paneId, "gen", dialog())?.channel).toBe("keys");
  });

  test("a part owns permissions: the screen makes no ask of that kind", () => {
    const r = rig();
    r.registry.bind(helloOf(), PANE, 7);
    expect(r.book.publish(PANE.paneId, "gen", dialog())).toBeNull();
  });

  test("a part without the kind leaves the dialog to the screen", () => {
    const r = rig();
    r.registry.bind(helloOf({ asks: [] }), PANE, 7);
    expect(r.book.publish(PANE.paneId, "gen", dialog())?.channel).toBe("keys");
  });

  test("the part says bye: the next read makes the keys ask again", () => {
    const r = rig();
    const part = r.registry.bind(helloOf(), PANE, 7);
    expect(r.book.publish(PANE.paneId, "gen", dialog())).toBeNull();
    r.registry.drop(part.partId);
    expect(r.book.publish(PANE.paneId, "gen", dialog())?.channel).toBe("keys");
  });

  test("the part goes idle: the sweep drops it and the screen owns the kind again", () => {
    const r = rig();
    r.registry.bind(helloOf(), PANE, 7);
    expect(r.book.publish(PANE.paneId, "gen", dialog())).toBeNull();
    r.advance(PART_IDLE_MS + 1);
    r.registry.sweep();
    expect(r.book.publish(PANE.paneId, "gen", dialog())?.channel).toBe("keys");
  });

  test("an open keys ask is voided when a part takes the kind over", () => {
    const r = rig();
    const before = r.book.publish(PANE.paneId, "gen", dialog());
    expect(before?.channel).toBe("keys");
    r.registry.bind(helloOf(), PANE, 7);
    expect(r.book.publish(PANE.paneId, "gen", dialog())).toBeNull();
    expect(r.book.entry(before!.id)?.state).toBe("voided");
    expect(r.book.currentAsk(PANE.paneId)).toBeNull();
  });
});

describe("ownerHold", () => {
  test("an owned pane lets the hook's request go with no decision; another pane goes to the hand-off", () => {
    const taken: string[] = [];
    const lines: string[] = [];
    const hold = ownerHold(
      (paneId) => paneId === "%1",
      (paneId) => {
        taken.push(paneId);
      },
      (line) => lines.push(line),
    );
    const conn = () => {
      const c = { released: 0, replies: 0, reply: () => ((c.replies += 1), true), release: () => void (c.released += 1) };
      return c;
    };
    const request = { v: 1, harness: "claude", pid: 1, pidStartTime: 1, markers: [], tool: "Bash", input: "ls", agent: null, hold: true, at: 1 };
    const owned = conn();
    hold("%1", request, owned, () => undefined);
    expect(owned).toMatchObject({ released: 1, replies: 0 });
    expect(taken).toEqual([]);
    expect(lines).toEqual(["[inside] hook hold let go pane=%1 tool=Bash: the pane's part owns permissions"]);
    const other = conn();
    hold("%2", request, other, () => undefined);
    expect(other).toMatchObject({ released: 0, replies: 0 });
    expect(taken).toEqual(["%2"]);
  });
});
