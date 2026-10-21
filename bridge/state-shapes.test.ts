import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeFiles } from "../cli/fakes.ts";
import { writeRun } from "../cli/update-run.ts";
import { loadConfig } from "./config.ts";
import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString } from "../web/src/lib/json.ts";
import type { JsonValue } from "./json.ts";
import { filePairingIo, parseRegistryText } from "./pairing.ts";
import { formatRecentFile, parseRecentText } from "./recent-runs.ts";
import { UpdateStateStore } from "./update.ts";
import { parseUpdateLine, UNREADABLE_BY_LAST_STABLE, UPDATE_LINE_FILE } from "./update-line.ts";
import { parseUpdateRun } from "./update-run.ts";

// ── THE STATE-SHAPE RULE (ADR 0110) ─────────────────────────────────────────────────────────────
//
// A build never changes the shape of an existing state file in a way the latest Stable cannot read:
// new fields and new files only. "Go back now" and a rollback put the last Stable back on a state
// directory this build wrote, and a Stable that cannot read its own pairing file locks the operator
// out, which is the very thing two release lines exist to prevent.
//
// The fixtures in `fixtures/last-stable/` are state files as the last Stable (named in LAST_STABLE)
// writes them. Each one is checked two ways:
//
//   1. THIS build reads it: its own parser takes the file and loses nothing it can name.
//   2. The last Stable reads what THIS build writes back: the file this build writes after reading the
//      fixture keeps every key of the fixture, at the same path, with the same JSON type. A reader
//      that ignores keys it does not know (every reader here does) then reads it as before.
//
// A file that fails (2) must be named in `UNREADABLE_BY_LAST_STABLE` (bridge/update-line.ts), and
// the phone shows that list before "Go back now". The list is empty, and the rule says it stays so.
//
// After a Stable release, refresh the fixtures from that release's writers and bump LAST_STABLE.

const FIXTURES = join(import.meta.dir, "fixtures", "last-stable");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const dirs: string[] = [];
async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-state-shapes-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** The JSON type of a value, as a reader that checks `typeof` sees it. */
function kind(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (asJsonString(value) !== undefined) return "string";
  if (asJsonNumber(value) !== undefined) return "number";
  if (asJsonBoolean(value) !== undefined) return "boolean";
  return "object";
}

/**
 * Every place where `written` drops a key `old` has, or gives it another JSON type. Arrays compare
 * element by element, so the shape of a list entry counts too. A `null` in the old file accepts any
 * type: the last Stable reads a nullable field, so a value there is one it already handles.
 */
function readerLosses(old: JsonValue, written: JsonValue | undefined, path = "$"): string[] {
  if (written === undefined) return [`${path} is gone`];
  if (old === null) return [];
  if (kind(old) !== kind(written)) return [`${path} was ${kind(old)}, is ${kind(written)}`];
  if (Array.isArray(old) && Array.isArray(written)) {
    return old.flatMap((item, i) => readerLosses(item, written[i], `${path}[${String(i)}]`));
  }
  const was = asJsonObject(old);
  const now = asJsonObject(written);
  if (was !== undefined && now !== undefined) {
    return Object.entries(was).flatMap(([key, value]) => (value === undefined ? [] : readerLosses(value, now[key], `${path}.${key}`)));
  }
  return [];
}

const parse = (text: string): JsonValue => {
  // SAFETY: `JSON.parse` output IS a JsonValue by construction; only shapes are compared below.
  return JSON.parse(text) as JsonValue;
};

/** One state file: how this build reads the fixture, and what it writes back after reading it. */
interface StateFile {
  readonly name: string;
  /** Reads the fixture and throws or fails an expectation if anything is lost. */
  readonly read: (text: string) => void;
  /** This build's own writer, fed what this build read from the fixture. Answers the file's text. */
  readonly writeBack: (text: string) => Promise<string>;
}

const FILES: readonly StateFile[] = [
  {
    name: "update.json",
    read: (text) => {
      const run = parseUpdateRun(text);
      expect(run).toMatchObject({ schema: 2, state: "done", from: "1.22.5", to: "1.22.6", runId: "0f8fad5b-d9cb-469f-a165-70867728950e" });
    },
    writeBack: async (text) => {
      const run = parseUpdateRun(text);
      if (run === null) throw new Error("update.json did not parse");
      const files = fakeFiles();
      writeRun(files, "/state", run);
      const written = [...files.entries].find(([path]) => path.endsWith("update.json"));
      if (written === undefined) throw new Error("writeRun wrote no update.json");
      return written[1].text;
    },
  },
  {
    name: "update-state.json",
    read: () => {},
    writeBack: async (text) => {
      const dir = await stateDir();
      await writeFile(join(dir, "update-state.json"), text);
      const store = new UpdateStateStore({ ...loadConfig(), stateDir: dir });
      await store.load();
      expect(store.lastNotified()).toBe("1.22.6");
      expect(store.dismissedVersion()).toBe("1.22.6");
      expect(store.dismissedCrewVersion()).toBe("1.22.5");
      expect(store.dismissedCrewAt()).toBe(1760700000000);
      // Any write rewrites the whole record; this one changes nothing the fixture holds.
      await store.setDismissed("offer", "1.22.6");
      return readFile(join(dir, "update-state.json"), "utf8");
    },
  },
  {
    name: "paired-devices.json",
    read: (text) => {
      const registry = parseRegistryText(text);
      expect(registry?.devices.map((d) => d.label)).toEqual(["pixel", "tablet"]);
      expect(registry?.devices[1]?.expiresAt).toBe(1761300000000);
    },
    writeBack: async (text) => {
      const registry = parseRegistryText(text);
      if (registry === null) throw new Error("paired-devices.json did not parse");
      const dir = await stateDir();
      await filePairingIo(dir).writeRegistry(registry);
      return readFile(join(dir, "paired-devices.json"), "utf8");
    },
  },
  {
    name: "commands-recent.json",
    read: (text) => {
      expect(parseRecentText(text)).toEqual([{ line: "git status", cwd: "/home/operator/project", at: 1760700000000, noPrompts: false }]);
    },
    writeBack: async (text) => formatRecentFile(parseRecentText(text) ?? []),
  },
];

describe("the state-shape rule against the last Stable (ADR 0110)", () => {
  test("the fixtures name the last Stable, and every fixture file is checked", () => {
    expect(fixture("LAST_STABLE").trim()).toMatch(/^\d+\.\d+\.\d+$/);
    const names = FILES.map((f) => f.name).toSorted();
    const onDisk = ["commands-recent.json", "paired-devices.json", "update-state.json", "update.json"];
    expect(names).toEqual(onDisk);
  });

  for (const file of FILES) {
    test(`${file.name}: this build reads the last Stable's file`, () => {
      file.read(fixture(file.name));
    });
  }

  test("the last Stable reads what this build writes back, or the file is named before Go back now", async () => {
    const unreadable: string[] = [];
    const why: string[] = [];
    for (const file of FILES) {
      const text = fixture(file.name);
      const losses = readerLosses(parse(text), parse(await file.writeBack(text)));
      if (losses.length > 0) {
        unreadable.push(file.name);
        why.push(`${file.name}: ${losses.join(", ")}`);
      }
    }
    expect({ unreadable, why }).toEqual({ unreadable: [...UNREADABLE_BY_LAST_STABLE], why: [] });
    // The rule: new fields and new files only. A non-empty list is a release decision, not a fix.
    expect(UNREADABLE_BY_LAST_STABLE).toEqual([]);
  });

  test("the comparison catches a dropped key and a changed type", () => {
    expect(readerLosses(parse('{"a":1,"b":"x"}'), parse('{"a":1}'))).toEqual(["$.b is gone"]);
    expect(readerLosses(parse('{"a":[{"n":1}]}'), parse('{"a":[{"n":"1"}]}'))).toEqual(["$.a[0].n was number, is string"]);
    expect(readerLosses(parse('{"a":null}'), parse('{"a":5,"extra":true}'))).toEqual([]);
  });

  test("the release line is a NEW file: the last Stable never reads it, and its absence reads as Stable", () => {
    expect(UPDATE_LINE_FILE).toBe("update-line.json");
    expect(FILES.some((f) => f.name === UPDATE_LINE_FILE)).toBe(false);
    expect(parseUpdateLine(null)).toMatchObject({ line: "stable", rejected: [] });
  });
});
