// The SDK's entries (M55 spec 03, packages/durable-sdk/src since spec 10): the core and the Bun and Node entries import
// nothing from Pi, the Pi entry imports nothing from the example, the Node entry runs on Node itself, and the caps a
// program names are the whole list.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { api, type Dial } from "./client.ts";
import { ALL_CAPS, createCore } from "../../../packages/durable-sdk/src/core/index.ts";
import { openCollie } from "../../../packages/durable-sdk/src/index.ts";
import { summaryOf } from "../../../packages/durable-sdk/src/pi/index.ts";
import { cleanup, tmp, waitFor } from "./util.ts";

afterAll(cleanup);

const SDK = new URL("../../../packages/durable-sdk/src/", import.meta.url).pathname;

/** Every .ts file under a folder, as paths relative to src/. */
function filesOf(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesOf(path);
    return name.endsWith(".ts") ? [relative(SDK, path)] : [];
  });
}

/** The module names a file imports or re-exports, a dynamic import with options (`{ with: { type: "json" } }`) included. */
function importsOf(file: string): string[] {
  const code = readFileSync(join(SDK, file), "utf8");
  return [...code.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+"([^"]+)"|import\(\s*"([^"]+)"\s*[,)]/g)].map((m) => (m[1] ?? m[2])!);
}

describe("the SDK split", () => {
  // The allowlist per package name (M66): Pi only in src/pi/ and src/durable-harness/; durable-harness and @workflow/*
  // only in the one World port, so a beta that moves an API moves one file.
  const PI = /^@(earendil-works|mariozechner)\//;
  const HARNESS = /^(durable-harness|@workflow\/)/;
  const piAllowed = (file: string) => file.startsWith("pi/") || file.startsWith("durable-harness/");
  const harnessAllowed = (file: string) => file === "durable-harness/world-port.ts";

  test("no pi import: no file in src/ outside src/pi and src/durable-harness imports Pi Durable or another @earendil-works or @mariozechner package", () => {
    const outside = filesOf(SDK).filter((file) => !piAllowed(file));
    expect(outside).toContain("core/index.ts");
    for (const file of outside) {
      for (const name of importsOf(file)) expect([file, name]).toEqual([file, expect.not.stringMatching(PI)]);
    }
  });

  test("durable-harness and @workflow/* are imported by src/durable-harness/world-port.ts and no other file", () => {
    const files = filesOf(SDK);
    expect(files).toContain("durable-harness/world-port.ts");
    for (const file of files.filter((f) => !harnessAllowed(f))) {
      for (const name of importsOf(file)) expect([file, name]).toEqual([file, expect.not.stringMatching(HARNESS)]);
    }
    expect(importsOf("durable-harness/world-port.ts").filter((name) => HARNESS.test(name)).sort()).toEqual(["@workflow/world", "durable-harness", "durable-harness/package.json", "durable-harness/pi-durable", "durable-harness/pi-durable"]);
  });

  test("no pi import from the example either: src/pi imports Pi and src/ only, never ../../ (the example's script)", () => {
    for (const file of filesOf(join(SDK, "pi"))) {
      for (const name of importsOf(file)) expect([file, name]).toEqual([file, expect.stringMatching(/^(@earendil-works\/|\.\.\/core\/|\.\/)/)]);
    }
  });

  test("src/durable-harness imports Pi, the World port and src/ only, never ../../ (an example)", () => {
    for (const file of filesOf(join(SDK, "durable-harness"))) {
      for (const name of importsOf(file)) expect([file, name]).toEqual([file, expect.stringMatching(/^(@earendil-works\/|durable-harness|@workflow\/|\.\.\/(core|pi)\/|\.\/)/)]);
    }
  });

  test("the Node entry and what it loads import nothing of Bun", () => {
    for (const file of ["node/index.ts", "open.ts", "http.ts", "socket.ts", ...filesOf(join(SDK, "core"))]) {
      for (const name of importsOf(file)) expect([file, name]).toEqual([file, expect.not.stringMatching(/^bun(:|$)/)]);
      expect([file, /\bBun\.[a-z]/.test(readFileSync(join(SDK, file), "utf8"))]).toEqual([file, false]);
    }
  });
});

describe("caps a program names", () => {
  const capsOf = async (caps?: Parameters<typeof createCore>[0]["caps"]) => {
    const core = createCore({ hostName: "c", ...(caps === undefined ? {} : { caps }) });
    return (await api.hello({ handler: (r) => core.handle(r) })).body.caps;
  };

  test("caps: { asks: true } is enough: every cap it does not name is false, as on the wire", async () => {
    expect(await capsOf({ asks: true })).toEqual({ asks: true, starters: false, send: false, steer: false, abort: false, rename: false, close: false, actions: false, history: false, reopen: false, terminal: false });
  });

  test("caps left out is everything on, and ALL_CAPS with one false turns that one off", async () => {
    expect(await capsOf()).toMatchObject({ asks: true, send: true, steer: true, history: false, terminal: false });
    expect(await capsOf({ ...ALL_CAPS, steer: false })).toMatchObject({ asks: true, send: true, steer: false, history: true });
  });
});

describe("the default tool summary", () => {
  test("one text argument reads as itself, more arguments as name(key: value, ...), cut at 200 characters", () => {
    expect(summaryOf({ note: "Order 5521 was charged twice." }, "write_note")).toBe("Order 5521 was charged twice.");
    expect(summaryOf({ order: "5521", amount: 40 }, "refund")).toBe('refund(order: "5521", amount: 40)');
    expect(summaryOf({ a: 1, b: "x".repeat(400) }, "big")).toHaveLength(203);
    expect(summaryOf([1, 2])).toBe("[1,2]");
  });
});

describe("closing the Bun server", () => {
  test("close() lets the reply in flight go out before it cuts the connection", async () => {
    const socket = join(tmp(), "run", "s.sock");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const collie = await openCollie({ socket, hostName: "c", callerCheck: "off", hooks: { onSend: () => gate } });
    collie.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "x" });
    collie.ready();
    const d: Dial = { socket, version: 1 };
    const sent = api.send(d, "p", "hello");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const closing = collie.close();
    release();
    expect((await sent).body).toEqual({ ok: true });
    await closing;
  });
});

const NODE = spawnSync("node", ["--version"], { encoding: "utf8" });
const nodeMajor = NODE.status === 0 ? Number(/^v(\d+)/.exec(NODE.stdout)?.[1] ?? 0) : 0;

describe("the Node entry", () => {
  test.skipIf(nodeMajor < 23)("runs on Node itself: listens on the private socket, warns once, and a requireApproval round trip lands", async () => {
    const socket = join(tmp(), "run", "s.sock");
    const child = spawn("node", [new URL("./node-child.ts", import.meta.url).pathname], { env: { ...process.env, DM_SOCK: socket }, stdio: ["ignore", "pipe", "pipe"] });
    const out: string[] = [];
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => out.push(...chunk.split("\n").filter(Boolean)));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
    try {
      const listening = JSON.parse(await waitFor(`node child listening (${err})`, () => out.find((line) => line.includes("listening"))));
      expect(listening.warned).toHaveLength(1);
      expect(listening.warned[0]).toContain("descendant check is off");
      expect((statSync(socket).mode & 0o777).toString(8)).toBe("600");
      const d: Dial = { socket, version: 1 };
      const ask = await waitFor("the ask", async () => (await api.snapshot(d)).body.panes[0]?.openAsks[0]);
      expect(ask).toMatchObject({ title: "refund wants to run", tool: { name: "refund", summary: 'refund(order: "5521", amount: 40)' } });
      expect((await api.answer(d, "p", ask.id, "allow")).body).toEqual({ result: "taken" });
      const approval = JSON.parse(await waitFor("the approval", () => out.find((line) => line.includes('"approval"'))));
      expect(approval).toEqual({ step: "approval", approved: true, decidedBy: "phone" });
      await waitFor("closed", () => out.find((line) => line.includes("closed")));
      expect(existsSync(socket)).toBe(false);
    } finally {
      child.kill();
    }
  });
});
