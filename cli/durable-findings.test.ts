import { afterEach, describe, expect, test } from "bun:test";

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
    ]);
    expect(row(findings, "durable-url").detail).toContain("· https ·");
    expect(row(findings, "durable-token").detail).toBe("COLLIE_DURABLE_TOKEN is 20 bytes; it must be at least 32");
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
    const both = await durableFindings({ ctx: context({ COLLIE_MUX: "durable", COLLIE_DURABLE_SOCKET: "/run/user/1000/d.sock", COLLIE_DURABLE_URL: "https://x.example", COLLIE_DURABLE_TOKEN: testToken() }) });
    expect(rows(both)).toEqual([
      ["durable-env", "error"],
      ["durable-socket", "skipped"],
      ["durable-url", "skipped"],
      ["durable-token", "skipped"],
      ["durable-hello", "skipped"],
      ["durable-ready", "skipped"],
    ]);
    expect(row(both, "durable-env").detail).toContain("are both set");
    const half = await durableFindings({ ctx: context(onUrl("https://x.example", undefined)) });
    expect(row(half, "durable-env").detail).toBe("COLLIE_DURABLE_URL is set without COLLIE_DURABLE_TOKEN; the program refuses a caller with no token");
  });

  test("on the socket transport the url and token rows are skipped with the reason", async () => {
    const findings = await durableFindings({ ctx: context({ COLLIE_MUX: "durable", COLLIE_DURABLE_SOCKET: "/nonexistent/durable/d.sock" }) });
    expect(row(findings, "durable-url")).toMatchObject({ status: "skipped", detail: "this peer uses the socket, and COLLIE_DURABLE_URL is not set" });
    expect(row(findings, "durable-token")).toMatchObject({ status: "skipped" });
    expect(row(findings, "durable-socket").status).toBe("error");
  });
});
