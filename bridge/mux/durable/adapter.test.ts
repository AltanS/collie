import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";

import { MUX_CAPABILITIES } from "../capabilities.ts";
import { buildMuxRegistry, createMux, MUX_ADAPTERS } from "../registry.ts";
import type { MuxOutcome, MuxSnapshot } from "../types.ts";
import {
  DURABLE_MUX,
  DURABLE_BUDGETS,
  DURABLE_SOCKET_OPTION,
  DurableMux,
  durableMuxFactory,
  FAILURES_TO_UNREACHABLE,
  MIN_SNAPSHOT_GAP_MS,
  STARTING,
  WRITE_TIMEOUT_MS,
} from "./adapter.ts";
import { CAPS } from "./clean.ts";
import { DURABLE_SOCKET_ENV, DurableSocketClient, SOCKET_NOT_PRIVATE } from "./client.ts";
import { FakeDurableClock, FakeDurableProgram, hasHostileChars, hostileText, SOCKET_ONLY_SKIP } from "./fixture.ts";

const programs: FakeDurableProgram[] = [];

interface Rig {
  readonly program: FakeDurableProgram;
  readonly adapter: DurableMux;
  readonly clock: FakeDurableClock;
  /** Move past the 250 ms floor, so the next read goes to the program. */
  tick(): void;
}

async function rig(): Promise<Rig> {
  const program = await FakeDurableProgram.startWire();
  programs.push(program);
  const clock = new FakeDurableClock();
  const adapter = new DurableMux(program.wire(), clock);
  return { program, adapter, clock, tick: () => clock.advance(MIN_SNAPSHOT_GAP_MS) };
}

afterEach(async () => {
  for (const program of programs.splice(0)) await program.close();
});

/** A refusal's reason and detail, or the word `ok`. */
function verdict(outcome: MuxOutcome<MuxSnapshot>): string {
  return outcome.ok ? "ok" : `${outcome.reason}: ${outcome.detail}`;
}

function paths(program: FakeDurableProgram): string[] {
  return program.requests.map((request) => request.path.replace("/session/v1", ""));
}

describe("capabilities", () => {
  test("a durable program declares agentDetection and agentSessionRef, and nothing that needs a screen, a key or a new shell", async () => {
    const { adapter } = await rig();
    const declared = MUX_CAPABILITIES.filter((capability) => adapter.capabilities.supports[capability]);
    expect(declared).toEqual(["agentDetection", "agentSessionRef"]);
    for (const absent of [
      "paneGrid",
      "gridScrollback",
      "typeText",
      "sendKeys",
      "createTab",
      "createSpace",
      "listWorktrees",
      "createWorktree",
      "openWorktree",
      "pushTopologyEvents",
      "pushPaneEvents",
    ] as const) {
      expect(adapter.capabilities.supports[absent]).toBe(false);
    }
  });

  test("the topology latency is the slowest the watch polls", async () => {
    const { adapter } = await rig();
    expect(adapter.capabilities.topologyLatency).toEqual({ kind: "bounded", ms: DURABLE_BUDGETS.socket.idlePollMs });
    expect(adapter.capabilities.spaces).toBe("many");
  });

  test("every verb it lacks answers unsupported, names its capability, and touches no socket", async () => {
    const { adapter, program } = await rig();
    const answers = [
      ["paneGrid", await adapter.readGrid("conv-01", { scope: "viewport", lines: 10, styling: "strip" })],
      ["typeText", await adapter.typeText("conv-01", "hi")],
      ["sendKeys", await adapter.sendKeys("conv-01", ["Enter"])],
      ["renamePane", await adapter.renamePane("conv-01", "x")],
      ["closePane", await adapter.closePane("conv-01")],
      ["setFocus", await adapter.setFocus("conv-01")],
      ["createTab", await adapter.createTab({ spaceId: "ws-notes" })],
      ["renameTab", await adapter.renameTab("ws-notes:main", "x")],
      ["closeTab", await adapter.closeTab("ws-notes:main")],
      ["createSpace", await adapter.createSpace({ cwd: "/tmp" })],
      ["listWorktrees", await adapter.listWorktrees({ repoRoot: "/tmp" })],
      ["createWorktree", await adapter.createWorktree({ repoRoot: "/tmp", branch: "b" })],
      ["openWorktree", await adapter.openWorktree({ repoRoot: "/tmp", path: "/tmp/x" })],
      ["listSessions", await adapter.listSessions()],
    ] as const;
    for (const [capability, answer] of answers) {
      expect(answer.ok).toBe(false);
      if (!answer.ok) {
        expect(answer.reason).toBe("unsupported");
        if (answer.reason === "unsupported") expect(answer.capability).toBe(capability);
      }
    }
    expect(program.requests).toEqual([]);
  });

  test("the adapter is registered as durable, and COLLIE_MUX=durable selects it", () => {
    expect(MUX_ADAPTERS.map((factory) => factory.mux)).toContain(DURABLE_MUX);
    expect(DURABLE_MUX).toBe("durable");
    const adapter = createMux(buildMuxRegistry(), "durable", {
      endpoint: "",
      timeoutMs: 0,
      options: { [DURABLE_SOCKET_OPTION]: "/nonexistent/durable.sock" },
    });
    expect(adapter.mux).toBe("durable");
    expect(adapter.logo).toContain("<svg");
  });
});

describe("boots with zero panes", () => {
  test("boots with zero panes and no error when no program is connected", async () => {
    const adapter = durableMuxFactory.create({
      endpoint: "",
      timeoutMs: 0,
      options: { [DURABLE_SOCKET_OPTION]: "/nonexistent/durable.sock" },
    });
    expect(adapter.mux).toBe("durable");
    expect(await adapter.reachable()).toBe(false);
    expect(adapter.watch).toBeDefined();
  });

  // Socket only: the refusal names a socket path, and a Windows process has no user id to check it with.
  test.skipIf(SOCKET_ONLY_SKIP)("with no program connected the adapter holds no panes and is unreachable, never an empty census", async () => {
    const adapter = new DurableMux(new DurableSocketClient("/nonexistent/durable.sock"), new FakeDurableClock());
    expect(adapter.program()).toBeNull();
    expect(adapter.held()).toBeNull();
    expect(verdict(await adapter.poll())).toBe("unreachable: no socket at /nonexistent/durable.sock");
    await expect(adapter.snapshot()).rejects.toThrow("no socket at /nonexistent/durable.sock");
  });

  // Socket only: the paths are socket paths.
  test.skipIf(SOCKET_ONLY_SKIP)("an unset, relative or over-long socket path is unreachable with a detail that names the variable", async () => {
    for (const configured of [undefined, "", "durable.sock", `/${"d".repeat(200)}`]) {
      const adapter = durableMuxFactory.create({
        endpoint: "",
        timeoutMs: 0,
        options: configured === undefined ? {} : { [DURABLE_SOCKET_OPTION]: configured },
      });
      if (!(adapter instanceof DurableMux)) throw new Error("the factory built another adapter");
      const outcome = await adapter.poll();
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.detail).toContain(DURABLE_SOCKET_ENV);
    }
  });

  test("a program that is up with no conversations is reachable with zero panes", async () => {
    const { adapter, program } = await rig();
    program.snapshot = { workspaces: [], tabs: [], panes: [], starters: [] };
    expect(await adapter.reachable()).toBe(true);
    expect(await adapter.snapshot()).toEqual({ panes: [], spaces: [], tabs: [] });
  });

  test("a program with a workspace and no conversation lists the workspace and its tab", async () => {
    const { adapter, program } = await rig();
    program.snapshot.panes = [];
    const snapshot = await adapter.snapshot();
    expect(snapshot.panes).toEqual([]);
    expect(snapshot.spaces.map((space) => space.spaceId)).toEqual(["ws-notes", "ws-site"]);
  });

  // Socket only: the line names the socket.
  test.skipIf(SOCKET_ONLY_SKIP)("the startup line names the socket, or says what is wrong with the variable", () => {
    const saved = process.env[DURABLE_SOCKET_ENV];
    try {
      process.env[DURABLE_SOCKET_ENV] = "/run/user/1000/durable.sock";
      expect(durableMuxFactory.describeTarget?.("")).toBe("private socket /run/user/1000/durable.sock");
      process.env[DURABLE_SOCKET_ENV] = "relative.sock";
      expect(durableMuxFactory.describeTarget?.("")).toBe(`${DURABLE_SOCKET_ENV} must be an absolute path`);
      delete process.env[DURABLE_SOCKET_ENV];
      expect(durableMuxFactory.describeTarget?.("")).toBe(`${DURABLE_SOCKET_ENV} is not set`);
    } finally {
      if (saved === undefined) delete process.env[DURABLE_SOCKET_ENV];
      else process.env[DURABLE_SOCKET_ENV] = saved;
    }
  });

  // Socket only: the variable names a Unix socket path, which Windows has no transport for.
  test.skipIf(SOCKET_ONLY_SKIP)("the factory reads the socket from the environment variable when no override is given", async () => {
    const program = await FakeDurableProgram.start();
    programs.push(program);
    const saved = process.env[DURABLE_SOCKET_ENV];
    try {
      process.env[DURABLE_SOCKET_ENV] = program.socketPath;
      const adapter = durableMuxFactory.create({ endpoint: "", timeoutMs: 0, options: {} });
      expect(await adapter.reachable()).toBe(true);
      expect((await adapter.snapshot()).panes).toHaveLength(5);
    } finally {
      if (saved === undefined) delete process.env[DURABLE_SOCKET_ENV];
      else process.env[DURABLE_SOCKET_ENV] = saved;
    }
  });
});

describe("fixture: the recorded snapshot through the adapter", () => {
  test("the fixture maps to spaces, tabs and panes with the conversation ids", async () => {
    const { adapter } = await rig();
    const snapshot = await adapter.snapshot();
    expect(snapshot.spaces.map((space) => [space.spaceId, space.number])).toEqual([
      ["ws-notes", 1],
      ["ws-site", 2],
    ]);
    expect(snapshot.tabs.map((tab) => tab.tabId)).toEqual(["ws-notes:main", "ws-notes:research", "ws-site:main"]);
    expect(snapshot.panes.map((pane) => pane.paneId)).toEqual(["conv-01", "conv-02", "conv-03", "conv-04", "conv-05"]);
    expect(snapshot.panes.every((pane) => pane.agent === "durable" && pane.alive && !pane.focused)).toBe(true);
  });

  test("status follows the state mapping: working, waiting, idle, an open ask that wins, and unknown", async () => {
    const { adapter } = await rig();
    const status = Object.fromEntries((await adapter.snapshot()).panes.map((pane) => [pane.paneId, pane.status]));
    expect(status).toEqual({
      "conv-01": "working",
      "conv-02": "blocked",
      "conv-03": "idle",
      "conv-04": "blocked",
      "conv-05": "unknown",
    });
  });

  test("the program view carries the turn id, the asks and the starters for later specs", async () => {
    const { adapter } = await rig();
    await adapter.snapshot();
    const program = adapter.program();
    expect(program?.session).toMatchObject({ version: 1, hostName: "denis-laptop" });
    expect(program?.snapshot.panes.find((pane) => pane.id === "conv-02")?.turnId).toBe("turn-02-a");
    expect(program?.snapshot.panes.find((pane) => pane.id === "conv-02")?.openAsks).toHaveLength(1);
    expect(program?.snapshot.starters).toEqual([{ id: "notes-new", label: "New note chat" }]);
  });

  test("starters are ignored when hello does not open them", async () => {
    const { adapter, program } = await rig();
    program.hello.caps.starters = false;
    await adapter.snapshot();
    expect(adapter.program()?.snapshot.starters).toEqual([]);
  });

  test("clean: hostile strings from the socket reach the snapshot cleaned and capped", async () => {
    const { adapter, program } = await rig();
    const hostile = hostileText("evil", 4000);
    program.retitlePane("conv-01", hostile);
    for (const workspace of program.snapshot.workspaces) Object.assign(workspace, { title: hostile });
    for (const tab of program.snapshot.tabs) Object.assign(tab, { title: hostile });
    const snapshot = await adapter.snapshot();
    const texts = [
      ...snapshot.panes.map((pane) => pane.terminalTitle ?? ""),
      ...snapshot.panes.map((pane) => pane.spaceLabel),
      ...snapshot.panes.map((pane) => pane.tabLabel ?? ""),
      ...snapshot.spaces.map((space) => space.label),
      ...snapshot.tabs.map((tab) => tab.label),
    ].filter((text) => text.startsWith("evil"));
    expect(texts.length).toBeGreaterThan(8);
    for (const text of texts) {
      expect(hasHostileChars(text)).toBe(false);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(CAPS.title);
    }
  });

  test("a pane with a bad id is dropped with its tab, through the adapter", async () => {
    const { adapter, program } = await rig();
    for (const tab of program.snapshot.tabs) if (tab.id === "ws-notes:research") Object.assign(tab, { id: "ws-notes/research" });
    const snapshot = await adapter.snapshot();
    expect(snapshot.panes.map((pane) => pane.paneId)).not.toContain("conv-02");
    expect(snapshot.tabs.map((tab) => tab.tabId)).not.toContain("ws-notes/research");
  });
});

describe("version negotiation", () => {
  test("hello carries no version, and every later call carries the agreed one", async () => {
    const { adapter, program, tick } = await rig();
    program.range = { min: 1, max: 3 };
    await adapter.snapshot();
    expect(program.requests.map((request) => [request.path.replace("/session/v1", ""), request.version])).toEqual([
      ["/hello", null],
      ["/snapshot", "1"],
    ]);
    // A later hello (after a 503) carries the version too.
    program.ready = false;
    tick();
    await adapter.poll();
    program.ready = true;
    tick();
    await adapter.poll();
    const hellos = program.requests.filter((request) => request.path.endsWith("/hello"));
    expect(hellos.map((request) => request.version)).toEqual([null, "1"]);
  });

  test("no overlap is unreachable with the ranges named, nothing else is called, and the census is never empty", async () => {
    const { adapter, program, tick } = await rig();
    program.range = { min: 2, max: 3 };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(verdict(await adapter.poll())).toBe("unreachable: incompatible: program speaks 2..3, this Collie speaks 1..1");
      tick();
    }
    expect(paths(program)).toEqual(["/hello", "/hello", "/hello"]);
    expect(await adapter.reachable()).toBe(false);
  });

  // Socket only: the HTTPS client reads a 401 as a refused token, the socket client as incompatible.
  test.skipIf(SOCKET_ONLY_SKIP)("a program that asks for a token is incompatible", async () => {
    const { adapter, program } = await rig();
    program.asksForToken = true;
    expect(verdict(await adapter.poll())).toBe("unreachable: incompatible: program asks for a token");
  });

  test("a 409 on a later call is incompatible, is not retried at that version, and hello starts over", async () => {
    const { adapter, program, tick } = await rig();
    await adapter.snapshot();
    program.range = { min: 2, max: 2 };
    tick();
    expect(verdict(await adapter.poll())).toBe("unreachable: incompatible: program speaks 2..2, this Collie speaks 1..1");
    program.range = { min: 1, max: 1 };
    tick();
    expect(verdict(await adapter.poll())).toBe("ok");
    const hellos = program.requests.filter((request) => request.path.endsWith("/hello"));
    expect(hellos.map((request) => request.version)).toEqual([null, null]);
  });

  test("a hello that is not JSON, or has no epoch, is unreadable", async () => {
    const { adapter, program, tick } = await rig();
    program.override = (path) => (path.endsWith("/hello") ? new Response("<html>") : undefined);
    expect(verdict(await adapter.poll())).toBe("unreachable: unreadable hello: hello is not a JSON object");
    tick();
    program.override = (path) =>
      path.endsWith("/hello") ? Response.json({ service: "collie-durable", protocol: { min: 1, max: 1 }, ready: true }) : undefined;
    expect(verdict(await adapter.poll())).toBe("unreachable: unreadable hello: hello has no usable epoch");
  });
});

describe("the service name and the hysteresis", () => {
  test("a socket whose hello names no durable service is incompatible: not a durable program", async () => {
    const { adapter, program } = await rig();
    program.hello.service = undefined;
    expect(verdict(await adapter.poll())).toBe("unreachable: incompatible: not a durable program");
    expect(paths(program)).toEqual(["/hello"]);
  });

  test("another program on the socket, answering its own JSON, is named the same way", async () => {
    const { adapter, program } = await rig();
    program.override = (path) => (path.endsWith("/hello") ? Response.json({ name: "some-other-daemon", version: "3.1" }) : undefined);
    expect(verdict(await adapter.poll())).toBe("unreachable: incompatible: not a durable program");
  });

  test("one failed read keeps the last layout; the second in a row is unreachable", async () => {
    const { adapter, program, tick } = await rig();
    expect(verdict(await adapter.poll())).toBe("ok");
    // The program stops answering, but keeps its socket.
    program.override = () => new Promise<Response>(() => undefined);
    tick();
    const first = await adapter.poll();
    expect(verdict(first)).toBe("ok");
    expect(first.ok && first.value.panes.length).toBeGreaterThan(0);
    tick();
    expect(verdict(await adapter.poll())).toStartWith("unreachable: no answer within");
    // It answers again: one good read is enough to come back, and the count starts over.
    program.override = null;
    tick();
    expect(verdict(await adapter.poll())).toBe("ok");
    program.override = () => new Promise<Response>(() => undefined);
    tick();
    expect(verdict(await adapter.poll())).toBe("ok");
  }, 10_000);

  test("a held layout keeps its open asks across one dropped read, and the second drop clears them", async () => {
    const { adapter, program, tick } = await rig();
    await adapter.snapshot();
    const asks = adapter.openAsks("conv-02");
    expect(asks).toHaveLength(1);
    program.override = () => new Promise<Response>(() => undefined);
    tick();
    const held = await adapter.poll();
    expect(verdict(held)).toBe("ok");
    expect(held.ok && held.value.panes.find((pane) => pane.paneId === "conv-02")?.status).toBe("blocked");
    expect(adapter.openAsks("conv-02")).toEqual(asks);
    expect(adapter.program()?.snapshot.panes.find((pane) => pane.id === "conv-02")?.openAsks).toHaveLength(1);
    tick();
    expect(verdict(await adapter.poll())).toStartWith("unreachable: no answer within");
    expect(adapter.openAsks("conv-02")).toBeUndefined();
    expect(adapter.program()).toBeNull();
  }, 10_000);

  test("a program that answers starting is never held, even after a good read", async () => {
    const { adapter, program, tick } = await rig();
    expect(verdict(await adapter.poll())).toBe("ok");
    program.ready = false;
    program.override = (path) => (path.endsWith("/snapshot") ? Response.json({ code: "starting" }, { status: 503 }) : undefined);
    tick();
    expect(verdict(await adapter.poll())).toBe(`unreachable: ${STARTING}`);
  });

  test("the write budget is 3 seconds, under the crew's 5 second budget", () => {
    expect(WRITE_TIMEOUT_MS).toBe(3000);
    expect(FAILURES_TO_UNREACHABLE).toBe(2);
  });
});

describe("ready and epoch", () => {
  test("ready false is unreachable with the detail starting, never an empty census", async () => {
    const { adapter, program } = await rig();
    program.ready = false;
    expect(verdict(await adapter.poll())).toBe(`unreachable: ${STARTING}`);
    expect(paths(program)).toEqual(["/hello"]);
    expect(await adapter.reachable()).toBe(false);
    await expect(adapter.snapshot()).rejects.toThrow("starting");
  });

  test("a 503 on snapshot is starting, and the next read asks hello again", async () => {
    const { adapter, program, tick } = await rig();
    await adapter.snapshot();
    program.ready = false;
    tick();
    expect(verdict(await adapter.poll())).toBe("unreachable: starting");
    program.ready = true;
    tick();
    expect(verdict(await adapter.poll())).toBe("ok");
    expect(program.requests.filter((request) => request.path.endsWith("/hello"))).toHaveLength(2);
  });

  test("a program that was not ready becomes readable once it is", async () => {
    const { adapter, program, tick } = await rig();
    program.ready = false;
    await adapter.poll();
    program.ready = true;
    tick();
    expect((await adapter.snapshot()).panes).toHaveLength(5);
  });

  test("a new epoch is followed: the old panes are held while the program starts, then the new snapshot replaces them", async () => {
    const { adapter, program, tick } = await rig();
    await adapter.snapshot();
    const oldEpoch = adapter.program()?.session.epoch;
    expect(oldEpoch).toBe(program.epoch);

    program.restart({ ready: false });
    tick();
    expect(verdict(await adapter.poll())).toBe("unreachable: starting");
    // Unreachable now, and the layout it had is still held for the pane log to ask about.
    expect(adapter.program()).toBeNull();
    expect(adapter.held()?.epoch).toBe(oldEpoch ?? "");
    expect(adapter.held()?.panes).toHaveLength(5);

    program.ready = true;
    program.removePane("conv-05");
    tick();
    expect((await adapter.snapshot()).panes).toHaveLength(4);
    expect(adapter.program()?.session.epoch).toBe(program.epoch);
    expect(adapter.held()?.epoch).toBe(program.epoch);
    expect(program.epoch).not.toBe(oldEpoch);
  });

  test("an epoch change seen only in the snapshot makes the adapter ask hello again", async () => {
    const { adapter, program, tick } = await rig();
    await adapter.snapshot();
    const hellosBefore = program.requests.filter((request) => request.path.endsWith("/hello")).length;
    program.restart();
    program.hello.caps.starters = false;
    tick();
    const snapshot = await adapter.snapshot();
    expect(snapshot.panes).toHaveLength(5);
    expect(program.requests.filter((request) => request.path.endsWith("/hello")).length).toBe(hellosBefore + 1);
    expect(adapter.program()?.session.epoch).toBe(program.epoch);
    // The new hello closed starters, so the new view has none.
    expect(adapter.program()?.snapshot.starters).toEqual([]);
  });

  // Socket only: the mode of the socket file.
  test.skipIf(SOCKET_ONLY_SKIP)("a socket that loses its privacy between two reads is refused on the next read", async () => {
    const { adapter, program, tick } = await rig();
    await adapter.snapshot();
    chmodSync(program.socketPath, 0o666);
    tick();
    expect(verdict(await adapter.poll())).toBe(`unreachable: ${SOCKET_NOT_PRIVATE}: the socket has mode 0666, not 0600`);
    chmodSync(program.socketPath, 0o600);
    tick();
    expect(verdict(await adapter.poll())).toBe("ok");
  });
});

describe("snapshot reads", () => {
  test("a second read sends the ETag, and a 304 answers the held snapshot", async () => {
    const { adapter, program, tick } = await rig();
    const first = await adapter.snapshot();
    tick();
    const second = await adapter.snapshot();
    const snapshots = program.requests.filter((request) => request.path.endsWith("/snapshot"));
    expect(snapshots.map((request) => request.ifNoneMatch)).toEqual([null, `"${program.epoch}-12"`]);
    expect(second).toBe(first);
  });

  test("a change moves rev, the ETag no longer matches, and the new snapshot is read", async () => {
    const { adapter, program, tick } = await rig();
    await adapter.snapshot();
    program.setState("conv-03", "working");
    tick();
    const next = await adapter.snapshot();
    expect(next.panes.find((pane) => pane.paneId === "conv-03")?.status).toBe("working");
    tick();
    await adapter.snapshot();
    const snapshots = program.requests.filter((request) => request.path.endsWith("/snapshot"));
    expect(snapshots.at(-1)?.ifNoneMatch).toBe(`"${program.epoch}-13"`);
  });

  test("hello is asked once while the program stays up", async () => {
    const { adapter, program, tick } = await rig();
    for (let i = 0; i < 4; i += 1) {
      await adapter.snapshot();
      tick();
    }
    expect(paths(program)).toEqual(["/hello", "/snapshot", "/snapshot", "/snapshot", "/snapshot"]);
  });

  test("two reads inside the 250 ms floor are one read of the program", async () => {
    const { adapter, program, clock } = await rig();
    await adapter.snapshot();
    clock.advance(MIN_SNAPSHOT_GAP_MS - 1);
    await adapter.snapshot();
    await adapter.reachable();
    expect(paths(program)).toEqual(["/hello", "/snapshot"]);
    clock.advance(1);
    await adapter.snapshot();
    expect(paths(program)).toEqual(["/hello", "/snapshot", "/snapshot"]);
  });

  test("callers that arrive together share one read", async () => {
    const { adapter, program } = await rig();
    await Promise.all([adapter.snapshot(), adapter.snapshot(), adapter.reachable()]);
    expect(paths(program)).toEqual(["/hello", "/snapshot"]);
  });

  test("a failed read counts toward the floor, so a down program is asked once per interval", async () => {
    const { adapter, program, tick } = await rig();
    program.override = () => new Response("boom", { status: 500 });
    expect(verdict(await adapter.poll())).toBe("unreachable: program answered 500");
    expect(verdict(await adapter.poll())).toBe("unreachable: program answered 500");
    expect(program.requests).toHaveLength(1);
    program.override = null;
    tick();
    expect(verdict(await adapter.poll())).toBe("ok");
  });

  test("refresh waits out the floor, then reads: the next snapshot shows a change nobody announced", async () => {
    const { adapter, program } = await rig();
    await adapter.snapshot();
    program.renameTab("ws-site:main", "renamed");
    expect((await adapter.snapshot()).tabs.find((tab) => tab.tabId === "ws-site:main")?.label).toBe("main");
    await adapter.refresh();
    expect((await adapter.snapshot()).tabs.find((tab) => tab.tabId === "ws-site:main")?.label).toBe("renamed");
  });

  test("refresh never throws when the program is down", async () => {
    const { adapter, program } = await rig();
    await program.close();
    await adapter.refresh();
    expect(await adapter.reachable()).toBe(false);
  });

  test("a reply past the snapshot cap is unreachable with the detail too-large", async () => {
    const { adapter, program } = await rig();
    program.override = (path) => (path.endsWith("/snapshot") ? new Response("x".repeat(4 * 1024 * 1024 + 1)) : undefined);
    expect(verdict(await adapter.poll())).toBe("unreachable: too-large");
  });

  test("a snapshot that is not a snapshot is unreadable, and keeps the last good layout", async () => {
    const { adapter, program, tick } = await rig();
    await adapter.snapshot();
    program.override = (path) => (path.endsWith("/snapshot") ? new Response("{}") : undefined);
    tick();
    expect(verdict(await adapter.poll())).toBe("unreachable: unreadable snapshot: snapshot has no usable rev or epoch");
    expect(adapter.held()?.panes).toHaveLength(5);
  });

  test("a 304 with nothing held is unreadable, not a crash", async () => {
    const { adapter, program } = await rig();
    program.override = (path) => (path.endsWith("/snapshot") ? new Response(null, { status: 304 }) : undefined);
    expect(verdict(await adapter.poll())).toBe("unreachable: unreadable snapshot: 304 with nothing held");
  });

  test("an unknown pane state and a missing ask list are both fine", async () => {
    const { adapter, program } = await rig();
    program.override = (path) => {
      if (!path.endsWith("/snapshot")) return undefined;
      const body = program.currentSnapshot();
      return Response.json({
        ...body,
        panes: [{ id: "p", workspaceId: "ws-notes", tabId: "ws-notes:main", title: "t", harness: "h", state: "naptime", lastActiveAt: 1, turnId: "u" }],
      });
    };
    const snapshot = await adapter.snapshot();
    expect(snapshot.panes.map((pane) => [pane.paneId, pane.status])).toEqual([["p", "unknown"]]);
  });
});

describe("starters (WIRE.md sections 7.6 and 7.7)", () => {
  const REQUEST = "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c";

  test("the program's starters are listed with its machine name, and none while it is unreachable", async () => {
    const { adapter, program, tick } = await rig();
    expect(await adapter.listStarters()).toEqual({ hostName: "denis-laptop", starters: [{ id: "notes-new", label: "New note chat" }], reachable: true });
    await program.close();
    tick();
    // The first failed read is held (WIRE.md section 8.8), so the starters hold with the layout.
    expect(await adapter.listStarters()).toEqual({ hostName: "denis-laptop", starters: [{ id: "notes-new", label: "New note chat" }], reachable: true });
    tick();
    expect(await adapter.listStarters()).toEqual({ hostName: "", starters: [], reachable: false });
  });

  test("a program without the starters cap lists none and is never asked to start one", async () => {
    const { adapter, program } = await rig();
    program.hello.caps.starters = false;
    expect(await adapter.listStarters()).toMatchObject({ starters: [], reachable: true });
    expect(await adapter.startStarter("notes-new", REQUEST)).toMatchObject({ kind: "unsupported" });
    expect(program.requests.some((request) => request.method === "POST")).toBe(false);
  });

  test("a start passes the request id through and the new pane is in the next census", async () => {
    const { adapter, program } = await rig();
    const outcome = await adapter.startStarter("notes-new", REQUEST);
    expect(outcome.kind).toBe("started");
    if (outcome.kind !== "started") return;
    expect(outcome.replayed).toBe(false);
    expect(program.starts).toEqual([{ starterId: "notes-new", requestId: REQUEST, paneId: outcome.paneId }]);
    expect((await adapter.snapshot()).panes.map((pane) => pane.paneId)).toContain(outcome.paneId);
  });

  test("a repeat of the request id is the program's own replay and runs nothing", async () => {
    const { adapter, program } = await rig();
    const first = await adapter.startStarter("notes-new", REQUEST);
    const second = await adapter.startStarter("notes-new", REQUEST);
    expect(first.kind === "started" && second.kind === "started" && first.paneId === second.paneId).toBe(true);
    expect(second).toMatchObject({ kind: "started", replayed: true });
    expect(program.starts).toHaveLength(1);
  });

  test("a failed start is the program's message, cleaned, and the same id may run again", async () => {
    const { adapter, program } = await rig();
    program.starterFailure = hostileText("no model key", 2000);
    const failed = await adapter.startStarter("notes-new", REQUEST);
    expect(failed.kind).toBe("failed");
    if (failed.kind === "failed") {
      expect(failed.message.startsWith("no model key")).toBe(true);
      expect(hasHostileChars(failed.message)).toBe(false);
      expect(Buffer.byteLength(failed.message)).toBeLessThanOrEqual(CAPS.problemMessage);
    }
    program.starterFailure = null;
    expect(await adapter.startStarter("notes-new", REQUEST)).toMatchObject({ kind: "started", replayed: false });
    expect(program.starts).toHaveLength(1);
  });

  test("a 409 not-supported is unsupported, a 404 and a reused id are refused", async () => {
    const { adapter, program } = await rig();
    program.override = (path) => (path.includes("/starter/") ? Response.json({ code: "not-supported" }, { status: 409 }) : undefined);
    expect(await adapter.startStarter("notes-new", REQUEST)).toMatchObject({ kind: "unsupported" });
    program.override = null;
    expect(await adapter.startStarter("nope", REQUEST)).toEqual({ kind: "refused", detail: "program answered 404 no-such-starter" });
    expect(await adapter.startStarter("notes-new", REQUEST)).toMatchObject({ kind: "started" });
    program.snapshot.starters.push({ id: "other", label: "Other" });
    expect(await adapter.startStarter("other", REQUEST)).toEqual({ kind: "refused", detail: "program answered 409 request-id-reused" });
  });

  test("a 5xx, an unreadable reply and a dropped connection are an unknown outcome, never a retry", async () => {
    const { adapter, program } = await rig();
    program.override = (path) => (path.includes("/starter/") ? Response.json({ code: "internal" }, { status: 500 }) : undefined);
    expect(await adapter.startStarter("notes-new", REQUEST)).toEqual({ kind: "unknown", detail: "program answered 500" });
    program.override = (path) => (path.includes("/starter/") ? new Response("<html>") : undefined);
    expect((await adapter.startStarter("notes-new", REQUEST)).kind).toBe("unknown");
    program.override = (path) => (path.includes("/starter/") ? new Response("x".repeat(20_000)) : undefined);
    expect((await adapter.startStarter("notes-new", REQUEST)).kind).toBe("unknown");
    expect(program.requests.filter((request) => request.method === "POST")).toHaveLength(3);
  });

  // M50 spec 14: the examples keep the newest 1000 receipts per pane, and answer a repeat of a dropped id with a
  // 500 `receipt-dropped`. The adapter must read that as an unknown outcome, so the phone offers the same id
  // again and nothing is sent a second time by itself.
  test("a 500 receipt-dropped (a program that capped its receipts) is an unknown outcome, never a retry", async () => {
    const { adapter, program } = await rig();
    program.override = (path) => (path.includes("/starter/") ? Response.json({ code: "receipt-dropped" }, { status: 500 }) : undefined);
    expect(await adapter.startStarter("notes-new", REQUEST)).toEqual({ kind: "unknown", detail: "program answered 500" });
    expect(program.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  test("a 503 starting is unreachable: nothing ran", async () => {
    const { adapter, program } = await rig();
    program.override = (path) => (path.includes("/starter/") ? Response.json({ code: "starting" }, { status: 503 }) : undefined);
    expect(await adapter.startStarter("notes-new", REQUEST)).toEqual({ kind: "unreachable", detail: STARTING });
  });

  test("a program that is down is unreachable, and a bad id never leaves", async () => {
    const { adapter, program, tick } = await rig();
    expect(await adapter.startStarter("a/b", REQUEST)).toMatchObject({ kind: "refused" });
    expect(program.requests).toEqual([]);
    await program.close();
    tick();
    expect((await adapter.startStarter("notes-new", REQUEST)).kind).toBe("unreachable");
  });
});
