import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BeaconMatcher } from "../bridge/beacon/decorate.ts";
import { HOST } from "../bridge/host.ts";
import type { JsonObject } from "../bridge/json.ts";
import type { LocalProposer } from "../bridge/tricks/propose-door.ts";
import type { ProposeAnswer } from "../bridge/tricks/proposals.ts";
import { PROPOSE_LIMITS, readProposal } from "../bridge/tricks/propose-wire.ts";
import type { WalkyHost, WalkyPane } from "../bridge/walky/deliver.ts";
import { WalkyLog } from "../bridge/walky/log.ts";
import { PROPOSE_LINE_PREFIX, WALKY_LINE_MAX } from "../bridge/walky/parse.ts";
import { WalkyService } from "../bridge/walky/service.ts";
import { spaceOf } from "../bridge/walky/space.ts";
import { PROPOSE_LINE_MS, PROPOSE_LINES_MAX, walkySocketPath, WalkyServer, type PlaceTarget } from "../bridge/walky/socket.ts";
import { MANIFEST_KEYS, PLACE_KINDS } from "../web/src/lib/tricks/schema.ts";
import { asJsonObject, parseJsonObject } from "../web/src/lib/json.ts";
import { capture, context } from "./fakes.ts";
import type { HillDeps } from "./hill.ts";
import { EXIT } from "./io.ts";
import { realFiles } from "./sys.ts";
import { cmdTrickGuide, trickGuide } from "./trick-guide.ts";
import { cmdTrickPropose, PROPOSE_UNKNOWN, proposeExit, readTrickFolder } from "./trick-propose.ts";
import { askSocket } from "./walky.ts";

// `collie trick guide` and `collie trick propose` (crew slice 8). The guide is checked against the schema;
// the propose verb against a real walky socket in a temp state dir, with a fake proposals door behind it,
// so the line, its size rules and who the proposer is are the real ones.

const socketTest = test.skipIf(HOST.platform === "win32");
const posixTest = test.skipIf(HOST.platform === "win32");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("collie trick guide", () => {
  test("names every manifest key and every place, from the schema", () => {
    const text = trickGuide().join("\n");
    for (const key of MANIFEST_KEYS) expect(text).toMatch(new RegExp(`^  ${key} +\\S`, "mu"));
    for (const place of PLACE_KINDS) expect(text).toMatch(new RegExp(`^  ${place} +\\S`, "mu"));
  });

  test("is plain text of 80 to 140 lines: no colour codes, no em dash, no home path", () => {
    const lines = trickGuide();
    expect(lines.length).toBeGreaterThanOrEqual(80);
    expect(lines.length).toBeLessThanOrEqual(140);
    const text = lines.join("\n");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("—");
    expect(text).not.toMatch(/\/home\/|\/var\/home\/|~\//u);
  });

  test("says the numbers the bridge checks with", () => {
    const text = trickGuide().join("\n");
    expect(text).toContain(`at most ${String(PROPOSE_LIMITS.files)} files and 5 MB`);
    expect(text).toContain("collie trick propose <folder>");
    expect(text).toContain("Nothing runs before their yes.");
  });

  test("prints the lines, or one JSON object with the lists; needs no bridge", () => {
    const io = capture();
    expect(cmdTrickGuide({ io }, [])).toBe(EXIT.OK);
    expect(io.stdout).toEqual(trickGuide());
    const json = capture();
    expect(cmdTrickGuide({ io: json }, ["--json"])).toBe(EXIT.OK);
    const body = parseJsonObject(json.stdout[0] ?? "");
    expect(body?.manifestKeys).toEqual([...MANIFEST_KEYS]);
    expect(body?.places).toEqual([...PLACE_KINDS]);
    const bad = capture();
    expect(cmdTrickGuide({ io: bad }, ["extra"])).toBe(EXIT.USAGE);
  });
});

const MANIFEST = 'id = "legs"\nname = "Browser leg"\nrun = "program.ts"\nplaces = ["belt"]\n';

/** A trick folder with the files given, beside the manifest and the program. */
function trickFolder(extra: Record<string, string> = {}): string {
  const dir = join(tempDir("propose-src-"), "legs");
  mkdirSync(dir);
  const files = { "trick.toml": MANIFEST, "program.ts": 'console.log(JSON.stringify({ v: 1, parts: [] }));\n', ...extra };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

describe("the folder read", () => {
  posixTest("leaves dot files, node_modules, logs, inputs/, media/, captures/ and config.toml behind", async () => {
    const dir = trickFolder({ ".env": "SECRET=placeholder", ".git/config": "x", "node_modules/a/index.js": "x", "run.log": "x", "inputs/a.md": "x", "media/a.png": "x", "captures/b.png": "x", "lib/util.ts": "export {};\n", "config.toml": "a = 1\n" });
    chmodSync(join(dir, "program.ts"), 0o755);
    const read = await readTrickFolder(dir);
    if (!read.ok) throw new Error(read.error);
    expect(read.files.map((f) => f.rel).toSorted()).toEqual(["lib/util.ts", "program.ts", "trick.toml"]);
    expect(read.files.find((f) => f.rel === "program.ts")?.executable).toBe(true);
    expect(read.left).toBe(8);
    expect(read.config).toBe(true);
  });

  posixTest("refuses a symbolic link, even to a file inside the folder", async () => {
    const dir = trickFolder();
    symlinkSync(join(dir, "program.ts"), join(dir, "alias.ts"));
    const read = await readTrickFolder(dir);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toBe("alias.ts is a symbolic link. A trick holds regular files only.");
  });

  test("refuses a folder deeper than the cap", async () => {
    const dir = trickFolder({ [`${"d/".repeat(PROPOSE_LIMITS.depth + 1)}x.ts`]: "x" });
    const read = await readTrickFolder(dir);
    expect(read.ok).toBe(false);
  });

  test("what it reads, the one reader takes", async () => {
    const read = await readTrickFolder(trickFolder({ "lib/util.ts": "export {};\n" }));
    if (!read.ok) throw new Error(read.error);
    const { wireFiles } = await import("../bridge/tricks/propose-wire.ts");
    expect(readProposal({ requestId: "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f", files: wireFiles(read.files) }).ok).toBe(true);
  });
});

describe("the exit codes", () => {
  test("a state, unreachable, failed or refused", () => {
    expect(proposeExit("hill_off")).toBe(EXIT.STATE);
    expect(proposeExit("lead_unreachable")).toBe(EXIT.UNREACHABLE);
    expect(proposeExit("failed")).toBe(EXIT.FAIL);
    expect(proposeExit("rate")).toBe(EXIT.REFUSED);
    expect(proposeExit("open_elsewhere")).toBe(EXIT.REFUSED);
  });
});

const matcher: BeaconMatcher = {
  namespace: "tmux",
  scope: async () => "/tmp/tmux-1/default",
  matches: (pane, marker, scope) => marker.scope === scope && pane.paneId === marker.pane,
  notesWithoutHooks: { agentDetection: "", agentSessionRef: "" },
};
const target: PlaceTarget = { session: "main", matcher, paneIds: () => ["%1", "%2"] };
const inPane = (pane: string) => ({ TMUX: "/tmp/tmux-1/default,123,0", TMUX_PANE: pane });
const SPACE = spaceOf({ memberId: "local", spaceId: "w1", spaceLabel: "w1" });
const panes: WalkyPane[] = [
  { session: "main", paneId: "%1", agent: true, harness: "agent-x", label: "repo#one", state: "idle", activeAt: null, instance: "aaaa", terminal: true, off: false, space: SPACE },
  { session: "main", paneId: "%2", agent: false, harness: null, label: "shell", state: "idle", activeAt: null, instance: "bbbb", terminal: true, off: false, space: SPACE },
];

interface ProposeBridge {
  readonly stateDir: string;
  readonly calls: { fields: JsonObject; who: LocalProposer }[];
}

/** A bridge on a real socket whose proposals door records each call and answers `answer`. */
async function bridge(answer: (fields: JsonObject) => Promise<ProposeAnswer> = async () => ({ ok: true, kind: "proposal", id: "legs", hash: "h", decision: "dc_k3m9x2p7q1ab", replaced: null }), withPropose = true, proposeLineMs?: number): Promise<ProposeBridge> {
  const stateDir = tempDir("propose-bridge-");
  const host: WalkyHost = { panes: () => panes, send: async () => ({ outcome: "sent" }), sendState: () => ({ outcome: "sent" }), cancelHeld: () => undefined };
  const walky = new WalkyService({ log: new WalkyLog(join(stateDir, "walky")), host, memberId: null, enabled: () => true, machine: "desk", keyPem: () => null });
  const calls: ProposeBridge["calls"] = [];
  const base = { socketPath: walkySocketPath(stateDir), service: walky, targets: () => [target], log: () => undefined, proposeLineMs: proposeLineMs ?? PROPOSE_LINE_MS };
  const propose = {
    local: async (fields: JsonObject, who: LocalProposer) => {
      calls.push({ fields, who });
      return await answer(fields);
    },
  };
  const server = withPropose ? new WalkyServer({ ...base, propose }) : new WalkyServer(base);
  expect(await server.start()).toBe(true);
  cleanups.push(() => server.stop());
  return { stateDir, calls };
}

function deps(sockets: string[], env: Record<string, string> = inPane("%1")): HillDeps & { readonly io: ReturnType<typeof capture> } {
  const io = capture();
  return {
    ctx: context(env, { stateDir: tempDir("propose-own-") }),
    files: realFiles,
    uid: process.getuid?.(),
    platform: "linux",
    readStdin: async () => "",
    stdinIsTty: true,
    ask: (path, line, ms) => askSocket(path, line, ms ?? 2000),
    sockets: () => sockets,
    mintRequestId: () => "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f",
    now: () => 1000,
    io,
  };
}

/** Send one raw line and read the one answer. */
function rawAsk(path: string, line: string): Promise<JsonObject | undefined> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      text += chunk;
    });
    socket.on("end", () => resolve(parseJsonObject(text.trim())));
    socket.on("error", () => resolve(undefined));
    socket.write(line);
  });
}

describe("collie trick propose, over the walky socket", () => {
  socketTest("from an agent's pane: the line opens with the op, the session proposes, the answer is printed", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)]);
    const code = await cmdTrickPropose(d, [trickFolder({ ".env": "SECRET=placeholder" })]);
    expect(d.io.stderr).toEqual([]);
    expect(code).toBe(EXIT.OK);
    expect(b.calls).toHaveLength(1);
    expect(b.calls[0]?.who.kind).toBe("agent");
    if (b.calls[0]?.who.kind === "agent") expect(b.calls[0].who.label).toBe("repo#one");
    const files = b.calls[0]?.fields.files;
    expect(Array.isArray(files) ? files.map((f) => asJsonObject(f)?.rel) : []).toEqual(["program.ts", "trick.toml"]);
    expect(d.io.stdout).toEqual([
      "Sent 2 files. Left behind: 1 (dot files, node_modules, logs, inputs/, media/, captures/, config.toml).",
      "Proposed legs. Your person sees it on the Hill as dc_k3m9x2p7q1ab. Nothing runs before their yes.",
      "Read the answer with: collie hill status dc_k3m9x2p7q1ab",
    ]);
  });

  socketTest("a config.toml stays behind, and the CLI says so", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdTrickPropose(d, [trickFolder({ "config.toml": "rows = 3\n" })])).toBe(EXIT.OK);
    const files = b.calls[0]?.fields.files;
    expect(Array.isArray(files) ? files.map((f) => asJsonObject(f)?.rel) : []).toEqual(["program.ts", "trick.toml"]);
    expect(d.io.stdout[0]).toBe("Sent 2 files. Left behind: 1 (dot files, node_modules, logs, inputs/, media/, captures/, config.toml).");
    expect(d.io.stdout[1]).toBe("config.toml stays behind: your person sets the trick up on the machine.");
  });

  socketTest("from a bare shell the proposer is a terminal", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)], inPane("%2"));
    expect(await cmdTrickPropose(d, [trickFolder()])).toBe(EXIT.OK);
    expect(b.calls[0]?.who).toEqual({ kind: "terminal" });
  });

  socketTest("a line longer than a walky line still arrives whole", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdTrickPropose(d, [trickFolder({ "data.json": "x".repeat(WALKY_LINE_MAX * 2) })])).toBe(EXIT.OK);
    expect(b.calls).toHaveLength(1);
  });

  socketTest("a refusal prints its words and the request id, with its exit code", async () => {
    const b = await bridge(async () => ({ ok: false, code: "rate", error: "This session proposed 6 tricks in the last hour. Wait, then propose again." }));
    const d = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdTrickPropose(d, [trickFolder()])).toBe(EXIT.REFUSED);
    expect(d.io.stderr).toEqual(["propose: This session proposed 6 tricks in the last hour. Wait, then propose again.", "propose: request id 0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f"]);
  });

  socketTest("a bridge without proposals answers unknown, and the CLI says so", async () => {
    const b = await bridge(undefined, false);
    const d = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdTrickPropose(d, [trickFolder()])).toBe(EXIT.UNREACHABLE);
    expect(d.io.stderr[0]).toBe(`propose: ${PROPOSE_UNKNOWN}`);
  });

  socketTest("a folder trick check refuses is never sent", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)]);
    const dir = trickFolder({ "trick.toml": `${MANIFEST}bogus = 1\n` });
    expect(await cmdTrickPropose(d, [dir])).toBe(EXIT.FAIL);
    expect(b.calls).toEqual([]);
  });

  socketTest("a long line that is not a proposal is refused, and so is a third proposal read at once", async () => {
    const b = await bridge();
    const path = walkySocketPath(b.stateDir);
    // An ordinary op past the walky cap: the short-line rule still holds.
    const long = await rawAsk(path, `${JSON.stringify({ op: "send", v: 1, markers: {}, text: "x".repeat(WALKY_LINE_MAX + 10) })}\n`);
    expect(long?.ok).toBe(false);
    expect(String(long?.error)).toMatch(/^(too long|bad request)/u);
    // A proposal line that names a second op later in the line is still read as nothing but a proposal.
    const twin = await rawAsk(path, `${PROPOSE_LINE_PREFIX}"v":1,"markers":{},"requestId":"x","files":[],"op":"send","pad":"${"x".repeat(WALKY_LINE_MAX)}"}\n`);
    expect(twin?.ok).toBe(false);
    expect(b.calls).toEqual([]);
    // Two slow proposal lines hold the two slots; the third is turned away unread.
    const held = Array.from({ length: PROPOSE_LINES_MAX }, () => {
      const socket = createConnection(path);
      socket.write(`${PROPOSE_LINE_PREFIX}"v":1`);
      return socket;
    });
    cleanups.push(() => {
      for (const socket of held) socket.destroy();
    });
    await Bun.sleep(50);
    const third = await rawAsk(path, `${PROPOSE_LINE_PREFIX}"v":1,"markers":{},"requestId":"x","files":[]}\n`);
    expect(third).toEqual({ ok: false, error: "another proposal is being read; try again in a moment", code: "failed", propose: true });
    for (const socket of held) socket.destroy();
    await Bun.sleep(50);
    const fourth = await rawAsk(path, `${PROPOSE_LINE_PREFIX}"v":1,"markers":{},"requestId":"x","files":[]}\n`);
    expect(fourth?.error).not.toBe("another proposal is being read; try again in a moment");
  });

  socketTest("a client that keeps its end open after the answer holds no slot", async () => {
    const b = await bridge();
    const path = walkySocketPath(b.stateDir);
    const line = `${PROPOSE_LINE_PREFIX}"v":1,"markers":{},"requestId":"x","files":[]}\n`;
    // Clients that read their answer and never close: each must give its slot back.
    const lingering: ReturnType<typeof createConnection>[] = [];
    for (let i = 0; i < PROPOSE_LINES_MAX + 1; i += 1) {
      const socket = createConnection({ path, allowHalfOpen: true });
      lingering.push(socket);
      const answered = new Promise<void>((resolve) => socket.once("data", () => resolve()));
      socket.write(line);
      await answered;
    }
    cleanups.push(() => {
      for (const socket of lingering) socket.destroy();
    });
    const next = await rawAsk(path, line);
    expect(next?.error).not.toBe("another proposal is being read; try again in a moment");
  });

  socketTest("two stalled proposal lines are cut off after their time, and the next proposal is read", async () => {
    const b = await bridge(undefined, true, 100);
    const path = walkySocketPath(b.stateDir);
    const held = Array.from({ length: PROPOSE_LINES_MAX }, () => {
      const socket = createConnection(path);
      socket.on("error", () => undefined);
      socket.write(`${PROPOSE_LINE_PREFIX}"v":1`);
      return socket;
    });
    cleanups.push(() => {
      for (const socket of held) socket.destroy();
    });
    await Bun.sleep(30);
    const busy = await rawAsk(path, `${PROPOSE_LINE_PREFIX}"v":1,"markers":{},"requestId":"x","files":[]}\n`);
    expect(busy?.error).toBe("another proposal is being read; try again in a moment");
    await Bun.sleep(250);
    const after = await rawAsk(path, `${PROPOSE_LINE_PREFIX}"v":1,"markers":{},"requestId":"x","files":[]}\n`);
    expect(after?.error).not.toBe("another proposal is being read; try again in a moment");
  });
});
