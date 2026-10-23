// Protocol edges over the private socket, SDK only. No Pi Durable here. The shared protocol tests are in
// protocol-suite.ts; this file runs them over the socket and adds what only the socket has.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, call } from "./client.ts";
import { openCollie } from "../../../packages/durable-sdk/src/index.ts";
import { protocolSuite } from "./protocol-suite.ts";
import { cleanup, tmp, waitFor } from "./util.ts";

afterAll(cleanup);

protocolSuite({
  name: "over the socket",
  async open({ hostName, caps, hooks, onRename }) {
    const collie = await openCollie({ callerCheck: "off", socket: join(tmp(), "run", "s.sock"), hostName, caps, hooks, onRename });
    return { collie, dial: { socket: collie.address, version: 1 } };
  },
});

/** Every file under a folder, its subfolders included. */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));

describe("no token", () => {
  test("there is no 401: an Authorization header is not read, and no code in the SDK reads a token but the durable-harness route's", async () => {
    const c = await openCollie({ callerCheck: "off", socket: join(tmp(), "tok.sock"), hostName: "t" });
    c.ready();
    const d = { socket: c.address, version: 1 };
    expect((await call({ ...d }, "GET", "/hello", undefined, { authorization: "Bearer nope" })).status).toBe(200);
    expect((await call(d, "GET", "/snapshot", undefined, { authorization: "Bearer nope" })).status).toBe(200);
    await c.close();
    // The one exception is transport 1B (M66): src/durable-harness/route.ts checks a bearer token, and no other file does.
    const files = filesUnder(new URL("../../../packages/durable-sdk/src/", import.meta.url).pathname);
    const token = /bearer|authorization|DM_TOKEN|timingSafeEqual|\btcp:/i;
    expect(files.filter((f) => token.test(readFileSync(f, "utf8"))).map((f) => f.slice(f.indexOf("src/")))).toEqual(["src/durable-harness/route.ts"]);
  });
});

describe("socket mode and path", () => {
  test("the socket is mode 0600 in a directory with mode 0700", async () => {
    const c = await openCollie({ callerCheck: "off", socket: join(tmp(), "run", "m.sock"), hostName: "m" });
    expect(statSync(c.address).mode & 0o777).toBe(0o600);
    expect(statSync(join(c.address, "..")).mode & 0o777).toBe(0o700);
    await c.close();
  });
  test("the path comes from COLLIE_DURABLE_SOCKET when none is passed", async () => {
    const path = join(tmp(), "env.sock");
    process.env.COLLIE_DURABLE_SOCKET = path;
    try {
      const c = await openCollie({ hostName: "e" });
      expect(c.address).toBe(path);
      expect((await api.hello({ socket: path })).status).toBe(200);
      await c.close();
    } finally {
      delete process.env.COLLIE_DURABLE_SOCKET;
    }
    await expect(openCollie({ hostName: "e" })).rejects.toThrow("COLLIE_DURABLE_SOCKET");
  });
  test("a relative path, a path over 103 bytes and a TCP spec are refused", async () => {
    await expect(openCollie({ callerCheck: "off", socket: "relative.sock", hostName: "x" })).rejects.toThrow("absolute");
    await expect(openCollie({ callerCheck: "off", socket: `${tmp()}/${"s".repeat(100)}.sock`, hostName: "x" })).rejects.toThrow("103");
    await expect(openCollie({ callerCheck: "off", socket: "tcp:127.0.0.1:0", hostName: "x" })).rejects.toThrow("absolute");
  });
  test("a clean close removes the socket, and a killed program's stale socket is removed before listening", async () => {
    const path = join(tmp(), "gone.sock");
    const c = await openCollie({ callerCheck: "off", socket: path, hostName: "x" });
    expect(existsSync(path)).toBe(true);
    await c.close();
    expect(existsSync(path)).toBe(false);

    // A program that dies by SIGKILL leaves its socket file behind.
    const child = Bun.spawn(
      ["bun", "-e", `import{createServer}from"node:net";createServer().listen(${JSON.stringify(path)},()=>console.log("up"))`],
      { stdout: "pipe", stderr: "inherit" },
    );
    await waitFor("socket file", () => existsSync(path));
    child.kill("SIGKILL");
    await child.exited;
    expect(existsSync(path)).toBe(true);
    const again = await openCollie({ callerCheck: "off", socket: path, hostName: "x" });
    again.ready();
    expect((await api.hello({ socket: path })).status).toBe(200);
    await again.close();
  });
  test("a file that is not a socket is not deleted, and a directory others can enter is refused", async () => {
    const dir = tmp();
    const file = join(dir, "plain");
    writeFileSync(file, "keep me");
    await expect(openCollie({ callerCheck: "off", socket: file, hostName: "x" })).rejects.toThrow("not a socket");
    expect(readFileSync(file, "utf8")).toBe("keep me");

    const open = join(dir, "open");
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    await expect(openCollie({ callerCheck: "off", socket: join(open, "s.sock"), hostName: "x" })).rejects.toThrow("0700");
  });
});

