import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentViewService, type ViewGate } from "../bridge/agent-view/service.ts";
import { AgentViewStore } from "../bridge/agent-view/store.ts";
import type { BeaconMatcher } from "../bridge/beacon/decorate.ts";
import { deniedFoldersSync, HillMediaStore } from "../bridge/hill/media.ts";
import { walkyPlace } from "../bridge/hill/walky.ts";
import { HOST } from "../bridge/host.ts";
import type { WalkyHost, WalkyPane } from "../bridge/walky/deliver.ts";
import { WalkyLog } from "../bridge/walky/log.ts";
import { unknownOp } from "../bridge/walky/refusals.ts";
import { WalkyService } from "../bridge/walky/service.ts";
import { VIEW_NEEDS_A_PANE, walkySocketPath, WalkyServer, type PlaceTarget } from "../bridge/walky/socket.ts";
import { spaceOf } from "../bridge/walky/space.ts";
import { asJsonObject, parseJsonObject } from "../web/src/lib/json.ts";
import { VIEW_NOTE_MAX, parseViewChoice, parseAgentView } from "../web/src/lib/agent-view/wire.ts";
import { NODE_ATTRS, NODE_KINDS, TONES } from "../web/src/lib/tricks/schema.ts";
import { capture, context } from "./fakes.ts";
import { EXIT } from "./io.ts";
import { TRICKS_WINDOWS_LINE } from "../web/src/lib/tricks/schema.ts";
import { viewHelpWithRules, viewRulesIdOf } from "./trick-view-help.ts";
import {
  attrsOf,
  cmdTrickView,
  cmdViewChoice,
  cmdViewClear,
  cmdViewHelp,
  cmdViewKeep,
  cmdViewPending,
  cmdViewRemove,
  cmdViewSet,
  cmdViewShow,
  cmdViewStart,
  cmdViewStatus,
  VIEW_BLOCKS_EXAMPLE,
  VIEW_CHOICE_EXAMPLE,
  VIEW_CHOICE_EXAMPLE_IMAGES,
  VIEW_SUBCOMMANDS,
  VIEW_CLOSED_SETS,
  VIEW_EXAMPLE,
  VIEW_NOT_HERE,
  VIEW_UNKNOWN,
  viewClosedSetLines,
  viewHelp,
  viewKindLines,
  viewTopLines,
  parseBlockArgs,
  parseShowArgs,
  readBlock,
  readChoice,
  readScreen,
  type ViewCall,
} from "./trick-view.ts";
import { realFiles } from "./sys.ts";
import { askSocket } from "./walky.ts";

const SOLO_SPACE = spaceOf({ memberId: "local", spaceId: "w1", spaceLabel: "w1" });
const BIN = "/home/op/apps/collie/bin/collie";
/** The trick the tests draw for, and one the gate does not know. */
const T = "morph";
const UNKNOWN_TRICK = "notes";
const RULES = "Draw one calm screen.\nKeep it short.\n";
const ONE = "local/%1#aaaa";

// `collie trick view <trick> <verb>` against a real bridge socket in a temp state dir, as cli/hill.test.ts
// drives the hill: the socket, the request lines and the answers are the real ones; only the panes are fakes.
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

/** A valid screen for the bridge: a heading and a bar with one button. */
const GOOD_VIEW = [
  { kind: "para", text: "Two tests fail after the rename", attrs: { role: "heading" } },
  { kind: "bar", kids: [{ kind: "button", attrs: { label: "Fix both", intent: "reply" } }] },
];

/** The gate of the fake world: the trick `T` is an approved, switched-on agent view; any other id is no trick. */
function gateOf(trick: string): ViewGate {
  if (trick === T) return { ok: true, name: "Morph", rules: RULES };
  return { ok: false, code: "no_trick", error: `no trick ${trick} is known here` };
}

/** The rules id the service compares a `start --rules` with. */
const RULES_ID = viewRulesIdOf(T, RULES);

async function bridge(withViews = true): Promise<{ readonly stateDir: string; readonly views: AgentViewService }> {
  const stateDir = mkdtempSync(join(tmpdir(), "view-cli-"));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const host: WalkyHost = { panes: () => panes, send: async () => ({ outcome: "sent" }), sendState: () => ({ outcome: "sent" }), cancelHeld: () => undefined };
  const walky = new WalkyService({ log: new WalkyLog(join(stateDir, "walky")), host, memberId: null, enabled: () => true, machine: "desk", keyPem: () => null });
  const views = new AgentViewService({
    store: new AgentViewStore(null, () => 1000),
    place: walkyPlace(walky, null),
    sessionsKnown: () => true,
    crewMode: () => "solo",
    binary: BIN,
    gate: { check: gateOf, fresh: async (trick) => gateOf(trick) },
    rulesIdOf: viewRulesIdOf,
    helpOf: viewHelpWithRules,
    now: () => Date.parse("2026-11-10T10:00:00.000Z"),
    media: new HillMediaStore(join(stateDir, "views"), deniedFoldersSync([stateDir]), () => undefined),
  });
  const base = { socketPath: walkySocketPath(stateDir), service: walky, targets: () => [target], log: () => undefined };
  const server = withViews ? new WalkyServer({ ...base, views }) : new WalkyServer(base);
  expect(await server.start()).toBe(true);
  cleanups.push(() => server.stop());
  return { stateDir, views };
}

/** The person switches a view on, as the phone does. No verb of the CLI can. */
async function switchOn(views: AgentViewService, session = ONE, trick = T): Promise<void> {
  const answer = await views.switch({ trick, session, on: true }, null);
  if (!answer.ok) throw new Error(`switch refused: ${answer.error}`);
}

async function switchOff(views: AgentViewService, session = ONE, trick = T): Promise<void> {
  const answer = await views.switch({ trick, session, on: false }, null);
  if (!answer.ok) throw new Error(`switch refused: ${answer.error}`);
}

/** A bridge of an older release without agent views: it answers `unknownOp` to an op it does not know. */
async function olderBridge(): Promise<string> {
  const stateDir = mkdtempSync(join(tmpdir(), "view-older-"));
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

function deps(sockets: string[], env: Record<string, string> = inPane("%1"), over: Partial<ViewCall> = {}): ViewCall & { readonly io: ReturnType<typeof capture> } {
  const io = capture();
  const cwd = mkdtempSync(join(tmpdir(), "view-cwd-"));
  const staging = mkdtempSync(join(tmpdir(), "view-staging-"));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  cleanups.push(() => rmSync(staging, { recursive: true, force: true }));
  return {
    trick: T,
    stagingRoot: () => staging,
    ctx: context(env, { stateDir: mkdtempSync(join(tmpdir(), "view-own-")) }),
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
  const dir = mkdtempSync("/tmp/view-pic-");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return () => dir;
}

function screenFile(d: ViewCall, content: string, name = "screen.json"): string {
  const path = join(d.cwd!(), name);
  writeFileSync(path, content);
  return name;
}

describe("help", () => {
  // The examples carry no `value`: a tap sends its label (rule 3), so the help's own example must pass.
  test("the example parses with the real part-view parser", () => {
    expect(parseAgentView(VIEW_EXAMPLE).refusals).toEqual([]);
  });

  test("the printed example parses too", () => {
    const example = viewHelp({ trick: T }).find((line) => line.startsWith("[{"));
    expect(example).toBeDefined();
    expect(parseAgentView(JSON.parse(example!)).view).toBeDefined();
  });

  test("the printed example is the same JSON, and the help holds the rules", () => {
    const lines = viewHelp({ trick: T });
    expect(lines).toContain(JSON.stringify(VIEW_EXAMPLE));
    const text = lines.join("\n");
    for (const words of ["One screen per answer", '"confirm"', "Never imitate a permission dialog", "A button takes no \"value\""]) expect(text).toContain(words);
  });

  test("the usage says a picture under /tmp is copied for the bridge", () => {
    expect(viewHelp({ trick: T }).join("\n")).toContain("A picture under /tmp is copied for the bridge, so you need not move it.");
  });

  test("the first rule is the scope; the next is to call start first, then show", () => {
    const rules = viewHelp({ trick: T }).filter((line) => line.startsWith("- "));
    expect(rules[0]).toContain("These rules apply only to a message whose first line starts with [view:morph <your address>] from operator:");
    expect(rules[1]).toContain("FIRST");
    expect(rules[1]).toContain("trick view morph start");
    expect(rules[1]).toContain("trick view morph show");
  });

  test("states the button's attrs, that a button takes no text, and how a decision is shaped", () => {
    const text = viewHelp({ trick: T }).join("\n");
    expect(text).toContain('"label" (one line, at most');
    expect(text).toContain('"intent" (use "intent": "reply")');
    expect(text).toContain('no "text"');
    expect(text).toContain('place it with {"kind":"image","attrs":{"ref":"0"}}');
    expect(text).toContain('A decision is a "choice"');
  });

  test("the commands and the rules name the trick, and no line speaks of the old verb", () => {
    const text = viewHelp({ trick: "notes" }).join("\n");
    expect(text).toContain("[view:notes <address>]");
    expect(text).toContain('The trick "notes" adds this one');
    expect(text).toContain("collie trick view notes show --session <session> <file.json>");
    expect(text).not.toContain("collie morph");
    expect(text).not.toContain("trick view morph");
    expect(viewTopLines().join("\n")).toContain("collie trick view <trick> <verb>");
  });

  test("with a session every command carries it; without, the commands say where to copy it from", () => {
    const filled = viewHelp({ trick: T, session: "local/%1#aaaa" }).join("\n");
    expect(filled).toContain('collie trick view morph start --session local/%1#aaaa --rules <rules id> "<3 to 6 words on what you are doing>"');
    expect(filled).toContain("collie trick view morph show --session local/%1#aaaa <file.json>");
    expect(filled).not.toContain("<session>");
    const bare = viewHelp({ trick: T }).join("\n");
    expect(bare).toContain('collie trick view morph start --session <session> --rules <rules id> "<3 to 6 words on what you are doing>"');
    expect(bare).toContain("replace <session> with the address in the request's head, [view:morph <address>]");
    expect(bare).toContain("never invent one");
    expect(viewHelp({ trick: T, session: "local/a b#aaaa" }).join("\n")).toContain("--session 'local/a b#aaaa' <file.json>");
  });

  test("every attribute with a closed set lists its values, from the schema, tones first", () => {
    const lines = viewClosedSetLines();
    expect(lines[1]).toStartWith("  tone (");
    expect(lines[1]).toContain(TONES.join(", "));
    expect(lines[1]).not.toContain("success");
    // `pressed` is Collie's to mark in an agent view (review 10 W7): no closed set offers it.
    expect(lines.join("\n")).not.toContain("pressed");
    // Every (kind, attribute) pair the table names exists in the schema's own table.
    for (const set of VIEW_CLOSED_SETS) {
      expect(set.kinds.length).toBeGreaterThan(0);
      for (const kind of set.kinds) expect(attrsOf(kind).includes(set.attr)).toBe(true);
    }
  });

  test("the kinds come from the schema: every kind is named, with every attribute", () => {
    const kinds = viewKindLines().join("\n");
    for (const kind of NODE_KINDS) expect(kinds).toContain(kind);
    // Every attribute but `pressed`, which Collie marks (review 10 W7).
    expect(kinds).toContain(`  button  attrs: ${NODE_ATTRS.button.filter((name) => name !== "pressed").map((name) => (name === "label" ? "label*" : name)).join(", ")}`);
  });

  test("help names the rules id it is given, in the text and in command 1", () => {
    const text = viewHelp({ trick: T, session: "local/%1#aaaa", rulesId: "1a2b3c4d" }).join("\n");
    expect(text).toContain("The rules id of this text and the trick's own rules is 1a2b3c4d.");
    expect(text).toContain('collie trick view morph start --session local/%1#aaaa --rules 1a2b3c4d "<3 to 6 words on what you are doing>"');
    expect(viewHelp({ trick: T, rulesId: RULES_ID }).join("\n")).toContain(`--rules ${RULES_ID}`);
  });

  test("help with no bridge prints the core help on stdout, one line on stderr, and exits 0; a bad address exits 2", async () => {
    const d = deps([]);
    expect(await cmdViewHelp(d, ["--session", "anything/%9#zzzz"])).toBe(EXIT.OK);
    expect(d.io.stdout.join("\n")).toContain("collie trick view morph show --session anything/%9#zzzz <file.json>");
    expect(d.io.stderr.join("\n")).toContain(VIEW_UNKNOWN);
    expect(await cmdViewHelp(deps([]), ["--session"])).toBe(EXIT.USAGE);
    expect(await cmdViewHelp(deps([]), ["--session", "a'b"])).toBe(EXIT.USAGE);
    expect(await cmdViewHelp(deps([]), ["--json"])).toBe(EXIT.USAGE);
    expect(await cmdViewHelp(deps([]), ["extra"])).toBe(EXIT.USAGE);
  });

  test("on Windows help prints the core help and asks no bridge", async () => {
    const sent: string[] = [];
    const d = deps([], inPane("%1"), { platform: "win32", ask: async (_path, line) => (sent.push(line), null) });
    expect(await cmdViewHelp(d, [])).toBe(EXIT.OK);
    expect(sent).toEqual([]);
    expect(d.io.stdout.length).toBeGreaterThan(10);
    expect(d.io.stderr).toEqual([]);
  });
});

describe("the dispatcher", () => {
  test("windows gate: every verb answers the line on a Windows machine, asks no bridge, and exits 1; help still prints", async () => {
    for (const verb of ["start", "show", "set", "status", "help"]) {
      const sent: string[] = [];
      const d = deps([], inPane("%1"), { platform: "win32", ask: async (_path, line) => (sent.push(line), null) });
      expect(await cmdTrickView(d, [T, verb, "--session", "anything"])).toBe(EXIT.FAIL);
      expect(d.io.stderr).toEqual([`error: ${TRICKS_WINDOWS_LINE}`]);
      expect(d.io.stdout).toEqual([]);
      expect(sent).toEqual([]);
    }
    const help = deps([], inPane("%1"), { platform: "win32" });
    expect(await cmdTrickView(help, ["--help"])).toBe(EXIT.OK);
    expect(help.io.stdout).toEqual(viewTopLines());
  });

  test("a bare call prints the top lines on stderr and exits 2; --help prints them on stdout and exits 0", async () => {
    const bare = deps([]);
    expect(await cmdTrickView(bare, [])).toBe(EXIT.USAGE);
    expect(bare.io.stdout).toEqual([]);
    expect(bare.io.stderr).toEqual(viewTopLines());
    for (const flag of ["--help", "-h"]) {
      const help = deps([]);
      expect(await cmdTrickView(help, [flag])).toBe(EXIT.OK);
      expect(help.io.stdout).toEqual(viewTopLines());
      expect(help.io.stderr).toEqual([]);
    }
    const top = viewTopLines().join("\n");
    for (const verb of VIEW_SUBCOMMANDS) expect(top).toContain(`collie trick view <trick> ${verb} `);
  });

  test("a trick id alone, or with --help, prints the top lines: exit 2 and exit 0", async () => {
    const alone = deps([]);
    expect(await cmdTrickView(alone, [T])).toBe(EXIT.USAGE);
    expect(alone.io.stderr).toEqual(viewTopLines());
    const help = deps([]);
    expect(await cmdTrickView(help, [T, "--help"])).toBe(EXIT.OK);
    expect(help.io.stdout).toEqual(viewTopLines());
  });

  test("a bad trick id is refused before any bridge is asked", async () => {
    const sent: string[] = [];
    for (const bad of ["Morph", "-morph", "has space", "a/b", "x".repeat(33)]) {
      const d = deps(["/nowhere"], inPane("%1"), { ask: async (_path, line) => (sent.push(line), null) });
      expect(await cmdTrickView(d, [bad, "status"])).toBe(EXIT.USAGE);
      expect(d.io.stderr[0]).toContain("is not a trick id");
    }
    expect(sent).toEqual([]);
  });

  test("an unknown verb is named, prints the top lines, exits 2, and asks no bridge; `on` and `off` are no verbs any more", async () => {
    const sent: string[] = [];
    for (const verb of ["nope", "on", "off", "toString", "__proto__"]) {
      const d = deps(["/nowhere"], inPane("%1"), { ask: async (_path, line) => (sent.push(line), null) });
      expect(await cmdTrickView(d, [T, verb])).toBe(EXIT.USAGE);
      expect(d.io.stderr[0]).toBe(`error: unknown trick view command \`${verb}\``);
      expect(d.io.stderr.slice(1)).toEqual(viewTopLines());
      expect(d.io.stdout).toEqual([]);
    }
    expect(sent).toEqual([]);
  });

  socketTest("a good verb reaches the bridge with the trick in the request line, as `trick.view.<verb>`", async () => {
    const b = await bridge();
    const sent: string[] = [];
    const d = deps([walkySocketPath(b.stateDir)], inPane("%1"), {
      ask: (path, line) => {
        sent.push(line);
        return askSocket(path, line, 2000);
      },
    });
    expect(await cmdTrickView(d, [T, "status", "--json"])).toBe(EXIT.OK);
    const request = parseJsonObject(sent.at(-1)!);
    expect(request).toMatchObject({ v: 1, op: "trick.view.status", trick: T });
    expect(Array.isArray(request?.markers) && request.markers.length > 0).toBe(true);
    expect(JSON.parse(d.io.stdout[0]!)).toMatchObject({ trickView: { trick: T, session: ONE, on: false } });

    await switchOn(b.views);
    const shown = deps([walkySocketPath(b.stateDir)], inPane("%1"), {
      ask: (path, line) => {
        sent.push(line);
        return askSocket(path, line, 2000);
      },
    });
    expect(await cmdTrickView(shown, [T, "show", screenFile(shown, JSON.stringify(GOOD_VIEW))])).toBe(EXIT.OK);
    expect(parseJsonObject(sent.at(-1)!)).toMatchObject({ op: "trick.view.show", trick: T });
    expect(shown.io.stdout[0]).toBe("shown: rev 1");
    expect(b.views.status(T, ONE).view?.rev).toBe(1);
  });

  socketTest("a trick the bridge does not know is refused with its code, exit 4", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdTrickView(d, [UNKNOWN_TRICK, "start", "Drawing"])).toBe(EXIT.REFUSED);
    expect(d.io.stderr[0]).toContain("(no_trick)");
  });

  socketTest("help prints the bridge's own lines, framed rules included, when the view is on", async () => {
    const b = await bridge();
    await switchOn(b.views);
    const d = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdTrickView(d, [T, "help"])).toBe(EXIT.OK);
    expect(d.io.stderr).toEqual([]);
    const expected = viewHelpWithRules({ binary: BIN, trick: T, session: ONE, rules: RULES, rulesId: RULES_ID });
    expect(d.io.stdout).toEqual(expected);
    expect(d.io.stdout).toContain(`Collie on this machine: ${BIN}`);
    expect(d.io.stdout.filter((line) => line.startsWith("━━━"))).toHaveLength(2);
    expect(d.io.stdout).toContain("Draw one calm screen.");
    expect(d.io.stdout.join("\n")).toContain(`The rules id of this text and the trick's own rules is ${RULES_ID}.`);
  });

  socketTest("help with the view off prints the core help and one line on stderr, exit 0, and no rules of the trick", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdViewHelp(d, [])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(viewHelp({ trick: T, session: null }));
    expect(d.io.stdout).not.toContain("Draw one calm screen.");
    expect(d.io.stderr.filter((line) => line !== "")).toHaveLength(1);
    expect(d.io.stderr.join("\n")).toContain(`only to a session whose view of "${T}" is on`);
    expect(d.io.stderr.join("\n")).toContain("this view is off for this session");
  });
});

describe("pictures and the decision block", () => {
  test("the choice example's view parses with its three pictures", () => {
    const example = asJsonObject(VIEW_CHOICE_EXAMPLE);
    expect(parseAgentView(example?.view, "/view", { images: VIEW_CHOICE_EXAMPLE_IMAGES }).refusals).toEqual([]);
  });

  test("rule 3 addition: the choice example's choice parses with its three pictures, its options carry no value", () => {
    const example = asJsonObject(VIEW_CHOICE_EXAMPLE);
    expect(parseViewChoice(example?.choice, "/choice", { images: VIEW_CHOICE_EXAMPLE_IMAGES }).refusals).toEqual([]);
  });

  test("the printed choice example is the constant", () => {
    const printed = viewHelp({ trick: T }).find((line) => line.startsWith('{"title"'));
    expect(printed === undefined ? undefined : JSON.parse(printed)).toEqual(VIEW_CHOICE_EXAMPLE);
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
  socketTest("a write while the view is off is refused view_off, and nothing is stored; the person's switch opens it", async () => {
    const b = await bridge();
    const sockets = [walkySocketPath(b.stateDir)];
    const off = deps(sockets);
    expect(await cmdViewShow(off, [screenFile(off, JSON.stringify(GOOD_VIEW)), "--title", "Tests"])).toBe(EXIT.REFUSED);
    expect(off.io.stderr[0]).toContain("(view_off)");
    expect(off.io.stderr[0]).toContain("only the person turns it on, on the phone");
    expect(b.views.status(T, ONE).view).toBeUndefined();
    // `status` reads while off, and says why.
    const status = deps(sockets);
    expect(await cmdViewStatus(status, [])).toBe(EXIT.OK);
    expect(status.io.stdout.slice(0, 3)).toEqual([`trick: ${T}`, `session: ${ONE}`, "view: off (switch)"]);

    await switchOn(b.views);
    const shown = deps(sockets);
    expect(await cmdViewShow(shown, [screenFile(shown, JSON.stringify(GOOD_VIEW)), "--title", "Tests"])).toBe(EXIT.OK);
    expect(shown.io.stdout[0]).toBe("shown: rev 1");
    expect(b.views.status(T, ONE).view?.title).toBe("Tests");
  });

  socketTest("show, status, clear and the person's switch follow the session", async () => {
    const b = await bridge();
    const sockets = [walkySocketPath(b.stateDir)];
    await switchOn(b.views);

    const shown = deps(sockets);
    expect(await cmdViewShow(shown, [screenFile(shown, JSON.stringify(GOOD_VIEW))])).toBe(EXIT.OK);
    expect(shown.io.stdout[0]).toBe("shown: rev 1");
    expect(shown.io.stdout.slice(1, 4)).toEqual([`trick: ${T}`, `session: ${ONE}`, "view: on"]);
    expect(shown.io.stdout.at(-1)).toStartWith(`sent as: [view:${T} ${ONE}] from operator: <text> [rules: `);
    expect(shown.io.stdout.at(-1)).toContain(`trick view ${T} help`);

    const again = deps(sockets);
    expect(await cmdViewShow(again, [screenFile(again, JSON.stringify(GOOD_VIEW))])).toBe(EXIT.OK);
    expect(again.io.stdout[0]).toBe("shown: rev 2");

    const status = deps(sockets, inPane("%1"));
    expect(await cmdViewStatus(status, ["--json"])).toBe(EXIT.OK);
    expect(JSON.parse(status.io.stdout[0]!)).toMatchObject({ trickView: { trick: T, session: ONE, on: true, view: { rev: 2 } } });

    const pictured = deps(sockets);
    writeFileSync(join(pictured.cwd!(), "shot.png"), PNG);
    expect(await cmdViewShow(pictured, [screenFile(pictured, JSON.stringify({ view: [{ kind: "image", attrs: { ref: "0" } }], choice: { options: [{ label: "This", preview: 0 }] } })), "--image", "shot.png=Now"])).toBe(EXIT.OK);
    const screen = b.views.status(T, ONE).view;
    expect(screen?.media?.map((m) => [m.mime, m.caption])).toEqual([["image/png", "Now"]]);
    expect(screen?.choice?.options[0]).toEqual({ label: "This", preview: 0 });

    const clear = deps(sockets);
    expect(await cmdViewClear(clear, [])).toBe(EXIT.OK);
    expect(clear.io.stdout[0]).toBe("cleared");
    expect(clear.io.stdout).toContain("screen: none");

    // The person switches it off: the agent's status says so, and a write is refused again.
    await switchOff(b.views);
    const off = deps(sockets);
    expect(await cmdViewStatus(off, [])).toBe(EXIT.OK);
    expect(off.io.stdout).toContain("view: off (switch)");
    const refused = deps(sockets);
    expect(await cmdViewClear(refused, [])).toBe(EXIT.REFUSED);
    expect(refused.io.stderr[0]).toContain("(view_off)");

    // Another pane's session is its own.
    const other = deps(sockets, inPane("%2"));
    expect(await cmdViewStatus(other, [])).toBe(EXIT.OK);
    // An off view has no head to send under, so `status` prints no `sent as` line.
    expect(other.io.stdout).toEqual([`trick: ${T}`, "session: local/%2#bbbb", "view: off (switch)", "screen: none"]);
  });

  socketTest("a picture under /tmp is staged for the bridge, which gets the staged path, and the stage is gone afterwards", async () => {
    const b = await bridge();
    await switchOn(b.views);
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
    expect(await cmdViewShow(d, [screenFile(d, view), "--image", "shot.png=Now"])).toBe(EXIT.OK);
    const path = /"path":"([^"]+)"/u.exec(sent.at(-1)!)?.[1] ?? "";
    if (HOST.platform === "linux") expect(path.startsWith(staging)).toBe(true);
    expect(b.views.status(T, ONE).view?.media?.[0]?.caption).toBe("Now");
    expect(readdirSync(staging)).toEqual([]);

    const set = deps([walkySocketPath(b.stateDir)], inPane("%1"), { stagingRoot: () => staging, cwd: tmpCwd() });
    writeFileSync(join(set.cwd!(), "more.png"), PNG);
    expect(await cmdViewSet(set, ["b2", screenFile(set, JSON.stringify({ kind: "image", attrs: { ref: "1" } }), "b.json"), "--image", "more.png"])).toBe(EXIT.OK);
    expect(readdirSync(staging)).toEqual([]);
  });

  socketTest("a refused picture under /tmp exits as a refusal, names the path the agent gave, and leaves no stage", async () => {
    const b = await bridge();
    await switchOn(b.views);
    const d = deps([walkySocketPath(b.stateDir)], inPane("%1"), { cwd: tmpCwd() });
    writeFileSync(join(d.cwd!(), "notes.png"), "not an image at all");
    const view = JSON.stringify({ view: [{ kind: "image", attrs: { ref: "0" } }] });
    const code = await cmdViewShow(d, [screenFile(d, view), "--image", "notes.png"]);
    if (HOST.platform !== "linux") return;
    expect(code).toBe(EXIT.REFUSED);
    expect(d.io.stderr[0]).toContain(`trick view: ${join(realpathSync(d.cwd!()), "notes.png")}: is not a PNG, JPEG or WebP image`);
    expect(d.io.stderr[0]).toContain("(bad_image)");
    expect(readdirSync(d.stagingRoot!())).toEqual([]);
    expect(b.views.status(T, ONE).view).toBeUndefined();
  });

  socketTest("start sets the drawing, status prints the session first and the drawing, show ends it; while off, start is refused", async () => {
    const b = await bridge();
    const sockets = [walkySocketPath(b.stateDir)];
    const refused = deps(sockets);
    expect(await cmdViewStart(refused, ["Checking", "the", "tests"])).toBe(EXIT.REFUSED);
    expect(refused.io.stderr[0]).toContain("(view_off)");
    expect(b.views.status(T, ONE).drawing).toBeUndefined();

    await switchOn(b.views);
    const started = deps(sockets);
    expect(await cmdViewStart(started, ["Checking", "the", "tests"])).toBe(EXIT.OK);
    expect(started.io.stdout[0]).toBe("started");
    expect(b.views.status(T, ONE).drawing?.note).toBe("Checking the tests");

    const status = deps(sockets);
    expect(await cmdViewStatus(status, [])).toBe(EXIT.OK);
    expect(status.io.stdout[0]).toBe(`trick: ${T}`);
    expect(status.io.stdout[1]).toBe(`session: ${ONE}`);
    expect(status.io.stdout.some((line) => line.startsWith("drawing: since ") && line.endsWith(", Checking the tests"))).toBe(true);

    const noNote = deps(sockets);
    expect(await cmdViewStart(noNote, ["--json"])).toBe(EXIT.OK);
    expect(JSON.parse(noNote.io.stdout[0]!)).toMatchObject({ trickView: { trick: T, session: ONE, on: true } });
    expect(b.views.status(T, ONE).drawing?.note).toBeUndefined();

    const shown = deps(sockets);
    expect(await cmdViewShow(shown, [screenFile(shown, JSON.stringify(GOOD_VIEW))])).toBe(EXIT.OK);
    expect(b.views.status(T, ONE).drawing).toBeUndefined();
  });

  socketTest("start --rules carries the id to the bridge: the current one drops the tail, a wrong one is no refusal", async () => {
    const b = await bridge();
    const sockets = [walkySocketPath(b.stateDir)];
    await switchOn(b.views);
    expect(await cmdViewStart(deps(sockets), ["--rules", "0000ffff", "Drawing"])).toBe(EXIT.OK);
    expect(b.views.status(T, ONE).hint).toBeDefined();
    const proven = deps(sockets);
    expect(await cmdViewStart(proven, ["--session", ONE, "--rules", RULES_ID, "Drawing", "the", "screen"])).toBe(EXIT.OK);
    expect(b.views.status(T, ONE).hint).toBeUndefined();
    expect(b.views.status(T, ONE).drawing?.note).toBe("Drawing the screen");
    expect(proven.io.stdout.at(-1)).toBe(`sent as: [view:${T} ${ONE}] from operator: <text>`);

    const bad = deps(sockets);
    expect(await cmdViewStart(bad, ["--rules"])).toBe(EXIT.USAGE);
    expect(await cmdViewStart(deps(sockets), ["--rules", "a b"])).toBe(EXIT.USAGE);
    // Only `start` takes it.
    expect(await cmdViewStatus(deps(sockets), ["--rules", RULES_ID])).toBe(EXIT.USAGE);
  });

  socketTest("a note past the cap is refused with exit 4", async () => {
    const b = await bridge();
    await switchOn(b.views);
    const d = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdViewStart(d, ["x".repeat(VIEW_NOTE_MAX + 1)])).toBe(EXIT.REFUSED);
    expect(d.io.stderr[0]).toContain("(bad_note)");
  });

  socketTest("--session naming the pane's own session is accepted, with or without the token", async () => {
    const b = await bridge();
    await switchOn(b.views);
    const sockets = [walkySocketPath(b.stateDir)];
    for (const given of [ONE, "local/%1"]) {
      const d = deps(sockets);
      expect(await cmdViewStart(d, ["--session", given, "Drawing"])).toBe(EXIT.OK);
    }
    const shown = deps(sockets);
    expect(await cmdViewShow(shown, ["--session", ONE, screenFile(shown, JSON.stringify(GOOD_VIEW))])).toBe(EXIT.OK);
    const clear = deps(sockets);
    expect(await cmdViewClear(clear, ["--session", "local/%1"])).toBe(EXIT.OK);
  });

  socketTest("--session naming another session is refused wrong_session with both addresses, exit 4, and nothing is drawn", async () => {
    const b = await bridge();
    await switchOn(b.views);
    const sockets = [walkySocketPath(b.stateDir)];
    // A wrong token in the same pane, and another pane's address.
    for (const given of ["local/%1#bbbb", "local/%2#bbbb", "elsewhere/%1#aaaa"]) {
      const start = deps(sockets);
      expect(await cmdViewStart(start, ["--session", given, "Drawing"])).toBe(EXIT.REFUSED);
      expect(start.io.stderr[0]).toContain("(wrong_session)");
      expect(start.io.stderr[0]).toContain(`this pane is ${ONE}, the command names ${given}`);
      const show = deps(sockets);
      expect(await cmdViewShow(show, ["--session", given, screenFile(show, JSON.stringify(GOOD_VIEW))])).toBe(EXIT.REFUSED);
      const clear = deps(sockets);
      expect(await cmdViewClear(clear, ["--session", given])).toBe(EXIT.REFUSED);
    }
    expect(b.views.status(T, ONE)).toMatchObject({ on: true });
    expect(b.views.status(T, ONE).view).toBeUndefined();
    expect(b.views.status(T, ONE).drawing).toBeUndefined();
    expect(b.views.status(T, "local/%2#bbbb").view).toBeUndefined();
  });

  socketTest("reads the screen from stdin with -", async () => {
    const b = await bridge();
    await switchOn(b.views);
    const d = deps([walkySocketPath(b.stateDir)], inPane("%1"), { stdinIsTty: false, readStdin: async () => JSON.stringify({ title: "From stdin", view: GOOD_VIEW }) });
    expect(await cmdViewShow(d, ["-"])).toBe(EXIT.OK);
    expect(b.views.status(T, ONE).view?.title).toBe("From stdin");
  });

  socketTest("a bad view is refused with exit 4 and each node's path and reason", async () => {
    const b = await bridge();
    await switchOn(b.views);
    const d = deps([walkySocketPath(b.stateDir)]);
    const bad = [{ kind: "para", text: "ok" }, { kind: "bar", kids: [{ kind: "button", attrs: { label: "Go" } }] }];
    expect(await cmdViewShow(d, [screenFile(d, JSON.stringify(bad))])).toBe(EXIT.REFUSED);
    expect(d.io.stderr[0]).toContain("(bad_view)");
    expect(d.io.stderr.some((line) => line.trim().startsWith("/view/1/kids/0"))).toBe(true);
  });

  socketTest("a shell pane is refused: a screen belongs to an agent's session", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)], inPane("%3"));
    expect(await cmdViewStart(d, ["Drawing"])).toBe(EXIT.STATE);
    expect(d.io.stderr[0]).toBe(`trick view: ${VIEW_NEEDS_A_PANE}`);
  });

  socketTest("a bridge without agent views is asked past; with none that knows them, exit 5", async () => {
    const older = await olderBridge();
    const d = deps([older]);
    expect(await cmdViewStatus(d, [])).toBe(EXIT.UNREACHABLE);
    expect(d.io.stderr[0]).toBe(`trick view: ${VIEW_UNKNOWN}`);
    const b = await bridge();
    const past = deps([older, walkySocketPath(b.stateDir)]);
    expect(await cmdViewStatus(past, [])).toBe(EXIT.OK);
    expect(past.io.stdout[0]).toBe(`trick: ${T}`);
  });

  socketTest("a bridge that knows agent views but not this pane answers not here", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)], inPane("%7"));
    expect(await cmdViewStatus(d, [])).toBe(EXIT.STATE);
    expect(d.io.stderr[0]).toBe(`trick view: ${VIEW_NOT_HERE}`);
  });

  socketTest("a bridge built without agent views answers its ops as unknown", async () => {
    const b = await bridge(false);
    const d = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdViewStatus(d, [])).toBe(EXIT.UNREACHABLE);
  });

  socketTest("the block cycle: outline, pending, set fills it, set inserts, remove, keep, choice; status names the blocks", async () => {
    const b = await bridge();
    const sockets = [walkySocketPath(b.stateDir)];
    const session = ONE;
    await switchOn(b.views);

    const outline = deps(sockets);
    expect(await cmdViewShow(outline, [screenFile(outline, JSON.stringify(VIEW_BLOCKS_EXAMPLE.outline))])).toBe(EXIT.OK);
    expect(b.views.status(T, session).view?.blocks?.map((block) => block.id)).toEqual(["summary"]);

    const pending = deps(sockets);
    expect(await cmdViewPending(pending, [VIEW_BLOCKS_EXAMPLE.pending.id, "Running", "the", "tests"])).toBe(EXIT.OK);
    expect(pending.io.stdout[0]).toBe("pending: block tests, rev 2");
    expect(pending.io.stdout).toContain('blocks: summary, tests (pending: "Running the tests")');

    const set = deps(sockets);
    expect(await cmdViewSet(set, ["tests", screenFile(set, JSON.stringify(VIEW_BLOCKS_EXAMPLE.block), "tests.json")])).toBe(EXIT.OK);
    expect(set.io.stdout[0]).toBe("set: block tests, rev 3");
    expect(b.views.status(T, session).view?.view[1]).toMatchObject({ kind: "list" });
    expect(b.views.status(T, session).view?.blocks?.[1]?.pending).toBeUndefined();

    const first = deps(sockets);
    expect(await cmdViewSet(first, ["intro", screenFile(first, JSON.stringify([{ kind: "para", text: "Hello" }]), "intro.json"), "--first"])).toBe(EXIT.OK);
    expect(b.views.status(T, session).view?.blocks?.map((block) => block.id)).toEqual(["intro", "summary", "tests"]);

    const removed = deps(sockets);
    expect(await cmdViewRemove(removed, ["intro"])).toBe(EXIT.OK);
    expect(removed.io.stdout[0]).toBe("removed: block intro, rev 5");

    const choice = deps(sockets);
    expect(await cmdViewChoice(choice, [screenFile(choice, JSON.stringify({ question: "Go on?", options: [{ label: "Yes" }, { label: "No" }] }), "choice.json")])).toBe(EXIT.OK);
    expect(choice.io.stdout).toContain("choice: 2 options");

    const kept = deps(sockets);
    expect(await cmdViewKeep(kept, ["summary", "choice"])).toBe(EXIT.OK);
    expect(kept.io.stdout[0]).toBe("kept: summary, choice, rev 7");

    const cleared = deps(sockets);
    expect(await cmdViewChoice(cleared, ["--clear"])).toBe(EXIT.OK);
    expect(b.views.status(T, session).view?.choice).toBeUndefined();
  });

  socketTest("a block edit that would break the screen is refused, exit 4, and the screen stays", async () => {
    const b = await bridge();
    await switchOn(b.views);
    const sockets = [walkySocketPath(b.stateDir)];
    const shown = deps(sockets);
    expect(await cmdViewShow(shown, [screenFile(shown, JSON.stringify(GOOD_VIEW))])).toBe(EXIT.OK);
    const before = b.views.status(T, ONE).view;

    const bad = deps(sockets);
    expect(await cmdViewSet(bad, ["b2", screenFile(bad, JSON.stringify({ kind: "button", attrs: { label: "Go" } }), "bad.json")])).toBe(EXIT.REFUSED);
    expect(bad.io.stderr[0]).toContain("(bad_view)");

    const missing = deps(sockets);
    expect(await cmdViewKeep(missing, ["nope"])).toBe(EXIT.REFUSED);
    expect(missing.io.stderr[0]).toContain("(bad_block)");
    expect(b.views.status(T, ONE).view).toEqual(before);
  });
});

describe("the block verbs' arguments", () => {
  test("help lists every verb's usage and the cycle, keep and pick rules (review 10 W7: Collie marks the pick)", () => {
    const text = viewHelp({ trick: T, session: "local/%1#aaaa" }).join("\n");
    for (const verb of VIEW_SUBCOMMANDS) expect(text).toContain(`collie trick view morph ${verb} `);
    expect(text).toContain("Draw the outline first: `trick view morph show` with the blocks you know, or `trick view morph pending <id>");
    expect(text).toContain("do not redraw the whole screen");
    expect(text).toContain("When a new request arrives, the operator's screen is cleared of your old blocks.");
    expect(text).toContain("Keep the question's block when you draw the next step; Collie marks the pick.");
    expect(text).not.toContain('"picked"');
    expect(text).not.toMatch(/send its `choice` with/u);
    expect(text).toContain("collie trick view morph pending --session local/%1#aaaa tests \"Running the tests\"");
  });

  test("the blocks example parses: the outline as a view, the block as one node", () => {
    expect(parseAgentView(VIEW_BLOCKS_EXAMPLE.outline).ids).toEqual(["summary"]);
    expect(parseAgentView([VIEW_BLOCKS_EXAMPLE.block]).refusals).toEqual([]);
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
    expect(await cmdViewSet(deps([]), ["b1"])).toBe(EXIT.USAGE);
    expect(await cmdViewPending(deps([]), ["b1"])).toBe(EXIT.USAGE);
    expect(await cmdViewRemove(deps([]), [])).toBe(EXIT.USAGE);
    expect(await cmdViewChoice(deps([]), [])).toBe(EXIT.USAGE);
    expect(await cmdViewChoice(deps([]), ["c.json", "--clear"])).toBe(EXIT.USAGE);
    expect(await cmdViewKeep(deps([]), [])).toBe(EXIT.USAGE);
    expect(await cmdViewKeep(deps([]), ["b1", "--all"])).toBe(EXIT.USAGE);
  });
});
