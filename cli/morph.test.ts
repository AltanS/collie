import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { BeaconMatcher } from "../bridge/beacon/decorate.ts";
import { deniedFoldersSync, HillMediaStore } from "../bridge/hill/media.ts";
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
import { asJsonObject, parseJsonObject } from "../web/src/lib/json.ts";
import { MORPH_NOTE_MAX, parseMorphChoice, parseMorphView } from "../web/src/lib/morph/wire.ts";
import { NODE_ATTRS, NODE_KINDS, TONES } from "../web/src/lib/tricks/schema.ts";
import { capture, context } from "./fakes.ts";
import { EXIT } from "./io.ts";
import {
  attrsOf,
  cmdMorph,
  cmdMorphChoice,
  cmdMorphClear,
  cmdMorphHelp,
  cmdMorphKeep,
  cmdMorphOff,
  cmdMorphOn,
  cmdMorphPending,
  cmdMorphRemove,
  cmdMorphSet,
  cmdMorphShow,
  cmdMorphStart,
  cmdMorphStatus,
  MORPH_BLOCKS_EXAMPLE,
  MORPH_CHOICE_EXAMPLE,
  MORPH_CHOICE_EXAMPLE_IMAGES,
  MORPH_SUBCOMMANDS,
  MORPH_CLOSED_SETS,
  MORPH_EXAMPLE,
  MORPH_NOT_HERE,
  MORPH_UNKNOWN,
  morphClosedSetLines,
  morphHelp,
  morphKindLines,
  parseBlockArgs,
  parseShowArgs,
  readBlock,
  readChoice,
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
/** A PNG's signature and IHDR (390 x 844), enough for the bridge's sniff and size. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0x86, 0, 0, 3, 0x4c, 8, 2, 0, 0, 0, 0, 0, 0, 0, ...Array.from({ length: 32 }, () => 0)]);
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
    media: new HillMediaStore(join(stateDir, "morph"), deniedFoldersSync([stateDir]), () => undefined),
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
  const staging = mkdtempSync(join(tmpdir(), "morph-staging-"));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  cleanups.push(() => rmSync(staging, { recursive: true, force: true }));
  return {
    stagingRoot: () => staging,
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

/** A working folder in the real /tmp, whatever TMPDIR says: the folder a bridge under PrivateTmp cannot see. */
function tmpCwd(): () => string {
  const dir = mkdtempSync("/tmp/morph-pic-");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return () => dir;
}

function screenFile(d: MorphDeps, content: string, name = "screen.json"): string {
  const path = join(d.cwd!(), name);
  writeFileSync(path, content);
  return name;
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

  test("the usage says a picture under /tmp is copied for the bridge", () => {
    expect(morphHelp().join("\n")).toContain("A picture under /tmp is copied for the bridge, so you need not move it.");
  });

  test("the first rule is to call start first, then show", () => {
    const first = morphHelp().find((line) => line.startsWith("- "));
    expect(first).toContain("FIRST");
    expect(first).toContain("morph start");
    expect(first).toContain("morph show");
  });

  test("states the button's attrs, that a button takes no text, and when to use para and line", () => {
    const text = morphHelp().join("\n");
    expect(text).toContain('"label" and "intent" (use "intent": "reply")');
    expect(text).toContain('A button takes no "text"');
    expect(text).toContain("Write sentences as `para` nodes. Use `line` only for short monospace text");
    expect(text).toContain("redraw the screen with \"pressed\": \"true\"");
    expect(text).toContain("Ask one decision per screen");
    expect(text).toContain('place it with {"kind":"image","attrs":{"ref":"0"}}');
    expect(text).toContain('For a decision, use "choice", one decision per screen');
    expect(text).toContain('For a UI question give every option a "preview" picture');
  });

  test("with a session every command carries it; without, the commands say where to copy it from", () => {
    const filled = morphHelp("local/%1#aaaa").join("\n");
    expect(filled).toContain('collie morph start --session local/%1#aaaa "<3 to 6 words on what you are doing>"');
    expect(filled).toContain("collie morph show --session local/%1#aaaa <file.json>");
    expect(filled).not.toContain("<session>");
    const bare = morphHelp().join("\n");
    expect(bare).toContain('collie morph start --session <session> "<3 to 6 words on what you are doing>"');
    expect(bare).toContain("replace <session> with the address after --session");
    expect(bare).toContain("never invent one");
    expect(morphHelp("local/a b#aaaa").join("\n")).toContain("--session 'local/a b#aaaa' <file.json>");
  });

  test("every attribute with a closed set lists its values, from the schema, tones first", () => {
    const lines = morphClosedSetLines();
    expect(lines[1]).toStartWith("  tone (");
    expect(lines[1]).toContain(TONES.join(", "));
    expect(lines[1]).not.toContain("success");
    expect(lines.join("\n")).toContain("pressed (button): true, false, mixed");
    // Every (kind, attribute) pair the table names exists in the schema's own table.
    for (const set of MORPH_CLOSED_SETS) {
      expect(set.kinds.length).toBeGreaterThan(0);
      for (const kind of set.kinds) expect(attrsOf(kind).includes(set.attr)).toBe(true);
    }
  });

  test("`morph help --session <address>` only prints, with the address filled in, and takes any address-shaped text", () => {
    const d = deps([]);
    expect(cmdMorphHelp(d, ["--session", "anything/%9#zzzz"])).toBe(EXIT.OK);
    expect(d.io.stdout.join("\n")).toContain("collie morph show --session anything/%9#zzzz <file.json>");
    const bad = deps([]);
    expect(cmdMorphHelp(bad, ["--session"])).toBe(EXIT.USAGE);
    expect(cmdMorphHelp(deps([]), ["--session", "a'b"])).toBe(EXIT.USAGE);
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

describe("pictures and the decision block", () => {
  test("the choice example parses with its three pictures, view and choice alike", () => {
    const example = asJsonObject(MORPH_CHOICE_EXAMPLE);
    expect(parseMorphView(example?.view, "/view", { images: MORPH_CHOICE_EXAMPLE_IMAGES }).refusals).toEqual([]);
    expect(parseMorphChoice(example?.choice, "/choice", { images: MORPH_CHOICE_EXAMPLE_IMAGES }).refusals).toEqual([]);
    const printed = morphHelp().find((line) => line.startsWith('{"title"'));
    expect(printed === undefined ? undefined : JSON.parse(printed)).toEqual(MORPH_CHOICE_EXAMPLE);
  });

  test("--image takes a path and a caption, at most four times", () => {
    expect(parseShowArgs(["s.json", "--image", "a.png", "--image", "b.png=The new header"])).toMatchObject({ images: [{ path: "a.png" }, { path: "b.png", caption: "The new header" }] });
    expect(parseShowArgs(["s.json", "--image"])).toHaveProperty("error");
    expect(parseShowArgs(["s.json", "--image", "a.png="])).toHaveProperty("error");
    expect(parseShowArgs(["s.json", ...Array.from({ length: 5 }, (_, i) => ["--image", `${String(i)}.png`]).flat()])).toHaveProperty("error");
  });

  test("the screen object takes a choice beside its view and title", () => {
    expect(readScreen(JSON.stringify({ view: [], choice: { options: [{ label: "A" }] } }), null)).toEqual({ view: [], title: null, choice: { options: [{ label: "A" }] } });
    expect(readScreen(JSON.stringify({ view: [], extra: 1 }), null)).toHaveProperty("error");
  });
});

describe("show's arguments and file", () => {
  test("reads a path or -, a title and --json", () => {
    expect(parseShowArgs(["s.json", "--title", "Tests", "--json"])).toEqual({ source: "s.json", title: "Tests", json: true, session: null, images: [] });
    expect(parseShowArgs(["-"])).toEqual({ source: "-", title: null, json: false, session: null, images: [] });
    expect(parseShowArgs(["--session", "local/%1#aaaa", "s.json"])).toEqual({ source: "s.json", title: null, json: false, session: "local/%1#aaaa", images: [] });
    expect(parseShowArgs(["--session"])).toHaveProperty("error");
    expect(parseShowArgs(["--session", "a b", "s.json"])).toHaveProperty("error");
    expect(parseShowArgs(["--session", "a", "--session", "b", "s.json"])).toHaveProperty("error");
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

    const pictured = deps([walkySocketPath(b.stateDir)]);
    writeFileSync(join(pictured.cwd!(), "shot.png"), PNG);
    expect(await cmdMorphShow(pictured, [screenFile(pictured, JSON.stringify({ view: [{ kind: "image", attrs: { ref: "0" } }], choice: { options: [{ label: "This", preview: 0 }] } })), "--image", "shot.png=Now"])).toBe(EXIT.OK);
    const screen = b.morph.status("local/%1#aaaa").view;
    expect(screen?.media?.map((m) => [m.mime, m.caption])).toEqual([["image/png", "Now"]]);
    expect(screen?.choice?.options[0]).toEqual({ label: "This", preview: 0 });

    const clear = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdMorphClear(clear, [])).toBe(EXIT.OK);
    expect(clear.io.stdout).toContain("screen: none");

    const off = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdMorphOff(off, [])).toBe(EXIT.OK);
    expect(off.io.stdout).toContain("morph: off");

    // Another pane's session is its own.
    const other = deps([walkySocketPath(b.stateDir)], inPane("%2"));
    expect(await cmdMorphStatus(other, [])).toBe(EXIT.OK);
    expect(other.io.stdout).toEqual(["session: local/%2#bbbb", "morph: off", "screen: none", `sent as: [morph] from operator: <text> [rules: ${BIN} morph help --session local/%2#bbbb]`]);
  });

  socketTest("a picture under /tmp is staged for the bridge, which gets the staged path, and the stage is gone afterwards", async () => {
    const b = await bridge();
    const sent: string[] = [];
    const d = deps([walkySocketPath(b.stateDir)], inPane("%1"), {
      cwd: tmpCwd(),
      ask: (path, line) => {
        sent.push(line);
        return askSocket(path, line, 2000);
      },
    });
    const staging = d.stagingRoot!();
    writeFileSync(join(d.cwd!(), "shot.png"), PNG);
    const view = JSON.stringify({ view: [{ kind: "image", attrs: { ref: "0" } }] });
    expect(await cmdMorphShow(d, [screenFile(d, view), "--image", "shot.png=Now"])).toBe(EXIT.OK);
    const path = /"path":"([^"]+)"/u.exec(sent.at(-1)!)?.[1] ?? "";
    if (HOST.platform === "linux") expect(path.startsWith(staging)).toBe(true);
    expect(b.morph.status("local/%1#aaaa").view?.media?.[0]?.caption).toBe("Now");
    expect(readdirSync(staging)).toEqual([]);

    const set = deps([walkySocketPath(b.stateDir)], inPane("%1"), { stagingRoot: () => staging, cwd: tmpCwd() });
    writeFileSync(join(set.cwd!(), "more.png"), PNG);
    expect(await cmdMorphSet(set, ["b2", screenFile(set, JSON.stringify({ kind: "image", attrs: { ref: "1" } }), "b.json"), "--image", "more.png"])).toBe(EXIT.OK);
    expect(readdirSync(staging)).toEqual([]);
  });

  socketTest("a refused picture under /tmp exits as a refusal, names the path the agent gave, and leaves no stage", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)], inPane("%1"), { cwd: tmpCwd() });
    writeFileSync(join(d.cwd!(), "notes.png"), "not an image at all");
    const view = JSON.stringify({ view: [{ kind: "image", attrs: { ref: "0" } }] });
    const code = await cmdMorphShow(d, [screenFile(d, view), "--image", "notes.png"]);
    if (HOST.platform !== "linux") return;
    expect(code).toBe(EXIT.REFUSED);
    expect(d.io.stderr[0]).toContain(`morph: ${join(realpathSync(d.cwd!()), "notes.png")}: is not a PNG, JPEG or WebP image`);
    expect(d.io.stderr[0]).toContain("(bad_image)");
    expect(readdirSync(d.stagingRoot!())).toEqual([]);
    expect(b.morph.status("local/%1#aaaa").view).toBeUndefined();
  });

  socketTest("start sets the drawing, status prints the session first and the drawing, show ends it", async () => {
    const b = await bridge();
    const sockets = [walkySocketPath(b.stateDir)];
    const started = deps(sockets);
    expect(await cmdMorphStart(started, ["Checking", "the", "tests"])).toBe(EXIT.OK);
    expect(started.io.stdout[0]).toStartWith("started. Morph is off for this session");
    expect(b.morph.status("local/%1#aaaa").drawing?.note).toBe("Checking the tests");

    const status = deps(sockets);
    expect(await cmdMorphStatus(status, [])).toBe(EXIT.OK);
    expect(status.io.stdout[0]).toBe("session: local/%1#aaaa");
    expect(status.io.stdout.some((line) => line.startsWith("drawing: since ") && line.endsWith(", Checking the tests"))).toBe(true);

    await cmdMorphOn(deps(sockets), []);
    const noNote = deps(sockets);
    expect(await cmdMorphStart(noNote, ["--json"])).toBe(EXIT.OK);
    expect(JSON.parse(noNote.io.stdout[0]!)).toMatchObject({ morph: { session: "local/%1#aaaa", on: true } });
    expect(b.morph.status("local/%1#aaaa").drawing?.note).toBeUndefined();

    const shown = deps(sockets);
    expect(await cmdMorphShow(shown, [screenFile(shown, JSON.stringify(MORPH_EXAMPLE))])).toBe(EXIT.OK);
    expect(b.morph.status("local/%1#aaaa").drawing).toBeUndefined();
  });

  socketTest("a note past the cap is refused with exit 4", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdMorphStart(d, ["x".repeat(MORPH_NOTE_MAX + 1)])).toBe(EXIT.REFUSED);
    expect(d.io.stderr[0]).toContain("(bad_note)");
  });

  socketTest("--session naming the pane's own session is accepted, with or without the token", async () => {
    const b = await bridge();
    const sockets = [walkySocketPath(b.stateDir)];
    for (const given of ["local/%1#aaaa", "local/%1"]) {
      const d = deps(sockets);
      expect(await cmdMorphStart(d, ["--session", given, "Drawing"])).toBe(EXIT.OK);
    }
    const shown = deps(sockets);
    expect(await cmdMorphShow(shown, ["--session", "local/%1#aaaa", screenFile(shown, JSON.stringify(MORPH_EXAMPLE))])).toBe(EXIT.OK);
    const clear = deps(sockets);
    expect(await cmdMorphClear(clear, ["--session", "local/%1"])).toBe(EXIT.OK);
  });

  socketTest("--session naming another session is refused wrong_session with both addresses, exit 4, and nothing is drawn", async () => {
    const b = await bridge();
    const sockets = [walkySocketPath(b.stateDir)];
    // A wrong token in the same pane, and another pane's address.
    for (const given of ["local/%1#bbbb", "local/%2#bbbb", "elsewhere/%1#aaaa"]) {
      const start = deps(sockets);
      expect(await cmdMorphStart(start, ["--session", given, "Drawing"])).toBe(EXIT.REFUSED);
      expect(start.io.stderr[0]).toContain("(wrong_session)");
      expect(start.io.stderr[0]).toContain(`this pane is local/%1#aaaa, the command names ${given}`);
      const show = deps(sockets);
      expect(await cmdMorphShow(show, ["--session", given, screenFile(show, JSON.stringify(MORPH_EXAMPLE))])).toBe(EXIT.REFUSED);
      const clear = deps(sockets);
      expect(await cmdMorphClear(clear, ["--session", given])).toBe(EXIT.REFUSED);
    }
    expect(b.morph.status("local/%1#aaaa")).toMatchObject({ on: false });
    expect(b.morph.status("local/%1#aaaa").view).toBeUndefined();
    expect(b.morph.status("local/%1#aaaa").drawing).toBeUndefined();
    expect(b.morph.status("local/%2#bbbb").view).toBeUndefined();
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

  socketTest("the block cycle: outline, pending, set fills it, set inserts, remove, keep, choice; status names the blocks", async () => {
    const b = await bridge();
    const sockets = [walkySocketPath(b.stateDir)];
    const session = "local/%1#aaaa";
    await cmdMorphOn(deps(sockets), []);

    const outline = deps(sockets);
    expect(await cmdMorphShow(outline, [screenFile(outline, JSON.stringify(MORPH_BLOCKS_EXAMPLE.outline))])).toBe(EXIT.OK);
    expect(b.morph.status(session).view?.blocks?.map((block) => block.id)).toEqual(["summary"]);

    const pending = deps(sockets);
    expect(await cmdMorphPending(pending, [MORPH_BLOCKS_EXAMPLE.pending.id, "Running", "the", "tests"])).toBe(EXIT.OK);
    expect(pending.io.stdout[0]).toBe("pending: block tests, rev 2");
    expect(pending.io.stdout).toContain('blocks: summary, tests (pending: "Running the tests")');

    const set = deps(sockets);
    expect(await cmdMorphSet(set, ["tests", screenFile(set, JSON.stringify(MORPH_BLOCKS_EXAMPLE.block), "tests.json")])).toBe(EXIT.OK);
    expect(set.io.stdout[0]).toBe("set: block tests, rev 3");
    expect(b.morph.status(session).view?.view[1]).toMatchObject({ kind: "list" });
    expect(b.morph.status(session).view?.blocks?.[1]?.pending).toBeUndefined();

    const first = deps(sockets);
    expect(await cmdMorphSet(first, ["intro", screenFile(first, JSON.stringify([{ kind: "para", text: "Hello" }]), "intro.json"), "--first"])).toBe(EXIT.OK);
    expect(b.morph.status(session).view?.blocks?.map((block) => block.id)).toEqual(["intro", "summary", "tests"]);

    const removed = deps(sockets);
    expect(await cmdMorphRemove(removed, ["intro"])).toBe(EXIT.OK);
    expect(removed.io.stdout[0]).toBe("removed: block intro, rev 5");

    const choice = deps(sockets);
    expect(await cmdMorphChoice(choice, [screenFile(choice, JSON.stringify({ question: "Go on?", options: [{ label: "Yes" }, { label: "No" }], picked: 0 }), "choice.json")])).toBe(EXIT.OK);
    expect(choice.io.stdout).toContain("choice: 2 options, picked 0");

    const kept = deps(sockets);
    expect(await cmdMorphKeep(kept, ["summary", "choice"])).toBe(EXIT.OK);
    expect(kept.io.stdout[0]).toBe('kept: summary, choice, rev 7');

    const cleared = deps(sockets);
    expect(await cmdMorphChoice(cleared, ["--clear"])).toBe(EXIT.OK);
    expect(b.morph.status(session).view?.choice).toBeUndefined();
  });

  socketTest("a block edit that would break the screen is refused, exit 4, and the screen stays", async () => {
    const b = await bridge();
    const sockets = [walkySocketPath(b.stateDir)];
    const shown = deps(sockets);
    expect(await cmdMorphShow(shown, [screenFile(shown, JSON.stringify(MORPH_EXAMPLE))])).toBe(EXIT.OK);
    const before = b.morph.status("local/%1#aaaa").view;

    const bad = deps(sockets);
    expect(await cmdMorphSet(bad, ["b2", screenFile(bad, JSON.stringify({ kind: "button", attrs: { label: "Go" } }), "bad.json")])).toBe(EXIT.REFUSED);
    expect(bad.io.stderr[0]).toContain("(bad_view)");

    const missing = deps(sockets);
    expect(await cmdMorphKeep(missing, ["nope"])).toBe(EXIT.REFUSED);
    expect(missing.io.stderr[0]).toContain("(bad_block)");
    expect(b.morph.status("local/%1#aaaa").view).toEqual(before);
  });
});

describe("the block verbs' arguments", () => {
  test("help lists every verb's usage and the cycle, keep and picked rules", () => {
    const text = morphHelp("local/%1#aaaa").join("\n");
    for (const verb of MORPH_SUBCOMMANDS) expect(text).toContain(`collie morph ${verb} `);
    expect(text).toContain("Draw the outline first: `morph show` with the blocks you know, or `morph pending <id>");
    expect(text).toContain("do not redraw the whole screen");
    expect(text).toContain("When a new request arrives, the operator's screen is cleared of your old blocks.");
    expect(text).toContain("To show a past decision as settled, send its `choice` with \"picked\"");
    expect(text).toContain("collie morph pending --session local/%1#aaaa tests \"Running the tests\"");
  });

  test("the blocks example parses: the outline as a view, the block as one node", () => {
    expect(parseMorphView(MORPH_BLOCKS_EXAMPLE.outline).ids).toEqual(["summary"]);
    expect(parseMorphView([MORPH_BLOCKS_EXAMPLE.block]).refusals).toEqual([]);
  });

  test("a verb takes only its own flags; --first and --after exclude each other", () => {
    expect(parseBlockArgs(["b1", "f.json", "--after", "b0"], { place: true })).toMatchObject({ words: ["b1", "f.json"], after: "b0", first: false });
    expect(parseBlockArgs(["b1", "--first", "--after", "b0"], { place: true })).toHaveProperty("error");
    expect(parseBlockArgs(["b1", "--after"], { place: true })).toHaveProperty("error");
    expect(parseBlockArgs(["b1", "--first"], {})).toHaveProperty("error");
    expect(parseBlockArgs(["--clear"], { clear: true })).toMatchObject({ clear: true, words: [] });
    expect(parseBlockArgs(["--all"], { clear: true })).toHaveProperty("error");
    expect(parseBlockArgs(["b1", "-"], { images: true })).toMatchObject({ words: ["b1", "-"] });
  });

  test("a block file is one node or a list of one; a choice file is an object", () => {
    expect(readBlock('{"kind":"para","text":"x"}')).toEqual({ node: { kind: "para", text: "x" } });
    expect(readBlock('[{"kind":"para","text":"x"}]')).toEqual({ node: [{ kind: "para", text: "x" }] });
    expect(readBlock("[]")).toHaveProperty("error");
    expect(readBlock('[{"kind":"para"},{"kind":"para"}]')).toHaveProperty("error");
    expect(readBlock("nope")).toHaveProperty("error");
    expect(readChoice('{"options":[]}')).toEqual({ choice: { options: [] } });
    expect(readChoice("[]")).toHaveProperty("error");
  });

  test("usage errors exit 2 before any bridge is asked", async () => {
    expect(await cmdMorphSet(deps([]), ["b1"])).toBe(EXIT.USAGE);
    expect(await cmdMorphPending(deps([]), ["b1"])).toBe(EXIT.USAGE);
    expect(await cmdMorphRemove(deps([]), [])).toBe(EXIT.USAGE);
    expect(await cmdMorphChoice(deps([]), [])).toBe(EXIT.USAGE);
    expect(await cmdMorphChoice(deps([]), ["c.json", "--clear"])).toBe(EXIT.USAGE);
    expect(await cmdMorphKeep(deps([]), [])).toBe(EXIT.USAGE);
    expect(await cmdMorphKeep(deps([]), ["b1", "--all"])).toBe(EXIT.USAGE);
  });
});
