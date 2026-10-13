import { afterEach, describe, expect, test } from "bun:test";

import { parseMarker } from "../bridge/crew/staleness.ts";
import { FakeDurableProgram, testToken } from "../bridge/mux/durable/fixture.ts";
import { durableFindings } from "./durable-findings.ts";
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
    expect(hello.detail).toBe("the program refused the token: token-refused: the program answered 401");
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
    expect(row(half, "durable-env").detail).toBe("COLLIE_DURABLE_URL is set without COLLIE_DURABLE_TOKEN; the program refuses a caller with no token");
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
