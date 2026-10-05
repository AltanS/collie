// The recorded output of a real Tern (captures/README.md), read through the adapter's own parsers.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { MuxWatchOptions } from "../types.ts";
import { TernMux } from "./adapter.ts";
import type { TernExec, TernStreamHandlers } from "./exec.ts";
import { parseEvent, parseListing, quoteLongIds } from "./protocol.ts";
import { TernWatch } from "./watch.ts";

const here = join(import.meta.dir, "captures");
const LS = readFileSync(join(here, "ls-0.4.5.json"), "utf8");
const EVENTS = readFileSync(join(here, "events-0.4.5.ndjson"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "");

/** A Tern that answers `ls --json` with the given text and nothing else. */
interface ListingOnly {
  readonly exec: TernExec;
  readonly calls: (readonly string[])[];
}

function listingOnly(stdout: string): ListingOnly {
  const calls: (readonly string[])[] = [];
  const exec: TernExec = {
    run: (args) => {
      calls.push(args);
      return Promise.resolve(
        args[0] === "ls" ? { code: 0, stdout, stderr: "" } : { code: 0, stdout: "", stderr: "" },
      );
    },
    events: () => ({ kill: () => undefined }),
  };
  return { exec, calls };
}

describe("a recorded `tern ls --json` (0.4.5)", () => {
  test("parses, and every id is exact", () => {
    const listing = parseListing(LS);
    const tab = listing.sessions[0]?.tabs[0];
    expect(String(listing.sessions[0]?.id)).toBe("4");
    expect(String(tab?.id)).toBe("213352500428886");
    expect(String(tab?.blocks[0]?.id)).toBe("213352500428885");
  });

  test("becomes one space, one unnamed tab and one focused shell pane", async () => {
    const snapshot = await new TernMux(listingOnly(LS).exec).snapshot();
    expect(snapshot.spaces.map((s) => [s.spaceId, s.label])).toEqual([["4", "Default"]]);
    expect(snapshot.tabs.map((t) => [t.tabId, t.label])).toEqual([["213352500428886", "1"]]);
    expect(snapshot.panes).toHaveLength(1);
    expect(snapshot.panes[0]).toMatchObject({
      paneId: "213352500428885",
      tabId: "213352500428886",
      spaceId: "4",
      cwd: "/home/you",
      focused: true,
    });
  });
});

describe("a recorded `tern events` stream (0.4.5)", () => {
  test("every line parses to an event the watch knows", () => {
    const kinds = EVENTS.map((line) => parseEvent(line)?.event);
    expect(kinds).not.toContain(undefined);
    expect(new Set(kinds)).toEqual(
      new Set(["pane_spawned", "layout_changed", "cwd_changed", "title_changed", "pane_closed"]),
    );
  });

  test("the watch pokes the topology on every line and names the pane where the line has one", async () => {
    const streams: TernStreamHandlers[] = [];
    const exec: TernExec = {
      run: () => Promise.resolve({ code: 0, stdout: LS, stderr: "" }),
      events: (h) => {
        streams.push(h);
        return { kill: () => undefined };
      },
    };
    let topology = 0;
    const panes: string[] = [];
    const options: MuxWatchOptions = {
      panes: [],
      onUp: () => undefined,
      onDown: () => undefined,
      onTopologyChange: () => {
        topology += 1;
      },
      onPaneChange: (paneId) => {
        panes.push(paneId);
      },
    };
    const watch = new TernWatch(exec, options);
    await Promise.resolve();
    const before = topology;
    expect(streams).toHaveLength(1);
    for (const line of EVENTS) streams[0]?.onLine(line);
    watch.close();
    expect(topology - before).toBe(EVENTS.length);
    expect(new Set(panes)).toEqual(new Set(["519210006478851", "519244366217218"]));
  });
});

describe("a Tern id past 2^53", () => {
  // 2^53 + 1 and 2^63 - 1: JSON.parse alone reads the first as ...992 and the second as ...808.
  const BLOCK = "9007199254740993";
  const TAB = "9223372036854775807";

  test("JSON.parse alone would round it, which is why it is quoted first", () => {
    // SAFETY: a literal with one numeric field.
    expect(String((JSON.parse(`{"id":${BLOCK}}`) as { id: number }).id)).not.toBe(BLOCK);
  });

  test("a listing keeps it exact, and the adapter addresses the block by it", async () => {
    const long = LS.replace("213352500428885", BLOCK).replace("213352500428886", TAB);
    const { exec, calls } = listingOnly(long);
    const tern = new TernMux(exec);
    const snapshot = await tern.snapshot();
    expect(snapshot.panes[0]?.paneId).toBe(BLOCK);
    expect(snapshot.tabs[0]?.tabId).toBe(TAB);
    await tern.typeText(BLOCK, "hi");
    expect(calls.at(-1)).toEqual(["send", BLOCK, "text", "--", "hi"]);
  });

  test("an event keeps it exact", () => {
    expect(String(parseEvent(`{"event":"pane_closed","pane":${BLOCK},"by":7}`)?.pane)).toBe(BLOCK);
  });

  test("only keys are touched: a title that spells the pattern stays a title, and short ids stay numbers", () => {
    const tricky = JSON.stringify({ title: `"id":${BLOCK}, "pane": ${BLOCK}`, id: 42, pane: Number("1234567890123456") });
    const quoted = quoteLongIds(tricky);
    // SAFETY: the object built two lines up.
    const back = JSON.parse(quoted) as { title: string; id: unknown; pane: unknown };
    expect(back.title).toBe(`"id":${BLOCK}, "pane": ${BLOCK}`);
    expect(back.id).toBe(42);
    expect(back.pane).toBe("1234567890123456");
  });

  test("a hostile run of digits is handled in linear time", () => {
    const flood = `{"id":${"9".repeat(200_000)}`;
    const started = performance.now();
    quoteLongIds(flood);
    quoteLongIds(`"id":`.repeat(40_000));
    expect(performance.now() - started).toBeLessThan(200);
  });
});
