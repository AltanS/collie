import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { api, type Dial } from "./client.ts";
import type { SessionEvent } from "../sdk/core/types.ts";

const made: string[] = [];
/** Remove every temp dir this file made. Each test file calls it in afterAll. */
export const cleanup = () => made.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
export const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "dm-test-"));
  made.push(dir);
  return dir;
};

export async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export const pane = async (d: Dial, id: string) => (await api.snapshot(d)).body.panes.find((p) => p.id === id);
/** Every event of a pane the way a reader gets them: from 0, and again at once while a reply says `more`. */
export async function allEvents(d: Dial, id: string): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for (let after = 0; ; ) {
    const r = (await api.events(d, id, after)).body;
    out.push(...r.events);
    if (!r.more) return out;
    after = r.next;
  }
}
export const firstAsk = async (d: Dial, id: string) => (await pane(d, id))?.openAsks[0];
export const openAsks = async (d: Dial, id: string) => (await pane(d, id))?.openAsks ?? [];

export type Child = ReturnType<typeof Bun.spawn>;
/** Start the real app.ts as a child process with its data in `dir`, and wait until its snapshot answers (503 while it shows its panes). */
export async function bootApp(d: Dial, dir: string, env: Record<string, string> = {}): Promise<Child> {
  const child = Bun.spawn(["bun", fileURLToPath(new URL("../app.ts", import.meta.url))], {
    env: { ...process.env, COLLIE_DURABLE_SOCKET: d.socket, DM_DATA: dir, DM_STEP_MS: "0", REAL_MODEL: "", ...env },
    stdout: "ignore",
    stderr: "inherit",
  });
  await waitFor("app up", async () => {
    try {
      return (await api.snapshot(d)).status === 200;
    } catch {
      return false;
    }
  });
  return child;
}
export async function killApp(child: Child, signal: "SIGKILL" | "SIGTERM" = "SIGKILL") {
  child.kill(signal);
  await child.exited;
}

/** Run tests/dial-child.ts as a child of this process (so a descendant of whoever hosts the SDK here). `via` wraps the command. */
export async function dialFrom(
  socket: string,
  method: string,
  path: string,
  body?: unknown,
  via: string[] = [],
): Promise<{ status: number; code?: string }> {
  const child = Bun.spawn([...via, "bun", fileURLToPath(new URL("./dial-child.ts", import.meta.url))], {
    env: { ...process.env, DM_SOCK: socket, DM_METHOD: method, DM_PATH: path, ...(body === undefined ? {} : { DM_BODY: JSON.stringify(body) }) },
    stdout: "pipe",
    stderr: "inherit",
  });
  const out = await new Response(child.stdout as ReadableStream).text();
  await child.exited;
  return JSON.parse(out);
}
