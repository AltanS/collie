import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";

import { binaryVersion, createVersionReader } from "./binary-version.ts";
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
