import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { apiSocketPath } from "../bridge/api/socket.ts";
import { DECLARED, OPERATION_NAMES } from "../bridge/api/operations.ts";
import { asJsonObject, parseJsonObject } from "../web/src/lib/json.ts";
import { apiHelp, API_ASK_MS, API_WAIT_ASK_MS, cmdApi, declaredOperations, escapeC1, flagOf, NO_LOCAL_API, parseFlags, plainLines, type ApiDeps, type CliOperation } from "./api.ts";
import { capture } from "./fakes.ts";
import { EXIT } from "./io.ts";
import { run } from "./program.ts";
import { realFiles } from "./sys.ts";
import { AskLate, askSocket } from "./walky.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** A state dir of the test's own, private to this user, as the bridge makes it. */
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "api-cli-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Served {
  readonly requests: string[];
  readonly server: Server;
}

/** A scratch Unix socket server on the API socket path of `dir`, answering each request line with `answer(line)`. */
async function serve(dir: string, answer: (line: string) => string | null): Promise<Served> {
  const path = apiSocketPath(dir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const requests: string[] = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk: string) => {
      requests.push(chunk.trim());
      const reply = answer(chunk.trim());
      if (reply === null) return;
      socket.end(`${reply}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => server.close());
  return { requests, server };
}

function deps(dir: string, over: Partial<ApiDeps> = {}): ApiDeps & { readonly io: ReturnType<typeof capture> } {
  return {
    stateDir: dir,
    platform: "linux",
    files: realFiles,
    uid: process.getuid?.(),
    ask: (path, line, ms) => askSocket(path, line, ms),
    mintId: () => "req-1",
    ...over,
    io: capture(),
  };
}

const FAKE: readonly CliOperation[] = [
  ...declaredOperations(),
  {
    name: "tally",
    summary: "A made-up operation for the test.",
    args: [
      { name: "workshop", type: "string", required: true, help: "The workshop to count." },
      { name: "maxItems", type: "integer", required: false, help: "How many to count." },
    ],
  },
];

describe("generated from the table", () => {
  test("the operations are the table's, in its order", () => {
    expect(declaredOperations().map((one) => one.name)).toEqual([...OPERATION_NAMES]);
    for (const name of OPERATION_NAMES) expect(declaredOperations().find((one) => one.name === name)).toBe(DECLARED[name]);
  });

  test("the help lists every operation with its summary and its flags, and says experimental", () => {
    const text = apiHelp(declaredOperations()).join("\n");
    expect(text).toContain("Experimental");
    for (const name of OPERATION_NAMES) {
      expect(text).toContain(name);
      expect(text).toContain(DECLARED[name].summary);
      for (const arg of DECLARED[name].args) expect(text).toContain(`${flagOf(arg.name)} <`);
    }
    expect(text).toContain("--session <text>");
    expect(text).toContain("--lines <number>");
    expect(text).toContain("--after <text>");
    expect(text).toContain("--wait <number>");
    expect(text).toContain("--json");
  });

  test("a row added to the table appears in the help and takes its flags, with no change to the verb", async () => {
    const text = apiHelp(FAKE).join("\n");
    expect(text).toContain("tally");
    expect(text).toContain("--workshop <text>  (required) The workshop to count.");
    expect(text).toContain("--max-items <number>");
    const dir = stateDir();
    const served = await serve(dir, () => JSON.stringify({ id: "req-1", ok: true, counted: 3 }));
    const d = deps(dir, { operations: FAKE });
    expect(await cmdApi(d, ["tally", "--workshop", "lodge", "--max-items=7"])).toBe(EXIT.OK);
    expect(parseJsonObject(served.requests[0] ?? "")).toEqual({ id: "req-1", op: "tally", args: { workshop: "lodge", maxItems: 7 } });
    expect(d.io.stdout).toEqual(["counted: 3"]);
  });

  test("bare `collie api` and `collie api --help` print the same generated list and exit 0", async () => {
    const bare = capture();
    expect(await run(["api"], bare)).toBe(EXIT.OK);
    const asked = capture();
    expect(await run(["api", "--help"], asked)).toBe(EXIT.OK);
    expect(bare.stdout).toEqual(apiHelp(declaredOperations()));
    expect(asked.stdout).toEqual(bare.stdout);
    expect(bare.stderr).toEqual([]);
  });
});

describe("the flags", () => {
  const read = DECLARED.read;
  const events = DECLARED.events;

  test("a flag is the argument name in kebab case, as `--name value` or `--name=value`", () => {
    expect(flagOf("session")).toBe("--session");
    expect(flagOf("maxItems")).toBe("--max-items");
    expect(parseFlags(read, ["--session", "ses_x", "--lines", "40"])).toEqual({ ok: true, args: { session: "ses_x", lines: 40 }, json: false });
    expect(parseFlags(read, ["--session=ses_x", "--json"])).toEqual({ ok: true, args: { session: "ses_x" }, json: true });
    expect(parseFlags(events, ["--after", "boot.4", "--wait", "25"])).toEqual({ ok: true, args: { after: "boot.4", wait: 25 }, json: false });
    expect(parseFlags(events, [])).toEqual({ ok: true, args: {}, json: false });
  });

  test("a whole-number flag given text, a flag with no value, an unknown flag, a repeat and a missing required flag are refused", () => {
    expect(parseFlags(read, ["--session", "ses_x", "--lines", "abc"])).toEqual({ ok: false, why: "--lines must be a whole number" });
    expect(parseFlags(read, ["--session", "ses_x", "--lines", "1.5"]).ok).toBe(false);
    expect(parseFlags(read, ["--session", "ses_x", "--lines"])).toEqual({ ok: false, why: "--lines needs a value" });
    expect(parseFlags(read, ["--session", "ses_x", "--lines="])).toEqual({ ok: false, why: "--lines needs a value" });
    expect(parseFlags(read, ["--session", "ses_x", "--color", "red"]).ok).toBe(false);
    expect(parseFlags(read, ["ses_x"]).ok).toBe(false);
    expect(parseFlags(read, ["--session", "a", "--session", "b"])).toEqual({ ok: false, why: "--session is given twice" });
    expect(parseFlags(read, ["--lines", "5"])).toEqual({ ok: false, why: "`read` needs --session <text>" });
    expect(parseFlags(DECLARED.hello, ["--session", "x"]).ok).toBe(false);
  });

  test("`--lines abc` through the verb is a usage error and sends nothing", async () => {
    const dir = stateDir();
    const served = await serve(dir, () => "{}");
    const d = deps(dir);
    expect(await cmdApi(d, ["read", "--session", "ses_x", "--lines", "abc"])).toBe(EXIT.USAGE);
    expect(d.io.stderr).toEqual(["error: --lines must be a whole number"]);
    expect(served.requests).toEqual([]);
  });

  test("an unknown operation is a usage error that names the operations", async () => {
    const d = deps(stateDir());
    expect(await cmdApi(d, ["send"])).toBe(EXIT.USAGE);
    expect(d.io.stderr[0]).toBe("error: unknown operation `send`");
    expect(d.io.stderr[1]).toContain("hello|sessions|brief|read|accounts|hill.list|events");
  });

  test("through `run`, a usage error exits 2", async () => {
    const io = capture();
    expect(await run(["api", "read", "--lines", "5"], io)).toBe(EXIT.USAGE);
  });
});

describe("no socket", () => {
  test("prints the one line and exits STATE", async () => {
    const d = deps(stateDir());
    expect(await cmdApi(d, ["hello"])).toBe(EXIT.STATE);
    expect(d.io.stderr).toEqual([NO_LOCAL_API]);
    expect(d.io.stdout).toEqual([]);
    expect(NO_LOCAL_API).toBe("The local API is on while tricks are switched on.");
  });

  test("a socket whose connection ends with no answer says the same", async () => {
    const dir = stateDir();
    await serve(dir, () => null);
    const d = deps(dir, { ask: async () => null });
    expect(await cmdApi(d, ["hello"])).toBe(EXIT.STATE);
    expect(d.io.stderr).toEqual([NO_LOCAL_API]);
  });

  test("Windows has no socket and prints the same line without looking", async () => {
    const dir = stateDir();
    const served = await serve(dir, () => "{}");
    const d = deps(dir, { platform: "win32" });
    expect(await cmdApi(d, ["hello"])).toBe(EXIT.STATE);
    expect(d.io.stderr).toEqual([NO_LOCAL_API]);
    expect(served.requests).toEqual([]);
  });

  test("a socket path that is a plain file is not dialled", async () => {
    const dir = stateDir();
    mkdirSync(join(dir, "api"), { mode: 0o700 });
    writeFileSync(apiSocketPath(dir), "");
    const d = deps(dir);
    expect(await cmdApi(d, ["hello"])).toBe(EXIT.STATE);
    expect(d.io.stderr[0]).toContain("is not a socket private to this user");
  });

  test("a socket in a folder others can write is not dialled", async () => {
    const dir = stateDir();
    const served = await serve(dir, () => JSON.stringify({ ok: true }));
    chmodSync(dirname(apiSocketPath(dir)), 0o777);
    const d = deps(dir);
    expect(await cmdApi(d, ["hello"])).toBe(EXIT.STATE);
    expect(d.io.stderr[0]).toContain("not a socket private to this user");
    expect(served.requests).toEqual([]);
  });
});

describe("a scratch socket answering", () => {
  const SESSIONS = {
    id: "req-1",
    ok: true,
    sessions: [
      { id: "ses_aaa", machine: "inst-workshop", agent: "claude", label: "lodge", folder: "example", state: "idle", rev: 11 },
      { id: "ses_bbb", machine: "inst-workshop", agent: "pi", label: "second", state: "working", rev: 12 },
    ],
  };

  test("sends one request line {id, op, args} and, with --json, prints the answer line as it came", async () => {
    const dir = stateDir();
    const line = JSON.stringify(SESSIONS);
    const served = await serve(dir, () => line);
    const d = deps(dir);
    expect(await cmdApi(d, ["sessions", "--json"])).toBe(EXIT.OK);
    expect(served.requests).toEqual([JSON.stringify({ id: "req-1", op: "sessions", args: {} })]);
    expect(d.io.stdout).toEqual([line]);
    expect(d.io.stderr).toEqual([]);
  });

  test("security read 2, item 3: with --json, DEL and C1 (a raw CSI) print as \\u00XX, and the line reads back the same value", async () => {
    const dir = stateDir();
    const hostile = { ...SESSIONS, sessions: [{ ...SESSIONS.sessions[0], label: "lodge\u009b31m\u007fx\u0080\u009f" }] };
    const line = JSON.stringify(hostile);
    expect(line).toContain("\u009b");
    await serve(dir, () => line);
    const d = deps(dir);
    expect(await cmdApi(d, ["sessions", "--json"])).toBe(EXIT.OK);
    const printed = d.io.stdout[0] ?? "";
    expect(printed).toContain(String.raw`lodge\u009b31m\u007fx\u0080\u009f`);
    expect(/[\u007f-\u009f]/u.test(printed)).toBe(false);
    expect(parseJsonObject(printed)).toEqual(hostile);
    expect(escapeC1('{"a":"plain é"}')).toBe('{"a":"plain é"}');
  });

  test("without --json, a list of objects prints as aligned columns and a missing cell as a dash", async () => {
    const dir = stateDir();
    await serve(dir, () => JSON.stringify(SESSIONS));
    const d = deps(dir);
    expect(await cmdApi(d, ["sessions"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual([
      "sessions:",
      "  id       machine        agent   label   folder   state    rev",
      "  ses_aaa  inst-workshop  claude  lodge   example  idle     11",
      "  ses_bbb  inst-workshop  pi      second  -        working  12",
    ]);
  });

  test("scalars print as key: value, nested objects flatten to a.b, text lists join, an empty list says none", () => {
    expect(plainLines({ id: "x", ok: true, api: 1, collie: "1.29.0", experimental: true, operations: ["hello", "events"], deep: { a: { b: "c" } }, events: [], next: null })).toEqual([
      "api: 1",
      "collie: 1.29.0",
      "experimental: true",
      "operations: hello, events",
      "deep.a.b: c",
      "events: (none)",
      "next: -",
    ]);
  });

  test("an events answer flattens each event's data and prints the cursor", () => {
    const lines = plainLines({
      ok: true,
      events: [
        { v: 1, id: "e1", cursor: "b.1", ts: "2026-01-01T00:00:00.000Z", type: "session.status", machine: "inst-workshop", session: "ses_aaa", data: { state: "idle" } },
        { v: 1, id: "e2", cursor: "b.2", ts: "2026-01-01T00:00:01.000Z", type: "turn.end", machine: "inst-workshop", session: "ses_aaa", data: {} },
      ],
      next: "b.2",
    });
    expect(lines[0]).toBe("events:");
    expect(lines[1]).toContain("data.state");
    expect(lines[2]).toContain("idle");
    expect(lines[3]).toContain("turn.end");
    expect(lines.at(-1)).toBe("next: b.2");
  });

  test("a screen's lines print indented under their key, and no control character reaches the terminal", () => {
    const lines = plainLines({ ok: true, session: "ses_aaa", text: "first\nsecond\u001b[31m red\u0007", lines: 2, truncated: false });
    expect(lines).toEqual(["session: ses_aaa", "text:", "  first", "  second?[31m red?", "lines: 2", "truncated: false"]);
    expect(plainLines({ ok: true, sessions: [{ label: "a\u001b]0;x\u0007b" }] }).join("\n")).not.toContain("\u001b");
  });

  test("an events wait gets 35 s, every other request 10 s", async () => {
    const dir = stateDir();
    await serve(dir, () => JSON.stringify({ ok: true, events: [], next: "b.1" }));
    const seen: number[] = [];
    const ask = (path: string, line: string, ms: number): Promise<string | null> => {
      seen.push(ms);
      return askSocket(path, line, ms);
    };
    expect(await cmdApi(deps(dir, { ask }), ["events", "--wait", "25", "--after", "b.0"])).toBe(EXIT.OK);
    expect(await cmdApi(deps(dir, { ask }), ["events", "--wait", "0"])).toBe(EXIT.OK);
    expect(await cmdApi(deps(dir, { ask }), ["events"])).toBe(EXIT.OK);
    expect(await cmdApi(deps(dir, { ask }), ["sessions"])).toBe(EXIT.OK);
    expect(seen).toEqual([API_WAIT_ASK_MS, API_ASK_MS, API_ASK_MS, API_ASK_MS]);
    expect([API_ASK_MS, API_WAIT_ASK_MS]).toEqual([10_000, 35_000]);
  });

  test("an answer that never comes ends in a failure, not a hang", async () => {
    const dir = stateDir();
    await serve(dir, () => null);
    const d = deps(dir, { ask: (path, line) => askSocket(path, line, 100) });
    expect(await cmdApi(d, ["hello"])).toBe(EXIT.FAIL);
    expect(d.io.stderr[0]).toContain("did not answer");
    const late = deps(dir, {
      ask: async () => {
        throw new AskLate(10_000);
      },
    });
    expect(await cmdApi(late, ["hello"])).toBe(EXIT.FAIL);
    expect(late.io.stderr).toEqual(["error: the local API did not answer within 10 s"]);
  });

  test("an answer that is not a JSON answer line is a failure", async () => {
    const dir = stateDir();
    await serve(dir, () => "not json");
    const d = deps(dir);
    expect(await cmdApi(d, ["hello"])).toBe(EXIT.FAIL);
    expect(d.io.stderr[0]).toContain("not one JSON answer line");
  });
});

describe("an error answer", () => {
  const refusal = (code: string, message: string): string => JSON.stringify({ id: "req-1", ok: false, error: { code, message } });

  test("prints error: <message> on stderr and exits REFUSED", async () => {
    const dir = stateDir();
    await serve(dir, () => refusal("api.session_unknown", "no session on this machine has that id; send sessions for the ids of now"));
    const d = deps(dir);
    expect(await cmdApi(d, ["brief", "--session", "ses_gone"])).toBe(EXIT.REFUSED);
    expect(d.io.stderr).toEqual(["error: no session on this machine has that id; send sessions for the ids of now"]);
    expect(d.io.stdout).toEqual([]);
  });

  test("api.failed exits FAIL", async () => {
    const dir = stateDir();
    await serve(dir, () => refusal("api.failed", "the operation failed inside the bridge; try again"));
    const d = deps(dir);
    expect(await cmdApi(d, ["read", "--session", "ses_x"])).toBe(EXIT.FAIL);
    expect(d.io.stderr).toEqual(["error: the operation failed inside the bridge; try again"]);
  });

  test("with --json the error answer is printed to stdout as sent, with the same exit code", async () => {
    const dir = stateDir();
    const line = refusal("api.busy", "too many screens are being read now; try again in 500 ms");
    await serve(dir, () => line);
    const d = deps(dir);
    expect(await cmdApi(d, ["read", "--session", "ses_x", "--json"])).toBe(EXIT.REFUSED);
    expect(d.io.stdout).toEqual([line]);
    expect(asJsonObject(parseJsonObject(d.io.stdout[0] ?? ""))?.ok).toBe(false);
    expect(d.io.stderr).toEqual([]);
  });
});
