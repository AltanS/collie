import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { BeaconMatcher } from "../bridge/beacon/decorate.ts";
import { walkyPlace } from "../bridge/hill/walky.ts";
import { HOST } from "../bridge/host.ts";
import { MorphService } from "../bridge/morph/service.ts";
import { MorphStore } from "../bridge/morph/store.ts";
import type { WalkyHost, WalkyPane } from "../bridge/walky/deliver.ts";
import { WalkyLog } from "../bridge/walky/log.ts";
import { unknownOp } from "../bridge/walky/refusals.ts";
import { WalkyService } from "../bridge/walky/service.ts";
import { MORPH_NEEDS_A_PANE, walkySocketPath, WalkyServer, type PlaceTarget } from "../bridge/walky/socket.ts";
import { spaceOf } from "../bridge/walky/space.ts";
import { parseJsonObject } from "../web/src/lib/json.ts";
import { parseMorphView } from "../web/src/lib/morph/wire.ts";
import { NODE_ATTRS, NODE_KINDS } from "../web/src/lib/tricks/schema.ts";
import { capture, context } from "./fakes.ts";
import { EXIT } from "./io.ts";
import {
  cmdMorph,
  cmdMorphClear,
  cmdMorphHelp,
  cmdMorphOff,
  cmdMorphOn,
  cmdMorphShow,
  cmdMorphStatus,
  MORPH_EXAMPLE,
  MORPH_NOT_HERE,
  MORPH_UNKNOWN,
  morphHelp,
  morphKindLines,
  parseShowArgs,
  readScreen,
  type MorphDeps,
} from "./morph.ts";
import { realFiles } from "./sys.ts";
import { askSocket } from "./walky.ts";

const SOLO_SPACE = spaceOf({ memberId: "local", spaceId: "w1", spaceLabel: "w1" });
const BIN = "/home/op/apps/collie/bin/collie";

// `collie morph` against a real bridge socket in a temp state dir, as cli/hill.test.ts drives the hill:
// the socket, the request lines and the answers are the real ones; only the panes are fakes.
const socketTest = test.skipIf(HOST.platform === "win32");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

const matcher: BeaconMatcher = {
  namespace: "tmux",
  scope: async () => "/tmp/tmux-1/default",
  matches: (pane, marker, scope) => marker.scope === scope && pane.paneId === marker.pane,
  notesWithoutHooks: { agentDetection: "", agentSessionRef: "" },
};
const target: PlaceTarget = { session: "main", matcher, paneIds: () => ["%1", "%2", "%3"] };
const inPane = (pane: string) => ({ TMUX: "/tmp/tmux-1/default,123,0", TMUX_PANE: pane });

const panes: WalkyPane[] = [
  { session: "main", paneId: "%1", agent: true, harness: "agent-x", label: "repo#one", state: "idle", activeAt: null, instance: "aaaa", terminal: true, off: false, space: SOLO_SPACE },
  { session: "main", paneId: "%2", agent: true, harness: "agent-y", label: "repo#two", state: "idle", activeAt: null, instance: "bbbb", terminal: true, off: false, space: SOLO_SPACE },
  { session: "main", paneId: "%3", agent: false, harness: null, label: "shell", state: "idle", activeAt: null, instance: "cccc", terminal: true, off: false, space: SOLO_SPACE },
];

async function bridge(withMorph = true): Promise<{ readonly stateDir: string; readonly morph: MorphService }> {
  const stateDir = mkdtempSync(join(tmpdir(), "morph-cli-"));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const host: WalkyHost = { panes: () => panes, send: async () => ({ outcome: "sent" }), sendState: () => ({ outcome: "sent" }), cancelHeld: () => undefined };
  const walky = new WalkyService({ log: new WalkyLog(join(stateDir, "walky")), host, memberId: null, enabled: () => true, machine: "desk", keyPem: () => null });
  const morph = new MorphService({
    store: new MorphStore(null, () => 1000),
    place: walkyPlace(walky, null),
    sessionsKnown: () => true,
    crewMode: () => "solo",
    binary: BIN,
    now: () => Date.parse("2026-11-10T10:00:00.000Z"),
  });
  const base = { socketPath: walkySocketPath(stateDir), service: walky, targets: () => [target], log: () => undefined };
  const server = withMorph ? new WalkyServer({ ...base, morph }) : new WalkyServer(base);
  expect(await server.start()).toBe(true);
  cleanups.push(() => server.stop());
  return { stateDir, morph };
}

/** A bridge of today's release without Morph: it answers `unknownOp` to an op it does not know. */
async function olderBridge(): Promise<string> {
  const stateDir = mkdtempSync(join(tmpdir(), "morph-older-"));
  const path = walkySocketPath(stateDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk: string) => socket.end(`${JSON.stringify({ ok: false, error: unknownOp(String(parseJsonObject(chunk)?.op ?? "")) })}\n`));
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
  return path;
}

function deps(sockets: string[], env: Record<string, string> = inPane("%1"), over: Partial<MorphDeps> = {}): MorphDeps & { readonly io: ReturnType<typeof capture> } {
  const io = capture();
  const cwd = mkdtempSync(join(tmpdir(), "morph-cwd-"));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  return {
    ctx: context(env, { stateDir: mkdtempSync(join(tmpdir(), "morph-own-")) }),
    files: realFiles,
    uid: process.getuid?.(),
    platform: "linux",
    readStdin: async () => "",
    stdinIsTty: true,
    ask: (path, line) => askSocket(path, line, 2000),
    sockets: () => sockets,
    cwd: () => cwd,
    ...over,
    io,
  };
}

function screenFile(d: MorphDeps, content: string): string {
  const path = join(d.cwd!(), "screen.json");
  writeFileSync(path, content);
  return "screen.json";
}

describe("help", () => {
  test("the example parses with the real part-view parser", () => {
    expect(parseMorphView(MORPH_EXAMPLE).refusals).toEqual([]);
  });

  test("the printed example is the same JSON, and the help holds the rules", () => {
    const lines = morphHelp();
    const example = lines.find((line) => line.startsWith("[{"));
    expect(example).toBeDefined();
    expect(parseMorphView(JSON.parse(example!)).view).toBeDefined();
    const text = lines.join("\n");
    for (const words of ["One screen per answer", '"confirm"', "Never imitate a permission dialog", '"value"']) expect(text).toContain(words);
  });

  test("the kinds come from the schema: every kind is named, with every attribute", () => {
    const kinds = morphKindLines().join("\n");
    for (const kind of NODE_KINDS) expect(kinds).toContain(kind);
    expect(kinds).toContain(`  button  attrs: ${NODE_ATTRS.button.map((name) => (name === "label" ? "label*" : name)).join(", ")}`);
  });

  test("`morph help` prints on stdout and exits 0; a bare `morph` prints on stderr and exits 2", () => {
    const d = deps([]);
    expect(cmdMorphHelp(d)).toBe(EXIT.OK);
    expect(d.io.stdout.length).toBeGreaterThan(10);
    const bare = deps([]);
    expect(cmdMorph(bare, [])).toBe(EXIT.USAGE);
    expect(bare.io.stdout).toEqual([]);
    expect(cmdMorph(deps([]), ["--help"])).toBe(EXIT.OK);
  });
});

describe("show's arguments and file", () => {
  test("reads a path or -, a title and --json", () => {
    expect(parseShowArgs(["s.json", "--title", "Tests", "--json"])).toEqual({ source: "s.json", title: "Tests", json: true });
    expect(parseShowArgs(["-"])).toEqual({ source: "-", title: null, json: false });
    expect(parseShowArgs([])).toHaveProperty("error");
    expect(parseShowArgs(["a", "b"])).toHaveProperty("error");
    expect(parseShowArgs(["a", "--nope"])).toHaveProperty("error");
  });

  test("a file is a list of nodes or { title?, view }, and the title is given once", () => {
    expect(readScreen("[]", "T")).toEqual({ view: [], title: "T" });
    expect(readScreen('{"title":"F","view":[]}', null)).toEqual({ view: [], title: "F" });
    expect(readScreen('{"title":"F","view":[]}', "T")).toHaveProperty("error");
    expect(readScreen('{"view":[],"x":1}', null)).toHaveProperty("error");
    expect(readScreen("{ nope", null)).toHaveProperty("error");
  });
});

describe("against a bridge", () => {
  socketTest("show while off is stored and says so; on, status, clear and off follow the session", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdMorphShow(d, [screenFile(d, JSON.stringify(MORPH_EXAMPLE)), "--title", "Tests"])).toBe(EXIT.OK);
    expect(d.io.stdout[0]).toStartWith("stored: rev 1. Morph is off for this session");
    expect(b.morph.status("local/%1#aaaa").view?.title).toBe("Tests");

    const on = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdMorphOn(on, [])).toBe(EXIT.OK);
    expect(on.io.stdout[0]).toBe("turned on");

    const shown = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdMorphShow(shown, [screenFile(shown, JSON.stringify(MORPH_EXAMPLE))])).toBe(EXIT.OK);
    expect(shown.io.stdout[0]).toBe("shown: rev 2");

    const status = deps([walkySocketPath(b.stateDir)], inPane("%1"));
    expect(await cmdMorphStatus(status, ["--json"])).toBe(EXIT.OK);
    expect(JSON.parse(status.io.stdout[0]!)).toMatchObject({ morph: { session: "local/%1#aaaa", on: true, view: { rev: 2 } } });

    const clear = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdMorphClear(clear, [])).toBe(EXIT.OK);
    expect(clear.io.stdout).toContain("screen: none");

    const off = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdMorphOff(off, [])).toBe(EXIT.OK);
    expect(off.io.stdout).toContain("morph: off");

    // Another pane's session is its own.
    const other = deps([walkySocketPath(b.stateDir)], inPane("%2"));
    expect(await cmdMorphStatus(other, [])).toBe(EXIT.OK);
    expect(other.io.stdout).toEqual(["morph: off", "screen: none", expect.stringContaining(`${BIN} morph show`)]);
  });

  socketTest("reads the screen from stdin with -", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)], inPane("%1"), { stdinIsTty: false, readStdin: async () => JSON.stringify({ title: "From stdin", view: MORPH_EXAMPLE }) });
    expect(await cmdMorphShow(d, ["-"])).toBe(EXIT.OK);
    expect(b.morph.status("local/%1#aaaa").view?.title).toBe("From stdin");
  });

  socketTest("a bad view is refused with exit 4 and each node's path and reason", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)]);
    const bad = [{ kind: "para", text: "ok" }, { kind: "bar", kids: [{ kind: "button", attrs: { label: "Go" } }] }];
    expect(await cmdMorphShow(d, [screenFile(d, JSON.stringify(bad))])).toBe(EXIT.REFUSED);
    expect(d.io.stderr[0]).toContain("(bad_view)");
    expect(d.io.stderr.some((line) => line.trim().startsWith("/view/1/kids/0"))).toBe(true);
  });

  socketTest("a shell pane is refused: a screen belongs to an agent's session", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)], inPane("%3"));
    expect(await cmdMorphOn(d, [])).toBe(EXIT.STATE);
    expect(d.io.stderr[0]).toBe(`morph: ${MORPH_NEEDS_A_PANE}`);
  });

  socketTest("a bridge without Morph is asked past; with none that knows it, exit 5", async () => {
    const older = await olderBridge();
    const d = deps([older]);
    expect(await cmdMorphStatus(d, [])).toBe(EXIT.UNREACHABLE);
    expect(d.io.stderr[0]).toBe(`morph: ${MORPH_UNKNOWN}`);
    const b = await bridge();
    const past = deps([older, walkySocketPath(b.stateDir)]);
    expect(await cmdMorphOn(past, [])).toBe(EXIT.OK);
  });

  socketTest("a bridge that knows Morph but not this pane answers not here", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)], inPane("%7"));
    expect(await cmdMorphStatus(d, [])).toBe(EXIT.STATE);
    expect(d.io.stderr[0]).toBe(`morph: ${MORPH_NOT_HERE}`);
  });

  socketTest("a bridge built without Morph answers its ops as unknown", async () => {
    const b = await bridge(false);
    const d = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdMorphStatus(d, [])).toBe(EXIT.UNREACHABLE);
  });
});
