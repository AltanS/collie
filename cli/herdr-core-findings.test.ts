import { describe, expect, test } from "bun:test";
import type { HcCoreReading } from "../bridge/mux/herdr-core/client.ts";
import { fakeExec, fakeFiles } from "./fakes.ts";
import { herdrCoreFindings, type HcDial } from "./herdr-core-findings.ts";

const SOCKET = "/run/user/7/herdr-core/default.sock";

const files = (present: readonly string[]) => fakeFiles(Object.fromEntries(present.map((path) => [path, ""])));
const hc = (stdout: string) => fakeExec({ answers: [["hc --version", { code: 0, stdout }]] });
const answers = (reading: Partial<HcCoreReading> = {}): HcDial => () =>
  Promise.resolve({ version: "0.1.14", generation: 1, live: 2, ...reading });

describe("herdr-core doctor rows", () => {
  test("a socket that answers and an hc on PATH: both ok, with the core's version and terminal count", async () => {
    const rows = await herdrCoreFindings({ env: { XDG_RUNTIME_DIR: "/run/user/7" }, endpoint: "", files: files([SOCKET]), exec: hc("hc 0.1.14\n"), dial: answers() });
    expect(rows.map((row) => [row.check, row.status, row.detail])).toEqual([
      ["hc-socket", "ok", `${SOCKET}: herdr-core 0.1.14, 2 live terminals`],
      ["hc-version", "ok", "hc 0.1.14"],
    ]);
  });

  test("one terminal reads in the singular", async () => {
    const rows = await herdrCoreFindings({ env: { XDG_RUNTIME_DIR: "/run/user/7" }, endpoint: "", files: files([SOCKET]), exec: hc("hc 0.1.14\n"), dial: answers({ live: 1 }) });
    expect(rows[0]?.detail).toContain("1 live terminal");
    expect(rows[0]?.detail).not.toContain("terminals");
  });

  test("no socket is an error naming where it looked, and nothing is dialled; no hc is only a warning", async () => {
    let dialled = false;
    const rows = await herdrCoreFindings({
      env: { XDG_RUNTIME_DIR: "/run/user/7", HC_SESSION: "lab" },
      endpoint: "",
      files: files([]),
      exec: fakeExec({ absent: ["hc"] }),
      dial: () => {
        dialled = true;
        return Promise.reject(new Error("never"));
      },
    });
    expect(rows[0]?.status).toBe("error");
    expect(rows[0]?.detail).toContain("/run/user/7/herdr-core/lab.sock");
    expect(rows[1]?.status).toBe("warn");
    expect(dialled).toBe(false);
  });

  test("a dead socket file is an error with the remedy, and says the core did not answer", async () => {
    const rows = await herdrCoreFindings({
      env: { XDG_RUNTIME_DIR: "/run/user/7" },
      endpoint: "",
      files: files([SOCKET]),
      exec: hc("hc 0.1.14\n"),
      dial: () => Promise.reject(new Error("connect ECONNREFUSED")),
    });
    expect(rows[0]?.status).toBe("error");
    expect(rows[0]?.detail).toContain("no core answers on it");
    expect(rows[0]?.detail).toContain("ECONNREFUSED");
    expect(rows[0]?.remedy).toContain("hc server start");
  });

  test("a core at another protocol generation is an error naming both", async () => {
    const rows = await herdrCoreFindings({ env: { XDG_RUNTIME_DIR: "/run/user/7" }, endpoint: "", files: files([SOCKET]), exec: hc("hc 0.2.0\n"), dial: answers({ generation: 2, version: "0.2.0" }) });
    expect(rows[0]?.status).toBe("error");
    expect(rows[0]?.detail).toContain("generation 2");
  });

  test("the endpoint variable names the socket that is dialled", async () => {
    let dialled = "";
    const rows = await herdrCoreFindings({
      env: {},
      endpoint: "/srv/core.sock",
      files: files(["/srv/core.sock"]),
      exec: hc("hc 0.1.14\n"),
      dial: (path) => {
        dialled = path;
        return answers()(path, 1);
      },
    });
    expect(dialled).toBe("/srv/core.sock");
    expect(rows[0]?.detail).toContain("/srv/core.sock");
  });
});
