import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { herdrCoreMuxFactory } from "./adapter.ts";
import { herdrCoreBeaconMatcher } from "./markers.ts";

const SOCKET = "/run/user/1000/herdr-core/default.sock";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("herdr-core's beacon matcher", () => {
  const matcher = herdrCoreBeaconMatcher("herdr-core", SOCKET);

  test("a marker names a pane when the address is equal and the socket is the one dialled", async () => {
    const scope = await matcher.scope();
    expect(scope).toBe(SOCKET);
    expect(matcher.matches({ paneId: "t3" }, { namespace: "herdr-core", scope: SOCKET, pane: "t3" }, SOCKET)).toBe(true);
    expect(matcher.matches({ paneId: "t3" }, { namespace: "herdr-core", scope: SOCKET, pane: "t4" }, SOCKET)).toBe(false);
  });

  test("the same address on another core session is another terminal", () => {
    const other = { namespace: "herdr-core", scope: "/run/user/1000/herdr-core/work.sock", pane: "t3" };
    expect(matcher.matches({ paneId: "t3" }, other, SOCKET)).toBe(false);
  });

  test("two spellings of one socket are one scope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hc-markers-"));
    dirs.push(dir);
    const real = join(dir, "core.sock");
    const link = join(dir, "alias.sock");
    writeFileSync(real, "");
    symlinkSync(real, link);
    const linked = herdrCoreBeaconMatcher("herdr-core", link);
    const scope = await linked.scope();
    expect(linked.matches({ paneId: "t1" }, { namespace: "herdr-core", scope: real, pane: "t1" }, scope ?? "")).toBe(true);
  });

  test("no endpoint is no scope, so nothing joins", async () => {
    expect(await herdrCoreBeaconMatcher("herdr-core", "  ").scope()).toBeNull();
  });

  test("the factory hands the bridge the socket it dials", async () => {
    const made = herdrCoreMuxFactory.beaconMatcher?.({ endpoint: "/srv/core.sock", timeoutMs: 0, options: {} });
    expect(await made?.scope()).toBe("/srv/core.sock");
    expect(made?.namespace).toBe("herdr-core");
  });
});
