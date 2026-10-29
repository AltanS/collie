import { describe, expect, test } from "bun:test";
import { fakeExec, fakeFiles } from "./fakes.ts";
import { herdrCoreFindings } from "./herdr-core-findings.ts";

const SOCKET = "/run/user/7/herdr-core/default.sock";

const files = (present: readonly string[]) => fakeFiles(Object.fromEntries(present.map((path) => [path, ""])));
const hc = (stdout: string) => fakeExec({ answers: [["hc --version", { code: 0, stdout }]] });

describe("herdr-core doctor rows", () => {
  test("a socket and an hc on PATH: both ok, with the path and the version", () => {
    const rows = herdrCoreFindings({ env: { XDG_RUNTIME_DIR: "/run/user/7" }, endpoint: "", files: files([SOCKET]), exec: hc("hc 0.1.14\n") });
    expect(rows.map((row) => [row.check, row.status, row.detail])).toEqual([
      ["hc-socket", "ok", SOCKET],
      ["hc-version", "ok", "hc 0.1.14"],
    ]);
  });

  test("no socket is an error naming where it looked; no hc is only a warning", () => {
    const rows = herdrCoreFindings({
      env: { XDG_RUNTIME_DIR: "/run/user/7", HC_SESSION: "lab" },
      endpoint: "",
      files: files([]),
      exec: fakeExec({ absent: ["hc"] }),
    });
    expect(rows[0]?.status).toBe("error");
    expect(rows[0]?.detail).toContain("/run/user/7/herdr-core/lab.sock");
    expect(rows[1]?.status).toBe("warn");
  });

  test("the endpoint variable names the socket that is checked", () => {
    const rows = herdrCoreFindings({ env: {}, endpoint: "/srv/core.sock", files: files(["/srv/core.sock"]), exec: hc("hc 0.1.14\n") });
    expect(rows[0]?.detail).toBe("/srv/core.sock");
  });
});
