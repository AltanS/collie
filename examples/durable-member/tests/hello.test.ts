// hello.ts is the README's first run: it puts one question on the wire, prints the answer, and exits.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { api, type Dial } from "./client.ts";
import { cleanup, firstAsk, pane, tmp, waitFor } from "./util.ts";

afterAll(cleanup);

const HELLO = fileURLToPath(new URL("../hello.ts", import.meta.url));

describe("hello.ts", () => {
  test("it is at most 20 lines of program code and imports the SDK core only", () => {
    const code = readFileSync(HELLO, "utf8").split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("//"));
    expect(code.length).toBeLessThanOrEqual(20);
    const imports = code.filter((line) => line.startsWith("import "));
    expect(imports).toEqual(['import { openCollie } from "../../packages/durable-sdk/src/index.ts";']);
  });

  test("one declared cap, one choice ask 'Deploy to staging?' with Yes and No, and the answer ends the program", async () => {
    const socket = join(tmp(), "h.sock");
    const d: Dial = { socket, version: 1 };
    const child = Bun.spawn(["bun", HELLO], { env: { ...process.env, COLLIE_DURABLE_SOCKET: socket }, stdout: "pipe", stderr: "inherit" });
    try {
      const hello = await waitFor("hello up", async () => (await api.hello(d).catch(() => undefined))?.body);
      expect(hello.host.name).toBe("hello");
      expect(Object.entries(hello.caps).filter(([, on]) => on)).toEqual([["asks", true]]);
      const ask = await waitFor("the question", async () => {
        const snap = (await api.snapshot(d).catch(() => undefined))?.body;
        return snap?.panes?.[0] === undefined ? undefined : firstAsk(d, snap.panes[0].id);
      });
      const snap = (await api.snapshot(d)).body;
      expect(snap.panes).toHaveLength(1);
      const target = snap.panes[0]!;
      expect(target.state).toBe("waiting");
      expect(target.openAsks).toHaveLength(1);
      expect(ask).toMatchObject({ kind: "choice", title: "Deploy to staging?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] });
      expect((await api.answerWith(d, target.id, ask.id, { optionIds: ["yes"] })).status).toBe(200);
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout as ReadableStream).text()).toContain("answer: yes");
      expect(await pane(d, target.id).catch(() => undefined)).toBeUndefined(); // the socket is closed
    } finally {
      child.kill();
    }
  }, 15_000);
});
