import { describe, expect, test } from "bun:test";

import { hostFor } from "../bridge/host.ts";
import { fakeFiles, posixKey } from "./fakes.ts";

describe("posixKey", () => {
  test("folds a Windows path to the POSIX key a fake filesystem stores", () => {
    expect(posixKey("C:\\opt\\collie\\bin\\collie.exe", hostFor("win32"))).toBe("/opt/collie/bin/collie.exe");
    expect(posixKey("\\opt\\collie", hostFor("win32"))).toBe("/opt/collie");
  });

  test("without a host it folds, so a Windows host pinned on Linux still finds its files", () => {
    expect(posixKey("C:\\opt\\collie")).toBe("/opt/collie");
    expect(posixKey("/opt/collie")).toBe("/opt/collie");
  });

  test("leaves a path alone off Windows, where a backslash is a legal name character", () => {
    expect(posixKey("/opt/co\\llie", hostFor("linux"))).toBe("/opt/co\\llie");
  });
});

describe("fakeFiles", () => {
  test("answers a path seeded by its POSIX key", () => {
    const files = fakeFiles({ "/opt/collie/VERSION": "1.0.0\n" });
    expect(files.read("/opt/collie/VERSION")).toBe("1.0.0\n");
    expect(files.exists("/opt/collie")).toBe(true);
  });
});
