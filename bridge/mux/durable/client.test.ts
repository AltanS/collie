import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DURABLE_SOCKET_ENV,
  DurableSocketClient,
  DurableUnreachable,
  resolveSocketPath,
  SOCKET_NOT_PRIVATE,
  SOCKET_PATH_MAX_BYTES,
  socketAccessProblem,
  socketFault,
  SYSTEM_PROBE,
  type DurableGet,
  type SocketProbe,
} from "./client.ts";
import { FakeDurableProgram } from "./fixture.ts";

const programs: FakeDurableProgram[] = [];
const scratch: string[] = [];

async function startProgram(): Promise<FakeDurableProgram> {
  const program = await FakeDurableProgram.start();
  programs.push(program);
  return program;
}

afterEach(async () => {
  for (const program of programs.splice(0)) await program.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const hello: DurableGet = { path: "/hello", version: null, ifNoneMatch: null, timeoutMs: 1000, maxBytes: 16 * 1024 };

/** The rejection of a promise, so a test can read its detail. */
async function refusal(promise: Promise<unknown>): Promise<DurableUnreachable> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof DurableUnreachable) return err;
    throw err;
  }
  throw new Error("the call answered");
}

describe("the socket path", () => {
  test("unset, blank, relative and over-long paths are refused with a detail that names the variable", () => {
    const refused = [undefined, "", "   ", "relative/path.sock", "./s.sock", `/${"d".repeat(SOCKET_PATH_MAX_BYTES)}`];
    for (const configured of refused) {
      const resolved = resolveSocketPath(configured);
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) expect(resolved.detail).toContain(DURABLE_SOCKET_ENV);
    }
  });

  test("an absolute path up to the sun_path limit is accepted", () => {
    expect(resolveSocketPath("/run/user/1000/durable.sock")).toEqual({ ok: true, path: "/run/user/1000/durable.sock" });
    const longest = `/${"d".repeat(SOCKET_PATH_MAX_BYTES - 1)}`;
    expect(resolveSocketPath(longest).ok).toBe(true);
  });

  test("the limit counts bytes: a path of multi-byte characters is over it sooner", () => {
    expect(resolveSocketPath(`/${"あ".repeat(40)}`).ok).toBe(false);
  });

  test("a client with a bad path dials nothing and says why", async () => {
    const err = await refusal(new DurableSocketClient("relative.sock").get(hello));
    expect(err.detail).toBe(`${DURABLE_SOCKET_ENV} must be an absolute path`);
    const unset = await refusal(new DurableSocketClient(undefined).get(hello));
    expect(unset.detail).toBe(`${DURABLE_SOCKET_ENV} is not set`);
  });
});

describe("the privacy check (WIRE.md section 1)", () => {
  test("a socket of mode 0600 owned by this user may be dialled", async () => {
    const program = await startProgram();
    expect(await socketAccessProblem(program.socketPath)).toBeNull();
    const reply = await new DurableSocketClient(program.socketPath).get(hello);
    expect(reply.status).toBe(200);
  });

  test("a socket with any group or other bit is not private, and is not dialled", async () => {
    const program = await startProgram();
    for (const mode of [0o660, 0o606, 0o666, 0o700 | 0o010, 0o755]) {
      chmodSync(program.socketPath, mode);
      expect(await socketAccessProblem(program.socketPath)).toBe(SOCKET_NOT_PRIVATE);
      const before = program.requests.length;
      const err = await refusal(new DurableSocketClient(program.socketPath).get(hello));
      expect(err.detail).toBe(SOCKET_NOT_PRIVATE);
      expect(program.requests.length).toBe(before);
    }
  });

  test("a socket owned by another user is not private", async () => {
    const program = await startProgram();
    const otherUser: SocketProbe = { lstat: SYSTEM_PROBE.lstat, uid: () => (SYSTEM_PROBE.uid() ?? 0) + 1 };
    expect(await socketAccessProblem(program.socketPath, otherUser)).toBe(SOCKET_NOT_PRIVATE);
    const err = await refusal(new DurableSocketClient(program.socketPath, otherUser).get(hello));
    expect(err.detail).toBe(SOCKET_NOT_PRIVATE);
  });

  test("a platform with no uid cannot show the owner, so it fails closed", async () => {
    const program = await startProgram();
    const noUid: SocketProbe = { lstat: SYSTEM_PROBE.lstat, uid: () => undefined };
    expect(await socketAccessProblem(program.socketPath, noUid)).toBe(SOCKET_NOT_PRIVATE);
  });

  test("a regular file, a directory and a symlink to a socket are not sockets", async () => {
    const program = await startProgram();
    const dir = mkdtempSync(join(tmpdir(), "collie-durable-client-"));
    scratch.push(dir);
    const file = join(dir, "file.sock");
    writeFileSync(file, "", { mode: 0o600 });
    const link = join(dir, "link.sock");
    symlinkSync(program.socketPath, link);
    for (const path of [file, dir, link]) {
      expect(await socketAccessProblem(path)).toBe(SOCKET_NOT_PRIVATE);
    }
  });

  test("socketFault names the check a path fails", async () => {
    const program = await startProgram();
    const dir = mkdtempSync(join(tmpdir(), "collie-durable-client-"));
    scratch.push(dir);
    const file = join(dir, "file.sock");
    writeFileSync(file, "", { mode: 0o600 });
    const uid = SYSTEM_PROBE.uid() ?? 0;
    expect(await socketFault(program.socketPath)).toBeNull();
    expect(await socketFault(join(dir, "none.sock"))).toEqual({ kind: "missing" });
    expect(await socketFault(file)).toEqual({ kind: "not-a-socket" });
    expect(await socketFault(program.socketPath, { lstat: SYSTEM_PROBE.lstat, uid: () => undefined })).toEqual({ kind: "no-uid" });
    expect(await socketFault(program.socketPath, { lstat: SYSTEM_PROBE.lstat, uid: () => uid + 1 })).toEqual({ kind: "wrong-owner", owner: uid, uid: uid + 1 });
    chmodSync(program.socketPath, 0o640);
    expect(await socketFault(program.socketPath)).toEqual({ kind: "open-mode", mode: 0o640 });
  });

  test("a missing path is not a privacy problem: nothing is listening yet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-durable-client-"));
    scratch.push(dir);
    const missing = join(dir, "none.sock");
    expect(await socketAccessProblem(missing)).toBe(`no socket at ${missing}`);
    const err = await refusal(new DurableSocketClient(missing).get(hello));
    expect(err.detail).toBe(`no socket at ${missing}`);
  });
});

describe("the request", () => {
  test("the version header and If-None-Match are sent only when asked for", async () => {
    const program = await startProgram();
    const client = new DurableSocketClient(program.socketPath);
    await client.get(hello);
    await client.get({ ...hello, path: "/snapshot", version: 1, ifNoneMatch: '"x-1"' });
    expect(program.requests.map((request) => [request.path, request.version, request.ifNoneMatch])).toEqual([
      ["/session/v1/hello", null, null],
      ["/session/v1/snapshot", "1", '"x-1"'],
    ]);
  });

  test("the ETag header comes back with the reply", async () => {
    const program = await startProgram();
    const client = new DurableSocketClient(program.socketPath);
    const reply = await client.get({ ...hello, path: "/snapshot", version: 1, maxBytes: 4 * 1024 * 1024 });
    expect(reply.etag).toBe(`"${program.epoch}-${String(program.rev)}"`);
    const again = await client.get({ ...hello, path: "/snapshot", version: 1, ifNoneMatch: reply.etag });
    expect(again.status).toBe(304);
    expect(again.text).toBe("");
  });

  test("a reply past the byte cap is cut off and refused as too-large", async () => {
    const program = await startProgram();
    program.override = () => new Response("x".repeat(20_000), { headers: { "content-type": "application/json" } });
    const err = await refusal(new DurableSocketClient(program.socketPath).get(hello));
    expect(err.detail).toBe("too-large");
  });

  test("a reply that streams past the cap without a length is cut off too", async () => {
    const program = await startProgram();
    program.override = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < 40; i += 1) controller.enqueue(new Uint8Array(1024));
            controller.close();
          },
        }),
      );
    const err = await refusal(new DurableSocketClient(program.socketPath).get(hello));
    expect(err.detail).toBe("too-large");
  });

  test("a program that does not answer in time is unreachable, and the call ends", async () => {
    const program = await startProgram();
    program.override = () => new Promise<Response>(() => undefined);
    const started = Date.now();
    const err = await refusal(new DurableSocketClient(program.socketPath).get({ ...hello, timeoutMs: 60 }));
    expect(err.detail).toBe("no answer within 60ms");
    expect(Date.now() - started).toBeLessThan(900);
  });

  test("a program that has gone leaves no socket, and that is the answer", async () => {
    const program = await startProgram();
    const path = program.socketPath;
    await program.close();
    // The program removes its own socket on a clean exit.
    const err = await refusal(new DurableSocketClient(path).get(hello));
    expect(err.detail).toBe(`no socket at ${path}`);
  });
});
