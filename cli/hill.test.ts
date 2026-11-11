import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { BeaconMatcher } from "../bridge/beacon/decorate.ts";
import { decision as storedDecision } from "../bridge/hill/fixtures.ts";
import { deniedFoldersSync, HillMediaStore } from "../bridge/hill/media.ts";
import { HOST } from "../bridge/host.ts";
import { memoryHillReceipts } from "../bridge/hill/receipts.ts";
import { CREW_HILL_MEDIA_ROUTE, CREW_HILL_POST_ROUTE, HILL_CALL_BUDGET_MS, HILL_FORWARD_BUDGET_MS, HILL_MEDIA_BUDGET_MS, HILL_POST_ASK_MS, HillCrewLead, HillHeldMedia, HillMemberForward, type HillLeadLink } from "../bridge/hill/crew.ts";
import { HillService, type HillServiceDeps } from "../bridge/hill/service.ts";
import { HillStore } from "../bridge/hill/store.ts";
import { HillSwitch, readHillSwitch } from "../bridge/hill/switch.ts";
import { walkyPlace } from "../bridge/hill/walky.ts";
import type { WalkyHost, WalkyPane } from "../bridge/walky/deliver.ts";
import { WalkyLog } from "../bridge/walky/log.ts";
import { unknownOp } from "../bridge/walky/refusals.ts";
import { WalkyService } from "../bridge/walky/service.ts";
import { walkySocketPath, WalkyServer, type PlaceTarget } from "../bridge/walky/socket.ts";
import { asJsonObject, asJsonString, parseJsonObject } from "../web/src/lib/json.ts";
import { capture, context } from "./fakes.ts";
import {
  clearedWords,
  cmdHill,
  cmdHillClear,
  cmdHillList,
  cmdHillPost,
  cmdHillStatus,
  cmdHillSwitch,
  cmdHillWithdraw,
  durationMs,
  HILL_OFF_WORDS,
  HILL_ON_WORDS,
  HILL_IMAGES_DROPPED,
  HILL_NOT_CONFIRMED,
  HILL_NOT_HERE,
  HILL_RULES,
  HILL_UNKNOWN,
  HILL_VIEW_DROPPED,
  HILL_VIEW_FILE_MAX,
  hillHelp,
  hillPostHelp,
  imagePathOf,
  parseImageArg,
  parsePostArgs,
  readViewFile,
  refusalExit,
  retryCommand,
  statusLines,
  type HillDeps,
} from "./hill.ts";
import { HILL_WRITING, hillWordingWarnings, sentenceCount } from "./hill-rules.ts";
import { EXIT } from "./io.ts";
import { run } from "./program.ts";
import { realFiles } from "./sys.ts";
import { AskLate, askSocket } from "./walky.ts";

import { spaceOf } from "../bridge/walky/space.ts";

/** One unnamed space on one machine: every fixture pane shares it, and no rule reads it yet. */
const SOLO_SPACE = spaceOf({ memberId: "local", spaceId: "w1", spaceLabel: "w1" });

// `collie hill` against a real bridge socket in a temp state dir, as cli/walky.test.ts drives walky: the
// socket, the request lines and the answers are the real ones; only the panes and the send are fakes.
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
const target: PlaceTarget = { session: "main", matcher, paneIds: () => ["%1", "%2"] };
const inPane = (pane: string) => ({ TMUX: "/tmp/tmux-1/default,123,0", TMUX_PANE: pane });

const panes: WalkyPane[] = [
  { session: "main", paneId: "%1", agent: true, harness: "agent-x", label: "repo#one", state: "idle", activeAt: null, instance: "aaaa", terminal: true, off: false, space: SOLO_SPACE },
  { session: "main", paneId: "%2", agent: true, harness: "agent-y", label: "repo#two", state: "working", activeAt: null, instance: "bbbb", terminal: true, off: false, space: SOLO_SPACE },
];

interface Bridge {
  readonly stateDir: string;
  readonly hill: HillService;
}

/** A bridge with the hill on a real socket. `withHill: false` is a bridge built without it. POSIX only. */
async function bridge(withHill = true, extra: Partial<HillServiceDeps> = {}): Promise<Bridge> {
  const stateDir = mkdtempSync(join(tmpdir(), "hill-cli-"));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const host: WalkyHost = { panes: () => panes, send: async () => ({ outcome: "sent" }), sendState: () => ({ outcome: "sent" }), cancelHeld: () => undefined };
  const walky = new WalkyService({ log: new WalkyLog(join(stateDir, "walky")), host, memberId: null, enabled: () => true, machine: "desk", keyPem: () => null });
  let n = 0;
  const hill = new HillService({
    store: new HillStore(null, () => 1000),
    receipts: memoryHillReceipts(),
    place: walkyPlace(walky, null),
    send: async () => "typed",
    crewMode: () => "solo",
    walkyOn: () => true,
    memberId: "m_aaaaaaaaaa",
    machine: "desk",
    now: () => 1000,
    mintId: () => {
      n += 1;
      return `dc_cli${String(n).padStart(9, "0")}`;
    },
    media: new HillMediaStore(join(stateDir, "hill"), deniedFoldersSync([stateDir])),
    // The real switch on this bridge's own state folder, so `collie hill on|off` moves it.
    hillSwitch: new HillSwitch(stateDir, () => undefined),
    ...extra,
  });
  const base = { socketPath: walkySocketPath(stateDir), service: walky, targets: () => [target], log: () => undefined };
  const server = withHill ? new WalkyServer({ ...base, hill }) : new WalkyServer(base);
  expect(await server.start()).toBe(true);
  cleanups.push(() => server.stop());
  return { stateDir, hill };
}

/**
 * A bridge of today's release, as far as an op it does not know goes: `readWalkyRequest` refuses it
 * with `unknownOp`, and `answerUnread` answers that reason to markers that name its pane. `bare`: a
 * bridge before 2026-10-30, which answers the bare `bad request` to every line it cannot read.
 */
async function olderBridge(bare = false): Promise<{ readonly path: string; readonly lines: string[] }> {
  const stateDir = mkdtempSync(join(tmpdir(), "hill-older-"));
  const path = walkySocketPath(stateDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lines: string[] = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk: string) => {
      lines.push(chunk);
      const op = String(parseJsonObject(chunk)?.op ?? "");
      socket.end(`${JSON.stringify({ ok: false, error: bare ? "bad request" : unknownOp(op) })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
  return { path, lines };
}

function deps(sockets: string[], env: Record<string, string> = inPane("%1"), over: Partial<HillDeps> = {}): HillDeps & { readonly io: ReturnType<typeof capture> } {
  const io = capture();
  // A picture under /tmp is copied for the bridge; the fake home is not writable, so the copy goes to a folder of the test's own.
  const staging = mkdtempSync(join(tmpdir(), "hill-stage-"));
  cleanups.push(() => rmSync(staging, { recursive: true, force: true }));
  return {
    ctx: context(env, { stateDir: mkdtempSync(join(tmpdir(), "hill-own-")) }),
    stagingRoot: () => staging,
    files: realFiles,
    uid: process.getuid?.(),
    platform: "linux",
    readStdin: async () => "",
    stdinIsTty: true,
    ask: (path, line) => askSocket(path, line, 2000),
    sockets: () => sockets,
    mintRequestId: () => "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f",
    now: () => 1000,
    ...over,
    io,
  };
}

/** The line every failed post ends with: its request id, and the command that sends it again once. */
function retryLine(args: readonly string[], id = "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f"): string {
  return `hill: request id ${id}; to send this post again, it posts once: ${retryCommand(args, id)}`;
}

const POST = ["--title", "Ship the zoom fix in 1.28.1?", "--summary", "The pill moves out of Chat. The leg is green.", "--option", "yes=Yes, Edge first", "--option", "no=No, wait for 1.29.0", "--recommend", "yes", "--why", "Edge users find it in a day."];

describe("post's flags", () => {
  test("the brief's example reads into the fields, with every optional flag", () => {
    const parsed = parsePostArgs([
      ...POST,
      "--confirm",
      "yes=Tap again: ship",
      "--detail",
      "no=Wait a week",
      "--priority",
      "now",
      "--text",
      "required",
      "--link",
      "Leg report=https://example.com/leg?run=3",
      "--about",
      "here",
      "--reply-to",
      "local/%2",
      "--supersedes",
      "dc_k3m9x2p7q1ab",
      "--expires",
      "2h",
      "--request-id",
      "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f",
      "--json",
      "--",
      "Body",
      "in Markdown",
    ]);
    expect(parsed).toEqual({
      fields: {
        title: "Ship the zoom fix in 1.28.1?",
        summary: "The pill moves out of Chat. The leg is green.",
        options: [
          { intent: "yes", label: "Yes, Edge first", confirm: "Tap again: ship" },
          { intent: "no", label: "No, wait for 1.29.0", detail: "Wait a week" },
        ],
        text: "required",
        recommends: { intent: "yes", why: "Edge users find it in a day." },
        links: [{ label: "Leg report", href: "https://example.com/leg?run=3" }],
        priority: "now",
        about: "here",
        replyTo: "local/%2",
        supersedes: "dc_k3m9x2p7q1ab",
      },
      images: [],
      requestId: "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f",
      expiresInMs: 7_200_000,
      viewPath: null,
      body: "Body in Markdown",
      json: true,
    });
  });

  test("each refusal says what is wrong, in one line", () => {
    const error = (args: string[]) => {
      const parsed = parsePostArgs(args);
      return "error" in parsed ? parsed.error : "ok";
    };
    expect(error(POST.slice(2))).toBe("a decision needs `--title`");
    expect(error(POST.slice(0, 2))).toBe("a decision needs `--summary`, in plain words");
    expect(error([...POST, "--option", "Yes=Big"])).toContain("is not an option intent");
    expect(error([...POST, "--option", "answer=Answer"])).toContain("is not an option intent");
    expect(error([...POST, "--option", "yes=Again"])).toBe("two options share the intent `yes`");
    expect(error([...POST, "--option", "nolabel"])).toBe("`--option` takes <intent>=<text>, got `nolabel`");
    expect(error([...POST, "--confirm", "maybe=Sure"])).toBe("`maybe` names no `--option`");
    expect(error(POST.slice(0, 10))).toBe("`--recommend` and `--why` go together: name one option and say why");
    expect(error([...POST.slice(0, 8), "--recommend", "maybe", "--why", "x"])).toBe("`--recommend maybe` names no `--option`");
    expect(error([...POST, "--priority", "asap"])).toBe("`--priority` is now, today or later");
    expect(error([...POST, "--text", "lots"])).toBe("`--text` is none, optional or required");
    expect(error(["--title", "t", "--summary", "s", "--text", "none"])).toBe("`--text none` needs at least one `--option`");
    expect(error([...POST, "--expires", "soon"])).toBe("`--expires soon` is a duration such as 30m, 2h, 3d or 1w");
    expect(error([...POST, "--expires", "31d"])).toBe("`--expires 31d` is longer than 30 days, the most a decision stays open");
    expect(error([...POST, "--expires", "5w"])).toBe("`--expires 5w` is longer than 30 days, the most a decision stays open");
    expect(parsePostArgs([...POST, "--expires", "30d"])).toMatchObject({ expiresInMs: 30 * 86_400_000 });
    expect(error([...POST, "--request-id", "abc"])).toBe("`--request-id abc` is not a UUID");
    expect(error([...POST, "--supersedes", "wt_aaaaaaaaaaa1"])).toContain("is not a decision id");
    expect(error([...POST, "--reply-to", "all"])).toContain("is not a session");
    expect(error([...POST, "--about", "repo"])).toContain("is not a session");
    expect(error([...POST, "--wat"])).toBe("unknown flag `--wat`");
    expect(error([...POST, "loose"])).toBe("unexpected `loose`: put the body after `--`");
    expect(error([...POST, "--title", "again"])).toBe("`--title` is given twice");
    expect(error([...POST, "--why"])).toBe("`--why` needs a value");
  });

  test("durations", () => {
    expect(durationMs("30m")).toBe(1_800_000);
    expect(durationMs("3d")).toBe(259_200_000);
    expect(durationMs("1w")).toBe(604_800_000);
    expect(durationMs("0h")).toBeNull();
    expect(durationMs("2 hours")).toBeNull();
  });

  test("a usage error exits 2 before any socket is asked", async () => {
    const d = deps([]);
    expect(await cmdHillPost(d, ["--title", "t"])).toBe(EXIT.USAGE);
    expect(d.io.stderr[0]).toBe("error: a decision needs `--summary`, in plain words");
  });
});

describe("post, status, withdraw and list against a bridge", () => {
  socketTest("post prints the id on one line and returns at once; the decision is the pane's, with the body after --", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdHillPost(d, [...POST, "--expires", "1h", "--", "Body", "here"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["dc_cli000000001"]);
    expect(b.hill.status({ kind: "agent", address: "local/%1#aaaa", memberId: null, harness: null, label: "", host: null }, "dc_cli000000001")).toMatchObject({
      ok: true,
      decision: { from: { address: "local/%1#aaaa" }, body: "Body here", expiresAt: 3_601_000, recommends: { intent: "yes" }, requestId: "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f" },
    });
  });

  socketTest("the body comes from stdin when nothing follows --, and stdin is not a terminal", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)], inPane("%1"), { stdinIsTty: false, readStdin: async () => "From stdin.\n" });
    expect(await cmdHillPost(d, [...POST, "--json"])).toBe(EXIT.OK);
    expect(JSON.parse(d.io.stdout[0]!)).toMatchObject({ decision: { body: "From stdin." } });
  });

  socketTest("a refusal prints the bridge's plain words and its code, and exits REFUSED", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdHillPost(d, ["--title", "t".repeat(121), "--summary", "s"])).toBe(EXIT.REFUSED);
    // The wording warnings come first, before the post; the refusal is the last line.
    expect(d.io.stderr).toEqual([
      "warning: the title has 121 characters. Keep it to 60: the decision as a short question.",
      "warning: the title asks no question. Write the decision as a question the options answer.",
      "hill: the title is longer than 120 characters (bad_title)",
      retryLine(["--title", "t".repeat(121), "--summary", "s"]),
    ]);
  });

  socketTest("outside a pane the bridge refuses: a decision belongs to a session", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)], {});
    expect(await cmdHillPost(d, POST)).toBe(EXIT.STATE);
    expect(d.io.stderr[0]).toContain("run this inside an agent's pane");
  });

  socketTest("status prints the state and the answer; withdraw closes it; list shows the caller's own, open first", async () => {
    const b = await bridge();
    const sock = [walkySocketPath(b.stateDir)];
    await cmdHillPost(deps(sock), POST);
    await cmdHillPost(deps(sock, inPane("%1"), { mintRequestId: () => "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e70" }), POST);
    const answered = await b.hill.answer({ rid: "11111111-1111-4111-8111-111111111111", node: "hill/dc_cli000000001", intent: "yes", value: { text: "Go.\nToday." } }, "dc_cli000000001", "Pixel 9");
    expect(answered.kind).toBe("receipt");
    const status = deps(sock);
    expect(await cmdHillStatus(status, ["dc_cli000000001"])).toBe(EXIT.OK);
    expect(status.io.stdout).toEqual(["dc_cli000000001 answered", "title: Ship the zoom fix in 1.28.1?", "goes to: repo#one on desk", "answer: yes (Yes, Edge first)", "  Go.", "  Today.", "by: Pixel 9", "delivery: typed"]);
    const withdraw = deps(sock);
    expect(await cmdHillWithdraw(withdraw, ["dc_cli000000002"])).toBe(EXIT.OK);
    expect(withdraw.io.stdout).toEqual(["dc_cli000000002 withdrawn", "title: Ship the zoom fix in 1.28.1?", "goes to: repo#one on desk", "reason: by the poster"]);
    const list = deps(sock);
    expect(await cmdHillList(list, [])).toBe(EXIT.OK);
    expect(list.io.stdout.map((line) => line.split("  ")[0])).toEqual(["dc_cli000000001", "dc_cli000000002"]);
    // Another pane sees none of them, and its status of one is not found.
    const other = deps(sock, inPane("%2"));
    expect(await cmdHillList(other, [])).toBe(EXIT.OK);
    expect(other.io.stdout).toEqual(["no decisions"]);
    const nosy = deps(sock, inPane("%2"));
    expect(await cmdHillStatus(nosy, ["dc_cli000000001"])).toBe(EXIT.STATE);
    expect(nosy.io.stderr).toEqual(["hill: no decision dc_cli000000001 from this session"]);
  });

  test("status and withdraw take one decision id", async () => {
    const d = deps([]);
    expect(await cmdHillStatus(d, ["wt_aaaaaaaaaaa1"])).toBe(EXIT.USAGE);
    expect(await cmdHillWithdraw(d, [])).toBe(EXIT.USAGE);
    expect(await cmdHillList(d, ["--all"])).toBe(EXIT.USAGE);
  });
});

describe("clear", () => {
  /** Post three decisions from pane %1, answer one and withdraw one: two closed, one open. */
  async function threeDecisions(b: Bridge): Promise<void> {
    const sock = [walkySocketPath(b.stateDir)];
    for (const rid of ["0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e71", "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e72", "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e73"]) {
      expect(await cmdHillPost(deps(sock, inPane("%1"), { mintRequestId: () => rid }), POST)).toBe(EXIT.OK);
    }
    await b.hill.answer({ rid: "11111111-1111-4111-8111-111111111111", node: "hill/dc_cli000000001", intent: "yes", value: { text: null } }, "dc_cli000000001", "Pixel 9");
    expect(await cmdHillWithdraw(deps(sock), ["dc_cli000000002"])).toBe(EXIT.OK);
  }

  socketTest("removes every closed decision, keeps the open one, and prints one line with the count", async () => {
    const b = await bridge();
    await threeDecisions(b);
    const d = deps([walkySocketPath(b.stateDir)], {});
    expect(await cmdHillClear(d, [])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["Cleared 2 closed decisions."]);
    expect(b.hill.list().open.map((x) => x.id)).toEqual(["dc_cli000000003"]);
    expect(b.hill.list().closed).toEqual([]);
    const again = deps([walkySocketPath(b.stateDir)], {});
    expect(await cmdHillClear(again, [])).toBe(EXIT.OK);
    expect(again.io.stdout).toEqual(["Nothing to clear: no closed decisions."]);
  });

  socketTest("needs no pane: it runs from a pane too, and --json prints the count", async () => {
    const b = await bridge();
    await threeDecisions(b);
    const d = deps([walkySocketPath(b.stateDir)], inPane("%2"));
    expect(await cmdHillClear(d, ["--json"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(['{"cleared":2}']);
  });

  socketTest("an older bridge first leads to the next socket; with none that knows the hill, it says so", async () => {
    const older = await olderBridge();
    const b = await bridge();
    await threeDecisions(b);
    const d = deps([older.path, walkySocketPath(b.stateDir)], {});
    expect(await cmdHillClear(d, [])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["Cleared 2 closed decisions."]);
    const none = deps([older.path], {});
    expect(await cmdHillClear(none, [])).toBe(EXIT.UNREACHABLE);
    expect(none.io.stderr).toEqual([`hill: ${HILL_UNKNOWN}`]);
  });

  test("the words, an unknown argument and Windows", async () => {
    expect(clearedWords(0)).toBe("Nothing to clear: no closed decisions.");
    expect(clearedWords(1)).toBe("Cleared 1 closed decision.");
    expect(clearedWords(7)).toBe("Cleared 7 closed decisions.");
    const d = deps([]);
    expect(await cmdHillClear(d, ["--all"])).toBe(EXIT.USAGE);
    expect(d.io.stderr[0]).toBe("error: unknown argument `--all`");
    expect(await cmdHillClear(deps([], {}, { platform: "win32" }), [])).toBe(EXIT.STATE);
  });

  test("`collie hill clear` is a verb of the program, and `collie hill --help` lists it", async () => {
    const help = capture();
    expect(await run(["hill", "--help"], help)).toBe(EXIT.OK);
    expect(help.stdout).toContain("  collie hill clear [--json]   (remove every closed decision from the Hill; open ones stay)");
  });
});

describe("the Hill's switch", () => {
  socketTest("off: a post is refused with the way back on and exits STATE; status, list and withdraw keep working; on again: it posts", async () => {
    const b = await bridge();
    const sock = [walkySocketPath(b.stateDir)];
    expect(await cmdHillPost(deps(sock), POST)).toBe(EXIT.OK);
    const own = { ctx: context({}, { stateDir: b.stateDir }), now: () => 1000 };
    const off = { ...own, io: capture() };
    expect(cmdHillSwitch(off, "off", [])).toBe(EXIT.OK);
    expect(off.io.stdout).toEqual([HILL_OFF_WORDS]);
    expect(readHillSwitch(b.stateDir)).toEqual({ on: false, problem: null });

    const refused = deps(sock, inPane("%1"), { mintRequestId: () => "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e71" });
    expect(await cmdHillPost(refused, POST)).toBe(EXIT.STATE);
    expect(refused.io.stderr.slice(-2)).toEqual(["hill: the Hill is off on this Collie; your person can switch it on in Settings, Alerts, on the phone, or with: collie hill on (hill_off)", retryLine(POST, "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e71")]);
    // The open decision is still there, and its poster can read, list and withdraw it while the Hill is off.
    const status = deps(sock);
    expect(await cmdHillStatus(status, ["dc_cli000000001"])).toBe(EXIT.OK);
    expect(status.io.stdout[0]).toBe("dc_cli000000001 open");
    const list = deps(sock);
    expect(await cmdHillList(list, [])).toBe(EXIT.OK);
    expect(list.io.stdout.map((line) => line.split("  ")[0])).toEqual(["dc_cli000000001"]);
    const withdraw = deps(sock);
    expect(await cmdHillWithdraw(withdraw, ["dc_cli000000001"])).toBe(EXIT.OK);
    expect(withdraw.io.stdout[0]).toBe("dc_cli000000001 withdrawn");

    const on = { ...own, io: capture() };
    expect(cmdHillSwitch(on, "on", [])).toBe(EXIT.OK);
    expect(on.io.stdout).toEqual([HILL_ON_WORDS]);
    const again = deps(sock, inPane("%1"), { mintRequestId: () => "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e72" });
    expect(await cmdHillPost(again, POST)).toBe(EXIT.OK);
    expect(again.io.stdout).toEqual(["dc_cli000000002"]);
  });

  test("a switch already in place says so and writes nothing; --json prints the value; another argument is a usage error", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "hill-switch-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const own = { ctx: context({}, { stateDir }), now: () => 1000 };
    const already = { ...own, io: capture() };
    expect(cmdHillSwitch(already, "on", [])).toBe(EXIT.OK);
    expect(already.io.stdout).toEqual(["The Hill is already on."]);
    expect(readHillSwitch(stateDir)).toEqual({ on: true, problem: null });
    const json = { ...own, io: capture() };
    expect(cmdHillSwitch(json, "off", ["--json"])).toBe(EXIT.OK);
    expect(json.io.stdout).toEqual(['{"on":false}']);
    const twice = { ...own, io: capture() };
    expect(cmdHillSwitch(twice, "off", [])).toBe(EXIT.OK);
    expect(twice.io.stdout).toEqual(["The Hill is already off."]);
    const bad = { ...own, io: capture() };
    expect(cmdHillSwitch(bad, "on", ["now"])).toBe(EXIT.USAGE);
    expect(bad.io.stderr[0]).toBe("error: unknown argument `now`");
  });

  test("`hill_off` exits STATE, apart from a post refused for its content (REFUSED)", () => {
    expect(refusalExit("hill_off")).toBe(EXIT.STATE);
    expect(refusalExit(null)).toBe(EXIT.STATE);
    expect(refusalExit("bad_title")).toBe(EXIT.REFUSED);
    expect(refusalExit("walky_off")).toBe(EXIT.REFUSED);
    // A member's lead that did not answer: a retry with the same request id may pass (CREW_PROTOCOL §22).
    expect(refusalExit("lead_unreachable")).toBe(EXIT.UNREACHABLE);
    expect(refusalExit("not_on_lead")).toBe(EXIT.REFUSED);
  });

  test("`collie hill on` and `off` are verbs of the tree", async () => {
    const help = capture();
    expect(await run(["hill", "--help"], help)).toBe(EXIT.OK);
    expect(help.stdout).toContain("  collie hill on    (switch the Hill on for this Collie; it is on unless switched off)");
    expect(help.stdout).toContain("  collie hill off   (switch the Hill off: every post is refused, the open decisions stay)");
  });
});

describe("an older bridge on the same machine", () => {
  socketTest("an older bridge asked first that does not know the hill leads the CLI to the next socket, the pane's own", async () => {
    const older = await olderBridge();
    const bare = await olderBridge(true);
    const b = await bridge();
    const d = deps([older.path, bare.path, walkySocketPath(b.stateDir)]);
    expect(await cmdHillPost(d, POST)).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["dc_cli000000001"]);
    expect(older.lines).toHaveLength(1);
    expect(bare.lines).toHaveLength(1);
  });

  socketTest("a real bridge built without the hill also leads to the next socket", async () => {
    const without = await bridge(false);
    const b = await bridge();
    const d = deps([walkySocketPath(without.stateDir), walkySocketPath(b.stateDir)]);
    expect(await cmdHillPost(d, POST)).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["dc_cli000000001"]);
  });

  socketTest("when no bridge knows the hill, the CLI says so and exits non-zero", async () => {
    const older = await olderBridge();
    const bare = await olderBridge(true);
    const without = await bridge(false);
    for (const verb of [(x: HillDeps) => cmdHillPost(x, POST), (x: HillDeps) => cmdHillStatus(x, ["dc_k3m9x2p7q1ab"]), (x: HillDeps) => cmdHillList(x, [])]) {
      const d = deps([older.path, bare.path, walkySocketPath(without.stateDir)]);
      expect(await verb(d)).toBe(EXIT.UNREACHABLE);
      expect(d.io.stderr[0]).toBe(`hill: ${HILL_UNKNOWN}`);
    }
  });

  test("no bridge at all: the same words", async () => {
    const d = deps([join(tmpdir(), "no-such-dir", "walky", "sock")]);
    expect(await cmdHillPost(d, POST)).toBe(EXIT.UNREACHABLE);
    expect(d.io.stderr).toEqual([`hill: ${HILL_UNKNOWN}`, retryLine(POST)]);
  });

  socketTest("a bridge that knows the hill but not this pane says it does not know the pane", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)], inPane("%9"));
    expect(await cmdHillPost(d, POST)).toBe(EXIT.STATE);
    expect(d.io.stderr).toEqual([`hill: ${HILL_NOT_HERE}`, retryLine(POST)]);
  });

  test("Windows has no walky socket", async () => {
    const d = deps([], inPane("%1"), { platform: "win32" });
    expect(await cmdHillPost(d, POST)).toBe(EXIT.STATE);
  });
});

describe("help", () => {
  const RULES = [
    "Post a decision only for what needs the person.",
    "Always write the summary in plain words, and recommend one option with a why.",
    "One question per decision. To change one, post again with --supersedes; never repost.",
    "Do not wait in a loop. The answer arrives as a WalkyTalky message and starts your next turn.",
    "If no answer arrived, read it with collie hill status <id>.",
    "An answer typed into your session for a decision you did not post carries only the id and the option word. Read the rest with collie hill status <id>.",
    "A worker with a lead asks its lead first.",
    "A --view only shows facts. No buttons: the options are the taps.",
    "When your operator settles the question in your session, take the card back: collie hill withdraw <id>.",
    "Before you post, read the crew state: collie hill state. here: post as usual. quiet: post, but do not wait for a fast answer. away: post nothing that needs an answer now; do work that needs no answer, then end your turn.",
    'A receipt or a post result can end with a line such as "Crew state: away." It is the state at that moment.',
  ];

  test("the rules are worded as the brief words them", () => {
    expect(HILL_RULES.join("\n")).toBe(RULES.join("\n"));
  });

  test("`collie hill --help` prints the usage and the rules and exits 0; a bare `collie hill` exits 2", async () => {
    const help = capture();
    expect(await run(["hill", "--help"], help)).toBe(EXIT.OK);
    expect(help.stdout[0]).toBe("usage: collie hill {post|status|withdraw|list|clear|on|off}");
    expect(help.stdout.slice(-RULES.length)).toEqual(RULES);
    const bare = capture();
    expect(cmdHill({ io: bare }, [])).toBe(EXIT.USAGE);
    expect(bare.stderr.slice(-RULES.length)).toEqual(RULES);
    const wrong = capture();
    expect(cmdHill({ io: wrong }, ["ask"])).toBe(EXIT.USAGE);
    expect(wrong.stderr[0]).toBe("error: unknown hill command `ask`");
  });

  test("`collie hill post --help` prints the usage and the rules, and posts nothing", async () => {
    const io = capture();
    expect(await run(["hill", "post", "--help"], io)).toBe(EXIT.OK);
    expect(io.stdout).toEqual(hillPostHelp());
    expect(io.stdout[0]).toStartWith("usage: collie hill post");
    expect(io.stdout).toContain("  With no --expires, a decision closes as expired after 14 days. --expires is at most 30 days.");
    expect(io.stdout.slice(-RULES.length)).toEqual(RULES);
  });
});

describe("the wording warnings", () => {
  const GOOD = { title: "Ship 1.28.1 to Stable now?", summary: "Stable users get the fix today. CI and the browser leg are green.", options: [{ intent: "ship", label: "Ship it" }, { intent: "hold", label: "Hold until CI" }] };

  test("a card worded by the rules gets none", () => {
    expect(hillWordingWarnings(GOOD)).toEqual([]);
  });

  test("a long title, a title that asks nothing, a long summary and a bare Yes each get one sentence", () => {
    const out = hillWordingWarnings({
      title: "The five new view kinds, and what they look like on the phone",
      summary: "One. Two. Three.",
      options: [{ intent: "yes", label: "Yes" }, { intent: "no", label: " no. " }, { intent: "ok", label: "OK!" }, { intent: "later", label: "Yes, after CI" }],
    });
    expect(out).toEqual([
      "the title has 61 characters. Keep it to 60: the decision as a short question.",
      "the title asks no question. Write the decision as a question the options answer.",
      "the summary has 3 sentences. Keep it to two: what the recommended option does, then the fact that decides it.",
      'option "yes" says only "Yes". Start it with a verb that says what happens, such as "Ship it".',
      'option "no" says only "no.". Start it with a verb that says what happens, such as "Ship it".',
      'option "ok" says only "OK!". Start it with a verb that says what happens, such as "Ship it".',
    ]);
  });

  test("a summary past 200 characters is long even in two sentences; a question mark anywhere in the title counts", () => {
    const summary = `${"a".repeat(150)}. ${"b".repeat(60)}.`;
    expect(hillWordingWarnings({ ...GOOD, title: "Post reply to #712? (dry run)", summary })).toEqual(["the summary has 213 characters. Keep it under 200, and put the evidence in the view or the body."]);
  });

  test("sentences split after an end mark and white space, never inside a version or a path", () => {
    expect(sentenceCount("Ship v1.28.1 to Stable. The leg is green.")).toBe(2);
    expect(sentenceCount("It reads web/src/app.tsx and stops")).toBe(1);
    expect(sentenceCount('He said "go." Then it ran! Done?')).toBe(3);
    expect(sentenceCount("")).toBe(0);
  });

  socketTest("post says them on stderr and still posts: a warning never refuses", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)]);
    expect(await cmdHillPost(d, ["--title", "Are the new kinds right", "--summary", "s", "--option", "yes=Yes", "--option", "no=Hold until CI"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["dc_cli000000001"]);
    expect(d.io.stderr).toEqual(["warning: the title asks no question. Write the decision as a question the options answer.", 'warning: option "yes" says only "Yes". Start it with a verb that says what happens, such as "Ship it".']);
  });

  test("both helps print how to word the card, above the rules", () => {
    for (const help of [hillHelp(), hillPostHelp()]) {
      const at = help.indexOf(HILL_WRITING[0]);
      expect(at).toBeGreaterThan(0);
      expect(help.slice(at, at + HILL_WRITING.length)).toEqual([...HILL_WRITING]);
      expect(help.indexOf(HILL_RULES[0])).toBeGreaterThan(at);
    }
  });
});

describe("post --image", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0x86, 0, 0, 0, 0xf0, 8, 2, 0, 0, 0]);

  function work(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "hill-cli-img-")));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  test("an --image value is a path, or a path and a caption after the first =", () => {
    expect(parseImageArg("shots/a.png")).toEqual({ path: "shots/a.png" });
    expect(parseImageArg("shots/a.png=The card, after")).toEqual({ path: "shots/a.png", caption: "The card, after" });
    expect(parseImageArg("a.png=x=y")).toEqual({ path: "a.png", caption: "x=y" });
    expect(parseImageArg("a.png=  ")).toEqual({ error: "`--image a.png=  ` has an empty caption; leave out the = for none" });
    expect(parseImageArg("=caption")).toMatchObject({ error: expect.stringContaining("takes <path>") });
    expect(parseImageArg(`a.png=${"x".repeat(81)}`)).toEqual({ error: "an image caption is at most 80 characters" });
    expect(parseImageArg(`a.png=${"x".repeat(80)}`)).toEqual({ path: "a.png", caption: "x".repeat(80) });
  });

  test("up to four --image, in order; a fifth is a usage error", () => {
    const parsed = parsePostArgs([...POST, "--image", "a.png", "--image", "b.png=Before"]);
    expect("error" in parsed ? parsed.error : parsed.images).toEqual([{ path: "a.png" }, { path: "b.png", caption: "Before" }]);
    const five = parsePostArgs([...POST, ...["a", "b", "c", "d", "e"].flatMap((name) => ["--image", `${name}.png`])]);
    expect(five).toEqual({ error: "a decision has at most 4 `--image`" });
  });

  test("the path sent is absolute with its folders resolved; the file's own name is never followed", () => {
    const dir = work();
    mkdirSync(join(dir, "shots"));
    symlinkSync(join(dir, "shots"), join(dir, "via"));
    expect(imagePathOf("shots/a.png", dir)).toEqual({ path: join(dir, "shots", "a.png") });
    expect(imagePathOf("via/a.png", dir)).toEqual({ path: join(dir, "shots", "a.png") });
    expect(imagePathOf(join(dir, "shots", "a.png"), "/")).toEqual({ path: join(dir, "shots", "a.png") });
    symlinkSync(join(dir, "shots", "a.png"), join(dir, "link.png"));
    expect(imagePathOf("link.png", dir)).toEqual({ path: join(dir, "link.png") });
    expect(imagePathOf("nowhere/a.png", dir)).toEqual({ error: "`--image nowhere/a.png`: no such folder" });
  });

  socketTest("the bridge reads the file the path names and keeps it on the decision; a symlink is refused with the reason", async () => {
    const b = await bridge();
    const dir = work();
    writeFileSync(join(dir, "a.png"), PNG);
    symlinkSync(join(dir, "a.png"), join(dir, "link.png"));
    const d = deps([walkySocketPath(b.stateDir)], inPane("%1"), { cwd: () => dir });
    expect(await cmdHillPost(d, [...POST, "--image", "a.png=After", "--json"])).toBe(EXIT.OK);
    expect(JSON.parse(d.io.stdout[0]!)).toMatchObject({ decision: { media: [{ kind: "image", mime: "image/png", width: 390, height: 240, caption: "After" }] } });
    const refused = deps([walkySocketPath(b.stateDir)], inPane("%1"), { cwd: () => dir, mintRequestId: () => "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e70" });
    expect(await cmdHillPost(refused, [...POST, "--image", "link.png"])).toBe(EXIT.REFUSED);
    expect(refused.io.stderr[0]).toContain("is a symlink; name the file itself");
    expect(refused.io.stderr[0]).toEndWith("(bad_image)");
  });

  socketTest("a bridge that took the post without its images says so on stderr", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "hill-noimg-"));
    const path = walkySocketPath(stateDir);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", () => socket.end(`${JSON.stringify({ ok: true, decision: storedDecision("dc_older0000001") })}\n`));
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    cleanups.push(() => {
      server.close();
      rmSync(stateDir, { recursive: true, force: true });
    });
    const dir = work();
    writeFileSync(join(dir, "a.png"), PNG);
    const d = deps([path], inPane("%1"), { cwd: () => dir });
    expect(await cmdHillPost(d, [...POST, "--image", "a.png"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["dc_older0000001"]);
    expect(d.io.stderr).toEqual([`hill: ${HILL_IMAGES_DROPPED}`]);
  });

  describe("a picture under /tmp, for a bridge with a private /tmp", () => {
    /** A folder of the test's own as the staging root, and a folder under /tmp for the picture. */
    function stage() {
      const root = join(work(), "image-staging");
      const dir = realpathSync(mkdtempSync(join("/tmp", "hill-cli-tmp-")));
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      writeFileSync(join(dir, "a.png"), PNG);
      return { root, dir, left: () => (existsSync(root) ? readdirSync(root) : []) };
    }

    /** A socket the CLI accepts as a bridge's (real folder, our uid, 0700); the `ask` of each test stands in for the bridge. */
    async function socket(): Promise<string> {
      const stateDir = mkdtempSync(join(tmpdir(), "hill-stage-sock-"));
      const path = walkySocketPath(stateDir);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const server = createServer((conn) => conn.end());
      await new Promise<void>((resolve) => server.listen(path, resolve));
      cleanups.push(() => {
        server.close();
        rmSync(stateDir, { recursive: true, force: true });
      });
      return path;
    }

    type Seen = { lines: string[]; staged: string[]; bytes: Uint8Array[] };

    /** An `ask` that records each request line, reads the staged files while the request is open, then answers. */
    function asking(seen: Seen, answer: (staged: string[]) => string | Promise<string>): HillDeps["ask"] {
      return async (_path, line) => {
        seen.lines.push(line);
        const sent = parseJsonObject(line)?.images;
        const images = (Array.isArray(sent) ? sent : []).flatMap((image) => asJsonString(asJsonObject(image)?.path) ?? []).map((path) => ({ path }));
        seen.staged.push(...images.map((image) => image.path));
        for (const image of images) if (existsSync(image.path)) seen.bytes.push(new Uint8Array(readFileSync(image.path)));
        return answer(images.map((image) => image.path));
      };
    }

    const seenNone = (): Seen => ({ lines: [], staged: [], bytes: [] });
    const okAnswer = `${JSON.stringify({ ok: true, decision: storedDecision("dc_staged000001") })}\n`;
    const refusal = (staged: string[]) => `${JSON.stringify({ ok: false, hill: true, code: "bad_image", error: `${staged[0] ?? ""}: the bridge does not like this picture` })}\n`;

    test("is copied, the copy is the path sent, and the copy is gone when the post is answered", async () => {
      const sock = await socket();
      const s = stage();
      const seen = seenNone();
      const d = deps([sock], inPane("%1"), { cwd: () => s.dir, stagingRoot: () => s.root, ask: asking(seen, () => okAnswer) });
      expect(await cmdHillPost(d, [...POST, "--image", "a.png=After"])).toBe(EXIT.OK);
      expect(seen.staged).toHaveLength(1);
      expect(seen.staged[0]!.startsWith(`${s.root}/`)).toBe(true);
      expect(seen.staged[0]).not.toContain("/tmp/hill-cli-tmp-");
      expect(JSON.parse(seen.lines[0]!).images).toEqual([{ path: seen.staged[0], caption: "After" }]);
      expect(seen.bytes[0]).toEqual(PNG);
      expect(existsSync(seen.staged[0]!)).toBe(false);
      expect(s.left()).toEqual([]);
    });

    test("a bridge refusal names the path the agent typed, not the copy, and the copy is gone", async () => {
      const sock = await socket();
      const s = stage();
      const seen = seenNone();
      const typed = join(s.dir, "a.png");
      const d = deps([sock], inPane("%1"), { cwd: () => s.dir, stagingRoot: () => s.root, ask: asking(seen, refusal) });
      expect(await cmdHillPost(d, [...POST, "--image", "a.png"])).toBe(EXIT.REFUSED);
      expect(d.io.stderr[0]).toBe(`hill: ${typed}: the bridge does not like this picture (bad_image)`);
      expect(d.io.stderr.join("\n")).not.toContain(s.root);
      expect(s.left()).toEqual([]);
    });

    test("a timeout and a throw leave no copy behind", async () => {
      const sock = await socket();
      const s = stage();
      const seen = seenNone();
      const late = deps([sock], inPane("%1"), { cwd: () => s.dir, stagingRoot: () => s.root, ask: asking(seen, () => Promise.reject(new AskLate(1000))) });
      expect(await cmdHillPost(late, [...POST, "--image", "a.png"])).toBe(EXIT.UNREACHABLE);
      expect(late.io.stderr[0]).toContain(HILL_NOT_CONFIRMED);
      expect(seen.staged).toHaveLength(1);
      expect(s.left()).toEqual([]);
      // `sockets` throws inside the request, after the copy was made.
      const thrown = deps([sock], inPane("%1"), {
        cwd: () => s.dir,
        stagingRoot: () => s.root,
        sockets: () => {
          expect(s.left()).toHaveLength(1);
          throw new Error("boom");
        },
      });
      await expect(cmdHillPost(thrown, [...POST, "--image", "a.png"])).rejects.toThrow("boom");
      expect(s.left()).toEqual([]);
    });

    test("a picture outside /tmp and /var/tmp is sent as it is, with no copy", async () => {
      const sock = await socket();
      if (!existsSync("/dev/shm")) return;
      const s = stage();
      const dir = realpathSync(mkdtempSync(join("/dev/shm", "hill-cli-shm-")));
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      writeFileSync(join(dir, "a.png"), PNG);
      const seen = seenNone();
      const d = deps([sock], inPane("%1"), { cwd: () => dir, stagingRoot: () => s.root, ask: asking(seen, () => okAnswer) });
      expect(await cmdHillPost(d, [...POST, "--image", "a.png"])).toBe(EXIT.OK);
      expect(seen.staged).toEqual([join(dir, "a.png")]);
      expect(existsSync(s.root)).toBe(false);
    });

    test("a picture the helper refuses is a plain error and a non-zero exit, and nothing is posted", async () => {
      const sock = await socket();
      const s = stage();
      const seen = seenNone();
      const missing = deps([sock], inPane("%1"), { cwd: () => s.dir, stagingRoot: () => s.root, ask: asking(seen, () => okAnswer) });
      expect(await cmdHillPost(missing, [...POST, "--image", "gone.png"])).toBe(EXIT.REFUSED);
      expect(missing.io.stderr[0]).toStartWith(`hill: ${join(s.dir, "gone.png")}`);
      // A copy that cannot be made has no bridge code: the machine's state, not the picture.
      const blocked = join(s.dir, "not-a-folder");
      writeFileSync(blocked, "x");
      const noCopy = deps([sock], inPane("%1"), { cwd: () => s.dir, stagingRoot: () => join(blocked, "stage"), ask: asking(seen, () => okAnswer) });
      expect(await cmdHillPost(noCopy, [...POST, "--image", "a.png"])).toBe(EXIT.FAIL);
      expect(noCopy.io.stderr[0]).toStartWith("hill: could not copy the picture for the bridge:");
      expect(seen.lines).toEqual([]);
    });
  });
});

describe("post --view", () => {
  const VIEW = [
    { kind: "bar", kids: [{ kind: "chip", text: "unit", attrs: { tone: "ok" } }, { kind: "chip", text: "e2e", attrs: { tone: "danger" } }] },
    { kind: "list", kids: [{ kind: "row", text: "src/app.ts", kids: [{ kind: "chip", text: "+12 \u22123" }] }] },
  ];

  function work(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "hill-cli-view-")));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  test("the file is read as JSON; a missing file, a folder, a file past 16 KiB or not JSON says so in one line", () => {
    const dir = work();
    writeFileSync(join(dir, "v.json"), JSON.stringify(VIEW));
    writeFileSync(join(dir, "big.json"), `[${" ".repeat(HILL_VIEW_FILE_MAX)}]`);
    writeFileSync(join(dir, "bad.json"), "[{");
    mkdirSync(join(dir, "folder"));
    expect(readViewFile("v.json", dir)).toEqual({ view: VIEW });
    expect(readViewFile(join(dir, "v.json"), "/")).toEqual({ view: VIEW });
    expect(readViewFile("none.json", dir)).toEqual({ error: "`--view none.json`: no such file" });
    expect(readViewFile("folder", dir)).toEqual({ error: "`--view folder` is not a file" });
    expect(readViewFile("big.json", dir)).toEqual({ error: "`--view big.json` is larger than 16 KiB" });
    expect(readViewFile("bad.json", dir)).toEqual({ error: "`--view bad.json` is not JSON" });
  });

  test("a file that cannot be read is a usage error, and nothing is posted", async () => {
    const dir = work();
    const d = deps([], inPane("%1"), { cwd: () => dir });
    expect(await cmdHillPost(d, [...POST, "--view", "none.json"])).toBe(EXIT.USAGE);
    expect(d.io.stderr[0]).toContain("`--view none.json`: no such file");
  });

  socketTest("the view goes on the decision; a button in it is refused bad_body with the path of the node", async () => {
    const b = await bridge();
    const dir = work();
    writeFileSync(join(dir, "v.json"), JSON.stringify(VIEW));
    writeFileSync(join(dir, "button.json"), JSON.stringify([{ kind: "para", text: "x" }, { kind: "button", text: "Merge", attrs: { intent: "merge" } }]));
    const d = deps([walkySocketPath(b.stateDir)], inPane("%1"), { cwd: () => dir });
    expect(await cmdHillPost(d, [...POST, "--view", "v.json", "--json"])).toBe(EXIT.OK);
    expect(JSON.parse(d.io.stdout[0]!)).toMatchObject({ decision: { view: VIEW } });
    const refused = deps([walkySocketPath(b.stateDir)], inPane("%1"), { cwd: () => dir, mintRequestId: () => "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e70" });
    expect(await cmdHillPost(refused, [...POST, "--view", "button.json"])).toBe(EXIT.REFUSED);
    expect(refused.io.stderr[0]).toContain("/view/1");
    expect(refused.io.stderr[0]).toEndWith("(bad_body)");
  });

  socketTest("a bridge that took the post without its view says so on stderr", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "hill-noview-"));
    const path = walkySocketPath(stateDir);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", () => socket.end(`${JSON.stringify({ ok: true, decision: storedDecision("dc_older0000002") })}\n`));
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    cleanups.push(() => {
      server.close();
      rmSync(stateDir, { recursive: true, force: true });
    });
    const dir = work();
    writeFileSync(join(dir, "v.json"), JSON.stringify(VIEW));
    const d = deps([path], inPane("%1"), { cwd: () => dir });
    expect(await cmdHillPost(d, [...POST, "--view", "v.json"])).toBe(EXIT.OK);
    expect(d.io.stderr).toEqual([`hill: ${HILL_VIEW_DROPPED}`]);
  });

  test("the help names the kinds and says the options are the taps", () => {
    const help = hillPostHelp().join("\n");
    expect(help).toContain("--view view.json");
    expect(help).toContain("No buttons: the options are the taps");
  });
});

describe("a retried post", () => {
  socketTest("the same --request-id posts once; other content under it is refused request_id_reused", async () => {
    const b = await bridge();
    const sock = [walkySocketPath(b.stateDir)];
    const id = "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e71";
    const first = deps(sock);
    expect(await cmdHillPost(first, [...POST, "--request-id", id, "--expires", "2h"])).toBe(EXIT.OK);
    const again = deps(sock, inPane("%1"), { now: () => 99_000 });
    expect(await cmdHillPost(again, [...POST, "--request-id", id, "--expires", "2h"])).toBe(EXIT.OK);
    expect(again.io.stdout).toEqual(first.io.stdout);
    const changed = deps(sock);
    expect(await cmdHillPost(changed, [...POST.map((arg) => (arg === "Ship the zoom fix in 1.28.1?" ? "Ship it later?" : arg)), "--request-id", id])).toBe(EXIT.REFUSED);
    expect(changed.io.stderr[0]).toBe(`hill: this request id already posted ${first.io.stdout[0]!} with other content; post with a new --request-id (request_id_reused)`);
  });
});

/**
 * A crew member's bridge on a real socket, whose forward dials a lead in this process through a link
 * that answers after `delayMs`: the slow relayed link of CREW_PROTOCOL §22.
 */
async function slowCrew(delayMs: number): Promise<{ readonly sock: string[]; readonly lead: HillService; readonly leadStore: HillStore }> {
  const stateDir = mkdtempSync(join(tmpdir(), "hill-member-"));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const leadStore = new HillStore(null, () => 1000);
  let n = 0;
  const lead = new HillService({
    store: leadStore,
    receipts: memoryHillReceipts(),
    place: (address) => (address.startsWith("laptop/%1") ? { address: "laptop/%1#aaaa", label: "repo#one", host: "laptop", unattended: false } : null),
    send: async () => "typed",
    crewMode: () => "lead",
    walkyOn: () => true,
    memberId: "m_lead000000",
    machine: "desk",
    now: () => 1000,
    mintId: () => {
      n += 1;
      return `dc_lead${String(n).padStart(8, "0")}`;
    },
  });
  const crewLead = new HillCrewLead({ hill: lead, held: new HillHeldMedia(() => 1000) });
  const link: HillLeadLink = {
    leadName: () => "desk",
    leadOlder: () => false,
    leadAtFloor: () => true,
    call: async (route, payload) => {
      await Bun.sleep(delayMs);
      const handle = route === CREW_HILL_POST_ROUTE ? crewLead.post.bind(crewLead) : route === CREW_HILL_MEDIA_ROUTE ? crewLead.media.bind(crewLead) : crewLead.op.bind(crewLead);
      const answer = await handle(parseJsonObject(payload), "laptop");
      return { kind: "answer", status: answer.status, body: JSON.parse(JSON.stringify(answer.body)) };
    },
  };
  const host: WalkyHost = { panes: () => panes, send: async () => ({ outcome: "sent" }), sendState: () => ({ outcome: "sent" }), cancelHeld: () => undefined };
  const walky = new WalkyService({ log: new WalkyLog(join(stateDir, "walky")), host, memberId: "laptop", enabled: () => true, machine: "laptop", keyPem: () => null });
  const member = new HillService({
    store: new HillStore(null, () => 1000),
    receipts: memoryHillReceipts(),
    place: walkyPlace(walky, "laptop"),
    send: async () => "typed",
    crewMode: () => "peer",
    walkyOn: () => true,
    memberId: "m_laptop0000",
    machine: "laptop",
    now: () => 1000,
    forward: new HillMemberForward(link),
  });
  const server = new WalkyServer({ socketPath: walkySocketPath(stateDir), service: walky, targets: () => [target], log: () => undefined, hill: member });
  expect(await server.start()).toBe(true);
  cleanups.push(() => server.stop());
  return { sock: [walkySocketPath(stateDir)], lead, leadStore };
}

describe("a post on a slow crew link", () => {
  socketTest("the CLI waits longer than the member's whole forward", () => {
    expect(HILL_POST_ASK_MS).toBeGreaterThan(HILL_FORWARD_BUDGET_MS);
    expect(HILL_FORWARD_BUDGET_MS).toBeGreaterThanOrEqual(HILL_MEDIA_BUDGET_MS + HILL_CALL_BUDGET_MS);
  });

  socketTest("a late answer says not confirmed and prints the retry; the retry with that id leaves one card", async () => {
    const { sock, leadStore } = await slowCrew(300);
    // The CLI's wait, cut short to stand for a forward that outlasts it.
    const first = deps(sock, inPane("%1"), { ask: (path, line) => askSocket(path, line, 50), mintRequestId: () => "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e99" });
    expect(await cmdHillPost(first, POST)).toBe(EXIT.UNREACHABLE);
    expect(first.io.stderr[0]).toBe(`hill: ${HILL_NOT_CONFIRMED}`);
    expect(first.io.stderr.join("\n")).not.toContain("no running Collie");
    const retry = /--request-id (\S+)/u.exec(first.io.stderr[1] ?? "")?.[1];
    expect(retry).toBe("0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e99");
    expect(first.io.stderr[1]).toContain(`collie hill post --title 'Ship the zoom fix in 1.28.1?'`);
    // The bridge went on and posted.
    await Bun.sleep(500);
    expect(leadStore.all()).toHaveLength(1);
    // The agent runs the printed command: the same request id posts once.
    const again = deps(sock);
    expect(await cmdHillPost(again, [...POST, "--request-id", retry!])).toBe(EXIT.OK);
    expect(again.io.stdout).toEqual([leadStore.all()[0]!.id]);
    expect(leadStore.all()).toHaveLength(1);
  });
});

describe("status of Collie's own card, from the session it tells", () => {
  const COLLIE = { kind: "collie" as const, ref: { type: "proposal" as const, id: "legs", hash: "a".repeat(64) }, label: "Collie" };
  const CARD = { requestId: "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f", title: "Switch on the trick legs?", summary: "An agent session (repo#one) on desk proposes it.", options: [{ intent: "on", label: "Switch it on" }, { intent: "later", label: "Not now" }], text: "none" as const, recommends: null };

  socketTest("the proposing session reads the card before and after the answer; another pane does not", async () => {
    const b = await bridge(true, { onCollieAnswer: async () => ({ ok: true }) });
    const sock = [walkySocketPath(b.stateDir)];
    const posted = b.hill.postCollie(COLLIE, CARD, { tellOf: "local/%1#aaaa" });
    expect(posted.ok).toBe(true);
    const before = deps(sock);
    expect(await cmdHillStatus(before, ["dc_cli000000001"])).toBe(EXIT.OK);
    expect(before.io.stdout).toEqual(["dc_cli000000001 open", "title: Switch on the trick legs?"]);
    await b.hill.answer({ rid: "11111111-1111-4111-8111-111111111111", node: "hill/dc_cli000000001", intent: "on", value: { text: null } }, "dc_cli000000001", "Pixel 9");
    const after = deps(sock);
    expect(await cmdHillStatus(after, ["dc_cli000000001"])).toBe(EXIT.OK);
    expect(after.io.stdout).toEqual(["dc_cli000000001 answered", "title: Switch on the trick legs?", "answer: on (Switch it on)", "by: Pixel 9", "delivery: typed"]);
    // Nobody else reads it, and the proposer cannot take it back.
    const other = deps(sock, inPane("%2"));
    expect(await cmdHillStatus(other, ["dc_cli000000001"])).not.toBe(EXIT.OK);
    expect(await cmdHillWithdraw(deps(sock), ["dc_cli000000001"])).not.toBe(EXIT.OK);
  });

  socketTest("on a crew member, the proposing session reads its lead's card", async () => {
    const { sock, lead } = await slowCrew(0);
    expect(lead.postCollie(COLLIE, CARD, { tellOf: "laptop/%1#aaaa" }).ok).toBe(true);
    const reader = deps(sock);
    expect(await cmdHillStatus(reader, ["dc_lead00000001"])).toBe(EXIT.OK);
    expect(reader.io.stdout).toEqual(["dc_lead00000001 open", "title: Switch on the trick legs?"]);
  });
});

describe("status from the session an answer goes to", () => {
  socketTest("the replyTo session reads the decision and its answer; a third pane does not", async () => {
    const b = await bridge();
    const sock = [walkySocketPath(b.stateDir)];
    expect(await cmdHillPost(deps(sock), [...POST, "--reply-to", "local/%2"])).toBe(EXIT.OK);
    await b.hill.answer({ rid: "11111111-1111-4111-8111-111111111111", node: "hill/dc_cli000000001", intent: "yes", value: { text: "Go." } }, "dc_cli000000001", "Pixel 9");
    const reader = deps(sock, inPane("%2"));
    expect(await cmdHillStatus(reader, ["dc_cli000000001"])).toBe(EXIT.OK);
    expect(reader.io.stdout).toEqual(["dc_cli000000001 answered", "title: Ship the zoom fix in 1.28.1?", "goes to: repo#two on desk", "answer: yes (Yes, Edge first)", "  Go.", "by: Pixel 9", "delivery: typed"]);
    // The replyTo session may read it, never take it back.
    const taker = deps(sock, inPane("%2"));
    expect(await cmdHillWithdraw(taker, ["dc_cli000000001"])).toBe(EXIT.STATE);
  });
});

describe("the session's name in status", () => {
  test("status names where the answer goes as the bridge served it, the session's name and its machine", () => {
    const decision = storedDecision("dc_named0000001", { target: { label: "concept hill v2", host: "lodge", unattended: false } });
    expect(statusLines(decision)).toEqual(["dc_named0000001 open", "title: Ship it?", "goes to: concept hill v2 on lodge"]);
    expect(statusLines({ ...decision, target: { label: "lead", host: null, unattended: false } })).toEqual(["dc_named0000001 open", "title: Ship it?", "goes to: lead"]);
    expect(statusLines({ ...decision, target: null })).toEqual(["dc_named0000001 open", "title: Ship it?"]);
  });
});
