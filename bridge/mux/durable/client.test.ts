import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  DURABLE_SOCKET_ENV,
  DurableOutcomeUnknown,
  DurableSocketClient,
  DurableUnreachable,
  resolveSocketPath,
  SOCKET_NOT_PRIVATE,
  SOCKET_PATH_MAX_BYTES,
  socketAccessProblem,
  socketFault,
  SYSTEM_PROBE,
  type DurableGet,
  type SocketFacts,
  type SocketProbe,
} from "./client.ts";
import { FakeDurableProgram, SOCKET_ONLY_SKIP } from "./fixture.ts";

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

// Socket only: the owner, mode and links of a Unix socket. Windows has no socket transport (WIRE.md section 1A).
describe.skipIf(SOCKET_ONLY_SKIP)("the privacy check (WIRE.md section 1A)", () => {
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
      expect(await socketAccessProblem(program.socketPath)).toBe(`${SOCKET_NOT_PRIVATE}: the socket has mode ${(mode & 0o777).toString(8).padStart(4, "0")}, not 0600`);
      const before = program.requests.length;
      const err = await refusal(new DurableSocketClient(program.socketPath).get(hello));
      expect(err.detail.startsWith(`${SOCKET_NOT_PRIVATE}: `)).toBe(true);
      expect(program.requests.length).toBe(before);
    }
  });

  test("a socket owned by another user is not private", async () => {
    const program = await startProgram();
    const otherUser: SocketProbe = { lstat: SYSTEM_PROBE.lstat, uid: () => (SYSTEM_PROBE.uid() ?? 0) + 1 };
    // The walk meets the socket's own folder first, and it is not that user's folder either.
    expect(await socketAccessProblem(program.socketPath, otherUser)).toContain(`${SOCKET_NOT_PRIVATE}: the socket's folder`);
    const err = await refusal(new DurableSocketClient(program.socketPath, otherUser).get(hello));
    expect(err.detail).toContain("belongs to user");
  });

  test("a platform with no uid cannot show the owner, so it fails closed", async () => {
    const program = await startProgram();
    const noUid: SocketProbe = { lstat: SYSTEM_PROBE.lstat, uid: () => undefined };
    expect(await socketAccessProblem(program.socketPath, noUid)).toBe(`${SOCKET_NOT_PRIVATE}: this platform shows no file owner`);
    expect(await socketFault(program.socketPath, noUid)).toEqual({ kind: "no-uid" });
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
      expect(await socketAccessProblem(path)).toStartWith(`${SOCKET_NOT_PRIVATE}: `);
    }
    expect(await socketFault(link)).toEqual({ kind: "symlink", path: link });
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
    expect(await socketFault(program.socketPath, { lstat: SYSTEM_PROBE.lstat, uid: () => uid + 1 })).toEqual({
      kind: "parent-wrong-owner",
      path: dirname(program.socketPath),
      owner: uid,
      uid: uid + 1,
    });
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

// Socket only: the folders on the way to a Unix socket. Windows has no socket transport (WIRE.md section 1A).
describe.skipIf(SOCKET_ONLY_SKIP)("the path walk (WIRE.md section 1A)", () => {
  const ME = 1000;

  /** One `lstat` answer: a directory, a socket or a link, with its owner and mode. */
  function entry(kind: "dir" | "socket" | "link", uid: number, mode: number): SocketFacts {
    return {
      isSocket: () => kind === "socket",
      isDirectory: () => kind === "dir",
      isSymbolicLink: () => kind === "link",
      uid,
      mode,
    };
  }

  /** A probe over a made-up tree, so the root and sticky cases need no root. */
  function tree(entries: Record<string, SocketFacts>): SocketProbe {
    return {
      uid: () => ME,
      lstat: async (path) => {
        const found = entries[path];
        if (found === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
        return found;
      },
    };
  }

  /** The good layout: `/` and `/run` root's, `/run/me` mine 0700, the socket mine 0600. */
  function good() {
    return {
      "/": entry("dir", 0, 0o755),
      "/run": entry("dir", 0, 0o755),
      "/run/me": entry("dir", ME, 0o700),
      "/run/me/d.sock": entry("socket", ME, 0o600),
    } satisfies Record<string, SocketFacts>;
  }

  test("a path of private folders under root's folders passes", async () => {
    expect(await socketFault("/run/me/d.sock", tree(good()))).toBeNull();
  });

  test("a sticky folder such as /tmp is allowed above the parent, never as the parent", async () => {
    const above = { "/": entry("dir", 0, 0o755), "/tmp": entry("dir", 0, 0o1777), "/tmp/me": entry("dir", ME, 0o700), "/tmp/me/d.sock": entry("socket", ME, 0o600) };
    expect(await socketFault("/tmp/me/d.sock", tree(above))).toBeNull();
    const parent = { "/": entry("dir", 0, 0o755), "/tmp": entry("dir", 0, 0o1777), "/tmp/d.sock": entry("socket", ME, 0o600) };
    expect(await socketFault("/tmp/d.sock", tree(parent))).toEqual({ kind: "parent-wrong-owner", path: "/tmp", owner: 0, uid: ME });
  });

  test("the parent must be this user's own with mode 0700", async () => {
    const open = { ...good(), "/run/me": entry("dir", ME, 0o755) };
    expect(await socketFault("/run/me/d.sock", tree(open))).toEqual({ kind: "parent-open-mode", path: "/run/me", mode: 0o755 });
    const rooted = { ...good(), "/run/me": entry("dir", 0, 0o700) };
    expect(await socketFault("/run/me/d.sock", tree(rooted))).toEqual({ kind: "parent-wrong-owner", path: "/run/me", owner: 0, uid: ME });
    const narrow = { ...good(), "/run/me": entry("dir", ME, 0o500) };
    expect(await socketFault("/run/me/d.sock", tree(narrow))).toEqual({ kind: "parent-open-mode", path: "/run/me", mode: 0o500 });
  });

  test("an ancestor of another user passes when no one else can write to it; the owner is not checked", async () => {
    // Under `PrivateTmp=yes` the root-owned `/` and `/run` show up as user 65534.
    const stranger = { ...good(), "/": entry("dir", 65534, 0o755), "/run": entry("dir", 4242, 0o755) };
    expect(await socketFault("/run/me/d.sock", tree(stranger))).toBeNull();
  });

  test("an ancestor that group or others can write to is refused unless it is sticky", async () => {
    const writable = { ...good(), "/run": entry("dir", 0, 0o775) };
    expect(await socketFault("/run/me/d.sock", tree(writable))).toEqual({ kind: "ancestor-open-mode", path: "/run", mode: 0o775 });
    const open = { ...good(), "/run": entry("dir", 4242, 0o777) };
    expect(await socketFault("/run/me/d.sock", tree(open))).toEqual({ kind: "ancestor-open-mode", path: "/run", mode: 0o777 });
    expect(await socketAccessProblem("/run/me/d.sock", tree(open))).toBe(
      `${SOCKET_NOT_PRIVATE}: /run has mode 0777, so group or others can write to it`,
    );
    const sticky = { ...good(), "/run": entry("dir", 4242, 0o1777) };
    expect(await socketFault("/run/me/d.sock", tree(sticky))).toBeNull();
  });

  test("a symlink anywhere in the path is refused, by name", async () => {
    const linked = { ...good(), "/run": entry("link", 0, 0o777) };
    expect(await socketFault("/run/me/d.sock", tree(linked))).toEqual({ kind: "symlink", path: "/run" });
    expect(await socketAccessProblem("/run/me/d.sock", tree(linked))).toBe(`${SOCKET_NOT_PRIVATE}: /run is a symlink`);
    const leaf = { ...good(), "/run/me/d.sock": entry("link", ME, 0o777) };
    expect(await socketFault("/run/me/d.sock", tree(leaf))).toEqual({ kind: "symlink", path: "/run/me/d.sock" });
  });

  test("a file where a folder should be is refused", async () => {
    const file = { ...good(), "/run": entry("socket", 0, 0o755) };
    expect(await socketFault("/run/me/d.sock", tree(file))).toEqual({ kind: "not-a-directory", path: "/run" });
  });

  test("a real folder with a symlink in its path is refused, and nothing is dialled", async () => {
    const program = await startProgram();
    const dir = mkdtempSync(join(tmpdir(), "collie-durable-walk-"));
    scratch.push(dir);
    const via = join(dir, "via");
    symlinkSync(dirname(program.socketPath), via);
    const path = join(via, basename(program.socketPath));
    expect(await socketFault(path)).toEqual({ kind: "symlink", path: via });
    const before = program.requests.length;
    const err = await refusal(new DurableSocketClient(path).get(hello));
    expect(err.detail).toBe(`${SOCKET_NOT_PRIVATE}: ${via} is a symlink`);
    expect(program.requests.length).toBe(before);
  });

  test("a real socket folder opened to others is refused by name", async () => {
    const program = await startProgram();
    const folder = dirname(program.socketPath);
    chmodSync(folder, 0o755);
    try {
      expect(await socketAccessProblem(program.socketPath)).toBe(`${SOCKET_NOT_PRIVATE}: the socket's folder ${folder} has mode 0755, not 0700`);
    } finally {
      chmodSync(folder, 0o700);
    }
  });

  test("the path cap is 103 bytes, the macOS limit", () => {
    expect(SOCKET_PATH_MAX_BYTES).toBe(103);
    expect(resolveSocketPath(`/${"d".repeat(102)}`).ok).toBe(true);
    expect(resolveSocketPath(`/${"d".repeat(103)}`).ok).toBe(false);
  });
});

// Socket only: the socket client dialling a Unix socket. Windows has no socket transport (WIRE.md section 1A).
describe.skipIf(SOCKET_ONLY_SKIP)("the request", () => {
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

  test("the deadline covers the whole read: headers on time and a body that trickles still end the call", async () => {
    const program = await startProgram();
    // Headers at once, then one byte every 20 ms, forever.
    program.override = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await Bun.sleep(20);
            controller.enqueue(new Uint8Array([0x20]));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    const started = Date.now();
    const err = await refusal(new DurableSocketClient(program.socketPath).get({ ...hello, timeoutMs: 150 }));
    expect(err.detail).toBe("no answer within 150ms");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test("a body that never ends is cut at the byte cap while it streams, not after", async () => {
    const program = await startProgram();
    // Bun 1.3.14 keeps pulling the body after the client has gone, at hundreds of MB a second, so the
    // body stops at four times the bound: such a runtime fails here instead of exhausting the machine.
    // The bound is what proves the cut happens while streaming; keep it below the ceiling.
    const bound = 16 * 1024 * 64;
    const ceiling = 4 * bound;
    let sent = 0;
    program.override = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= ceiling) {
              controller.close();
              return;
            }
            sent += 1024;
            controller.enqueue(new Uint8Array(1024));
          },
        }),
      );
    const err = await refusal(new DurableSocketClient(program.socketPath).get({ ...hello, timeoutMs: 5000 }));
    expect(err.detail).toBe("too-large");
    // The program stopped being read soon after the cap, long before the ceiling.
    expect(sent).toBeLessThan(bound);
  });

  test("a POST whose reply trickles past the deadline has an unknown outcome", async () => {
    const program = await startProgram();
    program.override = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await Bun.sleep(20);
            controller.enqueue(new Uint8Array([0x20]));
          },
        }),
      );
    const client = new DurableSocketClient(program.socketPath);
    const posted = client.post({ path: "/pane/p/abort", version: 1, body: { requestId: "r" }, timeoutMs: 150, maxBytes: 16 * 1024 });
    await expect(posted).rejects.toBeInstanceOf(DurableOutcomeUnknown);
    await expect(posted).rejects.toMatchObject({ detail: "no answer within 150ms" });
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
