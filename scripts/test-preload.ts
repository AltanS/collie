/**
 * TEST-ONLY. One temp folder per `bun test` process, removed when that process exits.
 *
 * `bunfig.toml` preloads this file before any test file is read. Nothing that ships imports it.
 *
 * ── WHY ──
 * Tests make scratch folders with `mkdtemp(join(tmpdir(), "collie-…-"))`, and about twenty test
 * files never remove theirs: one full run left 90 folders behind. On a machine that runs the suite
 * all day that came to about 80,000 folders, and on Fedora `/tmp` is a RAM disk with a size cap, so
 * it filled up and an unrelated `bun install` failed with ENOSPC (2026-11-04).
 *
 * Fixing each test is right and also never finished: the next new test leaks again. Pointing the
 * temp directory at a folder this process owns catches every one of them, the ones not written yet
 * included, and the child processes a test spawns inherit it through the environment.
 *
 * `os.tmpdir()` reads the environment on each call, so setting it here, before any test module is
 * loaded, is enough. It reads `TMPDIR` on Linux and macOS and `TEMP`/`TMP` on Windows; all three
 * are set so the Windows suite gets the same folder.
 *
 * A run that is killed, rather than one that exits, still leaves this one folder. That is one
 * folder in place of ninety, named `ct-` and six random characters.
 *
 * To look at what a failing test wrote, run with `COLLIE_TEST_KEEP_TMP=1`: the folder is kept,
 * and its path is printed when the run starts, so a run you stop by hand still tells you where.
 *
 * This applies to `bun test` run from the repository root, where this `bunfig.toml` is read.
 * `web/` and `examples/` have bunfig files of their own.
 */
import { afterAll, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The prefix is short on purpose ("ct", collie test). Some tests put a Unix socket under the temp
// folder, and Collie caps a socket path at 103 bytes, the macOS limit. macOS's own temp folder is
// already about 49 bytes, and with "collie-t-" the durable client test's socket came to 104.
const root = mkdtempSync(join(tmpdir(), "ct-"));
process.env.TMPDIR = root;
process.env.TEMP = root;
process.env.TMP = root;

const keep = process.env.COLLIE_TEST_KEEP_TMP === "1";
if (keep) console.error(`test-preload: COLLIE_TEST_KEEP_TMP=1, test files stay in ${root}`);

// `beforeAll` and `afterAll` in a preload file are global hooks: they run around the whole run, not
// around each file. A `process.on("exit")` handler does not run under `bun test`, which was tried
// first. Under `--rerun-each` the pair runs once per pass, so the folder is made again before each
// pass rather than only once at load, or pass two would find it gone.
beforeAll(() => {
  mkdirSync(root, { recursive: true });
});

afterAll(() => {
  if (keep) return;
  // A file a child process still holds open cannot be removed on Windows. A failed clean-up must
  // not turn a green run red, so it is reported and the run keeps its own result.
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    console.error(`test-preload: could not remove ${root}: ${String(error)}`);
  }
});
