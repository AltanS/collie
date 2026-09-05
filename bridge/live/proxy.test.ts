import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentView } from "../types.ts";
import { OmpLiveProxy } from "./proxy.ts";
import { LIVE_SESSION_HEADER, parseLiveCommand } from "./commands.ts";
import type { LiveDescriptor } from "./types.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "collie-live-"));
  dirs.push(dir);
  const pane: AgentView = {
    paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "Live", workspaceNumber: 1,
    tabId: "t1", agent: "omp", status: "idle", cwd: dir, focused: false,
    agentSession: { kind: "path", value: join(dir, "one.jsonl") },
  };
  const descriptor: LiveDescriptor = {
    version: 1, pid: process.pid, port: 12345, token: "a".repeat(64),
    paneId: pane.paneId, sessionId: "one", sessionRef: pane.agentSession!,
  };
  await Bun.write(join(dir, `${process.pid}.json`), JSON.stringify(descriptor));
  return { proxy: new OmpLiveProxy(dir), pane, dir, descriptor };
}

function getRequest() {
  return new Request("http://localhost/api/pane/w1%3Ap1/live");
}

const requestId = "12345678-1234-1234-1234-123456789abc";

describe("OMP Live session boundary", () => {
  test("a fresh session works before its journal exists, but a raced session switch is refused", async () => {
    const { proxy, pane, dir, descriptor } = await fixture();
    delete pane.agentSession;
    let currentSessionId = descriptor.sessionId;
    const host = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request) {
        if (request.headers.get(LIVE_SESSION_HEADER) !== currentSessionId) {
          return Response.json({ ok: false, error: "Session changed" }, { status: 409 });
        }
        return Response.json({ available: true, phase: "idle", muted: false, transcripts: [] });
      },
    });
    try {
      if (host.port === undefined) throw new Error("No TCP port");
      descriptor.port = host.port;
      await Bun.write(join(dir, `${process.pid}.json`), JSON.stringify(descriptor));
      expect((await (await proxy.handle(getRequest(), pane)).json()).available).toBe(true);
      currentSessionId = "next-session";
      expect((await proxy.handle(getRequest(), pane)).status).toBe(409);
    } finally { await host.stop(true); }
  });

  test("a pane switched to another conversation cannot reach its previous live host", async () => {
    const { proxy, pane } = await fixture();
    const network = spyOn(globalThis, "fetch");
    try {
      pane.agentSession = { kind: "path", value: join(pane.cwd, "another.jsonl") };
      const result = await proxy.handle(getRequest(), pane);
      expect((await result.json()).available).toBe(false);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });

  test("a reused pane belonging to a different harness cannot reach OMP", async () => {
    const { proxy, pane } = await fixture();
    pane.agent = "codex";
    const result = await proxy.handle(getRequest(), pane);
    expect((await result.json()).available).toBe(false);
  });

  test("local credentials and paths never enter the browser response", async () => {
    const { proxy, pane, descriptor } = await fixture();
    const network = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      available: true, phase: "listening", muted: false,
      transcripts: [{ role: "assistant", text: "Connected", final: true, accessToken: "secret" }],
      token: descriptor.token, sessionRef: descriptor.sessionRef, accessToken: "secret",
    }));
    try {
      const result = await proxy.handle(getRequest(), pane);
      expect(await result.json()).toEqual({
        available: true, phase: "listening", muted: false,
        transcripts: [{ role: "assistant", text: "Connected", final: true }],
      });
      expect(result.headers.get("cache-control")).toBe("no-store");
    } finally { network.mockRestore(); }
  });

  test("invalid call commands are refused before local host discovery or network I/O", async () => {
    const { proxy, pane } = await fixture();
    const network = spyOn(globalThis, "fetch");
    try {
      const result = await proxy.handle(new Request(getRequest(), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "offer", requestId, sdp: "not an SDP", url: "https://example.com" }),
      }), pane);
      expect(result.status).toBe(400);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
});

describe("OMP Live command admission", () => {
  test("a stale or missing call lease cannot address call controls", () => {
    expect(parseLiveCommand({ action: "stop" })).toBeNull();
    expect(parseLiveCommand({ action: "stop", requestId: "../other-session" })).toBeNull();
    expect(parseLiveCommand({ action: "mute", requestId, muted: "false" })).toBeNull();
  });

  test("large or non-audio signaling payloads cannot become an unbounded upstream request", () => {
    expect(parseLiveCommand({ action: "offer", requestId, sdp: "v=0" + "a".repeat(65536) })).toBeNull();
    expect(parseLiveCommand({ action: "offer", requestId, sdp: "file:///secret" })).toBeNull();
  });
});
