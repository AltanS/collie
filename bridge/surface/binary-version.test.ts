import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";

import { hostFor } from "../host.ts";
import {
  binaryVersion,
  createBinaryReader,
  createVersionReader,
  mergePaths,
  PANE_READ_INTERVAL_MS,
  spawnBinaryVersion,
  VERSION_CACHE_MS,
  VERSION_FAILED_CACHE_MS,
  VersionCache,
  type FileStamp,
} from "./binary-version.ts";
import { boundedRun } from "../login-path.ts";
import { SurfaceShadow } from "./shadow.ts";
import { loadProfiles, parseProfile, profileFor } from "../../web/src/lib/surface/profile.ts";

const [anyProfile] = [...loadProfiles().values()];

const bunProfile = () =>
  parseProfile({
    ...JSON.parse(JSON.stringify(anyProfile)),
    identity: { binary: "bun", versionCommand: ["bun", "--version"], versionRegex: "\\d+\\.\\d+\\.\\d+" },
  });

describe("binaryVersion", () => {
  test("takes the first version the command prints", () => {
    expect(binaryVersion(anyProfile!, () => "2.1.300 (a build)")).toBe("2.1.300");
  });

  test("reads a version printed on stderr too", () => {
    expect(binaryVersion(anyProfile!, (command) => ` ${command[0]} 9.8.7`)).toBe("9.8.7");
  });

  test("is null when the command will not run or prints no version", () => {
    expect(binaryVersion(anyProfile!, () => null)).toBeNull();
    expect(binaryVersion(anyProfile!, () => "command not found")).toBeNull();
  });

  test("a profile whose binary cannot be read is provisional", () => {
    const version = binaryVersion(anyProfile!, () => null);
    expect(profileFor(anyProfile!.id, version, { log: () => {} })?.status).toBe("provisional");
  });

  test("runs a real command", () => {
    expect(binaryVersion(bunProfile())).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("createVersionReader — the binary, on the login shell's PATH", () => {
  test("runs the version command found on the login shell's PATH, with that PATH", async () => {
    const runs: Array<{ argv: readonly string[]; path: string | undefined }> = [];
    const read = createVersionReader({
      env: { PATH: "/usr/bin" },
      // A POSIX host, so the `:` in these PATHs is the separator on a Windows machine too.
      host: hostFor("linux"),
      loginPath: () => Promise.resolve("/home/op/.local/bin:/usr/bin"),
      resolve: (binary, path) => (path?.startsWith("/home/op/.local/bin") ? `/home/op/.local/bin/${binary}` : null),
      run: (argv, path) => {
        runs.push({ argv, path });
        return Promise.resolve("2.1.300 (a build)");
      },
    });
    const [command, ...args] = anyProfile!.identity.versionCommand;
    expect(await read(anyProfile!)).toBe("2.1.300");
    expect(runs).toEqual([{ argv: [`/home/op/.local/bin/${command}`, ...args], path: "/home/op/.local/bin:/usr/bin" }]);
  });

  test("a binary nowhere on that PATH reads as unread, and nothing runs", async () => {
    let ran = false;
    const read = createVersionReader({
      loginPath: () => Promise.resolve("/usr/bin"),
      resolve: () => null,
      run: () => {
        ran = true;
        return Promise.resolve("2.1.300");
      },
    });
    expect(await read(anyProfile!)).toBeNull();
    expect(ran).toBe(false);
  });

  test("runs a real command from the PATH it is given", async () => {
    const read = createVersionReader({ loginPath: () => Promise.resolve(dirname(process.execPath)) });
    expect(await read(bunProfile())).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("createVersionReader — the login PATH first, the bridge's own PATH after it", () => {
  const OWN = "/systemd/only/bin:/usr/bin";
  const LOGIN = "/home/op/.local/bin:/usr/bin";
  const holders = (...dirs: string[]) => (binary: string, path: string | undefined) => {
    const dir = (path ?? "").split(":").find((d) => dirs.includes(d));
    return dir === undefined ? null : `${dir}/${binary}`;
  };

  test("a binary only the bridge's own PATH holds is still read, with the merged PATH", async () => {
    const runs: Array<{ argv: readonly string[]; path: string | undefined }> = [];
    const read = createVersionReader({
      env: { PATH: OWN },
      host: hostFor("linux"),
      loginPath: () => Promise.resolve(LOGIN),
      resolve: holders("/systemd/only/bin"),
      run: (argv, path) => {
        runs.push({ argv, path });
        return Promise.resolve("2.1.300");
      },
    });
    expect(await read(anyProfile!)).toBe("2.1.300");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.argv[0]).toStartWith("/systemd/only/bin/");
    expect(runs[0]!.path).toBe("/home/op/.local/bin:/usr/bin:/systemd/only/bin");
  });

  test("a binary only the login PATH holds is read", async () => {
    const runs: string[] = [];
    const read = createVersionReader({
      env: { PATH: OWN },
      host: hostFor("linux"),
      loginPath: () => Promise.resolve(LOGIN),
      resolve: holders("/home/op/.local/bin"),
      run: (argv) => {
        runs.push(argv[0]!);
        return Promise.resolve("2.1.300");
      },
    });
    expect(await read(anyProfile!)).toBe("2.1.300");
    expect(runs[0]).toStartWith("/home/op/.local/bin/");
  });

  test("a binary in both is taken from the login PATH", async () => {
    const runs: string[] = [];
    const read = createVersionReader({
      env: { PATH: OWN },
      host: hostFor("linux"),
      loginPath: () => Promise.resolve(LOGIN),
      resolve: holders("/home/op/.local/bin", "/systemd/only/bin"),
      run: (argv) => {
        runs.push(argv[0]!);
        return Promise.resolve("2.1.300");
      },
    });
    await read(anyProfile!);
    expect(runs[0]).toStartWith("/home/op/.local/bin/");
  });

  test("a binary in neither is null and nothing is spawned", async () => {
    let ran = false;
    const read = createVersionReader({
      env: { PATH: OWN },
      host: hostFor("linux"),
      loginPath: () => Promise.resolve(LOGIN),
      resolve: holders("/nowhere"),
      run: () => {
        ran = true;
        return Promise.resolve("2.1.300");
      },
    });
    expect(await read(anyProfile!)).toBeNull();
    expect(ran).toBe(false);
  });

  test("the default login PATH is asked when the process PATH is short (the launchd case)", async () => {
    const asked: string[] = [];
    const runs: Array<string | undefined> = [];
    const read = createVersionReader({
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/zsh" },
      host: hostFor("darwin"),
      askPath: (shell) => {
        asked.push(shell);
        return Promise.resolve("/Users/op/.opencode/bin:/usr/bin:/bin");
      },
      resolve: holders("/Users/op/.opencode/bin"),
      run: (_argv, path) => {
        runs.push(path);
        return Promise.resolve("2.1.300");
      },
    });
    expect(await read(anyProfile!)).toBe("2.1.300");
    expect(asked).toEqual(["/bin/zsh"]);
    expect(runs[0]).toBe("/Users/op/.opencode/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });
});

describe("mergePaths", () => {
  test("login first, own after, each directory once", () => {
    expect(mergePaths("/a:/b", "/b:/c", hostFor("linux"))).toBe("/a:/b:/c");
  });

  test("uses the host's separator", () => {
    expect(mergePaths("C:\\a", "C:\\b", hostFor("win32"))).toBe("C:\\a;C:\\b");
  });

  test("is undefined when neither is set", () => {
    expect(mergePaths(undefined, undefined)).toBeUndefined();
  });
});

describe("the shadow's default version reader", () => {
  test("is spawnBinaryVersion, so it reads on the login shell's PATH", () => {
    const mux = { readGrid: () => Promise.resolve({ ok: false as const, reason: "gone" as const, detail: "unused" }) };
    const shadow = new SurfaceShadow({ mux, pollMs: 1000, log: () => {} });
    // The field is private; reading it by name is the one way to see which reader the shadow defaulted to.
    expect(shadow["readVersion"]).toBe(spawnBinaryVersion);
  });
});

describe("createBinaryReader — the file and how the command ended", () => {
  const base = { env: { PATH: "/usr/bin" }, host: hostFor("linux"), loginPath: () => Promise.resolve("/home/op/.local/bin:/usr/bin") };
  const resolve = (binary: string) => `/home/op/.local/bin/${binary}`;

  test("keeps the resolved file and the exit code beside the version", async () => {
    const read = createBinaryReader({
      ...base,
      resolve,
      runDetailed: () => Promise.resolve({ exitCode: 0, output: "2.1.300 (a build) ", stderr: "" }),
    });
    const [command] = anyProfile!.identity.versionCommand;
    expect(await read(anyProfile!)).toEqual({
      binary: `/home/op/.local/bin/${command}`,
      version: "2.1.300",
      outcome: { exitCode: 0, output: "2.1.300 (a build) ", stderr: "" },
    });
  });

  test("a command that fails gives the file, no version and the exit code", async () => {
    const read = createBinaryReader({
      ...base,
      resolve,
      runDetailed: () => Promise.resolve({ exitCode: 127, output: " not found", stderr: "not found" }),
    });
    const got = await read(anyProfile!);
    expect(got.binary).not.toBeNull();
    expect(got.version).toBeNull();
    expect(got.outcome?.exitCode).toBe(127);
  });

  test("a binary nowhere on the PATH is null, and nothing runs", async () => {
    let ran = false;
    const read = createBinaryReader({
      ...base,
      resolve: () => null,
      runDetailed: () => {
        ran = true;
        return Promise.resolve(null);
      },
    });
    expect(await read(anyProfile!)).toEqual({ binary: null, version: null, outcome: null });
    expect(ran).toBe(false);
  });
});

describe("a version read that cannot hang a send (#594)", () => {
  // A child that holds stdout open after its parent is killed: the old 5 s timeout killed the parent and
  // then waited for the pipe, 20 s in the lab.
  test.skipIf(process.platform === "win32")("boundedRun answers at its cap even when a grandchild holds the pipe", async () => {
    const started = Date.now();
    const done = await boundedRun(["/bin/sh", "-c", "sleep 5 & sleep 5"], process.env, 200);
    expect(done).toEqual({ out: "", err: "", code: null });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test.skipIf(process.platform === "win32")("boundedRun returns what a quick command printed, and its exit code", async () => {
    expect(await boundedRun(["/bin/sh", "-c", "printf 1.2.3; exit 3"], process.env, 2_000)).toEqual({ out: "1.2.3", err: "", code: 3 });
  });

  test("sends that ask while a read runs share it", async () => {
    let reads = 0;
    let answer: (version: string | null) => void = () => undefined;
    const cache = new VersionCache(() => {
      reads++;
      return new Promise((done) => (answer = done));
    });
    const first = cache.versionOf(anyProfile!);
    const second = cache.versionOf(anyProfile!);
    answer("1.3.0");
    expect(await Promise.all([first, second])).toEqual(["1.3.0", "1.3.0"]);
    expect(reads).toBe(1);
  });

  test("a read that does not answer inside the budget reads as null, and stands for VERSION_FAILED_CACHE_MS only", async () => {
    let now = 1_000_000;
    let reads = 0;
    const cache = new VersionCache(
      () => {
        reads++;
        return reads === 1 ? new Promise<string | null>(() => undefined) : Promise.resolve("1.3.0");
      },
      () => now,
      20,
    );
    expect(await cache.versionOf(anyProfile!)).toBeNull();
    now += VERSION_FAILED_CACHE_MS;
    expect(await cache.versionOf(anyProfile!)).toBeNull();
    expect(reads).toBe(1);
    now += 1;
    // A later success replaces the failure, and stands for the long window.
    expect(await cache.versionOf(anyProfile!)).toBe("1.3.0");
    now += VERSION_FAILED_CACHE_MS + 1;
    expect(await cache.versionOf(anyProfile!)).toBe("1.3.0");
    expect(reads).toBe(2);
    expect(VERSION_FAILED_CACHE_MS).toBeLessThan(VERSION_CACHE_MS);
  });
});

describe("the pane's own program (ADR 0124, amended 2026-10-26)", () => {
  const read = (runs: Array<{ argv: readonly string[]; path: string | undefined }>) =>
    createVersionReader({
      env: { PATH: "/usr/bin" },
      host: hostFor("linux"),
      loginPath: () => Promise.resolve("/home/op/.bun/bin"),
      resolve: (binary) => `/home/op/.bun/bin/${binary}`,
      run: (argv, path) => {
        runs.push({ argv, path });
        return Promise.resolve("v9.9.9");
      },
    });

  test("runs the pane's file in place of the PATH binary, with the profile's own arguments and the merged PATH", async () => {
    const runs: Array<{ argv: readonly string[]; path: string | undefined }> = [];
    const [, ...args] = anyProfile!.identity.versionCommand;
    expect(await read(runs)(anyProfile!, ["/lab/copy/bin/agent"])).toBe("9.9.9");
    expect(runs).toEqual([{ argv: ["/lab/copy/bin/agent", ...args], path: "/home/op/.bun/bin:/usr/bin" }]);
  });

  test("an interpreter and a script: a bare interpreter name is searched on the PATH, the script kept as it is", async () => {
    const runs: Array<{ argv: readonly string[]; path: string | undefined }> = [];
    const [, ...args] = anyProfile!.identity.versionCommand;
    await read(runs)(anyProfile!, ["bun", "/lab/copy/node_modules/.bin/agent"]);
    expect(runs[0]?.argv).toEqual(["/home/op/.bun/bin/bun", "/lab/copy/node_modules/.bin/agent", ...args]);
  });

  test("a profile whose version command starts with another program keeps the PATH lookup", async () => {
    const runs: Array<{ argv: readonly string[]; path: string | undefined }> = [];
    const wrapped = parseProfile({
      ...JSON.parse(JSON.stringify(anyProfile)),
      identity: { binary: "agent", versionCommand: ["agent-launcher", "agent", "--version"], versionRegex: "\\d+\\.\\d+\\.\\d+" },
    });
    await read(runs)(wrapped, ["/lab/copy/bin/agent"]);
    expect(runs[0]?.argv).toEqual(["/home/op/.bun/bin/agent-launcher", "agent", "--version"]);
  });

  // Every file a test names has a stamp unless the test removes it: the cache keys a pane command by it.
  const stamps = (files: ReadonlyMap<string, { mtimeMs: number; size: number }> = new Map()): FileStamp => (path) => files.get(path) ?? { mtimeMs: 1_000, size: 10 };

  test("the cache keys by the program read: two copies read two versions, one file is read once", async () => {
    const asked: Array<readonly string[] | undefined> = [];
    const cache = new VersionCache(
      (_profile, pane) => {
        asked.push(pane);
        return Promise.resolve(pane === undefined ? "18.6.1" : pane[0] === "/a/agent" ? "18.12.6" : "18.13.0");
      },
      undefined,
      undefined,
      stamps(),
    );
    expect(await cache.versionOf(anyProfile!)).toBe("18.6.1");
    expect(await cache.versionOf(anyProfile!, ["/a/agent"])).toBe("18.12.6");
    expect(await cache.versionOf(anyProfile!, ["/b/agent"])).toBe("18.13.0");
    expect(await cache.versionOf(anyProfile!, ["/a/agent"])).toBe("18.12.6");
    expect(await cache.versionOf(anyProfile!)).toBe("18.6.1");
    expect(asked).toEqual([undefined, ["/a/agent"], ["/b/agent"]]);
  });

  test("a pane's program that does not answer inside the budget reads as unread, never as the PATH binary's version", async () => {
    const cache = new VersionCache((_profile, pane) => (pane === undefined ? Promise.resolve("18.6.1") : new Promise<string | null>(() => undefined)), undefined, 20, stamps());
    expect(await cache.versionOf(anyProfile!, ["/hung/agent"])).toBeNull();
    expect(await cache.versionOf(anyProfile!)).toBe("18.6.1");
  });

  test("a file replaced in place reads again: same path with a new mtime or size is a new key, the same stamp is a hit", async () => {
    let installed = "18.6.1";
    let reads = 0;
    const files = new Map([["/a/agent", { mtimeMs: 1_000, size: 10 }]]);
    const cache = new VersionCache(
      () => {
        reads++;
        return Promise.resolve(installed);
      },
      undefined,
      undefined,
      stamps(files),
    );
    expect(await cache.versionOf(anyProfile!, ["/a/agent"])).toBe("18.6.1");
    expect(await cache.versionOf(anyProfile!, ["/a/agent"])).toBe("18.6.1");
    expect(reads).toBe(1);
    installed = "18.12.6";
    files.set("/a/agent", { mtimeMs: 2_000, size: 10 });
    expect(await cache.versionOf(anyProfile!, ["/a/agent"])).toBe("18.12.6");
    expect(reads).toBe(2);
    installed = "18.13.0";
    files.set("/a/agent", { mtimeMs: 2_000, size: 11 });
    expect(await cache.versionOf(anyProfile!, ["/a/agent"])).toBe("18.13.0");
    expect(reads).toBe(3);
  });

  test("the stamp is the last word: an interpreter's script, not the interpreter", async () => {
    const statted: string[] = [];
    const cache = new VersionCache(() => Promise.resolve("1.0.0"), undefined, undefined, (path) => {
      statted.push(path);
      return { mtimeMs: 1, size: 1 };
    });
    await cache.versionOf(anyProfile!, ["/usr/bin/bun", "/lab/node_modules/.bin/omp"]);
    expect(statted).toEqual(["/lab/node_modules/.bin/omp"]);
    // The PATH lookup stats nothing.
    await cache.versionOf(anyProfile!);
    expect(statted).toHaveLength(1);
  });

  test("a file that cannot be statted is no pane command: the PATH binary answers, and the answer says so", async () => {
    const asked: Array<readonly string[] | undefined> = [];
    const cache = new VersionCache(
      (_profile, pane) => {
        asked.push(pane);
        return Promise.resolve(pane === undefined ? "18.6.1" : "18.12.6");
      },
      undefined,
      undefined,
      () => null,
    );
    expect(await cache.programVersion(anyProfile!, ["/gone/agent"], "p1")).toEqual({ version: "18.6.1", command: undefined });
    expect(asked).toEqual([undefined]);
  });

  test("a pane starts one fresh read of its own program per 10 s, and a pane over the limit uses the PATH result", async () => {
    let now = 1_000_000;
    const files = new Map([["/a/agent", { mtimeMs: 1, size: 1 }]]);
    const asked: Array<readonly string[] | undefined> = [];
    const cache = new VersionCache(
      (_profile, pane) => {
        asked.push(pane);
        return Promise.resolve(pane === undefined ? "18.6.1" : `pane-${pane.at(-1)}`);
      },
      () => now,
      undefined,
      stamps(files),
    );
    expect(await cache.programVersion(anyProfile!, ["/a/agent"], "p1")).toEqual({ version: "pane-/a/agent", command: ["/a/agent"] });
    // The file changes at once: a second fresh read on the same pane is over the limit.
    files.set("/a/agent", { mtimeMs: 2, size: 1 });
    now += PANE_READ_INTERVAL_MS - 1;
    expect(await cache.programVersion(anyProfile!, ["/a/agent"], "p1")).toEqual({ version: "18.6.1", command: undefined });
    // Another pane has its own allowance, and a cache hit is not a fresh read.
    expect(await cache.programVersion(anyProfile!, ["/a/agent"], "p2")).toMatchObject({ command: ["/a/agent"] });
    expect(await cache.programVersion(anyProfile!, ["/a/agent"], "p2")).toMatchObject({ command: ["/a/agent"] });
    now += 1;
    expect(await cache.programVersion(anyProfile!, ["/a/agent"], "p1")).toMatchObject({ command: ["/a/agent"] });
    expect(asked).toEqual([["/a/agent"], undefined, ["/a/agent"]]);
  });

  test("the limit holds a bounded number of panes: the oldest pane's allowance goes first", async () => {
    const files = new Map<string, { mtimeMs: number; size: number }>();
    const cache = new VersionCache(() => Promise.resolve("1.0.0"), () => 1_000_000, undefined, stamps(files));
    // Each pane runs its own file, so each first send is a fresh read that takes the pane's allowance.
    for (let i = 0; i < 300; i++) expect((await cache.programVersion(anyProfile!, [`/p/${i}`], `pane-${i}`)).command).toBeDefined();
    // Every file is replaced at the same instant: pane-299 is still limited, pane-0 was forgotten.
    for (const i of [0, 299]) files.set(`/p/${i}`, { mtimeMs: 5, size: 1 });
    expect((await cache.programVersion(anyProfile!, ["/p/299"], "pane-299")).command).toBeUndefined();
    expect((await cache.programVersion(anyProfile!, ["/p/0"], "pane-0")).command).toBeDefined();
  });
});
