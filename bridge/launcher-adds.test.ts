import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AuditLog } from "./audit.ts";
import { harnessLaunch } from "./harness-launch.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import {
  addLauncher,
  createRevokeWatch,
  forgetDeviceRows,
  launcherItems,
  mergeLaunchers,
  readMerged,
  sweepRevokedRows,
  type AddContext,
  type LauncherSources,
} from "./launcher-adds.ts";
import { AddedLauncherStore, memoryAddedIo, type AddedLauncher } from "./launchers-added.ts";
import { muxAck, muxOk, type MuxAck, type MuxAdapter, type MuxCreatedPane, type MuxGrid, type MuxOutcome, type MuxSpaceRequest } from "./mux/types.ts";
import { DEFAULT_SWITCHES, type LauncherSwitches } from "./operator-launchers.ts";
import { FORGET_DEVICE_PATH, launch, launchersRoute, serveAddedLauncherRoute, type AddedRouteCaller } from "./server.ts";
import type { SessionRuntime } from "./sessions.ts";
import type { StateEngine } from "./state-engine.ts";
import type { CreateResponse, Launcher, LaunchersResponse } from "./types.ts";

// Rows a phone adds (ADR 0094): the merged allowlist and who wins it, the three writes and their
// gate, the request id, the operator's switches enforced on the bridge, and the revoke cleanup.

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ID3 = "33333333-3333-4333-8333-333333333333";

function fixture(opts: { operator?: Launcher[]; switches?: Partial<LauncherSwitches> } = {}) {
  let switches: LauncherSwitches = { ...DEFAULT_SWITCHES, ...opts.switches };
  const io = memoryAddedIo();
  const added = new AddedLauncherStore(io, () => {});
  const lines: JsonObject[] = [];
  // SAFETY: each line is one `formatAuditLine` JSON object.
  const audit = new AuditLog((line) => void lines.push(JSON.parse(line) as JsonObject));
  const sources: LauncherSources = {
    operator: () => Promise.resolve(opts.operator ?? []),
    added,
    switches: () => Promise.resolve(switches),
  };
  const ctx = (over: Partial<AddContext> = {}): AddContext => ({ sources, device: "phone", via: "local", audit, now: () => 5, ...over });
  return {
    io,
    added,
    sources,
    lines,
    audit,
    ctx,
    setSwitches: (next: Partial<LauncherSwitches>) => {
      switches = { ...switches, ...next };
    },
  };
}

const recipe = (harness: string, options: string[], extra: JsonObject = {}): JsonValue => ({ requestId: ID1, recipe: { harness, options }, ...extra });

describe("addLauncher: a recipe", () => {
  test("the bridge builds the line from its own table and records who added it", async () => {
    const f = fixture();
    const out = await addLauncher(recipe("claude", ["skip"]), f.ctx());
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      ok: true,
      row: {
        command: "claude --dangerously-skip-permissions",
        label: "Claude Code, Skip permission prompts",
        source: "added",
        id: ID1,
        kind: "agent",
        harness: "claude",
        noPrompts: true,
        addedBy: "phone",
        addedAt: 5,
        addedAs: "recipe",
      },
    });
    expect(f.lines.map((l) => l.action)).toEqual(["launcher.add"]);
    expect(f.lines[0]?.device).toBe("phone");
  });

  test("a retry with the same request id adds nothing twice", async () => {
    const f = fixture();
    await addLauncher(recipe("claude", ["skip"]), f.ctx());
    const again = await addLauncher(recipe("claude", ["opus"]), f.ctx());
    expect(again.body).toMatchObject({ ok: true, replayed: true, row: { command: "claude --dangerously-skip-permissions" } });
    expect(await f.added.list()).toHaveLength(1);
    expect(f.lines).toHaveLength(1);
    expect(f.io.writes).toBe(1);
  });

  test("a bad recipe is refused with its reason, and nothing is stored", async () => {
    const f = fixture();
    for (const [body, reason] of [
      [recipe("bash", []), "unknown_harness"],
      [recipe("claude", ["--yolo"]), "unknown_option"],
      [recipe("claude", ["opus", "sonnet"]), "conflict"],
    ] as const) {
      const out = await addLauncher(body, f.ctx());
      expect(out.status).toBe(400);
      expect(out.body).toMatchObject({ ok: false, code: "launcher.bad_recipe", detail: { reason } });
    }
    expect(await f.added.list()).toEqual([]);
  });

  test("a request id is required, and one of recipe and text", async () => {
    const f = fixture();
    expect((await addLauncher({ recipe: { harness: "claude", options: [] } }, f.ctx())).status).toBe(400);
    expect((await addLauncher({ requestId: ID1 }, f.ctx())).status).toBe(400);
    expect((await addLauncher({ requestId: ID1, recipe: { harness: "claude", options: [] }, text: "htop" }, f.ctx())).status).toBe(400);
  });

  test("no device, no add", async () => {
    const f = fixture();
    const out = await addLauncher(recipe("claude", []), f.ctx({ device: null }));
    expect(out).toMatchObject({ status: 403, body: { code: "launcher.no_device" } });
  });

  test("a line the operator already wrote is a duplicate", async () => {
    const f = fixture({ operator: [{ command: "claude --continue", label: "Resume" }] });
    const out = await addLauncher(recipe("claude", ["continue"]), f.ctx());
    expect(out).toMatchObject({ status: 409, body: { code: "launcher.duplicate" } });
  });
});

describe("addLauncher: free text and the operator's switches, on the bridge", () => {
  const text = (line: string, extra: JsonObject = {}): JsonValue => ({ requestId: ID2, text: line, kind: "command", ...extra });

  test("free text is off by default", async () => {
    const f = fixture();
    expect(await addLauncher(text("htop"), f.ctx())).toMatchObject({ status: 403, body: { code: "launcher.free_text_off" } });
  });

  test("phone adds off refuses a recipe too", async () => {
    const f = fixture({ switches: { adds: false } });
    expect(await addLauncher(recipe("claude", []), f.ctx())).toMatchObject({ status: 403, body: { code: "launcher.adds_off" } });
  });

  test("with free text on: trimmed, NFC, labelled by its first word", async () => {
    const f = fixture({ switches: { freeText: true } });
    const out = await addLauncher(text("  htop -d 5 "), f.ctx());
    expect(out.body).toMatchObject({ ok: true, row: { command: "htop -d 5", label: "htop", kind: "command", noPrompts: false, addedAs: "text" } });
  });

  test("an agent line names a harness; the tick and the scan both mark no prompts", async () => {
    const f = fixture({ switches: { freeText: true } });
    expect((await addLauncher(text("claude-danger", { kind: "agent" }), f.ctx())).status).toBe(400);
    const ticked = await addLauncher(
      { requestId: ID2, text: "claude-danger", kind: "agent", harness: "claude", noPrompts: true, label: "Claude, no prompts" },
      f.ctx(),
    );
    expect(ticked.body).toMatchObject({ ok: true, row: { kind: "agent", harness: "claude", noPrompts: true, label: "Claude, no prompts" } });
    const scanned = await addLauncher({ requestId: ID3, text: "codex --yolo", kind: "agent", harness: "codex" }, f.ctx());
    expect(scanned.body).toMatchObject({ ok: true, row: { noPrompts: true } });
  });

  test("the character rule, on the line and on the label", async () => {
    const f = fixture({ switches: { freeText: true } });
    for (const [body, field, problem] of [
      [text("htop\nrm -rf ~"), "command", "forbidden_character"],
      [text("ls \u202Etxt"), "command", "forbidden_character"],
      [text("x".repeat(201)), "command", "too_long"],
      [text("htop", { label: "a\u2066b" }), "label", "forbidden_character"],
      [text("htop", { label: "x".repeat(61) }), "label", "too_long"],
    ] as const) {
      expect(await addLauncher(body, f.ctx())).toMatchObject({ status: 400, body: { code: "launcher.bad_text", detail: { field, problem } } });
    }
    expect(await f.added.list()).toEqual([]);
  });
});

describe("the merged allowlist", () => {
  const op: Launcher = { command: "make test", label: "Tests", cwd: "/srv/app" };
  function stored(over: Partial<AddedLauncher>): AddedLauncher {
    return { id: ID1, kind: "command", source: "text", command: "htop", label: "htop", noPrompts: false, device: "phone", via: "local", at: 1, ...over };
  }

  test("operator rows first, marked; an added row with the same line is not listed twice", () => {
    const merged = mergeLaunchers(
      [op, { command: "codex --yolo", label: "YOLO" }],
      [stored({ id: ID1, command: "make test", label: "mine" }), stored({ id: ID2, command: "htop" })],
      { adds: true, freeText: true },
    );
    expect(merged.rows.map((r) => [r.command, r.label, r.source, r.noPrompts])).toEqual([
      ["make test", "Tests", "operator", false],
      ["codex --yolo", "YOLO", "operator", true],
      ["htop", "htop", "added", false],
    ]);
  });

  test("switches take rows out without deleting them, with a reason", () => {
    const recipeRow = stored({ id: ID1, kind: "agent", harness: "claude", source: "recipe", options: [], command: "claude", label: "Claude Code" });
    const textRow = stored({ id: ID2 });
    const freeOff = mergeLaunchers([], [recipeRow, textRow], { adds: true, freeText: false });
    expect(freeOff.rows.map((r) => r.command)).toEqual(["claude"]);
    expect(freeOff.off).toEqual([{ id: ID2, label: "htop", command: "htop", kind: "command", reason: "free_text_off" }]);
    const allOff = mergeLaunchers([], [recipeRow, textRow], { adds: false, freeText: true });
    expect(allOff.rows).toEqual([]);
    expect(allOff.off.map((o) => o.reason)).toEqual(["adds_off", "adds_off"]);
    expect(allOff.stored).toHaveLength(2);
  });

  test("items: every agent, row and the shell, with availability and the reason code", () => {
    const merged = mergeLaunchers(
      [op, { command: "claude-danger", label: "Danger", kind: "agent", harness: "claude", noPrompts: true }],
      [stored({ id: ID2 })],
      { adds: true, freeText: false },
    );
    const items = launcherItems(
      [
        { id: "claude", label: "Claude Code", found: true },
        { id: "grok", label: "Grok", found: false },
      ],
      merged,
    );
    expect(items.map((i) => [i.key, i.group, i.available, i.reason ?? null, i.branch, i.noPrompts])).toEqual([
      ["harness:claude", "agents", true, null, true, false],
      ["harness:grok", "agents", false, "not_found", true, false],
      ["row:claude-danger", "agents", true, null, true, true],
      ["shell", "commands", true, null, true, false],
      ["row:make test", "commands", true, null, false, false],
      ["row:htop", "commands", false, "free_text_off", false, false],
    ]);
    expect(items.find((i) => i.key === "row:make test")).toMatchObject({ start: { command: "make test" }, cwd: "/srv/app", source: "operator" });
    expect(items.find((i) => i.key === "row:htop")).toMatchObject({ id: ID2, addedBy: "phone", source: "added" });
    expect(items.find((i) => i.key === "shell")?.start).toEqual({ shell: true });
  });

  test("GET /api/launchers carries `adding` and `items` when built with them", async () => {
    const f = fixture({ operator: [op] });
    await addLauncher(recipe("claude", ["skip"]), f.ctx());
    const res = await launchersRoute(
      async () => (await readMerged(f.sources)).rows,
      null,
      { list: () => Promise.resolve([{ id: "claude", label: "Claude Code", found: true }]) },
      { merged: () => readMerged(f.sources), file: "/home/op/.config/herdr/plugins/config/herdr.collie/launchers.toml" },
    );
    // SAFETY: the route answers a LaunchersResponse as JSON.
    const body = (await res.json()) as LaunchersResponse;
    expect(body.adding).toMatchObject({ adds: true, freeText: false, count: 1, max: 20, off: [], file: expect.stringContaining("launchers.toml") });
    expect(body.adding?.recipes.find((r) => r.harness === "claude")?.options[0]).toEqual({
      id: "skip",
      label: "Skip permission prompts",
      args: "--dangerously-skip-permissions",
      group: "permissions",
      noPrompts: true,
    });
    expect(body.items?.map((i) => i.key)).toEqual(["harness:claude", "row:claude --dangerously-skip-permissions", "shell", "row:make test"]);
  });
});

// ── The three routes through the caller's gate ────────────────────────────────────────────────

function caller(over: Partial<AddedRouteCaller> & { lines?: JsonObject[] } = {}): AddedRouteCaller {
  return {
    gate: () => null,
    // SAFETY: the added-launcher routes read only `name` off the runtime.
    resolve: () => Promise.resolve({ name: "default" } as SessionRuntime),
    device: () => "phone",
    audit: new AuditLog(() => {}),
    ...over,
  };
}

const postTo = (path: string, body: JsonValue) =>
  new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("serveAddedLauncherRoute", () => {
  test("not one of its paths, or not a POST: null", async () => {
    const f = fixture();
    expect(await serveAddedLauncherRoute(postTo("/api/launchers", {}), "/api/launchers", caller(), f.sources)).toBeNull();
    expect(await serveAddedLauncherRoute(new Request("http://x/api/launchers/added"), "/api/launchers/added", caller(), f.sources)).toBeNull();
  });

  test("the write gate first: a read-only device adds nothing", async () => {
    const f = fixture();
    let asked = "";
    const res = await serveAddedLauncherRoute(
      postTo("/api/launchers/added", recipe("claude", [])),
      "/api/launchers/added",
      caller({
        gate: (level) => {
          asked = level;
          return new Response("device not authorised", { status: 403 });
        },
      }),
      f.sources,
    );
    expect(asked).toBe("write");
    expect(res?.status).toBe(403);
    expect(await f.added.list()).toEqual([]);
  });

  test("a member that is not taking writes refuses before this store is touched", async () => {
    const f = fixture();
    const refusal = new Response(JSON.stringify({ ok: false, code: "host_unreachable" }), { status: 503 });
    const res = await serveAddedLauncherRoute(
      postTo("/api/launchers/added", recipe("claude", [])),
      "/api/launchers/added",
      caller({ resolve: () => Promise.resolve(refusal) }),
      f.sources,
    );
    expect(res).toBe(refusal);
    expect(await f.added.list()).toEqual([]);
  });

  test("over the crew link the row records it came that way", async () => {
    const f = fixture();
    await serveAddedLauncherRoute(postTo("/api/launchers/added", recipe("claude", [])), "/api/launchers/added", caller({ via: "crew" }), f.sources);
    expect((await f.added.list())[0]?.via).toBe("crew");
  });

  test("add, rename, remove; an unknown id is a 404; each is audited", async () => {
    const f = fixture();
    const lines: JsonObject[] = [];
    // SAFETY: each line is one audit JSON object.
    const c = caller({ audit: new AuditLog((l) => void lines.push(JSON.parse(l) as JsonObject)) });
    expect((await serveAddedLauncherRoute(postTo("/api/launchers/added", recipe("pi", ["continue"])), "/api/launchers/added", c, f.sources))?.status).toBe(200);
    const renamed = await serveAddedLauncherRoute(postTo("/api/launchers/added/rename", { id: ID1, label: "Pi again" }), "/api/launchers/added/rename", c, f.sources);
    expect(await renamed?.json()).toMatchObject({ ok: true, row: { label: "Pi again", command: "pi --continue" } });
    const missing = await serveAddedLauncherRoute(postTo("/api/launchers/added/remove", { id: ID2 }), "/api/launchers/added/remove", c, f.sources);
    expect(missing?.status).toBe(404);
    const removed = await serveAddedLauncherRoute(postTo("/api/launchers/added/remove", { id: ID1 }), "/api/launchers/added/remove", c, f.sources);
    expect(await removed?.json()).toEqual({ ok: true, removed: 1 });
    expect(await f.added.list()).toEqual([]);
    expect(lines.map((l) => l.action)).toEqual(["launcher.add", "launcher.rename", "launcher.remove"]);
  });
});

// ── An added row starts, and stops starting when the operator says so ──────────────────────────

class FakeMux {
  readonly texts: string[] = [];
  createSpace(request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    return Promise.resolve(muxOk({ paneId: "w1:p1", spaceId: "w1", spaceLabel: request.label ?? "", tabId: "w1:t1", cwd: request.cwd ?? "/" }));
  }
  readGrid(paneId: string): Promise<MuxOutcome<MuxGrid>> {
    return Promise.resolve(muxOk({ paneId, text: "$ ", truncated: false, revision: 1 }));
  }
  typeText(_paneId: string, text: string): Promise<MuxAck> {
    this.texts.push(text);
    return Promise.resolve(muxAck());
  }
  sendKeys(): Promise<MuxAck> {
    return Promise.resolve(muxAck());
  }
  closePane(): Promise<MuxAck> {
    return Promise.resolve(muxAck());
  }
  refresh(): Promise<void> {
    return Promise.resolve();
  }
}

function asMux(fake: Partial<MuxAdapter>): MuxAdapter {
  // SAFETY: a dashboard launch reaches createSpace, readGrid, typeText, sendKeys, closePane and
  // refresh, the six FakeMux implements.
  return fake as MuxAdapter;
}

function engine(): StateEngine {
  const stub: Partial<StateEngine> = {
    pokeNow: () => {},
    current: () => ({ agents: [], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" }),
  };
  // SAFETY: `launch` from the dashboard reaches only `current()` and `pokeNow()`.
  return stub as StateEngine;
}

async function launchRow(f: ReturnType<typeof fixture>, command: string) {
  const mux = new FakeMux();
  let ms = 0;
  const res = await launch(
    asMux(mux),
    engine(),
    postTo("/api/launch", { command }),
    new AuditLog(() => {}),
    null,
    "default",
    async () => (await readMerged(f.sources)).rows,
    {
      now: () => ms,
      sleep: (by: number) => {
        ms += by;
        return Promise.resolve();
      },
    },
    { harnesses: { launch: harnessLaunch } },
  );
  // SAFETY: the route answers a CreateResponse as JSON.
  return { status: res.status, body: (await res.json()) as CreateResponse, typed: mux.texts };
}

describe("launching an added row", () => {
  test("it is on the allowlist while the switches allow it", async () => {
    const f = fixture({ switches: { freeText: true } });
    await addLauncher({ requestId: ID1, text: "htop -d 5", kind: "command" }, f.ctx());
    const on = await launchRow(f, "htop -d 5");
    expect(on.status).toBe(200);
    expect(on.typed).toEqual(["htop -d 5"]);
    f.setSwitches({ freeText: false });
    const off = await launchRow(f, "htop -d 5");
    expect(off.status).toBe(400);
    expect(off.body).toMatchObject({ code: "launch.not_allowlisted" });
    f.setSwitches({ freeText: true, adds: false });
    expect((await launchRow(f, "htop -d 5")).status).toBe(400);
    expect(await f.added.list()).toHaveLength(1); // held back, never deleted
  });
});

// ── Revoke: the rows go with the device ─────────────────────────────────────────────────────────

describe("revoke cleanup", () => {
  async function seeded() {
    const f = fixture({ switches: { freeText: true } });
    await addLauncher({ requestId: ID1, text: "htop", kind: "command" }, f.ctx({ device: "lost" }));
    await addLauncher({ requestId: ID2, text: "btop", kind: "command" }, f.ctx({ device: "lost", via: "crew" }));
    await addLauncher({ requestId: ID3, text: "top", kind: "command" }, f.ctx({ device: "tablet" }));
    f.lines.length = 0;
    return f;
  }

  test("forgetDeviceRows removes that device's rows of one path, and logs each", async () => {
    const f = await seeded();
    const gone = await forgetDeviceRows(f.added, "lost", "local", f.audit, "device-revoked");
    expect(gone.map((r) => r.command)).toEqual(["htop"]);
    expect((await f.added.list()).map((r) => r.command)).toEqual(["btop", "top"]);
    expect(f.lines).toEqual([
      expect.objectContaining({ action: "launcher.remove", detail: expect.objectContaining({ addedBy: "lost", reason: "device-revoked", requestId: ID1 }) }),
    ]);
    // The crew forget names the crew rows only.
    expect((await forgetDeviceRows(f.added, "lost", "crew", f.audit, "device-revoked")).map((r) => r.command)).toEqual(["btop"]);
  });

  test("the read-time sweep drops local rows whose device is no longer paired, never on an unreadable registry", async () => {
    const f = await seeded();
    expect(await sweepRevokedRows(f.added, null, f.audit)).toEqual([]);
    expect(await f.added.list()).toHaveLength(3);
    const gone = await sweepRevokedRows(f.added, new Set(["tablet"]), f.audit);
    expect(gone.map((r) => r.command)).toEqual(["htop"]);
    // A crew row's label is the lead's, not this registry's: the sweep leaves it.
    expect((await f.added.list()).map((r) => r.command)).toEqual(["btop", "top"]);
    expect(f.io.writes).toBe(4); // three adds and one sweep; a sweep with nothing to do writes nothing
    await sweepRevokedRows(f.added, new Set(["tablet"]), f.audit);
    expect(f.io.writes).toBe(4);
  });

  test("the revoke watch reports a label once, after it was seeded", () => {
    const watch = createRevokeWatch();
    expect(watch(new Set(["a", "b"]))).toEqual([]);
    expect(watch(null)).toEqual([]);
    expect(watch(new Set(["a"]))).toEqual(["b"]);
    expect(watch(new Set(["a"]))).toEqual([]);
  });

  test("server.ts wires every revoke path to the forget, and keeps the crew forget off the browser path", () => {
    const src = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
    const revoke = src.indexOf('if (pathname === "/api/devices/revoke"');
    const revoked = src.indexOf("revoked = await pairing.revoke(label);", revoke);
    expect(src.indexOf('await forgetDevice(label, "device-revoked");', revoked)).toBeGreaterThan(revoked);
    expect(src).toContain('await forgetDevice(parsed.label, "expired-replaced");');
    // The browser path answers the crew forget with a 404, before any session route.
    const browser = src.indexOf("if (pathname === FORGET_DEVICE_PATH) {");
    expect(browser).toBeGreaterThan(0);
    expect(browser).toBeLessThan(src.indexOf("const sessionRouted = await serveSessionRoute(req, url, {"));
    // The crew dispatch serves it, for crew rows only.
    expect(src).toContain('forgetDeviceRows(addedLaunchers, forgotten.trim(), "crew"');
    expect(FORGET_DEVICE_PATH).toBe("/api/launchers/added/forget-device");
  });
});
