import { describe, expect, test } from "bun:test";

import { fakeFiles, posixKey } from "./fakes.ts";

describe("posixKey", () => {
  test("folds a Windows path to the POSIX key a fake filesystem stores", () => {
    expect(posixKey("C:\\opt\\collie\\bin\\collie.exe", "win32")).toBe("/opt/collie/bin/collie.exe");
    expect(posixKey("\\opt\\collie", "win32")).toBe("/opt/collie");
  });

  test("leaves a path alone off Windows, where a backslash is a legal name character", () => {
    expect(posixKey("/opt/co\\llie", "linux")).toBe("/opt/co\\llie");
  });
});

describe("fakeFiles", () => {
  test("answers a path seeded by its POSIX key", () => {
    const files = fakeFiles({ "/opt/collie/VERSION": "1.0.0\n" });
    expect(files.read("/opt/collie/VERSION")).toBe("1.0.0\n");
    expect(files.exists("/opt/collie")).toBe(true);
  });
});
