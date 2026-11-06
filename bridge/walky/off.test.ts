import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST } from "../host.ts";
import { WalkyOff } from "./off.ts";

// File modes are POSIX: the 0600 check is skipped on Windows.
const POSIX_ONLY = HOST.platform === "win32";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const root = mkdtempSync(join(tmpdir(), "walky-off-"));
  roots.push(root);
  return join(root, "walky");
}

const T0 = 1_786_000_000_000;
const pane = (instance = "aaaa", paneId = "w1:p1") => ({ session: "main", paneId, instance });

describe("the off flag", () => {
  test("is off only for the instance that set it, and on again after `on`", () => {
    const off = new WalkyOff(null, () => T0);
    expect(off.isOff(pane())).toBe(false);
    expect(off.set(pane(), true, "session")).toBe(true);
    expect(off.isOff(pane())).toBe(true);
    // Another session that took the pane id is on.
    expect(off.isOff(pane("bbbb"))).toBe(false);
    // An `on` from another token at the same id leaves this session's row alone.
    expect(off.set(pane("bbbb"), false, "session")).toBe(false);
    expect(off.isOff(pane())).toBe(true);
    expect(off.set(pane(), false, "session")).toBe(false);
    expect(off.isOff(pane())).toBe(false);
  });

  test("a set is idempotent, and the last hand wins while the first time stays", () => {
    let now = T0;
    const off = new WalkyOff(null, () => now);
    off.set(pane(), true, "session");
    now += 1000;
    off.set(pane(), true, "session");
    expect(off.all()).toEqual([{ session: "main", paneId: "w1:p1", token: "aaaa", since: T0, by: "session" }]);
    off.set(pane(), true, "operator");
    expect(off.all()).toEqual([{ session: "main", paneId: "w1:p1", token: "aaaa", since: T0, by: "operator" }]);
  });

  test("the file is absent until the first `off`, and persists across a reload", () => {
    const at = dir();
    const off = new WalkyOff(at, () => T0);
    off.set(pane(), false, "session");
    expect(existsSync(join(at, "off.json"))).toBe(false);
    off.set(pane(), true, "operator");
    expect(existsSync(join(at, "off.json"))).toBe(true);
    const after = new WalkyOff(at, () => T0 + 1);
    expect(after.isOff(pane())).toBe(true);
    expect(after.all()).toEqual([{ session: "main", paneId: "w1:p1", token: "aaaa", since: T0, by: "operator" }]);
  });

  test.skipIf(POSIX_ONLY)("the file is 0600 in a 0700 folder", () => {
    const at = dir();
    new WalkyOff(at, () => T0).set(pane(), true, "session");
    expect(statSync(join(at, "off.json")).mode & 0o777).toBe(0o600);
    expect(statSync(at).mode & 0o777).toBe(0o700);
  });

  test("a dropped instance takes its flag with it, on disk too; a newer token at the same id stays", () => {
    const at = dir();
    const off = new WalkyOff(at, () => T0);
    off.set(pane(), true, "session");
    off.drop("main", "w1:p1", "bbbb");
    expect(off.isOff(pane())).toBe(true);
    off.drop("main", "w1:p1", "aaaa");
    expect(off.isOff(pane())).toBe(false);
    expect(new WalkyOff(at, () => T0).all()).toEqual([]);
  });

  test("a corrupt file reads as nobody off, and stays as it is until the next write", () => {
    const at = dir();
    mkdirSync(at, { recursive: true });
    const path = join(at, "off.json");
    writeFileSync(path, "{ not json");
    const off = new WalkyOff(at, () => T0);
    expect(off.all()).toEqual([]);
    off.set(pane(), false, "session");
    expect(readFileSync(path, "utf8")).toBe("{ not json");
    off.set(pane(), true, "session");
    expect(new WalkyOff(at, () => T0).isOff(pane())).toBe(true);
  });

  test("a row that fails its rule is left out, and the good rows still read", () => {
    const at = dir();
    mkdirSync(at, { recursive: true });
    const good = { session: "main", paneId: "w1:p1", token: "aaaa", since: T0, by: "session" };
    const panes = [good, { ...good, paneId: "w1:p2", token: "NOT A TOKEN" }, { ...good, paneId: "w1:p3", by: "someone" }, { ...good, paneId: "w1:p4", since: "soon" }];
    writeFileSync(join(at, "off.json"), JSON.stringify({ v: 1, panes }));
    expect(new WalkyOff(at, () => T0).all()).toEqual([{ session: "main", paneId: "w1:p1", token: "aaaa", since: T0, by: "session" }]);
  });
});
