import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { walkySocketPath } from "../bridge/walky/socket.ts";
import { askInput, askRig, ONE, posted } from "../bridge/hill/ask-rig.ts";
import { readWalkyRequest } from "../bridge/walky/parse.ts";
import type { JsonObject } from "../bridge/json.ts";
import { parseJsonObject } from "../web/src/lib/json.ts";
import { ASK_DRY_RUN, ASK_HELP, ASK_NO_BACKGROUND, cardOf, cmdAskCancel, cmdAskStatus, cmdWalkyAsk, cmdWalkyAsks, namesAnAsk, parseAskArgs, parseFileArg } from "./ask.ts";
import { capture, context } from "./fakes.ts";
import type { HillDeps } from "./hill.ts";
import { EXIT } from "./io.ts";
import { run } from "./program.ts";
import { realFiles, type Files } from "./sys.ts";

// `collie walky ask` and its verbs (Asks, 2026-11-22). The bridge is a scripted socket here: each case sees
// the request line the CLI wrote and answers what a bridge would. The bridge's own rules are in
// bridge/hill/asks*.test.ts.

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

function scratch(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "collie-ask-cli-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Scripted {
  readonly d: HillDeps & { readonly io: ReturnType<typeof capture> };
  readonly lines: JsonObject[];
}

/**
 * The socket the CLI's safety check takes (`holdSocketSafe`): a socket of this uid in a private folder.
 * The scripted `ask` answers in its place, so no socket is made. The check is told what a POSIX host
 * says of it, as the neighbouring tests of `cli/` do (`hill-state.test.ts`): a Windows host has no
 * Unix socket door, and its real folders carry no mode bits.
 */
const SOCKET = walkySocketPath(join(tmpdir(), "collie-ask-cli-bridge"));
const SOCKET_FOLDERS = new Set([dirname(SOCKET), dirname(dirname(SOCKET))]);
const SOCKET_FILES: Files = {
  ...realFiles,
  entryType: (path) => (path === SOCKET ? "other" : SOCKET_FOLDERS.has(path) ? "directory" : realFiles.entryType(path)),
  mode: (path) => (SOCKET_FOLDERS.has(path) ? 0o700 : realFiles.mode(path)),
};

/** Deps whose one bridge answers `reply` to every line, and keeps each line it got. */
function scripted(reply: (line: JsonObject) => object, over: Partial<HillDeps> = {}): Scripted {
  const io = capture();
  const lines: JsonObject[] = [];
  const d: HillDeps & { readonly io: ReturnType<typeof capture> } = {
    ctx: context({ TMUX: "/tmp/tmux-1/default,123,0", TMUX_PANE: "%1" }, { stateDir: scratch() }),
    stagingRoot: () => scratch(),
    files: SOCKET_FILES,
    uid: undefined,
    platform: "linux",
    readStdin: async () => "",
    stdinIsTty: true,
    ask: async (_path, line) => {
      const row = parseJsonObject(line) ?? {};
      lines.push(row);
      return `${JSON.stringify(reply(row))}\n`;
    },
    sockets: () => [SOCKET],
    mintRequestId: () => "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f",
    now: () => 1000,
    ...over,
    io,
  };
  return { d, lines };
}

const BASE = ["Ship the fix on Edge first?", "--fact", "The fix is green on the leg.", "--option", "edge=Ship it on Edge first", "--does", "edge=Testers get it today.", "--option", "stable=Ship it on Stable now", "--does", "stable=Everyone gets it today."];

function refusal(args: readonly string[]): string {
  const read = parseAskArgs(args);
  if (!("error" in read)) throw new Error("not refused");
  return read.error;
}

describe("the flags of walky ask", () => {
  test("reads a whole ask", () => {
    const read = parseAskArgs([...BASE, "--recommend", "edge", "--why", "Testers see it first.", "--file", "docs/hill.md#Asks (in work)", "--file", "bridge/server.ts:3832", "--replaces", "ak_aaaaaaaaaaaa", "--", "The", "background."]);
    expect(read).toMatchObject({
      question: "Ship the fix on Edge first?",
      fact: "The fix is green on the leg.",
      options: [
        { intent: "edge", label: "Ship it on Edge first", detail: "Testers get it today." },
        { intent: "stable", label: "Ship it on Stable now", detail: "Everyone gets it today." },
      ],
      recommends: { intent: "edge", why: "Testers see it first." },
      inline: "The background.",
      files: [{ path: "docs/hill.md", heading: "Asks (in work)" }, { path: "bridge/server.ts", line: 3832 }],
      replaces: "ak_aaaaaaaaaaaa",
      words: false,
      dryRun: false,
    });
  });

  test("refuses each rule, naming the flag and the limit", () => {
    expect(refusal(["--fact", "x"])).toContain("the question is missing");
    expect(refusal(["One?", "Two?", "--fact", "x"])).toContain("only one argument");
    expect(refusal([`${"x".repeat(90)}?`, "--fact", "x"])).toBe("the question has 91 characters. The limit is 90.");
    expect(refusal(["Ship it.", "--fact", "x"])).toBe('the question must end with "?".');
    expect(refusal(["Ship?"])).toBe("--option must be given 2 to 5 times. You gave 0. An ask with no options takes --words.");
    expect(refusal(["Ship?", "--fact", "x".repeat(241)])).toBe("--fact has 241 characters. The limit is 240.");
    expect(refusal([...BASE, "--fact", "again"])).toBe("--fact may be given only once.");
    expect(refusal(["Ship?", "--fact", "x", "--option", "edge=Ship it", "--does", "edge=x"])).toContain("--option must be given 2 to 5 times. You gave 1.");
    expect(refusal(["Ship?", "--fact", "x", "--option", "yes=Yes", "--option", "no=No"])).toContain('--option yes label "Yes" is not allowed');
    expect(refusal(["Ship?", "--fact", "x", "--option", "a=OK", "--option", "b=Wait a day"])).toContain("is not allowed");
    expect(refusal(["Ship?", "--fact", "x", "--option", "Bad Id=Ship it"])).toContain('--option id "Bad Id" is not valid');
    expect(refusal(["Ship?", "--fact", "x", "--option", "more-context=Ship it"])).toContain("is not valid");
    expect(refusal(["Ship?", "--fact", "x", "--option", "a=Ship it", "--option", "a=Hold it"])).toContain("is used twice");
    expect(refusal(["Ship?", "--fact", "x", "--option", "a=", "--option", "b=Hold it"])).toContain("has an empty label");
    expect(refusal(["Ship?", "--fact", "x", "--option", `a=${"x".repeat(61)}`, "--option", "b=Hold it"])).toBe("--option a label has 61 characters. The limit is 60.");
    expect(refusal(["Ship?", "--fact", "x", "--option", "aShip it"])).toContain('--option needs the form <id>="<label>"');
    expect(refusal([...BASE, "--cost", "zz=x"])).toBe('--cost id "zz" is not one of the options (edge, stable).');
    expect(refusal([...BASE, "--cost", "edge=a", "--cost", "edge=b"])).toContain("--cost is given twice");
    expect(refusal([...BASE, "--cost", `edge=${"x".repeat(301)}`])).toBe("--cost edge text has 301 characters. The limit is 300.");
    expect(refusal([...BASE, "--does", "zz=x"])).toContain('--does id "zz" is not one of the options');
    expect(refusal([...BASE, "--does", "edge=again"])).toContain("--does is given twice");
    expect(refusal(["Ship?", "--fact", "x", "--option", "a=Ship it", "--option", "b=Hold it", "--does", `a=${"x".repeat(301)}`, "--does", "b=y"])).toBe("--does a text has 301 characters. The limit is 300.");
    expect(refusal([...BASE, "--recommend", "edge"])).toBe("--recommend and --why go together. Give both or neither.");
    expect(refusal([...BASE, "--why", "x"])).toBe("--recommend and --why go together. Give both or neither.");
    expect(refusal([...BASE, "--recommend", "zz", "--why", "x"])).toContain('--recommend id "zz" is not one of the options');
    expect(refusal([...BASE, "--recommend", "edge", "--why", "x".repeat(201)])).toContain("--why is 1 to 200 characters");
    expect(refusal([...BASE, "--body", "a.md", "--", "inline"])).toContain("not both");
    expect(refusal([...BASE, "--", "x".repeat(20_001)])).toBe("the body after -- has 20001 characters. The limit is 20000.");
    expect(refusal([...BASE, ...Array.from({ length: 11 }, (_, i) => ["--file", `f${String(i)}.md`]).flat()])).toBe("--file may be given at most 10 times. You gave 11.");
    expect(refusal([...BASE, "--file", "a.md#"])).toContain("heading after # is empty");
    expect(refusal([...BASE, "--file", `a.md#${"h".repeat(121)}`])).toContain("The limit is 120.");
    expect(refusal([...BASE, "--file", "a.md:0"])).toContain(":line is a positive whole number");
    expect(refusal([...BASE, "--image", "a.png="])).toContain("--image");
    expect(refusal([...BASE, "--replaces", "wt_aaaaaaaaaaaa"])).toContain("--replaces");
    expect(refusal([...BASE, "--request-id", "nope"])).toContain("--request-id is a UUID");
    expect(refusal([...BASE, "--text", "none"])).toBe("unknown flag --text. See: collie walky ask --help");
    expect(refusal(["Ship?", "--fact"])).toBe("--fact needs a value.");
  });

  test("only the question and the options are required; every other field is optional", () => {
    const bare = parseAskArgs(["Ship it?", "--option", "a=Ship it", "--option", "b=Hold it"]);
    expect(bare).toMatchObject({ question: "Ship it?", fact: "", options: [{ intent: "a", label: "Ship it" }, { intent: "b", label: "Hold it" }], recommends: null, bodyPath: null, inline: null, files: [], images: [], replaces: null, requestId: null });
    expect("error" in bare ? [] : bare.options.map((option) => Object.keys(option))).toEqual([["intent", "label"], ["intent", "label"]]);
    // One --does, no --cost: each is per option and optional.
    expect(parseAskArgs(["Ship it?", "--option", "a=Ship it", "--option", "b=Hold it", "--does", "a=It ships."])).toMatchObject({ options: [{ intent: "a", detail: "It ships." }, { intent: "b" }] });
    const full = parseAskArgs([...BASE, "--cost", "edge=One more day.", "--cost", "stable=A risk for all."]);
    expect(full).toMatchObject({ options: [{ intent: "edge", detail: "Testers get it today.", cost: "One more day." }, { intent: "stable", detail: "Everyone gets it today.", cost: "A risk for all." }] });
    expect(parseAskArgs(["What should the page say?", "--words"])).toMatchObject({ words: true, fact: "", options: [] });
  });

  test("--words takes no option and no recommendation", () => {
    expect(parseAskArgs(["What should the page say?", "--fact", "It is blank.", "--words"])).toMatchObject({ words: true, options: [] });
    expect(refusal([...BASE, "--words"])).toContain("--words takes no --option");
    expect(refusal(["What?", "--fact", "x", "--words", "--recommend", "a", "--why", "b"])).toContain("--recommend needs options");
  });

  test("a --file place: a line at the end, else a heading after the last folder", () => {
    expect(parseFileArg("a/b.md")).toEqual({ path: "a/b.md" });
    expect(parseFileArg("a/b.md:12")).toEqual({ path: "a/b.md", line: 12 });
    expect(parseFileArg("a#b/c.md#The heading")).toEqual({ path: "a#b/c.md", heading: "The heading" });
    expect(parseFileArg("C:/x.md")).toEqual({ path: "C:/x.md" });
  });
});

describe("the help", () => {
  test("holds the seven rules and stays under 1,500 bytes", async () => {
    const bytes = new TextEncoder().encode(ASK_HELP.join("\n")).byteLength;
    expect(bytes).toBeLessThan(1500);
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(ASK_HELP.some((line) => line.startsWith(`${String(n)}. `))).toBe(true);
    const io = capture();
    expect(await run(["walky", "ask", "--help"], io)).toBe(EXIT.OK);
    expect(io.stdout.join("\n")).toContain("7. A dialog that blocks a command is not an ask.");
  });
});

describe("walky ask", () => {
  test("--dry-run prints the card, the no-background line, and sends nothing", async () => {
    const s = scripted(() => ({ ok: true }));
    expect(await cmdWalkyAsk(s.d, [...BASE, "--recommend", "edge", "--why", "Testers see it first.", "--dry-run"])).toBe(EXIT.OK);
    expect(s.lines).toHaveLength(0);
    expect(s.d.io.stdout[0]).toBe(ASK_DRY_RUN);
    expect(s.d.io.stdout).toContain("Question: Ship the fix on Edge first?");
    expect(s.d.io.stdout).toContain("  edge: Ship it on Edge first (recommended)");
    expect(s.d.io.stdout).toContain("Why: Testers see it first.");
    expect(s.d.io.stdout.at(-1)).toBe(ASK_NO_BACKGROUND);
  });

  test("--dry-run still checks the body file and the linked files", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "body.md"), "## Found\n\nIt works.");
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "a.md"), "x");
    symlinkSync(join(dir, "docs", "a.md"), join(dir, "docs", "link.md"));
    const s = scripted(() => ({ ok: true }), { cwd: () => dir });
    expect(await cmdWalkyAsk(s.d, [...BASE, "--body", "gone.md", "--dry-run"])).toBe(EXIT.USAGE);
    expect(s.d.io.stderr.at(-1)).toBe("ask: --body file gone.md does not exist.");
    expect(await cmdWalkyAsk(s.d, [...BASE, "--file", "docs/gone.md", "--dry-run"])).toBe(EXIT.USAGE);
    expect(s.d.io.stderr.at(-1)).toBe("ask: --file docs/gone.md does not exist.");
    expect(await cmdWalkyAsk(s.d, [...BASE, "--file", "docs", "--dry-run"])).toBe(EXIT.USAGE);
    expect(s.d.io.stderr.at(-1)).toBe("ask: --file docs is not a regular file.");
    expect(await cmdWalkyAsk(s.d, [...BASE, "--body", "body.md", "--file", "docs/link.md:3", "--dry-run"])).toBe(EXIT.OK);
    // The CLI follows the link to the real path; the card shows where it leads.
    expect(s.d.io.stdout).toContain(`  ${join(dir, "docs", "a.md")}:3`);
    expect(s.d.io.stdout).toContain("Background:");
    expect(s.d.io.stdout).not.toContain(ASK_NO_BACKGROUND);
    expect(s.lines).toHaveLength(0);
  });

  test("sends ask.post with the absolute real paths, then prints the id and the card", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "a.md"), "x");
    const r = askRig();
    const stored = posted(r.hill.post(ONE, askInput(1, { body: "Line one.\nLine two." })));
    const s = scripted(() => ({ ok: true, decision: stored }), { cwd: () => dir });
    expect(await cmdWalkyAsk(s.d, [...BASE, "--file", "a.md#Top", "--", "Line one.\nLine two."])).toBe(EXIT.OK);
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).toMatchObject({ op: "ask.post", requestId: "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f", title: "Ship the fix on Edge first?", summary: "The fix is green on the leg.", text: "optional", supersedes: null, ask: { words: false, files: [{ path: join(dir, "a.md"), heading: "Top" }] } });
    // The line the CLI wrote is one the bridge reads as an ask.post.
    const reread = readWalkyRequest(JSON.stringify({ v: 1, markers: [], ...s.lines[0] }));
    expect(reread.ok && reread.request.op).toBe("ask.post");
    expect(s.d.io.stdout[0]).toBe(stored.id);
    // The card, then the one line that says how the ask stays open and how to close it.
    expect(s.d.io.stdout.slice(1, -1)).toEqual(cardOf(stored));
    expect(s.d.io.stdout.at(-1)).toBe(`Open until answered. Settled first? collie walky cancel ${stored.id} [--answered]`);
  });

  test("a refusal prints the bridge's words and code, and a retry line when the same ask may pass", async () => {
    const s = scripted(() => ({ ok: false, error: "this session has 5 open asks", code: "too_many_open", hill: true }));
    expect(await cmdWalkyAsk(s.d, BASE)).toBe(EXIT.REFUSED);
    expect(s.d.io.stderr).toEqual(["asks: this session has 5 open asks (too_many_open)"]);
    const off = scripted(() => ({ ok: false, error: "the Hill is off", code: "hill_off", hill: true }));
    expect(await cmdWalkyAsk(off.d, BASE)).toBe(EXIT.STATE);
    expect(off.d.io.stderr).toHaveLength(1);
    const plain = scripted(() => ({ ok: false, error: "no pane", hill: true }));
    expect(await cmdWalkyAsk(plain.d, BASE)).toBe(EXIT.STATE);
    expect(plain.d.io.stderr.at(-1)).toBe("ask: send it again with --request-id 0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f");
  });

  test("a bridge that answers a plain Decision is refused: it is older than asks", async () => {
    const r = askRig();
    const plain = posted(r.hill.post(ONE, { requestId: "00000000-0000-4000-8000-000000000003", title: "Plain?", summary: "A plain card.", options: [{ intent: "yes", label: "Yes" }], recommends: null }));
    const s = scripted(() => ({ ok: true, decision: plain }));
    expect(await cmdWalkyAsk(s.d, BASE)).toBe(EXIT.FAIL);
  });
});

describe("walky asks, status and cancel", () => {
  test("asks lists the open asks, one line each, or says there are none", async () => {
    const r = askRig();
    const a = posted(r.hill.post(ONE, askInput(1)));
    const s = scripted(() => ({ ok: true, decisions: [a] }));
    expect(await cmdWalkyAsks(s.d, [])).toBe(EXIT.OK);
    expect(s.lines[0]).toMatchObject({ op: "ask.list" });
    expect(s.d.io.stdout).toEqual([`${a.id} ${a.title}`]);
    const none = scripted(() => ({ ok: true, decisions: [] }));
    expect(await cmdWalkyAsks(none.d, [])).toBe(EXIT.OK);
    expect(none.d.io.stdout).toEqual(["No open asks."]);
    expect(await cmdWalkyAsks(none.d, ["x"])).toBe(EXIT.USAGE);
  });

  test("the id's prefix routes status and cancel: ak_ and dc_ to the ask, wt_ to the message", () => {
    expect(namesAnAsk(["ak_aaaaaaaaaaaa"])).toBe(true);
    expect(namesAnAsk(["--json", "dc_aaaaaaaaaaaa"])).toBe(true);
    expect(namesAnAsk(["wt_aaaaaaaaaaaa"])).toBe(false);
    expect(namesAnAsk(["--answered"])).toBe(false);
  });

  test("status asks ask.status and prints the state", async () => {
    const r = askRig();
    const a = posted(r.hill.post(ONE, askInput(1)));
    const s = scripted(() => ({ ok: true, decision: a }));
    expect(await cmdAskStatus(s.d, [a.id])).toBe(EXIT.OK);
    expect(s.lines[0]).toMatchObject({ op: "ask.status", id: a.id });
    expect(s.d.io.stdout[0]).toBe(`${a.id} open`);
    expect(await cmdAskStatus(s.d, [])).toBe(EXIT.USAGE);
  });

  test("cancel sends --answered and --because, and refuses both at once", async () => {
    const r = askRig();
    const a = posted(r.hill.post(ONE, askInput(1)));
    const closed = r.hill.cancelAsk(ONE, a.id, { answered: true, because: null });
    if (!closed.ok) throw new Error("not closed");
    const s = scripted(() => ({ ok: true, decision: closed.decision }));
    expect(await cmdAskCancel(s.d, [a.id, "--answered"])).toBe(EXIT.OK);
    expect(s.lines[0]).toEqual({ v: 1, markers: expect.any(Array), op: "ask.cancel", id: a.id, answered: true });
    expect(s.d.io.stdout).toEqual([`${a.id} withdrawn (answered in the session)`, "  Ship the fix on Edge first, round 1?"]);
    expect(await cmdAskCancel(s.d, [a.id, "--because", "The test answers it."])).toBe(EXIT.OK);
    expect(s.lines[1]).toMatchObject({ op: "ask.cancel", because: "The test answers it." });
    expect(await cmdAskCancel(s.d, [a.id, "--answered", "--because", "x"])).toBe(EXIT.USAGE);
    expect(await cmdAskCancel(s.d, [a.id, "--because"])).toBe(EXIT.USAGE);
    expect(await cmdAskCancel(s.d, [a.id, "--because", "x".repeat(201)])).toBe(EXIT.USAGE);
    expect(await cmdAskCancel(s.d, [a.id, "--nope"])).toBe(EXIT.USAGE);
    expect(s.lines).toHaveLength(2);
  });

  test("cancel takes 1 to 5 ids with one flag for all, and one bad id stops none", async () => {
    const r = askRig();
    const asks = [1, 2, 3, 4, 5].map((n) => posted(r.hill.post(ONE, askInput(n))));
    const ids = asks.map((ask) => ask.id);
    const s = scripted((row) => {
      const asked = Array.isArray(row.ids) ? row.ids.map(String) : [];
      return { ok: true, results: asked.map((id) => {
        const closed = r.hill.cancelAsk(ONE, id, { answered: true, because: null });
        return closed.ok ? { id, ok: true, decision: closed.decision } : { id, ok: false, error: closed.error };
      }) };
    });
    expect(await cmdAskCancel(s.d, [...ids.slice(0, 2), "ak_zzzzzzzzzzzz", ...ids.slice(2), "--answered"])).toBe(EXIT.USAGE);
    expect(s.d.io.stderr.at(-1)).toContain("1 to 5");
    expect(await cmdAskCancel(s.d, [ids[0]!, "ak_zzzzzzzzzzzz", ids[1]!, "--answered"])).toBe(EXIT.STATE);
    expect(s.lines[0]).toEqual({ v: 1, markers: expect.any(Array), op: "ask.cancel", ids: [ids[0]!, "ak_zzzzzzzzzzzz", ids[1]!], answered: true });
    expect(s.d.io.stdout).toContain(`${ids[0]!} withdrawn (answered in the session)`);
    expect(s.d.io.stdout).toContain(`${ids[1]!} withdrawn (answered in the session)`);
    expect(s.d.io.stderr.at(-1)).toMatch(/^ask: ak_zzzzzzzzzzzz: /);
    expect(await cmdAskCancel(s.d, [...ids.slice(2), "ak_yyyyyyyyyyyy", "ak_xxxxxxxxxxxx", "--because", "Settled by the test."])).toBe(EXIT.STATE);
    expect(s.lines[1]).toMatchObject({ op: "ask.cancel", because: "Settled by the test." });
    expect(s.lines[1]?.ids).toHaveLength(5);
    // Every one of the five is closed now: a second cancel finds none open.
    for (const id of ids) expect(r.hill.cancelAsk(ONE, id, { answered: true, because: null }).ok).toBe(false);
  });

  test("keep is gone: a usage error, not a silent accept", async () => {
    const io = capture();
    expect(await run(["walky", "keep", "ak_aaaaaaaaaaaa"], io)).toBe(EXIT.USAGE);
  });

  test("the bridge reads each ask op, and refuses a bad id", () => {
    const read = (row: JsonObject) => readWalkyRequest(JSON.stringify({ v: 1, markers: [], ...row }));
    expect(read({ op: "ask.list" })).toMatchObject({ ok: true, request: { op: "ask.list" } });
    expect(read({ op: "ask.status", id: "ak_aaaaaaaaaaaa" })).toMatchObject({ ok: true, request: { op: "ask.status", id: "ak_aaaaaaaaaaaa" } });
    expect(read({ op: "ask.cancel", id: "ak_aaaaaaaaaaaa", answered: true })).toMatchObject({ ok: true, request: { op: "ask.cancel", answered: true, because: null } });
    expect(read({ op: "ask.cancel", id: "ak_aaaaaaaaaaaa", because: 4 })).toMatchObject({ ok: false });
    expect(read({ op: "ask.cancel", ids: ["ak_aaaaaaaaaaaa", "ak_bbbbbbbbbbbb"], answered: true })).toMatchObject({ ok: true, request: { op: "ask.cancel", ids: ["ak_aaaaaaaaaaaa", "ak_bbbbbbbbbbbb"], single: false, answered: true } });
    expect(read({ op: "ask.cancel", ids: Array.from({ length: 6 }, () => "ak_aaaaaaaaaaaa") })).toMatchObject({ ok: false });
    expect(read({ op: "ask.cancel", ids: [] })).toMatchObject({ ok: false });
    expect(read({ op: "ask.cancel", ids: ["ak_aaaaaaaaaaaa", "wt_aaaaaaaaaaaa"] })).toMatchObject({ ok: false });
    expect(read({ op: "ask.cancel", id: "ak_aaaaaaaaaaaa", ids: ["ak_aaaaaaaaaaaa"] })).toMatchObject({ ok: false });
    expect(read({ op: "ask.keep", id: "ak_aaaaaaaaaaaa" })).toMatchObject({ ok: false });
    expect(read({ op: "ask.check" })).toMatchObject({ ok: false });
    expect(read({ op: "ask.remind", event: "prompt", promptHash: "abc", at: 5 })).toMatchObject({ ok: true, request: { op: "ask.remind", event: { kind: "prompt", hash: "abc", at: 5 } } });
    expect(read({ op: "ask.remind", event: "prompt", promptHash: null, at: 5 })).toMatchObject({ ok: true, request: { event: { kind: "prompt", hash: null } } });
    expect(read({ op: "ask.remind", event: "start", source: "compact" })).toMatchObject({ ok: true, request: { event: { kind: "start", source: "compact" } } });
    expect(read({ op: "ask.remind", event: "stop" })).toMatchObject({ ok: false });
    expect(read({ op: "ask.remind", event: "prompt", promptHash: "abc" })).toMatchObject({ ok: false });
    expect(read({ op: "ask.status", id: "wt_aaaaaaaaaaaa" })).toMatchObject({ ok: false });
  });
});
