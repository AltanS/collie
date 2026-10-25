import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";

import { hostFor } from "../host.ts";
import { binaryVersion, createBinaryReader, createVersionReader, mergePaths, spawnBinaryVersion, VERSION_CACHE_MS, VERSION_FAILED_CACHE_MS, VersionCache } from "./binary-version.ts";
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
