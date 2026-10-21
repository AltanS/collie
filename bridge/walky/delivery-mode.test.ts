import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { forPlatform, loadProfiles } from "../../web/src/lib/surface/profile.ts";
import { formatEnvelope } from "./types.ts";

// M62 hardening H: how a message reaches a busy pane. Walky talky types through the Send Protocol in
// mode `send`, one send, and the protocol decides per harness profile what a running turn gets: the
// harness's own queue (its Enter queues), the profile's queue key (its Enter steers, so Enter never
// goes into the turn), or Collie's own hold until the pane is free. This test reads that answer off
// every shipped profile and holds docs/walky-talky.md's table to it, so a profile change that moves a
// harness from one row to another fails here until the page says so.

type TurnPath = "queue" | "queue key" | "hold";

function turnPath(keys: { readonly enterWhileRunning?: string; readonly queueKey?: string }): TurnPath {
  if (keys.enterWhileRunning === "queues") return "queue";
  if (keys.queueKey !== undefined) return "queue key";
  return "hold";
}

const DOC = readFileSync(join(import.meta.dirname, "..", "..", "docs", "walky-talky.md"), "utf8");

/** The docs table's rows: `| \`<profile>\` | <path> | ... |`. */
function documented(): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of DOC.split("\n")) {
    const match = /^\| `([a-z0-9-]+)` \| (queue|queue key|hold) \|/u.exec(line);
    if (match !== null) rows.set(match[1]!, match[2]!);
  }
  return rows;
}

describe("a message into a busy pane", () => {
  test("an agent's message is one line, so no newline key goes into a turn", () => {
    const line = formatEnvelope({ id: "wt_aaaaaaaaaaa1", kind: "agent", from: { memberId: null, address: "local/%1", harness: "x", label: "repo#main" }, replyTo: null, body: "two\nlines" });
    expect(line.includes("\n")).toBe(false);
  });

  test("every shipped profile takes the queue, the queue key or Collie's hold, never a steering Enter, and the docs name which", () => {
    const rows = documented();
    const profiles = loadProfiles();
    expect(profiles.size).toBeGreaterThan(0);
    for (const [id, profile] of profiles) {
      const keys = forPlatform(profile, "linux").keys;
      const path = turnPath(keys);
      // A profile whose Enter steers takes the queue key; without one it would be held, never Entered.
      if (keys.enterWhileRunning === "steers") expect([id, path]).not.toEqual([id, "queue"]);
      expect([id, rows.get(id)]).toEqual([id, path]);
    }
    expect([...rows.keys()].toSorted()).toEqual([...profiles.keys()].toSorted());
  });
});
