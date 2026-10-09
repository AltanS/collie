import { describe, expect, test } from "bun:test";

import {
  FOUND_TTL_MS,
  HARNESS_LAUNCHES,
  NOT_STARTED,
  createHarnessProbe,
  harnessLaunch,
  launchIdsAreContractNames,
} from "./harness-launch.ts";
import { hostFor } from "./host.ts";
import { MUX_AGENT_NAMES } from "./mux/agents.ts";

// The agents the New sheet starts by id (ADR 0091): the bridge's list, never the phone's.

describe("the harness table", () => {
  test("every id is an agent name the mux contract accepts", () => {
    expect(launchIdsAreContractNames()).toBe(true);
  });

  test("every contract name is either started or named with a reason", () => {
    const started = new Set(HARNESS_LAUNCHES.map((h) => h.id));
    const missing = MUX_AGENT_NAMES.filter((name) => !started.has(name) && !Object.hasOwn(NOT_STARTED, name));
    expect(missing).toEqual([]);
  });

  test("ids are unique and a binary is one bare word, never a line", () => {
    expect(new Set(HARNESS_LAUNCHES.map((h) => h.id)).size).toBe(HARNESS_LAUNCHES.length);
    for (const h of HARNESS_LAUNCHES) expect(h.binary).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  test("a lookup is exact: no prefix, no prototype key", () => {
    expect(harnessLaunch("claude")?.binary).toBe("claude");
    expect(harnessLaunch("claude-danger")).toBeUndefined();
    expect(harnessLaunch("toString")).toBeUndefined();
    expect(harnessLaunch("antigravity")).toBeUndefined();
  });
});

describe("createHarnessProbe — found, on the login shell's PATH", () => {
  const linux = hostFor("linux");

  test("searches the PATH the login shell printed, not the bridge's own", async () => {
    const seen: Array<string | undefined> = [];
    const probe = createHarnessProbe({
      env: { PATH: "/usr/bin", SHELL: "/bin/bash" },
      host: linux,
      askPath: () => Promise.resolve("/home/op/.opencode/bin:/usr/bin"),
      find: (binary, path) => {
        seen.push(path);
        return binary === "opencode";
      },
    });
    const list = await probe.list();
    expect(seen.every((p) => p === "/home/op/.opencode/bin:/usr/bin")).toBe(true);
    expect(list.find((h) => h.id === "opencode")).toEqual({ id: "opencode", label: "opencode", found: true });
    expect(list.find((h) => h.id === "claude")?.found).toBe(false);
  });

  test("a shell that cannot be asked falls back to the bridge's own PATH", async () => {
    const seen: Array<string | undefined> = [];
    const probe = createHarnessProbe({
      env: { PATH: "/usr/bin", SHELL: "/bin/zsh" },
      host: linux,
      askPath: () => Promise.resolve(null),
      find: (_binary, path) => {
        seen.push(path);
        return false;
      },
    });
    await probe.list();
    expect(new Set(seen)).toEqual(new Set(["/usr/bin"]));
  });

  test("an unknown shell is never asked", async () => {
    let asked = 0;
    const probe = createHarnessProbe({
      env: { PATH: "/usr/bin", SHELL: "/opt/weird/xonsh" },
      host: linux,
      askPath: () => {
        asked++;
        return Promise.resolve("/nope");
      },
      find: () => false,
    });
    await probe.list();
    expect(asked).toBe(0);
  });

  test("Windows asks no login shell", async () => {
    let asked = 0;
    const probe = createHarnessProbe({
      env: { Path: "C:\\bin", SHELL: "/bin/bash" },
      host: hostFor("win32"),
      askPath: () => {
        asked++;
        return Promise.resolve("/nope");
      },
      find: () => false,
    });
    await probe.list();
    expect(asked).toBe(0);
  });

  test("the login PATH is asked once per process, and found flags are kept for the TTL", async () => {
    let asked = 0;
    let finds = 0;
    let clock = 0;
    const probe = createHarnessProbe({
      env: { PATH: "/usr/bin", SHELL: "/bin/bash" },
      host: linux,
      askPath: () => {
        asked++;
        return Promise.resolve("/usr/bin");
      },
      find: () => {
        finds++;
        return true;
      },
      now: () => clock,
    });
    await probe.list();
    await probe.list();
    expect(finds).toBe(HARNESS_LAUNCHES.length);
    clock += FOUND_TTL_MS;
    await probe.list();
    expect(finds).toBe(HARNESS_LAUNCHES.length * 2);
    expect(asked).toBe(1);
  });

  test("a caller cannot change the cached list", async () => {
    const probe = createHarnessProbe({ env: {}, host: linux, askPath: () => Promise.resolve(null), find: () => true });
    const first = await probe.list();
    first[0]!.found = false;
    expect((await probe.list())[0]!.found).toBe(true);
  });
});
