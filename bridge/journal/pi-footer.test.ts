import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "../json.ts";
import {
  addPiRow,
  emptyPiTotals,
  formatPiTokens,
  parsePiFooter,
  PiFooterTotals,
  piFooterFields,
  pickByFooter,
} from "./pi-footer.ts";
import { PiTranscriptSource } from "./pi.ts";

// A footer as pi 1.5.2 draws it under the conversation (read off live panes on 2026-11-17, the folder
// and branch replaced): the folder row, then the stats row, then whatever extensions add.
const screenWith = (stats: string, ...above: string[]) =>
  [...above, "─".repeat(100), "~/proj (main)", stats, "extension row"].join("\n");

describe("formatPiTokens — pi's own footer.js formatTokens", () => {
  test("below 1000 the number, then one decimal of thousands, whole thousands, one decimal of millions, whole millions", () => {
    expect(formatPiTokens(0)).toBe("0");
    expect(formatPiTokens(138)).toBe("138");
    expect(formatPiTokens(999)).toBe("999");
    expect(formatPiTokens(1000)).toBe("1.0k");
    expect(formatPiTokens(3412)).toBe("3.4k");
    expect(formatPiTokens(26_400)).toBe("26k");
    expect(formatPiTokens(171_499)).toBe("171k");
    expect(formatPiTokens(6_700_000)).toBe("6.7M");
    expect(formatPiTokens(114_300_000)).toBe("114M");
  });

  test("the rounding quirks of pi are kept, because the match is on pi's text", () => {
    // 9999 rounds up to "10.0k" and 999_999 to "1000k": pi draws exactly that.
    expect(formatPiTokens(9999)).toBe("10.0k");
    expect(formatPiTokens(999_999)).toBe("1000k");
  });
});

describe("parsePiFooter — the stats row of a pane's screen", () => {
  test("the four counts, the cache-hit rate and the context part", () => {
    const footer = parsePiFooter(screenWith("↑34k ↓661k R114M W6.7M CH99.7% 4.2%/1.0M (auto)"));
    expect(footer?.fields).toEqual(["↑34k", "↓661k", "R114M", "W6.7M", "CH99.7%"]);
  });

  test("a field pi leaves out (zero) is simply not there", () => {
    expect(parsePiFooter(screenWith("↑26k ↓827 R171k 10.3%/272k (auto)"))?.fields).toEqual(["↑26k", "↓827", "R171k"]);
    expect(parsePiFooter(screenWith("↓12k W3.2k CH0.0% 1.0%/272k"))?.fields).toEqual(["↓12k", "W3.2k", "CH0.0%"]);
  });

  test("a cost, a subscription mark, an unknown context and the model name on the right do not matter", () => {
    const row = "↑3.4k ↓99k R11M W715k CH99.4% $1.234 (sub) ?/272k (auto)        some-model • high";
    expect(parsePiFooter(screenWith(row))?.fields).toEqual(["↑3.4k", "↓99k", "R11M", "W715k", "CH99.4%"]);
    expect(parsePiFooter(screenWith("↑3.4k ↓99k $0.500 5.0%/200k"))?.fields).toEqual(["↑3.4k", "↓99k"]);
  });

  test("the bottommost row wins, and anything above it is the agent's output", () => {
    const screen = ["↑1.0k ↓2.0k 1.0%/272k", "text", "↑26k ↓827 R171k 10.3%/272k (auto)", "↑5.0k ↓6.0k 2.0%/272k"].join("\n");
    expect(parsePiFooter(screen)?.fields).toEqual(["↑5.0k", "↓6.0k"]);
  });

  test("a row cut off on a narrow pane, or without its context part, names nothing", () => {
    expect(parsePiFooter(screenWith("↑26k ↓827 R17"))).toBeNull();
    expect(parsePiFooter(screenWith("↑26k ↓827 R171k"))).toBeNull();
    expect(parsePiFooter(screenWith("↑26k ↓827 R171k 10.3%"))).toBeNull();
    expect(parsePiFooter(screenWith("↑26k ↓827 R171k 10.3%/..."))).toBeNull();
  });

  test("a pane that has barely begun (fewer than two counts) names nothing", () => {
    expect(parsePiFooter(screenWith("0.0%/272k (auto)"))).toBeNull();
    expect(parsePiFooter(screenWith("↑12 3.0%/272k"))).toBeNull();
    expect(parsePiFooter(screenWith("R171k 3.0%/272k"))).toBeNull();
  });

  test("a screen with no stats row, an empty screen and prose that mentions arrows", () => {
    expect(parsePiFooter("")).toBeNull();
    expect(parsePiFooter("hello\nworld")).toBeNull();
    expect(parsePiFooter("the rate went ↑26k ↓827 R171k then 10.3%/272k")).toBeNull();
  });
});

describe("piFooterFields — what pi draws for a set of totals", () => {
  const totals = (input: number, output: number, cacheRead: number, cacheWrite: number, latestHit?: number) => ({
    input,
    output,
    cacheRead,
    cacheWrite,
    latestHit,
  });

  test("a zero count is left out", () => {
    expect(piFooterFields(totals(26_000, 827, 171_000, 0))).toEqual(["↑26k", "↓827", "R171k"]);
    expect(piFooterFields(totals(0, 12_000, 0, 3200))).toEqual(["↓12k", "W3.2k"]);
  });

  test("the cache-hit rate needs a cache count and a newest turn with a prompt, and has one decimal", () => {
    expect(piFooterFields(totals(34_000, 661_000, 114_000_000, 6_700_000, 99.74))).toEqual([
      "↑34k",
      "↓661k",
      "R114M",
      "W6.7M",
      "CH99.7%",
    ]);
    expect(piFooterFields(totals(34_000, 661_000, 114_000_000, 6_700_000, undefined))).toEqual(["↑34k", "↓661k", "R114M", "W6.7M"]);
    expect(piFooterFields(totals(34_000, 661_000, 0, 0, 50))).toEqual(["↑34k", "↓661k"]);
  });
});

// The row builders below write the shape of a pi 1.5.2 log (checked on live logs).
const usage = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { total: 0.01 },
});
const assistant = (id: string, u: ReturnType<typeof usage>): string =>
  JSON.stringify({
    type: "message",
    id,
    parentId: "p0",
    timestamp: "2026-11-17T10:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: u },
  });
const user = (id: string): string =>
  JSON.stringify({ type: "message", id, parentId: "p0", timestamp: "2026-11-17T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
const sessionRow = (id: string, cwd: string): string => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-17T10:00:00.000Z", cwd });

describe("addPiRow — the rows pi's footer counts", () => {
  const fold = (...rows: JsonValue[]) => {
    const totals = emptyPiTotals();
    for (const row of rows) addPiRow(totals, row);
    return totals;
  };

  test("assistant turns, tool results with usage, usage rows, compactions and branch summaries are all added", () => {
    const totals = fold(
      { type: "message", message: { role: "assistant", usage: usage(10, 20, 30, 40) } },
      { type: "message", message: { role: "toolResult", usage: usage(1, 2, 3, 4) } },
      { type: "usage", usage: usage(100, 200, 300, 400) },
      { type: "compaction", usage: usage(1000, 2000, 3000, 4000) },
      { type: "branch_summary", usage: usage(10_000, 20_000, 30_000, 40_000) },
    );
    expect([totals.input, totals.output, totals.cacheRead, totals.cacheWrite]).toEqual([11_111, 22_222, 33_333, 44_444]);
  });

  test("a user message, a tool result without usage and a row of another kind add nothing", () => {
    const totals = fold(
      { type: "message", message: { role: "user", content: [] } },
      { type: "message", message: { role: "toolResult" } },
      { type: "custom", usage: usage(9, 9, 9, 9) },
      { type: "session", cwd: "/x" },
    );
    expect(totals).toEqual(emptyPiTotals());
  });

  test("the cache-hit rate is the newest assistant turn's, and a turn with no prompt clears it", () => {
    const first = fold({ type: "message", message: { role: "assistant", usage: usage(10, 5, 90, 0) } });
    expect(first.latestHit).toBeCloseTo(90, 5);
    const aborted = fold(
      { type: "message", message: { role: "assistant", usage: usage(10, 5, 90, 0) } },
      { type: "message", message: { role: "assistant", usage: usage(0, 0, 0, 0) } },
    );
    expect(aborted.latestHit).toBeUndefined();
    // A tool result with usage adds to the counts but is not a turn.
    const withTool = fold(
      { type: "message", message: { role: "assistant", usage: usage(10, 5, 90, 0) } },
      { type: "message", message: { role: "toolResult", usage: usage(0, 0, 0, 0) } },
    );
    expect(withTool.latestHit).toBeCloseTo(90, 5);
  });

  test("a usage field that is not a number counts as zero and never poisons the sum", () => {
    const totals = fold({ type: "message", message: { role: "assistant", usage: { input: "many", output: 7, cacheRead: null } } });
    expect(totals.input).toBe(0);
    expect(totals.output).toBe(7);
  });
});

/** A scratch folder, removed by the test that made it. */
async function scratch(): Promise<string> {
  const dir = `${tmpdir()}/collie-pi-footer-${Math.floor(performance.now() * 1000)}-${Math.floor(Math.random() * 1e6)}`;
  await mkdir(dir, { recursive: true });
  return realpath(dir);
}

describe("PiFooterTotals — the totals of a whole log, read once and then by appended bytes", () => {
  test("sums every counted row of the file", async () => {
    const dir = await scratch();
    const path = join(dir, "a.jsonl");
    await writeFile(path, [sessionRow("s", "/p"), user("u1"), assistant("a1", usage(10, 20, 30, 40)), assistant("a2", usage(1, 2, 3, 4))].join("\n") + "\n");
    const totals = await new PiFooterTotals().read(path);
    expect([totals?.input, totals?.output, totals?.cacheRead, totals?.cacheWrite]).toEqual([11, 22, 33, 44]);
    await rm(dir, { recursive: true, force: true });
  });

  test("a later read adds only what was appended, and waits for the end of a half-written row", async () => {
    const dir = await scratch();
    const path = join(dir, "a.jsonl");
    await writeFile(path, [sessionRow("s", "/p"), assistant("a1", usage(10, 0, 0, 0))].join("\n") + "\n");
    const reader = new PiFooterTotals();
    expect((await reader.read(path))?.input).toBe(10);
    const row = assistant("a2", usage(5, 0, 0, 0));
    await appendFile(path, row.slice(0, 40));
    expect((await reader.read(path))?.input).toBe(10);
    await appendFile(path, `${row.slice(40)}\n`);
    expect((await reader.read(path))?.input).toBe(15);
    await rm(dir, { recursive: true, force: true });
  });

  test("a file replaced under the same name, or one that cannot be read, is not mixed with the old sum", async () => {
    const dir = await scratch();
    const path = join(dir, "a.jsonl");
    await writeFile(path, [sessionRow("s1", "/p"), assistant("a1", usage(100, 0, 0, 0))].join("\n") + "\n");
    const reader = new PiFooterTotals();
    expect((await reader.read(path))?.input).toBe(100);
    await writeFile(path, [sessionRow("s2", "/p"), assistant("b1", usage(7, 0, 0, 0))].join("\n") + "\n");
    expect((await reader.read(path))?.input).toBe(7);
    expect(await reader.read(join(dir, "missing.jsonl"))).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  test("a row that is not JSON is skipped", async () => {
    const dir = await scratch();
    const path = join(dir, "a.jsonl");
    await writeFile(path, `${sessionRow("s", "/p")}\n{"usage": broken\n${assistant("a1", usage(3, 0, 0, 0))}\n`);
    expect((await new PiFooterTotals().read(path))?.input).toBe(3);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("pickByFooter — exactly one log may have the footer's totals", () => {
  test("the one matching log is the answer, however many others there are", async () => {
    const dir = await scratch();
    const logs: { id: string; path: string }[] = [];
    for (const [id, input] of [["one", 1000], ["two", 2000], ["three", 3000]] as const) {
      const path = join(dir, `${id}.jsonl`);
      await writeFile(path, `${assistant(id, usage(input, 500, 0, 0))}\n`);
      logs.push({ id, path });
    }
    const found = await pickByFooter({ fields: ["↑2.0k", "↓500"] }, logs, new PiFooterTotals());
    expect(found?.id).toBe("two");
    await rm(dir, { recursive: true, force: true });
  });

  test("no log matching, or two logs matching, is no answer", async () => {
    const dir = await scratch();
    const logs: { id: string; path: string }[] = [];
    for (const id of ["one", "two"]) {
      const path = join(dir, `${id}.jsonl`);
      await writeFile(path, `${assistant(id, usage(1000, 500, 0, 0))}\n`);
      logs.push({ id, path });
    }
    expect(await pickByFooter({ fields: ["↑1.0k", "↓500"] }, logs, new PiFooterTotals())).toBeNull();
    expect(await pickByFooter({ fields: ["↑9.0k", "↓500"] }, logs, new PiFooterTotals())).toBeNull();
    expect(await pickByFooter({ fields: ["↑1.0k", "↓500"] }, [], new PiFooterTotals())).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  test("the cache-hit rate is part of the match", async () => {
    const dir = await scratch();
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    // Same counts after rounding, a different newest turn: 90% read against 10%.
    await writeFile(a, `${assistant("a1", usage(10, 5, 9000, 0))}\n`);
    await writeFile(b, `${assistant("b1", usage(9000, 5, 10, 0))}\n`);
    const logs = [
      { id: "a", path: a },
      { id: "b", path: b },
    ];
    const reader = new PiFooterTotals();
    expect((await pickByFooter({ fields: ["↑10", "↓5", "R9.0k", "CH99.9%"] }, logs, reader))?.id).toBe("a");
    expect((await pickByFooter({ fields: ["↑9.0k", "↓5", "R10", "CH0.1%"] }, logs, reader))?.id).toBe("b");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("PiTranscriptSource — a pane in a shared folder finds its log by its footer (#508)", () => {
  const cwd = "/srv/proj";
  const folder = "--srv-proj--";
  const ONE = "019f4665-7df0-7540-a64f-7068335f2101";
  const TWO = "019f4665-7df0-7540-a64f-7068335f2102";
  const THREE = "019f4665-7df0-7540-a64f-7068335f2103";

  /** Three sessions of one folder with distinct totals, and a source over them. */
  async function world() {
    const base = await scratch();
    const root = join(base, "pi-sessions");
    const places = { home: join(base, "home"), tmp: join(base, "tmp") };
    await mkdir(join(root, folder), { recursive: true });
    const write = async (id: string, rows: string[], head: string = sessionRow(id, cwd)) => {
      const path = join(root, folder, `2026-11-17T10-00-00-000Z_${id}.jsonl`);
      await writeFile(path, `${[head, ...rows].join("\n")}\n`);
      return path;
    };
    // Totals: ONE ↑26k ↓827 R171k, TWO ↑3.4k ↓99k R11M W715k, THREE ↑34k ↓661k R114M W6.7M.
    const one = await write(ONE, [assistant("a", usage(26_000, 827, 171_000, 0))]);
    const two = await write(TWO, [assistant("a", usage(3400, 99_000, 11_000_000, 715_000))]);
    const three = await write(THREE, [assistant("a", usage(34_000, 661_000, 114_000_000, 6_700_000))]);
    // The newest log is the neighbour's: what a folder walk would wrongly answer.
    await utimes(one, new Date(Date.now() - 300_000), new Date(Date.now() - 300_000));
    await utimes(two, new Date(Date.now() - 200_000), new Date(Date.now() - 200_000));
    await utimes(three, new Date(Date.now() - 5_000), new Date(Date.now() - 5_000));
    const src = new PiTranscriptSource(root, places);
    const shared = (stats: string | null) => ({ shared: true as const, screen: async () => (stats === null ? null : screenWith(stats)) });
    return { base, root, write, src, shared };
  }

  test("the log whose totals are the footer's is the pane's, not the newest one", async () => {
    const w = await world();
    expect(await w.src.discoverSession(cwd, w.shared("↑26k ↓827 R171k CH86.8% 10.3%/272k (auto)"))).toEqual({ kind: "id", value: ONE });
    expect(await w.src.discoverSession(cwd, w.shared("↑3.4k ↓99k R11M W715k CH93.9% 9.0%/272k"))).toEqual({ kind: "id", value: TWO });
    expect(await w.src.discoverSession(cwd, w.shared("↑34k ↓661k R114M W6.7M CH94.4% 4.2%/1.0M"))).toEqual({ kind: "id", value: THREE });
    await rm(w.base, { recursive: true, force: true });
  });

  test("the answer reads: the ref resolves to that log inside the root", async () => {
    const w = await world();
    const ref = await w.src.discoverSession(cwd, w.shared("↑26k ↓827 R171k CH86.8% 10.3%/272k"));
    expect(ref).toEqual({ kind: "id", value: ONE });
    expect(await w.src.resolve(ref ?? { kind: "id", value: "" })).toContain(ONE);
    await rm(w.base, { recursive: true, force: true });
  });

  test("a footer that matches no log, a fresh pane, no screen and an unreadable screen: no session", async () => {
    const w = await world();
    expect(await w.src.discoverSession(cwd, w.shared("↑26k ↓828 R171k CH86.8% 10.3%/272k"))).toBeNull();
    expect(await w.src.discoverSession(cwd, w.shared("0.0%/272k (auto)"))).toBeNull();
    expect(await w.src.discoverSession(cwd, w.shared(null))).toBeNull();
    expect(await w.src.discoverSession(cwd, { shared: true })).toBeNull();
    expect(
      await w.src.discoverSession(cwd, {
        shared: true,
        screen: async () => {
          throw new Error("grid unavailable");
        },
      }),
    ).toBeNull();
    await rm(w.base, { recursive: true, force: true });
  });

  test("two logs with the same totals are no answer", async () => {
    const w = await world();
    await w.write("019f4665-7df0-7540-a64f-7068335f2104", [assistant("a", usage(26_000, 827, 171_000, 0))]);
    expect(await w.src.discoverSession(cwd, w.shared("↑26k ↓827 R171k CH86.8% 10.3%/272k"))).toBeNull();
    await rm(w.base, { recursive: true, force: true });
  });

  test("a log filed for this folder name but written in another cwd is not a candidate", async () => {
    const w = await world();
    // The folder name is lossy: `/srv-proj` files under the same name as `/srv/proj`.
    await w.write("019f4665-7df0-7540-a64f-7068335f2105", [assistant("a", usage(7000, 7, 70_000, 0))], sessionRow("019f4665-7df0-7540-a64f-7068335f2105", "/srv-proj"));
    expect(await w.src.discoverSession(cwd, w.shared("↑7.0k ↓7 R70k CH90.9% 1.0%/272k"))).toBeNull();
    await rm(w.base, { recursive: true, force: true });
  });

  test("a pane's footer moves with its log: the next turn is matched by the appended bytes", async () => {
    const w = await world();
    expect(await w.src.discoverSession(cwd, w.shared("↑26k ↓827 R171k CH86.8% 10.3%/272k"))).toEqual({ kind: "id", value: ONE });
    await appendFile(join(w.root, folder, `2026-11-17T10-00-00-000Z_${ONE}.jsonl`), `${assistant("b", usage(2000, 1000, 29_000, 0))}\n`);
    // The old footer no longer matches (pi has not drawn the new one yet), the new one does.
    expect(await w.src.discoverSession(cwd, w.shared("↑26k ↓827 R171k CH86.8% 10.3%/272k"))).toBeNull();
    expect(await w.src.discoverSession(cwd, w.shared("↑28k ↓1.8k R200k CH93.5% 11.0%/272k"))).toEqual({ kind: "id", value: ONE });
    await rm(w.base, { recursive: true, force: true });
  });

  test("a pane that is not in a shared folder still takes the folder walk, footer or none", async () => {
    const w = await world();
    // Not shared: the newest log is the pane's, as before; the footer is not even read.
    expect(await w.src.discoverSession(cwd, { screen: async () => screenWith("↑26k ↓827 R171k CH86.8% 10.3%/272k") })).toEqual({ kind: "id", value: THREE });
    await rm(w.base, { recursive: true, force: true });
  });
});
