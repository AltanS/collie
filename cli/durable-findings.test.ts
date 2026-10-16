import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseMarker } from "../bridge/crew/staleness.ts";
import { HOST } from "../bridge/host.ts";
import { FakeDurableProgram, testToken } from "../bridge/mux/durable/fixture.ts";
import { WINDOWS_NO_SOCKET } from "../bridge/mux/durable/transport.ts";
import { durableFindings, sourcesFindings } from "./durable-findings.ts";
import { context } from "./fakes.ts";
import type { Finding } from "./finding.ts";

// `collie doctor`'s durable rows for the second transport, HTTPS with a bearer token (ADR 0103),
// against the fake program served over HTTP on 127.0.0.1. The socket transport's rows are proved in
// `cli/doctor.test.ts` ("doctor durable"); this file proves the https rows, the skips in both
// directions, and that no row carries the token. Every token is minted at run time.

const started: FakeDurableProgram[] = [];
afterEach(async () => {
  for (const program of started.splice(0)) await program.close();
});

async function startHttp(token: string): Promise<FakeDurableProgram> {
  const program = await FakeDurableProgram.startHttp(token);
  started.push(program);
  return program;
}

const onUrl = (url: string, token: string | undefined) => ({ COLLIE_MUX: "durable", COLLIE_DURABLE_URL: url, COLLIE_DURABLE_TOKEN: token });

function rows(findings: Finding[]): [string, string][] {
  return findings.map((finding) => [finding.check, finding.status]);
}

function row(findings: Finding[], check: string): Finding {
  const found = findings.find((finding) => finding.check === check);
  if (found === undefined) throw new Error(`no ${check} row`);
  return found;
}

/** Every word doctor printed for these rows, so a test can look for the token in all of it. */
function printed(findings: Finding[]): string {
  return JSON.stringify(findings);
}

describe("doctor durable over https", () => {
  test("a ready program behind a URL gives ok rows for env, url, token, hello and ready, and skips the socket with the reason", async () => {
    const token = testToken();
    const program = await startHttp(token);
    const findings = await durableFindings({ ctx: context(onUrl(program.url, token)) });
    expect(rows(findings)).toEqual([
      ["durable-env", "ok"],
      ["durable-socket", "skipped"],
      ["durable-url", "ok"],
      ["durable-token", "ok"],
      ["durable-hello", "ok"],
      ["durable-ready", "ok"],
      ["durable-lead", "skipped"],
    ]);
    expect(row(findings, "durable-env").detail).toContain("transport: https with a bearer token");
    expect(row(findings, "durable-socket").detail).toContain("this peer uses COLLIE_DURABLE_URL");
    expect(row(findings, "durable-url").detail).toBe(`${program.url} · loopback http, for wrangler dev on this machine · ${String(program.url.length)} bytes`);
    expect(row(findings, "durable-token").detail).toBe("set, 64 bytes");
    expect(program.requests.map((request) => [request.path, request.bearer])).toEqual([["/session/v1/hello", "match"]]);
    expect(printed(findings)).not.toContain(token);
  });

  test("an https URL is named as https in the url row, and nothing is dialled when the token row fails", async () => {
    const findings = await durableFindings({ ctx: context(onUrl("https://member.example.workers.dev", testToken().slice(0, 20))) });
    expect(rows(findings)).toEqual([
      ["durable-env", "ok"],
      ["durable-socket", "skipped"],
      ["durable-url", "ok"],
      ["durable-token", "error"],
      ["durable-hello", "skipped"],
      ["durable-ready", "skipped"],
      ["durable-lead", "skipped"],
    ]);
    expect(row(findings, "durable-url").detail).toContain("· https ·");
    expect(row(findings, "durable-token").detail).toBe("COLLIE_DURABLE_TOKEN is 20 bytes; it must be at least 32 bytes, for example 64 hex characters from `openssl rand -hex 32`");
  });

  test("plain http off loopback fails the url row with the reason and dials nothing", async () => {
    const findings = await durableFindings({ ctx: context(onUrl("http://example.com:8801", testToken())) });
    expect(row(findings, "durable-url").status).toBe("error");
    expect(row(findings, "durable-url").detail).toContain("unencrypted");
    expect(row(findings, "durable-token").status).toBe("ok");
    expect(row(findings, "durable-hello").status).toBe("skipped");
  });

  test("a program that refuses the token fails the hello row as token-refused, and the row never shows a token", async () => {
    const program = await startHttp(testToken());
    const mine = testToken();
    const findings = await durableFindings({ ctx: context(onUrl(program.url, mine)) });
    const hello = row(findings, "durable-hello");
    expect(hello.status).toBe("error");
    expect(hello.detail).toBe("the durable agent refused the token: token-refused: the durable agent answered 401");
    expect(hello.remedy).toContain("COLLIE_DURABLE_TOKEN");
    expect(row(findings, "durable-ready").status).toBe("skipped");
    expect(printed(findings)).not.toContain(mine);
  });

  test("a URL that answers without the durable service name is the wrong program, named for the URL", async () => {
    const token = testToken();
    const program = await startHttp(token);
    program.hello.service = undefined;
    const findings = await durableFindings({ ctx: context(onUrl(program.url, token)) });
    expect(row(findings, "durable-hello").detail).toContain("something answered at this URL");
    expect(row(findings, "durable-hello").remedy).toContain("COLLIE_DURABLE_URL");
  });

  test("a program that is not ready over https is a warning on the ready row", async () => {
    const token = testToken();
    const program = await startHttp(token);
    program.ready = false;
    const findings = await durableFindings({ ctx: context(onUrl(program.url, token)) });
    expect(row(findings, "durable-hello").status).toBe("ok");
    expect(row(findings, "durable-ready").status).toBe("warn");
  });

  test("both transports set, or a URL without a token, fails the env row with one message and skips the rest", async () => {
    const both = await durableFindings({ ctx: context({ COLLIE_MUX: "durable", COLLIE_DURABLE_SOCKET: "/run/user/1000/d.sock", COLLIE_DURABLE_URL: "https://x.example", COLLIE_DURABLE_TOKEN: testToken() }), platform: "linux" });
    expect(rows(both)).toEqual([
      ["durable-env", "error"],
      ["durable-socket", "skipped"],
      ["durable-url", "skipped"],
      ["durable-token", "skipped"],
      ["durable-hello", "skipped"],
      ["durable-ready", "skipped"],
      ["durable-lead", "skipped"],
    ]);
    expect(row(both, "durable-env").detail).toContain("are both set");
    const half = await durableFindings({ ctx: context(onUrl("https://x.example", undefined)) });
    expect(row(half, "durable-env").detail).toBe("COLLIE_DURABLE_URL is set without COLLIE_DURABLE_TOKEN; the durable agent refuses a caller with no token");
  });

  test("on the socket transport the url and token rows are skipped with the reason", async () => {
    const findings = await durableFindings({ ctx: context({ COLLIE_MUX: "durable", COLLIE_DURABLE_SOCKET: "/nonexistent/durable/d.sock" }), platform: "linux" });
    expect(row(findings, "durable-url")).toMatchObject({ status: "skipped", detail: "this peer uses the socket, and COLLIE_DURABLE_URL is not set" });
    expect(row(findings, "durable-token")).toMatchObject({ status: "skipped" });
    expect(row(findings, "durable-socket").status).toBe("error");
  });
});

describe("doctor durable on Windows (a fake platform, so the rows are proved on every host)", () => {
  const socketEnv = { COLLIE_MUX: "durable", COLLIE_DURABLE_SOCKET: "C:\\run\\d.sock" };

  test("a socket path fails the env row with the sentence the boot line prints, and every socket row skips with the reason", async () => {
    const findings = await durableFindings({ ctx: context(socketEnv), platform: "win32" });
    expect(rows(findings)).toEqual([
      ["durable-env", "error"],
      ["durable-socket", "skipped"],
      ["durable-url", "skipped"],
      ["durable-token", "skipped"],
      ["durable-hello", "skipped"],
      ["durable-ready", "skipped"],
      ["durable-lead", "skipped"],
    ]);
    expect(row(findings, "durable-env").detail).toBe("the private socket transport is not available on Windows; set COLLIE_DURABLE_URL and COLLIE_DURABLE_TOKEN instead");
    expect(row(findings, "durable-env").remedy).toContain("set COLLIE_DURABLE_URL and COLLIE_DURABLE_TOKEN");
    expect(row(findings, "durable-socket").detail).toBe("Windows has no socket transport");
  });

  test("nothing set points at the URL and the token only", async () => {
    const findings = await durableFindings({ ctx: context({ COLLIE_MUX: "durable" }), platform: "win32" });
    expect(row(findings, "durable-env").remedy).toContain("COLLIE_DURABLE_URL and COLLIE_DURABLE_TOKEN");
    expect(row(findings, "durable-env").remedy).not.toContain("absolute path");
  });

  test("the URL with its token reads the same on Windows as anywhere", async () => {
    const token = testToken();
    const program = await startHttp(token);
    const findings = await durableFindings({ ctx: context(onUrl(program.url, token)), platform: "win32" });
    expect(row(findings, "durable-env").status).toBe("ok");
    expect(row(findings, "durable-hello").status).toBe("ok");
  });
});

// M50 spec 14: a durable peer whose lead is below 1.21.0 names it. The release is the one the running
// bridge heard in `X-Crew-Lead-Release` and wrote into its runtime marker; doctor reads the marker.
describe("doctor durable: the lead's release (durable-lead)", () => {
  // A token that breaks its rule: the six program rows stop before any dial, and the lead row is still read.
  const quiet = () => context(onUrl("https://member.example.workers.dev", testToken().slice(0, 20)));
  const BASE = { bootedAt: 1, pid: 2, mode: "peer", roster: [] };
  const marker = (leadRelease?: string) => parseMarker(JSON.stringify(leadRelease === undefined ? BASE : { ...BASE, leadRelease }));

  test("a peer whose lead is below 1.21.0 warns with the sentence, and says what to do", async () => {
    const lead = row(await durableFindings({ ctx: quiet(), crew: { mode: "peer", marker: marker("1.20.2") } }), "durable-lead");
    expect(lead.status).toBe("warn");
    expect(lead.detail).toBe("the lead is 1.20.2; it shows durable panes without the question card and its Terminal tab polls; update the lead");
    expect(lead.remedy).toBe("update the lead to 1.21.0 or later");
  });

  test("a peer whose lead is 1.21.0 or later is ok", async () => {
    for (const release of ["1.21.0", "1.22.3", "2.0.0"]) {
      const lead = row(await durableFindings({ ctx: quiet(), crew: { mode: "peer", marker: marker(release) } }), "durable-lead");
      expect([release, lead.status]).toEqual([release, "ok"]);
    }
  });

  test("skipped with the reason: a solo machine, the lead itself, and a lead that stated no release (a dev build)", async () => {
    const solo = row(await durableFindings({ ctx: quiet() }), "durable-lead");
    expect([solo.status, solo.detail]).toEqual(["skipped", "this machine is not in a crew, so there is no lead to show its panes"]);
    const lead = row(await durableFindings({ ctx: quiet(), crew: { mode: "lead", marker: marker() } }), "durable-lead");
    expect(lead.status).toBe("skipped");
    expect(lead.detail).toContain("this machine is the lead");
    for (const read of [marker(), null]) {
      const dev = row(await durableFindings({ ctx: quiet(), crew: { mode: "peer", marker: read } }), "durable-lead");
      expect(dev.status).toBe("skipped");
      expect(dev.detail).toContain("dev build");
    }
  });
});

// ── M55: one block per program in sources.json ───────────────────────────────

describe("doctor sources", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function configDir(sources: readonly Record<string, string>[], mode = 0o600): string {
    const dir = mkdtempSync(join(tmpdir(), "collie-doctor-sources-"));
    dirs.push(dir);
    writeFileSync(join(dir, "sources.json"), JSON.stringify(sources), { mode });
    return dir;
  }

  test("no sources.json: no rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-doctor-sources-"));
    dirs.push(dir);
    expect(await sourcesFindings({ ctx: context({}, { configDir: dir }) })).toEqual([]);
  });

  /**
   * The rows for one cloud program (an https URL) and one desk program (a socket), as `platform` reads
   * them. The cloud block and the file row are the same everywhere. A socket program differs: off Windows
   * the env row is ok and the socket row carries the failure (nothing is at that path); on Windows there is
   * no socket transport, so the env row carries it and the socket row is skipped. The Windows branch needs
   * no socket probe, so a pinned "win32" proves it on every host, and a Windows host runs it for real.
   */
  async function sourceRows(platform: NodeJS.Platform): Promise<void> {
    const windows = platform === "win32";
    const token = testToken();
    const program = await startHttp(token);
    const dir = configDir([
      { name: "cloud", kind: "durable", url: program.url, token },
      { name: "desk", kind: "durable", socket: "/nonexistent/durable/desk.sock" },
    ]);
    const findings = await sourcesFindings({ ctx: context({}, { configDir: dir }), platform, mode: () => 0o600 });
    expect(rows(findings)).toEqual([
      ["sources", "ok"],
      ["durable-env:cloud", "ok"],
      ["durable-socket:cloud", "skipped"],
      ["durable-url:cloud", "ok"],
      ["durable-token:cloud", "ok"],
      ["durable-hello:cloud", "ok"],
      ["durable-ready:cloud", "ok"],
      ["durable-env:desk", windows ? "error" : "ok"],
      ["durable-socket:desk", windows ? "skipped" : "error"],
      ["durable-url:desk", "skipped"],
      ["durable-token:desk", "skipped"],
      ["durable-hello:desk", "skipped"],
      ["durable-ready:desk", "skipped"],
    ]);
    // Windows reads no file mode (NTFS has none), so the row carries no mode there.
    expect(row(findings, "sources").detail).toBe(`2 durable agents in ${join(dir, "sources.json")}${windows ? "" : ", mode 0600"}`);
    if (windows) {
      expect(row(findings, "durable-env:desk").detail).toBe(WINDOWS_NO_SOCKET);
      expect(row(findings, "durable-env:desk").remedy).toContain('"socket" of "desk"');
      expect(row(findings, "durable-socket:desk").detail).toBe("Windows has no socket transport");
    } else {
      expect(row(findings, "durable-env:desk").detail).toBe("transport: private socket · socket=/nonexistent/durable/desk.sock");
      expect(row(findings, "durable-socket:desk").remedy).toContain('"socket" of "desk"');
      expect(row(findings, "durable-url:desk").detail).toBe('this durable agent uses a socket, and "url" of "desk" is not set');
    }
    expect(printed(findings)).not.toContain(token);
  }

  test("one row for the file, then one block of six rows per program, each named for it, and never the token", async () => {
    await sourceRows(HOST.platform);
  });

  test("the same rows when the platform is Windows, on whatever host this runs", async () => {
    await sourceRows("win32");
  });

  test("a file group or others can read is an error, because it may hold a token", async () => {
    const dir = configDir([{ name: "desk", kind: "durable", socket: "/nonexistent/d.sock" }]);
    const file = row(await sourcesFindings({ ctx: context({}, { configDir: dir }), platform: "linux", mode: () => 0o644 }), "sources");
    expect(file.status).toBe("error");
    expect(file.detail).toContain("mode 0644");
    expect(file.remedy).toBe(`run \`chmod 600 ${join(dir, "sources.json")}\``);
  });

  test("a bad file is one error row naming the entry and the field", async () => {
    const dir = configDir([{ name: "desk", kind: "durable", socket: "/s", url: "https://x.example", token: testToken() }]);
    const findings = await sourcesFindings({ ctx: context({}, { configDir: dir }) });
    expect(rows(findings)).toEqual([["sources", "error"]]);
    expect(row(findings, "sources").detail).toContain('entry "desk": set "socket" or "url", not both');
  });

  test("with programs off one skipped row says so, and the file is not read", async () => {
    const dir = configDir([{ name: "desk", kind: "durable", socket: "/s", url: "https://x.example", token: testToken() }]);
    const findings = await sourcesFindings({ ctx: context({ COLLIE_PROGRAMS: "off" }, { configDir: dir }), crew: { mode: "solo", marker: null } });
    expect(rows(findings)).toEqual([["sources", "skipped"]]);
    expect(row(findings, "sources").detail).toBe("durable agents are off (COLLIE_PROGRAMS=off)");
  });

  test("the lead row follows the blocks when the verb asks for it", async () => {
    const dir = configDir([{ name: "desk", kind: "durable", socket: "/nonexistent/d.sock" }]);
    const findings = await sourcesFindings({ ctx: context({}, { configDir: dir }), platform: "linux", mode: () => 0o600, crew: { mode: "solo", marker: null } });
    expect(findings.at(-1)?.check).toBe("durable-lead");
  });
});
