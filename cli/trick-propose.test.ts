import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BeaconMatcher } from "../bridge/beacon/decorate.ts";
import { HOST } from "../bridge/host.ts";
import type { JsonObject } from "../bridge/json.ts";
import type { LocalProposer } from "../bridge/tricks/propose-door.ts";
import type { ProposeAnswer } from "../bridge/tricks/proposals.ts";
import { PROPOSE_LIMITS, PROPOSE_PICTURES, PROPOSE_TOO_MANY_PARTS, readProposal } from "../bridge/tricks/propose-wire.ts";
import type { WalkyHost, WalkyPane } from "../bridge/walky/deliver.ts";
import { WalkyLog } from "../bridge/walky/log.ts";
import { PROPOSE_LINE_PREFIX, WALKY_LINE_MAX } from "../bridge/walky/parse.ts";
import { WalkyService } from "../bridge/walky/service.ts";
import { spaceOf } from "../bridge/walky/space.ts";
import { PROPOSE_LINE_MS, PROPOSE_LINES_MAX, walkySocketPath, WalkyServer, type PlaceTarget } from "../bridge/walky/socket.ts";
import { MANIFEST_KEYS, PLACE_KINDS, TRICKS_OFF_LINE } from "../web/src/lib/tricks/schema.ts";
import { asJsonObject, parseJsonObject } from "../web/src/lib/json.ts";
import { capture, context } from "./fakes.ts";
import type { HillDeps } from "./hill.ts";
import { EXIT } from "./io.ts";
import { realFiles } from "./sys.ts";
import { cmdTrickGuide, trickGuide } from "./trick-guide.ts";
import { GROUP_MASKED, GROUP_TOO_LARGE, groupLineEnds, sizeWords } from "../bridge/tricks/card-group.ts";
import { TRICK_HELPER } from "../bridge/tricks/scan.ts";
import { cmdTrickPropose, leftPictureLines, PROPOSE_ADDED_HERE_HINT, PROPOSE_NEEDS_CONFIG, PROPOSE_UNKNOWN, PROPOSE_WHERE, proposeExit, proposeWhere, readTrickFolder, sentLine } from "./trick-propose.ts";
import { cmdTrickInit } from "./trick.ts";
import { askSocket } from "./walky.ts";

// `collie trick guide` and `collie trick propose` (crew slice 8). The guide is checked against the schema;
// the propose verb against a real walky socket in a temp state dir, with a fake proposals door behind it,
// so the line, its size rules and who the proposer is are the real ones.

/** The first bytes of a PNG, a JPEG and a WebP: what the picture check reads. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 12, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

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

describe("where the person finds a proposal (M96 spec 14)", () => {
  test("the guide and the propose output name the Hill and Settings, Tricks, and never ask for the Hill to be switched on", () => {
    expect(PROPOSE_WHERE).toBe("on the Hill, or in Settings, Tricks, while the Hill is off");
    const guide = trickGuide().join("\n");
    expect(guide).toContain("in this session on the phone, and in Settings, Tricks (on the Hill too, while it is on)");
    for (const text of [guide, PROPOSE_WHERE]) {
      expect(text).not.toMatch(/switch(es)? the Hill on/iu);
      expect(text).not.toContain("Experiments");
    }
  });
});

describe("where the card is, from the bridge's answer (package I)", () => {
  test("the session first while the card is tied to it, the Hill only while it is on, Settings, Tricks always; no answer of where keeps the old words", () => {
    expect(proposeWhere({ session: true, hill: false })).toBe("in this session on the phone, and in Settings, Tricks");
    expect(proposeWhere({ session: true, hill: true })).toBe("in this session on the phone, on the Hill, and in Settings, Tricks");
    expect(proposeWhere({ session: false, hill: true })).toBe("on the Hill, and in Settings, Tricks");
    expect(proposeWhere({ session: false, hill: false })).toBe("in Settings, Tricks, on the phone");
    expect(proposeWhere(undefined)).toBe(PROPOSE_WHERE);
    for (const where of [{ session: true, hill: false }, { session: false, hill: false }]) expect(proposeWhere(where)).not.toContain("Hill");
  });
});

describe("collie trick guide", () => {
  test("names every manifest key and every place, from the schema", () => {
    const text = trickGuide().join("\n");
    for (const key of MANIFEST_KEYS) expect(text).toMatch(new RegExp(`^  ${key} +\\S`, "mu"));
    for (const place of PLACE_KINDS) expect(text).toMatch(new RegExp(`^  ${place} +\\S`, "mu"));
  });

  test("is plain text of 80 to 150 lines: no colour codes, no em dash, no home path", () => {
    const lines = trickGuide();
    expect(lines.length).toBeGreaterThanOrEqual(80);
    // 150 since 1.29.1: the guide names every manifest key on its own line, and `drafts` made it 141.
    expect(lines.length).toBeLessThanOrEqual(150);
    const text = lines.join("\n");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("—");
    expect(text).not.toMatch(/\/home\/|\/var\/home\/|~\//u);
  });

  test("N3: says that from.session is not proof of who tapped", () => {
    const text = trickGuide().join("\n");
    expect(text).toContain("from.session is not proof of who tapped or where the part was drawn.");
  });

  test("says the numbers the bridge checks with", () => {
    const text = trickGuide().join("\n");
    expect(text).toContain(`at most ${String(PROPOSE_LIMITS.files)} files and 5 MB`);
    expect(text).toContain("collie trick propose <folder>");
    expect(text).toContain("Nothing runs before their yes.");
    expect(text).toContain("a group of up to 8 cards, every line of it.");
    expect(text).toContain("7 cards hold the code, about 6 KB each (42 KB in all).");
  });

  test("has a short agent-view section: the keys, the content rule, never auto, no proposal, where the rules are read", () => {
    const text = trickGuide().join("\n");
    expect(text).toContain("AGENT VIEWS\n");
    expect(text).toContain('It needs contract = 2 and rules = "rules.md"');
    expect(text).toContain("no run of more than 2 spaces, no more than 2 blank lines in a row.");
    expect(text).toContain("A trick with rules never takes a new version without asking.");
    expect(text).toContain("An agent cannot propose a trick with an agent view or rules.");
    expect(text).not.toContain("later build");
    expect(text).toContain("collie trick view <id> help --session <address>");
  });

  test("fault C: says that from contract 2 a key Collie does not know leaves its part out", () => {
    const text = trickGuide().join("\n");
    expect(text).toContain("THE KEYS OF A PART\n");
    expect(text).toContain("With contract 1, Collie ignores a key it does not know, and the part still draws.");
    expect(text).toContain("With contract 2, a key Collie does not know, at any depth of a part, leaves that part out.");
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
  test("leaves dot files, node_modules, logs, inputs/, config.toml and what is not a picture in media/ and captures/ behind", async () => {
    const dir = trickFolder({ ".env": "SECRET=placeholder", ".git/config": "x", "node_modules/a/index.js": "x", "run.log": "x", "inputs/a.md": "x", "media/a.png": "x", "captures/b.png": "x", "lib/util.ts": "export {};\n", "config.toml": "a = 1\n" });
    chmodSync(join(dir, "program.ts"), 0o755);
    const read = await readTrickFolder(dir);
    if (!read.ok) throw new Error(read.error);
    expect(read.files.map((f) => f.rel).toSorted()).toEqual(["lib/util.ts", "program.ts", "trick.toml"]);
    // The executable bit is read off the disk, which only a POSIX file mode holds.
    if (process.platform !== "win32") expect(read.files.find((f) => f.rel === "program.ts")?.executable).toBe(true);
    expect(read.left).toBe(8);
    expect(read.config).toBe(true);
    // "x" is no picture by its first bytes: each file stays behind with its reason, and no picture goes.
    expect(read.pictures).toEqual([]);
    expect(read.leftPictures).toEqual([
      { rel: "captures/b.png", why: "is not a PNG, JPEG or WebP picture by its first bytes" },
      { rel: "media/a.png", why: "is not a PNG, JPEG or WebP picture by its first bytes" },
    ]);
  });

  test("brings the pictures of media/ and captures/: by name and first bytes, within the caps", async () => {
    const dir = trickFolder({ "media/notes.txt": "x", "media/.hidden.png": "x" });
    // Media/ in another case is another folder only where names keep their case. NTFS (and APFS) fold it into media/,
    // where the file would be read as one of media/'s own, so the case point is made only where it exists.
    const casesFold = existsSync(join(dir, "MEDIA"));
    if (!casesFold) {
      mkdirSync(join(dir, "Media"));
      writeFileSync(join(dir, "Media", "upper.png"), "x");
    }
    writeFileSync(join(dir, "media", "fireball.png"), PNG_BYTES);
    mkdirSync(join(dir, "media", "sheets"));
    writeFileSync(join(dir, "media", "sheets", "pose.webp"), WEBP_BYTES);
    mkdirSync(join(dir, "captures"));
    writeFileSync(join(dir, "captures", "shot.jpg"), JPEG_BYTES);
    const big = new Uint8Array(PROPOSE_PICTURES.bytes + 1);
    big.set(PNG_BYTES);
    writeFileSync(join(dir, "media", "big.png"), big);
    writeFileSync(join(dir, "media", "fake.png"), "<svg/>");
    const read = await readTrickFolder(dir);
    if (!read.ok) throw new Error(read.error);
    expect(read.files.map((f) => f.rel).toSorted()).toEqual(["program.ts", "trick.toml"]);
    expect(read.pictures.map((f) => f.rel)).toEqual(["captures/shot.jpg", "media/fireball.png", "media/sheets/pose.webp"]);
    expect(read.leftPictures).toEqual([
      { rel: "media/big.png", why: "is larger than 2 MB" },
      { rel: "media/fake.png", why: "is not a PNG, JPEG or WebP picture by its first bytes" },
      { rel: "media/notes.txt", why: "is not a .png, .jpg, .jpeg or .webp file" },
    ]);
    // Media/ in another case (where it is a folder of its own), the dot file and the three above stay behind.
    expect(read.left).toBe(casesFold ? 4 : 5);
    // What the CLI reads, the wire takes.
    expect(readProposal({ requestId: "11111111-2222-4333-8444-555555555555", files: [...read.files, ...read.pictures].map((f) => ({ rel: f.rel, b64: Buffer.from(f.bytes).toString("base64") })) }).ok).toBe(true);
  });

  posixTest("a picture through a link stays behind: a linked file, a linked folder, a linked media/; the mode bit never goes", async () => {
    const dir = trickFolder();
    const elsewhere = tempDir("propose-elsewhere-");
    writeFileSync(join(elsewhere, "a.png"), PNG_BYTES);
    mkdirSync(join(dir, "captures"));
    writeFileSync(join(dir, "captures", "shot.png"), PNG_BYTES);
    chmodSync(join(dir, "captures", "shot.png"), 0o755);
    symlinkSync(join(elsewhere, "a.png"), join(dir, "captures", "linked.png"));
    symlinkSync(elsewhere, join(dir, "captures", "sheets"));
    symlinkSync(elsewhere, join(dir, "media"));
    const read = await readTrickFolder(dir);
    if (!read.ok) throw new Error(read.error);
    // A picture never carries the executable mark, whatever its mode on disk.
    expect(read.pictures.map((f) => [f.rel, f.executable])).toEqual([["captures/shot.png", false]]);
    expect(read.leftPictures).toEqual([
      { rel: "media", why: "is a symbolic link, so its pictures stay behind" },
      { rel: "captures/linked.png", why: "is a symbolic link" },
      { rel: "captures/sheets", why: "is a symbolic link" },
    ]);
  });

  test("past the picture count, the rest stays behind, each named", async () => {
    const dir = trickFolder();
    mkdirSync(join(dir, "media"));
    for (let i = 0; i <= PROPOSE_PICTURES.files; i += 1) writeFileSync(join(dir, "media", `p${String(i).padStart(3, "0")}.png`), PNG_BYTES);
    const read = await readTrickFolder(dir);
    if (!read.ok) throw new Error(read.error);
    expect(read.pictures).toHaveLength(PROPOSE_PICTURES.files);
    expect(read.leftPictures).toEqual([{ rel: `media/p${String(PROPOSE_PICTURES.files).padStart(3, "0")}.png`, why: `is past the ${String(PROPOSE_PICTURES.files)} pictures a proposal brings` }]);
  });

  test("the lines it prints: the pictures sent, and each file of media/ or captures/ left behind, at most ten", () => {
    expect(sentLine(2, 0)).toBe("Sent 2 files.");
    expect(sentLine(1, 1)).toBe("Sent 1 file and 1 picture.");
    expect(sentLine(3, 2)).toBe("Sent 3 files and 2 pictures.");
    const many = Array.from({ length: 12 }, (_, i) => ({ rel: `media/n${String(i)}.txt`, why: "is not a .png, .jpg, .jpeg or .webp file" }));
    const lines = leftPictureLines(many);
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe("Left behind: media/n0.txt is not a .png, .jpg, .jpeg or .webp file.");
    expect(lines.at(-1)).toBe("Left behind: 2 more files of media/ and captures/.");
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
  socketTest("decision 7: a trick that draws nothing without its config.toml is proposed with a warning, and the line says so", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)], { ...inPane("%1"), PATH: process.env.PATH ?? "/usr/bin:/bin" });
    // Without config.toml the program prints no part: the person would see nothing until they add it.
    const program = 'import { readFileSync } from "node:fs";\nlet parts = [];\ntry { readFileSync("config.toml"); parts = [{ at: "belt", id: "belt", mark: { icon: "plug", label: "ok" } }]; } catch {}\nconsole.log(JSON.stringify({ v: 1, parts }));\n';
    expect(await cmdTrickPropose(d, [trickFolder({ "program.ts": program, "config.toml": 'repo = "x"\n' })])).toBe(EXIT.OK);
    expect(d.io.stderr).toContain(PROPOSE_NEEDS_CONFIG);
    expect(b.calls[0]?.fields.settings).toBe(true);
  });

  socketTest("decision 7: a trick that draws without its config.toml carries no such line", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)], { ...inPane("%1"), PATH: process.env.PATH ?? "/usr/bin:/bin" });
    const program = 'console.log(JSON.stringify({ v: 1, parts: [{ at: "belt", id: "belt", mark: { icon: "plug", label: "ok" } }] }));\n';
    expect(await cmdTrickPropose(d, [trickFolder({ "program.ts": program, "config.toml": 'repo = "x"\n' })])).toBe(EXIT.OK);
    expect(d.io.stderr).not.toContain(PROPOSE_NEEDS_CONFIG);
    expect(b.calls[0]?.fields.settings).toBeUndefined();
  });

  socketTest("decision 11: a scan warning prints with one prefix, warning:", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdTrickPropose(d, [trickFolder({ "program.ts": 'await fetch("https://example.invalid/x");\nconsole.log(JSON.stringify({ v: 1, parts: [] }));\n' })])).toBe(EXIT.OK);
    const warned = d.io.stderr.filter((line) => line.includes("program.ts:1"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toStartWith("warning: program.ts:1 ");
    expect(warned[0]).not.toContain("warn: ");
  });

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
      "Sent 2 files. Left behind: 1 (dot files, node_modules, logs, inputs/, config.toml, and any file in media/ or captures/ that is not a picture).",
      "Proposed legs. Your person sees it as dc_k3m9x2p7q1ab on the Hill, or in Settings, Tricks, while the Hill is off. Nothing runs before their yes.",
      "Read the answer with: collie hill status dc_k3m9x2p7q1ab",
    ]);
    // A draft that init made in an agent's work folder proposes with nothing registered for its id.
    const work = tempDir("propose-work-");
    const root = tempDir("propose-config-");
    const out = capture();
    const init = {
      ctx: context(inPane("%1"), { configDir: join(root, "config"), stateDir: join(root, "state") }),
      io: out,
      files: realFiles,
      fetch: async () => new Response("{}"),
      now: () => 1000,
      paneKind: async () => "agent" as const,
      cwd: work,
    };
    expect(await cmdTrickInit(init, ["draft-one"])).toBe(EXIT.OK);
    const draft = join(work, "draft-one");
    // Nothing was written to the tricks folder, so the bridge has no entry for the id.
    expect(existsSync(join(root, "config", "tricks"))).toBe(false);
    const e = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdTrickPropose(e, [draft])).toBe(EXIT.OK);
    expect(e.io.stderr).toEqual([]);
    expect(b.calls).toHaveLength(2);
    const sent = b.calls[1]?.fields.files;
    expect(Array.isArray(sent) ? sent.map((f) => asJsonObject(f)?.rel) : []).toContain("trick.toml");
  });

  socketTest("a session's proposal with the Hill off names the session and Settings, Tricks, never the Hill", async () => {
    const b = await bridge(async () => ({ ok: true, kind: "proposal", id: "legs", hash: "h", decision: "dc_k3m9x2p7q1ab", replaced: null, where: { session: true, hill: false } }));
    const d = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdTrickPropose(d, [trickFolder()])).toBe(EXIT.OK);
    expect(d.io.stdout).toContain("Proposed legs. Your person sees it as dc_k3m9x2p7q1ab in this session on the phone, and in Settings, Tricks. Nothing runs before their yes.");
  });

  socketTest("the pictures go on the line beside the code, and the CLI names what stayed behind", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)]);
    const dir = trickFolder({ "media/notes.txt": "x" });
    writeFileSync(join(dir, "media", "fireball.png"), PNG_BYTES);
    writeFileSync(join(dir, "media", "pose.png"), PNG_BYTES);
    expect(await cmdTrickPropose(d, [dir])).toBe(EXIT.OK);
    const files = b.calls[0]?.fields.files;
    expect(Array.isArray(files) ? files.map((f) => asJsonObject(f)?.rel) : []).toEqual(["program.ts", "trick.toml", "media/fireball.png", "media/pose.png"]);
    expect(d.io.stdout[0]).toBe("Sent 2 files and 2 pictures. Left behind: 1 (dot files, node_modules, logs, inputs/, config.toml, and any file in media/ or captures/ that is not a picture).");
    expect(d.io.stdout[1]).toBe("Left behind: media/notes.txt is not a .png, .jpg, .jpeg or .webp file.");
  });

  socketTest("a config.toml stays behind, and the CLI says so", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdTrickPropose(d, [trickFolder({ "config.toml": "rows = 3\n" })])).toBe(EXIT.OK);
    const files = b.calls[0]?.fields.files;
    expect(Array.isArray(files) ? files.map((f) => asJsonObject(f)?.rel) : []).toEqual(["program.ts", "trick.toml"]);
    expect(d.io.stdout[0]).toBe("Sent 2 files. Left behind: 1 (dot files, node_modules, logs, inputs/, config.toml, and any file in media/ or captures/ that is not a picture).");
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
    // Collie's own helper (about 42 KB, named on card 1) and 20 KB of data: past a walky line once base64'd.
    const data = Array.from({ length: 400 }, (_, i) => `"row ${String(i).padStart(4, "0")} of the data the program reads"`).join(",\n");
    expect(((TRICK_HELPER.length + data.length) * 4) / 3).toBeGreaterThan(WALKY_LINE_MAX);
    expect(await cmdTrickPropose(d, [trickFolder({ "trick.ts": TRICK_HELPER, "data.json": `[\n${data}\n]\n` })])).toBe(EXIT.OK);
    expect(b.calls).toHaveLength(1);
  });

  socketTest("a trick larger than a group of cards, or with a key in it, is refused before anything is sent (crew slice 8); a helper of an older Collie is sent, a hand-edited one refused with the reason", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)]);
    const big = Array.from({ length: 900 }, (_, i) => `"row ${String(i).padStart(4, "0")} of the data the program reads, longer than a group holds"`).join(",\n");
    expect(await cmdTrickPropose(d, [trickFolder({ "data.json": `[\n${big}\n]\n` })])).toBe(EXIT.REFUSED);
    expect(d.io.stderr).toEqual([`propose: ${GROUP_TOO_LARGE}`]);
    const e = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdTrickPropose(e, ["--json", trickFolder({ "keys.ts": 'export const KEY = "sk-or-v1-your-key-here-placeholder00";\n' })])).toBe(EXIT.REFUSED);
    expect(JSON.parse(e.io.stdout.join(""))).toEqual({ ok: false, code: "cannot_show", error: GROUP_MASKED });
    expect(b.calls).toEqual([]);
    const v8 = readFileSync(new URL("../bridge/tricks/fixtures/helper-v8.txt", import.meta.url), "utf8");
    // A trick.ts from an older Collie is sent as Collie's helper, with one note; a hand-edited one is refused with the reason.
    const olderDeps = deps([walkySocketPath(b.stateDir)]);
    const older = trickFolder({ "trick.ts": v8 });
    expect(await cmdTrickPropose(olderDeps, [older])).toBe(EXIT.OK);
    expect(b.calls).toHaveLength(1);
    expect(olderDeps.io.stderr.filter((line) => line.includes("older Collie"))).toEqual([`trick.ts is the helper from an older Collie (v8). Run \`collie trick helper ${older}\` to update it.`]);
    expect(olderDeps.io.stderr.join("\n")).not.toContain("too large");
    const editedDeps = deps([walkySocketPath(b.stateDir)]);
    const edited = trickFolder({ "trick.ts": `${v8}// a hand edit\n` });
    expect(await cmdTrickPropose(editedDeps, [edited])).toBe(EXIT.REFUSED);
    expect(editedDeps.io.stderr).toEqual([`propose: trick.ts says helper v8 but its text differs from that helper, so it counts as your own code (${sizeWords(Buffer.byteLength(`${v8}// a hand edit\n`))}). Run \`collie trick helper ${edited}\` to restore it, or remove the version line.`]);
    expect(b.calls).toHaveLength(1);
    // A hand-edited helper that is not the cause (the folder is too large anyway) keeps the general refusal.
    const f = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdTrickPropose(f, [trickFolder({ "trick.ts": `${v8}// a hand edit\n`, "data.json": `[\n${big}\n]\n` })])).toBe(EXIT.REFUSED);
    expect(f.io.stderr).toEqual([`propose: ${GROUP_TOO_LARGE}`]);
  });

  socketTest("a trick with Windows line ends is sent; one with a CR inside a line is refused in words that name the file", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)]);
    const crlf = (text: string) => text.replaceAll("\n", "\r\n");
    expect(await cmdTrickPropose(d, [trickFolder({ "trick.toml": crlf(MANIFEST), "program.ts": crlf("console.log(1);\nconsole.log(2);\n") })])).toBe(EXIT.OK);
    expect(b.calls).toHaveLength(1);
    const e = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdTrickPropose(e, ["--json", trickFolder({ "program.ts": "console.log(1);\rconsole.log(2);\r" })])).toBe(EXIT.REFUSED);
    expect(JSON.parse(e.io.stdout.join(""))).toEqual({ ok: false, code: "cannot_show", error: groupLineEnds("program.ts") });
    expect(b.calls).toHaveLength(1);
  });

  socketTest("a refusal prints its words and the request id, with its exit code", async () => {
    const b = await bridge(async () => ({ ok: false, code: "rate", error: "This session proposed 6 tricks in the last hour. Wait, then propose again." }));
    const d = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdTrickPropose(d, [trickFolder()])).toBe(EXIT.REFUSED);
    expect(d.io.stderr).toEqual(["propose: This session proposed 6 tricks in the last hour. Wait, then propose again.", "propose: request id 0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f"]);
    // A trick added on this machine: the CLI adds the way out on a line of its own, after the bridge's words.
    const added = await bridge(async () => ({ ok: false, code: "exists", error: "legs was added on this machine. Change it there." }));
    const e = deps([walkySocketPath(added.stateDir)]);
    expect(await cmdTrickPropose(e, [trickFolder()])).toBe(EXIT.REFUSED);
    expect(e.io.stderr).toEqual([
      "propose: legs was added on this machine. Change it there.",
      `propose: ${PROPOSE_ADDED_HERE_HINT}`,
      "propose: request id 0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f",
    ]);
    expect(PROPOSE_ADDED_HERE_HINT).toBe("Copy the folder outside the tricks folder and propose the copy, or ask the person to switch it on.");
  });

  socketTest("tricks switched off: the bridge's off sentence is printed, nothing is proposed, and it exits STATE", async () => {
    const b = await bridge(async () => ({ ok: false, code: "no_tricks", error: TRICKS_OFF_LINE }));
    const d = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdTrickPropose(d, [trickFolder()])).toBe(EXIT.STATE);
    expect(d.io.stdout).toEqual([]);
    expect(d.io.stderr).toEqual([`propose: ${TRICKS_OFF_LINE}`, "propose: request id 0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f"]);
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

  socketTest("S3: a proposal line with more parts than any trick needs is refused before it is parsed", async () => {
    const b = await bridge();
    const zeros = Array.from({ length: 100_000 }, () => "0").join(",");
    const answer = await rawAsk(walkySocketPath(b.stateDir), `${PROPOSE_LINE_PREFIX}"v":1,"markers":{},"requestId":"x","files":[${zeros}]}\n`);
    expect(answer).toEqual({ ok: false, error: PROPOSE_TOO_MANY_PARTS, code: "bad_request", propose: true });
    expect(b.calls).toEqual([]);
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

describe("a trick that gives agents instructions (contract 2)", () => {
  socketTest("the CLI refuses it with has_rules before anything reaches the socket, for a new trick and a new version", async () => {
    const b = await bridge();
    const view = trickFolder({ "trick.toml": 'id = "morph"\nname = "Morph"\ncontract = 2\nplaces = ["agent-view"]\nrules = "rules.md"\n', "rules.md": "Draw one screen.\n" });
    const adds = trickFolder({ "trick.toml": MANIFEST.replace('places = ["belt"]', 'places = ["belt", "agent-view"]\ncontract = 2\nrules = "rules.md"'), "rules.md": "Draw one screen.\n" });
    for (const folder of [view, adds]) {
      const d = deps([walkySocketPath(b.stateDir)]);
      expect(await cmdTrickPropose(d, [folder])).toBe(EXIT.REFUSED);
      expect(d.io.stderr.join("\n")).toContain("A trick that gives agents instructions cannot be proposed by an agent. Ask your person to add it on the machine.");
      const json = deps([walkySocketPath(b.stateDir)]);
      expect(await cmdTrickPropose(json, [folder, "--json"])).toBe(EXIT.REFUSED);
      expect(json.io.stdout.join("\n")).toContain('"has_rules"');
    }
    expect(b.calls).toEqual([]);
  });
});
