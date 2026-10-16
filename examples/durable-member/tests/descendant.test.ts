// The same-user defence: the SDK refuses answer, send, abort and starter from the program itself and from any
// descendant of it (403 caller-refused), and keeps reads open. Bun gives the peer's pid through the fd of a
// Bun.listen socket (SO_PEERCRED over bun:ffi); the SDK walks the parent links in /proc.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "./client.ts";
import { type Collie, openCollie, type PaneHandle } from "../../../packages/durable-sdk/src/index.ts";
import { peerCredsAvailable, peerOf, relationOf } from "../../../packages/durable-sdk/src/peer.ts";
import { cleanup, dialFrom, tmp, waitFor } from "./util.ts";

let collie: Collie;
let socket: string;
let pane: PaneHandle;
const sent: string[] = [];
let aborts = 0;
let starts = 0;
let held: Promise<unknown>;

beforeAll(async () => {
  socket = join(tmp(), "d.sock");
  collie = await openCollie({ socket, hostName: "t" }); // the default: callerCheck "descendant"
  pane = collie.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "x" });
  pane.onSend((text) => void sent.push(text));
  pane.onAbort(() => void aborts++);
  collie.starters([{ id: "s", label: "S", run: async () => (starts++, { paneId: "p" }) }]);
  held = pane.ask({ id: "a1", kind: "permission", toolCallId: "c1", itemId: "c1", title: "t", options: [{ id: "allow", label: "Allow", effect: "allow" }] });
  held.catch(() => {});
  collie.ready();
});
afterAll(async () => {
  await collie.close();
  cleanup();
});

const turn = async () => (await api.snapshot({ socket, version: 1 })).body.panes[0]!.turnId;
const acts = async (via: string[] = []) => {
  const t = await turn();
  const rid = () => crypto.randomUUID();
  return [
    await dialFrom(socket, "POST", "/pane/p/answer", { requestId: rid(), askId: "a1", revision: 1, answer: { optionId: "allow" } }, via),
    await dialFrom(socket, "POST", "/pane/p/send", { requestId: rid(), turnId: t, text: "hi" }, via),
    await dialFrom(socket, "POST", "/pane/p/abort", { requestId: rid(), turnId: t }, via),
    await dialFrom(socket, "POST", "/starter/s", { requestId: rid() }, via),
  ];
};
const nothingRan = () => {
  expect(sent).toEqual([]);
  expect(aborts).toBe(0);
  expect(starts).toBe(0);
};

describe("descendant check", () => {
  test("Bun gives the peer's credentials through the fd of a Bun.listen socket", async () => {
    expect(peerCredsAvailable()).toBe(true);
    let seen: ReturnType<typeof peerOf>;
    const l = Bun.listen({ unix: join(tmp(), "c.sock"), socket: { open: (s) => void (seen = peerOf((s as unknown as { fd: number }).fd)), data() {} } });
    const c = await Bun.connect({ unix: l.unix!, socket: { data() {}, open() {}, close() {} } });
    await waitFor("peer", () => seen);
    expect(seen).toEqual({ pid: process.pid, uid: process.getuid!(), gid: process.getgid!() });
    c.end();
    l.stop(true);
  });

  test("a descendant of the program is refused answer, send, abort and starter with 403 caller-refused, and still reads", async () => {
    for (const r of await acts()) expect(r).toEqual({ status: 403, code: "caller-refused" });
    nothingRan();
    expect(await dialFrom(socket, "GET", "/hello")).toMatchObject({ status: 200 });
    expect(await dialFrom(socket, "GET", "/snapshot")).toMatchObject({ status: 200 });
    expect(await dialFrom(socket, "GET", "/pane/p/events?after=0&epoch=x")).toMatchObject({ status: 200 });
  });

  test("a grandchild behind a shell is a descendant too", async () => {
    for (const r of await acts(["sh", "-c", '"$0" "$@"; true'])) expect(r).toEqual({ status: 403, code: "caller-refused" }); // the shell stays between
    nothingRan();
  });

  test("the program itself is refused too, and its reads stay open", async () => {
    const d = { socket, version: 1 };
    expect((await api.answer(d, "p", "a1", "allow")).body.code).toBe("caller-refused");
    expect((await api.send(d, "p", "hi")).body.code).toBe("caller-refused");
    expect((await api.abort(d, "p")).body.code).toBe("caller-refused");
    expect((await api.start(d, "s")).body.code).toBe("caller-refused");
    expect((await api.snapshot(d)).status).toBe(200);
    nothingRan();
  });

  test("a process that left the tree (reparented to init) is not a descendant and may act: the limit the README names", async () => {
    const out = join(tmp(), "orphan.json");
    const t = await turn();
    const child = Bun.spawn(["setsid", "-f", "bun", fileURLToPath(new URL("./dial-child.ts", import.meta.url))], {
      env: { ...process.env, DM_SOCK: socket, DM_METHOD: "POST", DM_PATH: "/pane/p/send", DM_BODY: JSON.stringify({ requestId: "orphan-1", turnId: t, text: "from an orphan" }), DM_OUT: out },
    });
    await child.exited;
    await waitFor("orphan reply", () => existsSync(out) && readFileSync(out, "utf8"));
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ status: 200 });
    expect(sent).toEqual(["from an orphan"]);
    sent.length = 0;
    rmSync(out);
  });

  test("relationOf walks the parent links: self, descendant, other, and unknown when the walk breaks", () => {
    const up = new Map([[40, 30], [30, 20], [20, 10], [10, 1], [99, 98]]);
    const parent = (p: number) => up.get(p);
    expect(relationOf(10, 10, parent)).toBe("self");
    expect(relationOf(40, 10, parent)).toBe("descendant");
    expect(relationOf(20, 10, parent)).toBe("descendant");
    expect(relationOf(40, 77, parent)).toBe("other"); // ends at pid 1 without meeting the program
    expect(relationOf(99, 10, parent)).toBe("unknown"); // 98 is gone
    expect(relationOf(5, 10, parent)).toBe("unknown"); // the peer is already gone
    const loop = (p: number) => (p === 1 ? 2 : 1);
    expect(relationOf(3, 10, (p) => loop(p) + 1)).toBe("unknown"); // a loop ends
  });

  test("callerCheck off is the program's own choice, and the README states the limits of the defence", async () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toMatch(/^## The trust model/m);
    expect(readme).toContain("descendant");
    expect(readme).toContain("sandbox");
    expect(readme).toContain("allow-always");
  });
});
