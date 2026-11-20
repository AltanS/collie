import { describe, expect, test } from "bun:test";

import { context, fakeExec, fakeFiles, HOME, type Scripted } from "./fakes.ts";
import { muxFinding } from "./setup-findings.ts";

// `collie doctor`'s mux line on COLLIE_MUX=rex. It runs one call, `rex api call server.status`, the call
// the bridge makes once at start, and never starts a server (`--autostart=false`).

const REX_BIN = `${HOME}/.local/bin/rex`;
const STATUS_ARGV = `${REX_BIN} --autostart=false --color=never api call server.status`;

function finding(files: Record<string, string>, answers: Scripted["answers"] = []) {
  return muxFinding({ ctx: context({ COLLIE_MUX: "rex" }), files: fakeFiles(files), exec: fakeExec({ answers }) });
}

const status = (revision: number): Scripted["answers"] => [
  [STATUS_ARGV, { stdout: JSON.stringify({ api_revision: revision, listeners: [{ endpoint: "unix:///run/user/7/rex/server.sock", primary: true }] }) }],
];

describe("collie doctor on rex", () => {
  test("it prints the binary, the server's address and its API revision", () => {
    const line = finding({ [REX_BIN]: "" }, status(19));
    expect(line.status).toBe("ok");
    expect(line.detail).toBe(`rex · ${REX_BIN} · unix:///run/user/7/rex/server.sock · API revision 19 · set by COLLIE_MUX`);
  });

  test("a revision Collie was not tested with is a warning with the bridge's sentence", () => {
    const line = finding({ [REX_BIN]: "" }, status(20));
    expect(line.status).toBe("warn");
    expect(line.detail).toContain("Rex API revision 20 was not tested with Collie (tested: 18, 19)");
  });

  test("no binary names every path it tried, and COLLIE_REX_BIN", () => {
    const line = finding({});
    expect(line.status).toBe("error");
    expect(line.detail).toContain(`no rex binary at ${REX_BIN}, /usr/local/bin/rex, /usr/bin/rex`);
    expect(line.remedy).toContain("COLLIE_REX_BIN");
  });

  test("no server is an error that names the start command", () => {
    const line = finding({ [REX_BIN]: "" }, [[`${REX_BIN} --autostart=false`, { code: 1, stderr: "Error: no Rex server is running\n" }]]);
    expect(line.status).toBe("error");
    expect(line.detail).toBe(`rex — ${REX_BIN} answered, but no Rex server did: Error: no Rex server is running`);
    expect(line.remedy).toContain("rex server start");
  });
});
