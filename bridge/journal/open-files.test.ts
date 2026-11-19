import { describe, expect, test } from "bun:test";

import { createOpenFiles, lsofArgs, MAX_CACHED_PIDS, OPEN_FILES_TTL_MS, pathsOf, type LsofRunner } from "./open-files.ts";

// The reader is driven with an injected runner and clock: no process is forked, and nothing here
// touches node:child_process.

function counting(out: (pid: string) => string | Error = (pid) => `p${pid}\nn/file/${pid}`) {
  const calls: string[][] = [];
  const run: LsofRunner = async (args) => {
    calls.push([...args]);
    const result = out(args[2] ?? "");
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, run };
}

describe("lsofArgs", () => {
  test("asks for the pid's files and its group's, as a union: -p and -g with no -a", () => {
    expect(lsofArgs(10)).toEqual(["-nP", "-p", "10", "-g", "10", "-Fn"]);
    expect(lsofArgs(10)).not.toContain("-a");
    expect(lsofArgs(10, "group")).toEqual(lsofArgs(10));
  });

  test("asks for the pid's own files only in the pid scope: -a -p and no -g", () => {
    expect(lsofArgs(10, "pid")).toEqual(["-nP", "-a", "-p", "10", "-Fn"]);
    expect(lsofArgs(10, "pid")).not.toContain("-g");
  });

  test("a reader asks the argument list of its own scope, the group by default", async () => {
    const asked: string[][] = [];
    const run: LsofRunner = async (args) => {
      asked.push([...args]);
      return "n/file";
    };
    await createOpenFiles(run)(10);
    await createOpenFiles(run, Date.now, { scope: "pid" })(11);
    expect(asked).toEqual([
      ["-nP", "-p", "10", "-g", "10", "-Fn"],
      ["-nP", "-a", "-p", "11", "-Fn"],
    ]);
  });
});

describe("pathsOf", () => {
  test("keeps the n lines without their tag, and nothing else", () => {
    expect(pathsOf("p10\nf5\nn/a/b\nn/c d\n\nn")).toEqual(["/a/b", "/c d", ""]);
  });
});

describe("createOpenFiles", () => {
  test("answers a pid's files, and runs lsof once for a second of repeats", async () => {
    let now = 1_000;
    const { calls, run } = counting();
    const files = createOpenFiles(run, () => now);
    for (let i = 0; i < 100; i++) expect(await files(7)).toEqual(["/file/7"]);
    expect(calls).toHaveLength(1);
    now += OPEN_FILES_TTL_MS;
    await files(7);
    expect(calls).toHaveLength(1);
    now += 1;
    await files(7);
    expect(calls).toHaveLength(2);
  });

  test("two requests in one tick share one run", async () => {
    const { calls, run } = counting();
    const files = createOpenFiles(run, () => 0);
    expect(await Promise.all([files(7), files(7)])).toEqual([["/file/7"], ["/file/7"]]);
    expect(calls).toHaveLength(1);
  });

  test("keeps each pid apart", async () => {
    const { calls, run } = counting();
    const files = createOpenFiles(run, () => 0);
    expect(await files(1)).toEqual(["/file/1"]);
    expect(await files(2)).toEqual(["/file/2"]);
    expect(calls).toHaveLength(2);
  });

  test("a failed run answers no files, never throws, and is asked again only after the second", async () => {
    let now = 0;
    const { calls, run } = counting(() => Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" }));
    const files = createOpenFiles(run, () => now);
    expect(await files(7)).toEqual([]);
    expect(await files(7)).toEqual([]);
    expect(calls).toHaveLength(1);
    now += OPEN_FILES_TTL_MS + 1;
    expect(await files(7)).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  test("holds at most MAX_CACHED_PIDS answers", async () => {
    const { calls, run } = counting();
    const files = createOpenFiles(run, () => 0);
    for (let pid = 1; pid <= MAX_CACHED_PIDS; pid++) await files(pid);
    expect(calls).toHaveLength(MAX_CACHED_PIDS);
    await files(MAX_CACHED_PIDS + 1); // the table is full: cleared, then this pid kept
    await files(1); // gone, so asked again
    expect(calls).toHaveLength(MAX_CACHED_PIDS + 2);
  });
});
