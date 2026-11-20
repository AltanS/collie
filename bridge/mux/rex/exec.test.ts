import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  badRexEndpoint,
  CALL_OUTPUT_CAP,
  CAPTURE_OUTPUT_CAP,
  defaultRexSocket,
  NO_BINARY_CODE,
  noRexBinaryMessage,
  OUTPUT_CAPPED_CODE,
  outputCapFor,
  pumpLines,
  rexBinaryCandidates,
  rexChildEnv,
  SpawnRexExec,
} from "./exec.ts";

// The macOS facts these pin were probed against the Rex.app-managed server, rex 0.0.1793974979
// (API revision 11), on an Apple-silicon Mac (MUX_CONTRACT.md, RX): the app exports REX_BIN_DIR into
// every block pointing inside its bundle, the default socket lives under Application Support, and an
// ambient REX_SESSION scopes every bare `-b` to that session alone.

describe("rexBinaryCandidates", () => {
  test("rex's own REX_BIN_DIR comes first", () => {
    expect(rexBinaryCandidates("/home/o", "/Applications Support/bundle/MacOS")).toEqual([
      "/Applications Support/bundle/MacOS/rex",
      "/home/o/.local/bin/rex",
      "/usr/local/bin/rex",
      "/usr/bin/rex",
      "/bin/rex",
      "/opt/homebrew/bin/rex",
      "/opt/local/bin/rex",
    ]);
  });

  test("no REX_BIN_DIR leaves the fixed prefixes", () => {
    expect(rexBinaryCandidates("/home/o", "")).not.toContain("/rex");
    expect(rexBinaryCandidates("/home/o", "  ")).toEqual([
      "/home/o/.local/bin/rex",
      "/usr/local/bin/rex",
      "/usr/bin/rex",
      "/bin/rex",
      "/opt/homebrew/bin/rex",
      "/opt/local/bin/rex",
    ]);
  });
});

describe("rexChildEnv", () => {
  test("strips the ambient session and block scope, keeps the rest, never mutates the source", () => {
    const env = { PATH: "/usr/bin", REX_SESSION: "session:1", REX_BLOCK: "block:1", REX_SERVER: "unix:///x" };
    expect(rexChildEnv(env)).toEqual({ PATH: "/usr/bin", REX_SERVER: "unix:///x" });
    expect(env).toEqual({ PATH: "/usr/bin", REX_SESSION: "session:1", REX_BLOCK: "block:1", REX_SERVER: "unix:///x" });
  });
});

describe("defaultRexSocket", () => {
  test("XDG_RUNTIME_DIR wins on every platform — it is how a throwaway server is placed", () => {
    expect(defaultRexSocket("/tmp/run", 1000, "/home/o", "darwin")).toBe("/tmp/run/rex/server.sock");
    expect(defaultRexSocket("/run/user/1000", 1000, "/home/o", "linux")).toBe("/run/user/1000/rex/server.sock");
  });

  test("a Mac with no XDG runtime dir reads the app-managed Application Support socket", () => {
    expect(defaultRexSocket(undefined, 501, "/Users/o", "darwin")).toBe("/Users/o/Library/Application Support/rex/server.sock");
  });

  test("Linux keeps /run/user when nothing is configured", () => {
    expect(defaultRexSocket(undefined, 1000, "/home/o", "linux")).toBe("/run/user/1000/rex/server.sock");
  });
});

/**
 * Rex has no Windows build (a Linux server, a macOS app: docs/multiplexers.md), and these two cases run a
 * `sh` script and `/usr/bin/echo` as the rex binary, so they are left out on Windows. The kill past the
 * cap was checked there by hand on 2026-11-20: SpawnRexExec on a compiled endless printer answered
 * OUTPUT_CAPPED_CODE after 2.9 s, and no copy of the child was left running.
 */
const NO_REX_ON_WINDOWS = process.platform === "win32";

describe("a child's output is capped", () => {
  test("the whole capture may be large, every other call small", () => {
    expect(outputCapFor(["capture", "-b", "block:x", "--format=vt"])).toBe(CAPTURE_OUTPUT_CAP);
    expect(outputCapFor(["block", "call", "-b", "block:x", "blob_read", "{}"])).toBe(CALL_OUTPUT_CAP);
    expect(CAPTURE_OUTPUT_CAP).toBe(64 * 1024 * 1024);
    expect(CALL_OUTPUT_CAP).toBe(2 * 1024 * 1024);
  });

  test.skipIf(NO_REX_ON_WINDOWS)("a child that never stops printing is killed past the cap, and the answer says so", async () => {
    // A stand-in that prints for ever, whatever it is asked: the shape of a rex that answers without end.
    const dir = mkdtempSync(join(tmpdir(), "rex-cap-"));
    const endless = join(dir, "rex");
    writeFileSync(endless, "#!/bin/sh\nwhile :; do echo 0123456789abcdef0123456789abcdef; done\n");
    chmodSync(endless, 0o755);
    const exec = new SpawnRexExec(endless, "", 20_000);
    const started = performance.now();
    const result = await exec.run(["ls", "--json"]).finally(() => rmSync(dir, { recursive: true, force: true }));
    expect(result.code).toBe(OUTPUT_CAPPED_CODE);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`rex printed more than ${String(CALL_OUTPUT_CAP)} bytes for \`ls\` and was killed`);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  test.skipIf(NO_REX_ON_WINDOWS)("an answer under the cap arrives whole", async () => {
    const exec = new SpawnRexExec("/usr/bin/echo", "", 5_000);
    const result = await exec.run(["ls", "--json"]);
    expect(result).toEqual({ code: 0, stdout: "--autostart=false --color=never ls --json\n", stderr: "" });
  });
});

describe("the event stream's lines", () => {
  async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
    for (const part of parts) yield new TextEncoder().encode(part);
  }

  test("a line past the cap is dropped whole, and the next line arrives", async () => {
    const lines: string[] = [];
    await pumpLines(chunks('{"a":1}\n', "x".repeat(40), "x".repeat(40), "tail\n", '{"b":2}\n'), (line) => lines.push(line), 64);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("an unterminated line never grows past the cap", async () => {
    const lines: string[] = [];
    await pumpLines(chunks(...Array.from({ length: 100 }, () => "y".repeat(50))), (line) => lines.push(line), 64);
    expect(lines).toEqual([]);
  });

  test("a line split across chunks and one ending CRLF are whole lines", async () => {
    const lines: string[] = [];
    await pumpLines(chunks('{"a"', ':1}\r\n{"b":2}'), (line) => lines.push(line), 64);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe("REX_BIN_DIR counts only as an absolute folder", () => {
  test("a relative or empty REX_BIN_DIR adds no candidate", () => {
    const plain = rexBinaryCandidates("/home/o", "");
    expect(rexBinaryCandidates("/home/o", "bin")).toEqual(plain);
    expect(rexBinaryCandidates("/home/o", "./bin")).toEqual(plain);
    expect(rexBinaryCandidates("/home/o", "   ")).toEqual(plain);
    expect(plain[0]).toBe("/home/o/.local/bin/rex");
  });

  test("an absolute one comes first", () => {
    expect(rexBinaryCandidates("/home/o", " /usr/bin ")[0]).toBe("/usr/bin/rex");
  });
});

describe("the no rex binary message says where it looked", () => {
  test("it lists every path tried and names COLLIE_REX_BIN", () => {
    expect(noRexBinaryMessage("", ["/home/o/.local/bin/rex", "/usr/bin/rex"])).toBe(
      "no rex binary at /home/o/.local/bin/rex, /usr/bin/rex; set COLLIE_REX_BIN to its absolute path",
    );
  });

  test("a COLLIE_REX_BIN that is not there is named", () => {
    expect(noRexBinaryMessage(" rex ", ["/usr/bin/rex"])).toBe('COLLIE_REX_BIN="rex" is not an absolute path to a file that is there');
  });

  test("a call with no binary answers that message, and so does the event stream", async () => {
    const exec = new SpawnRexExec(null, "", 1_000, "no rex binary at /x/rex; set COLLIE_REX_BIN to its absolute path");
    expect(await exec.run(["ls"])).toEqual({ code: NO_BINARY_CODE, stdout: "", stderr: "no rex binary at /x/rex; set COLLIE_REX_BIN to its absolute path" });
    const reason = await new Promise<string>((resolve) => exec.events({ onLine: () => undefined, onExit: resolve }));
    expect(reason).toBe("no rex binary at /x/rex; set COLLIE_REX_BIN to its absolute path");
  });
});

describe("an endpoint that starts with a dash is refused before any rex call", () => {
  test("it is named as no address", () => {
    expect(badRexEndpoint("--help")).toBe('the Rex endpoint "--help" starts with a dash, so it is not a host label or a server address');
    expect(badRexEndpoint(" -x ")).not.toBeNull();
    expect(badRexEndpoint("")).toBeNull();
    expect(badRexEndpoint("unix:///run/user/1000/rex/server.sock")).toBeNull();
    expect(badRexEndpoint("my-host")).toBeNull();
  });

  test("a call and the event stream answer the refusal and run nothing", async () => {
    // /bin/false would exit 1 if it ran; the refusal must come first.
    const exec = new SpawnRexExec("/bin/false", "--help", 1_000);
    const result = await exec.run(["ls"]);
    expect(result.code).toBe(NO_BINARY_CODE);
    expect(result.stderr).toContain("starts with a dash");
    const reason = await new Promise<string>((resolve) => exec.events({ onLine: () => undefined, onExit: resolve }));
    expect(reason).toContain("starts with a dash");
  });
});
