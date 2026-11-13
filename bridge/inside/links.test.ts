import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { configHome, defaultPartsRoot, linkedHarnesses, linkRecordPath, partsRoot } from "./links.ts";

const HOME = "/home/pat";

describe("the parts folder (M99 spec 09)", () => {
  test("the default is ~/.config/collie/inside", () => {
    expect(partsRoot({}, HOME)).toBe(join(HOME, ".config", "collie", "inside"));
    expect(partsRoot({}, HOME)).toBe(defaultPartsRoot(HOME));
  });

  test("an absolute XDG_CONFIG_HOME moves it; a relative one is ignored, as the spec says", () => {
    expect(partsRoot({ XDG_CONFIG_HOME: "/data/cfg" }, HOME)).toBe(join("/data/cfg", "collie", "inside"));
    expect(configHome({ XDG_CONFIG_HOME: "cfg" }, HOME)).toBe(join(HOME, ".config"));
    expect(partsRoot({ XDG_CONFIG_HOME: "./cfg" }, HOME)).toBe(defaultPartsRoot(HOME));
  });

  test("COLLIE_PARTS_DIR, the folder a unit pins, wins when absolute", () => {
    expect(partsRoot({ COLLIE_PARTS_DIR: "/pinned", XDG_CONFIG_HOME: "/data/cfg" }, HOME)).toBe("/pinned");
    expect(partsRoot({ COLLIE_PARTS_DIR: "rel" }, HOME)).toBe(defaultPartsRoot(HOME));
  });

  test("the bridge and the CLI read the same records through the same folder", () => {
    const env = { XDG_CONFIG_HOME: "/data/cfg" };
    const record = linkRecordPath(env, HOME, "claude");
    const files = {
      list: (path: string) => (path === partsRoot(env, HOME) ? ["claude.link.json", "claude", "notes.txt"] : []),
      read: (path: string) => (path === record ? JSON.stringify({ harness: "claude", version: "1.29.0", at: 1 }) : null),
    };
    expect(linkedHarnesses(env, HOME, files)).toEqual(["claude"]);
    // A bridge started without the variable looks in the default folder, and sees nothing there.
    expect(linkedHarnesses({}, HOME, files)).toEqual([]);
  });
});
