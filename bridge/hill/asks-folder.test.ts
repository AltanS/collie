import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readHillCrewState } from "./crew-state.ts";
import { ASKS_DIR, DECISIONS_FILE, hillDir, HillStore, OLD_HILL_DIR } from "./store.ts";
import { readHillSwitch, writeHillSwitch } from "./switch.ts";

// ADR 0179: the state folder is `asks/`, with no migration and nothing carried over. A full old `hill/`
// folder is never read, written or deleted.

let state = "";
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "collie-asks-folder-"));
});
afterEach(() => rmSync(state, { recursive: true, force: true }));

const OLD_DECISION = { v: 1, id: "dc_aaaaaaaaaaaa", requestId: "x", state: "open" };

/** Lay down an old `hill/` folder as a build before ADR 0179 left it. */
function oldFolder(): Map<string, string> {
  const old = join(state, OLD_HILL_DIR);
  mkdirSync(join(old, "media", "dc_aaaaaaaaaaaa"), { recursive: true });
  const files = {
    "decisions.json": JSON.stringify({ v: 1, decisions: [OLD_DECISION] }),
    "switch.json": JSON.stringify({ v: 1, on: true, at: "2026-11-10T09:41:00.000Z" }),
    "state.json": JSON.stringify({ v: 1, state: "away", at: 1762873260000, by: "Pixel" }),
    "receipts.json": JSON.stringify({ v: 1, receipts: [] }),
    "tricks.json": JSON.stringify({ v: 1, tricks: { t: { gen: 0, keys: {} } } }),
    "media/dc_aaaaaaaaaaaa/m1": "picture bytes",
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(old, name), text);
  return snapshot();
}

/** Every file under the old folder with its bytes and mtime. */
function snapshot(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).toSorted()) {
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path, `${rel}${name}/`);
      else out.set(`${rel}${name}`, `${readFileSync(path, "utf8")}@${String(st.mtimeMs)}`);
    }
  };
  walk(join(state, OLD_HILL_DIR), "");
  return out;
}

describe("the asks folder (ADR 0179)", () => {
  test("the folder is asks/ and the file asks.json, behind one constant", () => {
    expect(ASKS_DIR).toBe("asks");
    expect(hillDir(state)).toBe(join(state, "asks"));
    expect(DECISIONS_FILE).toBe("asks.json");
  });

  test("a full old hill/ folder: the new code starts clean, carries nothing, and the old folder is byte-identical after a run", () => {
    const before = oldFolder();
    const store = new HillStore(hillDir(state), () => 1000);
    expect(store.all()).toEqual([]);
    expect(readHillSwitch(state).on).toBe(false);
    expect(readHillCrewState(state).view.state).toBe("here");
    writeHillSwitch(state, true);
    expect(snapshot()).toEqual(before);
    expect(readFileSync(join(state, ASKS_DIR, "switch.json"), "utf8")).toContain('"on": true');
  });

  test("an old dc_ id in the new file is not read: kept raw, never listed", () => {
    mkdirSync(hillDir(state), { recursive: true });
    writeFileSync(join(hillDir(state), DECISIONS_FILE), JSON.stringify({ v: 1, decisions: [OLD_DECISION] }));
    expect(new HillStore(hillDir(state), () => 1000).get("dc_aaaaaaaaaaaa")).toBeUndefined();
  });
});
