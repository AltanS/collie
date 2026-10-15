import { describe, expect, test } from "bun:test";

import { binaryVersion } from "./binary-version.ts";
import { loadProfiles, parseProfile, profileFor } from "../../web/src/lib/surface/profile.ts";

const [anyProfile] = [...loadProfiles().values()];

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
    const profile = parseProfile({
      ...JSON.parse(JSON.stringify(anyProfile)),
      identity: { binary: "bun", versionCommand: ["bun", "--version"], versionRegex: "\\d+\\.\\d+\\.\\d+" },
    });
    expect(binaryVersion(profile)).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
