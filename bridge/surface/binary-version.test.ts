import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";

import { hostFor } from "../host.ts";
import { binaryVersion, createVersionReader, mergePaths, spawnBinaryVersion } from "./binary-version.ts";
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
