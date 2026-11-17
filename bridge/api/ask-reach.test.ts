// THE ASK CANNOT BE REACHED (M105 spec 03, task 6; decision 15). The local API is read only: no
// operation of its table may be able to answer an ask, type into a session or press a key. This test
// proves it statically, in three ways, so a change that adds a path fails here and not in a review:
//
//  1. IMPORT REACH. Every non-test module in bridge/api/ is a root. Following every relative import
//     (value imports, re-exports and dynamic `import()`), no module reached may be one of
//     {@link ASK_ANSWERING}, nor sit in a folder that only exists to write: the Surface, the inside
//     hub's command queue, a multiplexer's own adapter folder. A `import type` is not followed: it is
//     erased, so it cannot put code on a path (it still has to name a type, and bus.ts, a type import of
//     operations.ts, imports nothing that writes anyway). The scan reads the real files, and a planted
//     import in an in-memory file is caught, so the test is not vacuous.
//  2. THE DEPS' NAMES. The handlers get the bridge only through `ReadsDeps` (reads.ts). Its members, and
//     the members of the one object it passes through (`bus`), must carry no name that sends, answers,
//     presses a key, types or writes. Checked twice: by the compiler (a type that is `never` when one
//     exists, so `bun run typecheck` fails) and by reading the declaration's text.
//  3. THE TABLE IS READ ONLY. Every row is a `read` that needs `look`, and the local tier grants `look`.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { EventBus } from "../events/bus.ts";
import { buildTable, LOCAL_TIER_RIGHTS, OPERATION_NAMES } from "./operations.ts";
import { buildReads, type ReadsDeps } from "./reads.ts";
import { depsOf, world } from "./fixtures/reads-world.ts";

const BRIDGE = resolve(import.meta.dir, "..");
const REPO = resolve(BRIDGE, "..");

/**
 * The modules that answer an ask or write into a session, each with why. A path from bridge/api/ to any
 * of them is a path from an operation to a write.
 */
export const ASK_ANSWERING: ReadonlyMap<string, string> = new Map([
  ["bridge/server.ts", "hosts every route: POST /api/ask/<id>, POST /api/pane/:id/answer, reply, keys, the Hill's answer"],
  ["bridge/index.ts", "the composition root: it owns the send path, the ask book and every writer"],
  ["bridge/surface/ask.ts", "AskAnswerer: walks the keys of a dialog and commits the person's tap (POST /api/ask/<id>)"],
  ["bridge/surface/hold.ts", "HoldBook: gives the person's decision to the permission hook that waits on it"],
  ["bridge/surface/holds.ts", "the held send's queue on disk: text the Send Protocol types later"],
  ["bridge/surface/key-gate.ts", "every key to a pane leaves through this gate"],
  ["bridge/surface/protocol.ts", "the Send Protocol: types a message into a pane and verifies it"],
  ["bridge/surface/data-send.ts", "the send by data over an inside link, no screen"],
  ["bridge/surface/durable-driver.ts", "a durable program's driver: answers its asks by id"],
  ["bridge/durable/answer.ts", "POST /api/pane/:id/answer for a durable pane: one tap answers one ask"],
  ["bridge/inside/asks.ts", "PartAsks: turns a person's answer into an `answer` command for the part inside the agent"],
  ["bridge/inside/queue.ts", "CommandQueue: the commands (answer, prompt, steer) waiting for a part to take them"],
  ["bridge/inside/hub.ts", "InsideHub: `enqueue`, the command sender to a part inside an agent"],
  ["bridge/hill/service.ts", "HillService: its answer types the person's choice into the posting session"],
  ["bridge/walky/deliver.ts", "WalkyTalky delivery: types a message into another session"],
  ["bridge/walky/service.ts", "WalkyService: sends messages between sessions"],
  ["bridge/mux/keys.ts", "the neutral key spelling every multiplexer's sendKeys takes"],
  ["bridge/mux/herdr/adapter.ts", "Herdr's sendKeys and sendText write paths"],
  ["bridge/mux/herdr/keys.ts", "Herdr's key encoding for sendKeys"],
  ["bridge/mux/herdr-core/adapter.ts", "herdr-core's sendKeys and sendText write paths"],
  ["bridge/mux/tmux/adapter.ts", "tmux's sendKeys and sendText write paths"],
  ["bridge/mux/zellij/adapter.ts", "zellij's sendKeys and sendText write paths"],
  ["bridge/mux/zellij/keys.ts", "zellij's key encoding for sendKeys"],
  ["bridge/mux/tern/adapter.ts", "tern's sendKeys and sendText write paths"],
  ["bridge/mux/tuios/adapter.ts", "tuios's sendKeys and sendText write paths"],
  ["bridge/mux/durable/adapter.ts", "the durable adapter's answer and send paths"],
]);

/** Folders whose every module writes or sends: nothing under them may be reached either. */
const WRITING_FOLDERS: readonly string[] = ["bridge/surface/", "bridge/inside/", "bridge/durable/", "bridge/walky/", "bridge/mux/herdr/", "bridge/mux/herdr-core/", "bridge/mux/tmux/", "bridge/mux/zellij/", "bridge/mux/tern/", "bridge/mux/tuios/", "bridge/mux/durable/"];

// `import ... from "x"`, `export ... from "x"`, `import "x"`, `import("x")`; the capture says whether a statement is `type`-only.
const STATEMENT = /\b(?:import|export)(\s+type)?\s+[^'";]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;

/** The relative specifiers a source text puts on a runtime path (a `type` import or re-export is erased and left out). */
export function runtimeSpecifiers(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(STATEMENT)) {
    if (match[1] !== undefined) continue;
    const specifier = match[2] ?? match[3] ?? match[4];
    if (specifier?.startsWith(".")) out.push(specifier);
  }
  return out;
}

/** The files a walk from `roots` reaches, each with the file that first led to it. `read` is the file system, or a stand-in. */
export function reach(roots: readonly string[], read: (path: string) => string | null): Map<string, string> {
  const seen = new Map<string, string>();
  const todo = roots.map((root): [string, string] => [root, "(root)"]);
  for (let step = todo.pop(); step !== undefined; step = todo.pop()) {
    const [file, by] = step;
    if (seen.has(file)) continue;
    seen.set(file, by);
    const text = read(file);
    if (text === null) continue;
    for (const specifier of runtimeSpecifiers(text)) todo.push([resolve(dirname(file), specifier), file]);
  }
  return seen;
}

/** The reached files that answer an ask or sit in a writing folder, as `<path> (<why>)`. */
export function writersAmong(reached: Iterable<string>): string[] {
  const out: string[] = [];
  for (const file of reached) {
    const rel = relative(REPO, file).split(sep).join("/");
    const named = ASK_ANSWERING.get(rel);
    if (named !== undefined) out.push(`${rel} (${named})`);
    else if (WRITING_FOLDERS.some((folder) => rel.startsWith(folder))) out.push(`${rel} (a folder that only writes)`);
  }
  return out;
}

function readFile(path: string): string | null {
  return existsSync(path) && path.endsWith(".ts") ? readFileSync(path, "utf8") : null;
}

function apiSources(): string[] {
  return readdirSync(join(BRIDGE, "api"))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
    .map((name) => join(BRIDGE, "api", name));
}

describe("import reach: no operation can reach the code that answers an ask", () => {
  test("the walk starts at every module of bridge/api and sees the operations, the reads and the mask", () => {
    const reached = [...reach(apiSources(), readFile).keys()].map((file) => relative(REPO, file).split(sep).join("/"));
    for (const expected of ["bridge/api/operations.ts", "bridge/api/reads.ts", "bridge/api/ids.ts", "bridge/answer-mask.ts", "bridge/redact.ts", "bridge/pane-name.ts"]) {
      expect(reached).toContain(expected);
    }
  });

  test("no module reached from bridge/api is an ask-answering one, or in a folder that only writes", () => {
    expect(writersAmong(reach(apiSources(), readFile).keys())).toEqual([]);
  });

  test("every listed module exists, so a rename cannot hollow the list out", () => {
    for (const rel of ASK_ANSWERING.keys()) expect(existsSync(join(REPO, rel))).toBe(true);
    for (const folder of WRITING_FOLDERS) expect(readdirSync(join(REPO, folder)).length).toBeGreaterThan(0);
  });

  test("a planted import is caught, however it is spelled; a type import is not followed", () => {
    const api = join(BRIDGE, "api", "planted.ts");
    const files = new Map<string, string>([
      [api, `import { a } from "./hop.ts";`],
      [join(BRIDGE, "api", "hop.ts"), `export { b } from "../surface/ask.ts";`],
      [join(BRIDGE, "api", "dyn.ts"), `const m = await import("../server.ts");`],
      [join(BRIDGE, "api", "bare.ts"), `import "../inside/hub.ts";`],
      [join(BRIDGE, "api", "typed.ts"), `import type { Hub } from "../inside/hub.ts"; export type { A } from "../server.ts";`],
      [join(BRIDGE, "api", "folder.ts"), `import { x } from "../mux/tmux/protocol.ts";`],
    ]);
    const read = (path: string): string | null => files.get(path) ?? null;
    const writers = (name: string): string[] => writersAmong(reach([join(BRIDGE, "api", name)], read).keys());
    expect(writers("planted.ts")).toEqual([expect.stringContaining("bridge/surface/ask.ts")]);
    expect(writers("dyn.ts")).toEqual([expect.stringContaining("bridge/server.ts")]);
    expect(writers("bare.ts")).toEqual([expect.stringContaining("bridge/inside/hub.ts")]);
    expect(writers("folder.ts")).toEqual([expect.stringContaining("a folder that only writes")]);
    expect(writers("typed.ts")).toEqual([]);
  });
});

// The compiler's half of the names rule: a key of the deps (or of the bus it passes) that contains one of
// these words makes `Offending` a union, and the line below fails to compile.
type Banned = `${string}${"send" | "answer" | "key" | "type" | "write" | "steer" | "prompt" | "reply" | "press" | "enqueue" | "submit" | "post" | "paste" | "input" | "deliver" | "tell" | "publish" | "subscribe"}${string}`;
type KeysOfDeps = Extract<keyof ReadsDeps, string> | Extract<keyof ReadsDeps["bus"], string>;
type Offending = Extract<Lowercase<KeysOfDeps>, Banned>;
const NO_OFFENDING_NAME: [Offending] extends [never] ? true : never = true;

const BANNED_WORDS = /send|answer|key|type|write|steer|prompt|reply|press|enqueue|submit|post|paste|input|deliver|tell|publish|subscribe/iu;

describe("the deps of the reads name no way to write", () => {
  test("by the compiler: no member name of ReadsDeps or of its bus carries a writing word", () => {
    expect(NO_OFFENDING_NAME).toBe(true);
  });

  test("by the declaration's text: every member of ReadsDeps, and every key the bus is picked down to", () => {
    const source = readFileSync(join(BRIDGE, "api", "reads.ts"), "utf8");
    const start = source.indexOf("export interface ReadsDeps {");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}\n", start));
    const members = [...body.matchAll(/^ {2}(?:readonly )?([A-Za-z_]\w*)\s*[(:?]/gmu)].map((match) => match[1]!);
    expect(members).toEqual(["machine", "panes", "instanceOf", "bus", "paneAccount", "accountsBody", "draftState", "readScreen", "hillOpen", "defaultLines"]);
    const picked = [...body.matchAll(/\bbus:\s*Pick<EventBus,\s*([^>]+)>/gu)].flatMap((match) => [...match[1]!.matchAll(/"([^"]+)"/gu)].map((one) => one[1]!));
    expect(picked).toEqual(["since"]);
    for (const name of [...members, ...picked]) expect(name).not.toMatch(BANNED_WORDS);
  });

  test("the scan sees a bad name: planted members are caught", () => {
    for (const name of ["sendText", "answerAsk", "pressKey", "typeInto", "writeFile", "enqueueCommand", "publishEvent", "keys"]) expect(name).toMatch(BANNED_WORDS);
    for (const name of ["machine", "panes", "readScreen", "draftState", "hillOpen", "since", "instanceOf", "paneAccount", "accountsBody", "defaultLines", "bus"]) expect(name).not.toMatch(BANNED_WORDS);
  });
});

describe("the table is read only", () => {
  test("every row is a read that needs look, and the local tier grants look and nothing more", () => {
    const table = buildTable({ version: () => "9.9.9-test", bus: new EventBus({ machine: () => "m", bootId: "boot1" }), reads: buildReads(depsOf(world())) });
    expect([...table.keys()]).toEqual([...OPERATION_NAMES]);
    for (const row of table.values()) {
      expect(row.kind).toBe("read");
      expect(row.right).toBe("look");
    }
    expect(LOCAL_TIER_RIGHTS).toEqual(["look"]);
  });
});
