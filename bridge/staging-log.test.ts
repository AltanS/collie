import { describe, expect, test } from "bun:test";

import {
  readStagingLog,
  safeRunId,
  STAGING_LOG_LINE_CHARS,
  STAGING_LOG_LINES,
  STAGING_LOG_PREFIX,
  stagingLogPath,
  tailOf,
} from "./staging-log.ts";

// The staging progress file (M20/10). The write side is `cli/update.ts`; this is the read side and
// the shape both sides agree on.

const STATE = "/var/state/collie";

describe("the staging progress file", () => {
  test("the name is keyed to the run, which is what makes a stale file unreadable", () => {
    expect(stagingLogPath(STATE, "r-abc")).toBe(`${STATE}/${STAGING_LOG_PREFIX}r-abc.log`);
    // A reader asks for the run it is looking at, so last week's file is a path nobody requests.
    expect(stagingLogPath(STATE, "r-abc")).not.toBe(stagingLogPath(STATE, "r-def"));
    // And a run nobody wrote a file for simply reads as nothing.
    expect(readStagingLog(STATE, "r-never-ran")).toBeNull();
  });

  test("a run id can never name a path outside the state directory", () => {
    // The id arrives from a `--run-id` argument. It is `crypto.randomUUID()` today, so this changes
    // nothing — but a value that COULD carry `/` or `..` is closed here rather than trusted at the
    // call site.
    expect(safeRunId("../../etc/passwd")).toBe("....etcpasswd");
    expect(stagingLogPath(STATE, "../../etc/passwd").startsWith(`${STATE}/`)).toBe(true);
    expect(safeRunId("")).toBe("unknown");
    expect(safeRunId("/".repeat(20))).toBe("unknown");
    expect(safeRunId("a".repeat(200)).length).toBe(64);
  });

  test("WHOLE LINES ONLY — a half-written last line is dropped", () => {
    // The writer appends while the bridge reads. A tail that showed half a sentence would be a tail
    // the operator reads as a crash.
    expect(tailOf("fetching 1.6.0\nbuilding 1.6.0 — this is the s")).toBe("fetching 1.6.0");
    expect(tailOf("fetching 1.6.0\nbuilding 1.6.0\n")).toBe("fetching 1.6.0\nbuilding 1.6.0");
    // Not one whole line yet is nothing to show, never a fragment.
    expect(tailOf("fetching 1.6")).toBeNull();
    expect(tailOf("")).toBeNull();
    expect(tailOf("\n\n  \n")).toBeNull();
  });

  test("the tail is bounded in both directions, so the card is never asked to render a build log", () => {
    const many = Array.from({ length: STAGING_LOG_LINES + 20 }, (_, i) => `line ${i}`).join("\n");
    const tail = tailOf(`${many}\n`)!;
    expect(tail.split("\n").length).toBe(STAGING_LOG_LINES);
    // The LAST lines, which is what "what is happening now" means.
    expect(tail.split("\n").at(-1)).toBe(`line ${STAGING_LOG_LINES + 19}`);

    const long = `${"x".repeat(STAGING_LOG_LINE_CHARS + 50)}\n`;
    const cut = tailOf(long)!;
    expect(cut.length).toBe(STAGING_LOG_LINE_CHARS + 1);
    expect(cut.endsWith("…")).toBe(true);
  });
});
