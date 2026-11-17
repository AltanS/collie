// THE ASK CANNOT BE REACHED (M105 spec 03, task 6; decision 15; security read 1, item 7). The local API
// is read only: no operation of its table may be able to answer an ask, type into a session or press a
// key. The claim rests on two things, both held here: (a) the operations get the bridge through ONE
// narrow interface, `ApiWorld` (world.ts), and bridge/index.ts builds an object of exactly that type (the
// key test, below); (b) every operation, run against a world whose write methods all throw, calls none
// of them (the spy test, below). The import walk stays beside them, and guards the imports:
//
//  1. IMPORT REACH. Every non-test module in bridge/api/ is a root. Following every relative import
//     (value imports, re-exports and dynamic `import()`), no module reached may be one of
//     {@link ASK_ANSWERING}, nor sit in a folder that only exists to write: the Surface, the inside
//     hub's command queue, a multiplexer's own adapter folder. A `import type` is not followed: it is
//     erased, so it cannot put code on a path (it still has to name a type, and bus.ts, a type import of
//     operations.ts, imports nothing that writes anyway). The imports are read by Bun's own transpiler
//     (`Bun.Transpiler.scanImports`), a real tokenizer: an import named in a comment or a string is not
//     one, and a comment cannot hide a real import (a text scan read comments as code both ways). The
//     scan reads the real files, and a planted import in an in-memory file is caught, so the test is not
//     vacuous.
//  2. THE WORLD'S NAMES. The members of `ApiWorld`, and of the one object it passes through (`bus`), carry
//     no name that sends, answers, presses a key, types or writes: by the compiler and by the text.
//  3. THE TABLE IS READ ONLY. Every row is a `read` that needs `see` or `read`, and the local tier grants
//     `read` (which holds `see`), no level above it.
//  4. THE KEYS. `API_WORLD_KEYS` and the interface agree both ways (the compiler), `narrowWorld` keeps
//     exactly those keys and a bus of two reads (at run time), and bridge/index.ts builds the table only
//     through `apiTable(buildApiWorld({ ... }))`, whose one literal is `narrowWorld({ ... } satisfies
//     ApiWorld)` (world.ts). world-build.test.ts runs that builder over a real HillService and a real
//     WalkyInstances (security read 2, item 5).
//  5. THE SPIES. Every operation of the table runs, with valid arguments, against a world whose every
//     member is a spy, carrying extra write methods (typing, answering, start, stop, close, settings, a
//     Hill answer, mark seen) on itself and on the objects it hands out; each write throws, none is called.
//     It runs once on that world as it is (the write methods reachable at run time) and once narrowed.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { EventBus } from "../events/bus.ts";
import type { JsonObject } from "../json.ts";
import { idOf } from "./ids.ts";
import { buildTable, LOCAL_TIER_RIGHTS, OPERATION_NAMES, type OperationContext, type OperationName } from "./operations.ts";
import { buildReads, type PaneSource } from "./reads.ts";
import { API_WORLD_KEYS, apiTable, EVERY_KEY_LISTED, narrowWorld, NO_KEY_EXTRA, type ApiWorld } from "./world.ts";
import { depsOf, keyOf, MACHINE, world } from "./fixtures/reads-world.ts";

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

// Bun's own TypeScript scanner: it tokenizes, so comments and strings are not read as imports, and it
// leaves out what the compiler erases (`import type`, `export type`, an import of types alone).
const SCANNER = new Bun.Transpiler({ loader: "ts" });

/** The relative specifiers a source text puts on a runtime path (a `type` import or re-export is erased and left out). */
export function runtimeSpecifiers(text: string): string[] {
  return SCANNER.scanImports(text)
    .map((found) => found.path)
    .filter((specifier) => specifier.startsWith("."));
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

  test("a comment or a string that names an import is not one; a real import after such a comment is still seen", () => {
    const fake = [
      `// import { a } from "../surface/ask.ts";`,
      `/* import "../inside/hub.ts"; */`,
      `/**\n * export { b } from "../server.ts";\n * const m = await import("../walky/deliver.ts");\n */`,
      `const words = "import { x } from '../surface/protocol.ts'";`,
      `const tpl = \`export * from "../mux/keys.ts"\`;`,
    ].join("\n");
    expect(runtimeSpecifiers(`${fake}\nexport const quiet = 1;`)).toEqual([]);
    // A comment that reads like the start of a type import must not swallow the real one after it.
    const hiding = `/* import type { T } from */ import { a } from "../surface/ask.ts";\n// import type\nimport { b } from "../inside/hub.ts";\nconst r = /"/; import { c } from "../server.ts";`;
    expect(runtimeSpecifiers(hiding)).toEqual(["../surface/ask.ts", "../inside/hub.ts", "../server.ts"]);
    expect(runtimeSpecifiers(`${fake}\nimport { real } from "./real.ts";`)).toEqual(["./real.ts"]);
    // A type-only import is erased, whichever way it is spelled; a mixed one is followed.
    expect(runtimeSpecifiers(`import type { A } from "./a.ts";\nimport { type B } from "./b.ts";\nexport type { C } from "./c.ts";\nimport { type D, e } from "./d.ts";\nconsole.log(e);`)).toEqual(["./d.ts"]);
  });
});

// The compiler's half of the names rule: a key of the deps (or of the bus it passes) that contains one of
// these words makes `Offending` a union, and the line below fails to compile.
type Banned = `${string}${"send" | "answer" | "key" | "type" | "write" | "steer" | "prompt" | "reply" | "press" | "enqueue" | "submit" | "post" | "paste" | "input" | "deliver" | "tell" | "publish" | "subscribe"}${string}`;
type KeysOfDeps = Extract<keyof ApiWorld, string> | Extract<keyof ApiWorld["bus"], string>;
type Offending = Extract<Lowercase<KeysOfDeps>, Banned>;
const NO_OFFENDING_NAME: [Offending] extends [never] ? true : never = true;

const BANNED_WORDS = /send|answer|key|type|write|steer|prompt|reply|press|enqueue|submit|post|paste|input|deliver|tell|publish|subscribe/iu;

describe("the world of the operations names no way to write", () => {
  test("by the compiler: no member name of ApiWorld or of its bus carries a writing word", () => {
    expect(NO_OFFENDING_NAME).toBe(true);
  });

  test("by the declaration's text: every member of ApiWorld, and every key the bus is picked down to", () => {
    const source = readFileSync(join(BRIDGE, "api", "world.ts"), "utf8");
    const start = source.indexOf("export interface ApiWorld {");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}\n", start));
    const members = [...body.matchAll(/^ {2}(?:readonly )?([A-Za-z_]\w*)\s*[(:?]/gmu)].map((match) => match[1]!);
    expect(members).toEqual([...API_WORLD_KEYS]);
    const picked = [...body.matchAll(/\bbus:\s*Pick<EventBus,\s*([^>]+)>/gu)].flatMap((match) => [...match[1]!.matchAll(/"([^"]+)"/gu)].map((one) => one[1]!));
    expect(picked).toEqual(["since", "waitFor"]);
    for (const name of [...members, ...picked]) expect(name).not.toMatch(BANNED_WORDS);
  });

  test("the scan sees a bad name: planted members are caught", () => {
    for (const name of ["sendText", "answerAsk", "pressKey", "typeInto", "writeFile", "enqueueCommand", "publishEvent", "keys"]) expect(name).toMatch(BANNED_WORDS);
    for (const name of ["machine", "panes", "readScreen", "draftState", "hillOpen", "machines", "since", "instanceOf", "paneAccount", "accountsBody", "defaultLines", "bus"]) expect(name).not.toMatch(BANNED_WORDS);
  });
});

describe("the table is read only", () => {
  test("every row is a read that needs see, read alone needs read, and the local tier grants read and nothing more", () => {
    const table = buildTable({ version: () => "9.9.9-test", bus: new EventBus({ machine: () => "m", bootId: "boot1" }), reads: buildReads(depsOf(world())) });
    expect([...table.keys()]).toEqual([...OPERATION_NAMES]);
    for (const row of table.values()) {
      expect(row.kind).toBe("read");
      expect(row.right).toBe(row.name === "read" ? "read" : "see");
    }
    expect(LOCAL_TIER_RIGHTS).toBe("read");
  });
});

describe("the keys: the operations hold exactly the world's interface", () => {
  test("by the compiler: API_WORLD_KEYS and ApiWorld agree both ways", () => {
    expect(EVERY_KEY_LISTED).toBe(true);
    expect(NO_KEY_EXTRA).toBe(true);
  });

  test("narrowWorld keeps exactly the interface's keys, and a bus of its two reads, whatever the object carried", () => {
    const wide = Object.assign(spyWorld().world, { sendKeys: () => undefined, answer: () => undefined });
    const narrow = narrowWorld(wide);
    expect(Object.keys(narrow).toSorted()).toEqual([...API_WORLD_KEYS].toSorted());
    expect(Object.keys(narrow.bus).toSorted()).toEqual(["since", "waitFor"]);
    expect("publish" in narrow.bus).toBe(false);
  });

  test("bridge/index.ts builds the table only through apiTable(buildApiWorld({ ... })), and the builder narrows its one literal", () => {
    const index = readFileSync(join(BRIDGE, "index.ts"), "utf8");
    expect(index).not.toMatch(/\bbuildTable\(|\bbuildReads\(|\bnarrowWorld\(/u);
    const start = index.indexOf("table: apiTable(");
    expect(start).toBeGreaterThan(-1);
    const block = index.slice(start, index.indexOf("granted: LOCAL_TIER_RIGHTS", start));
    expect(block).toMatch(/^table: apiTable\(\s*buildApiWorld\(\{/u);
    expect(block).toMatch(/\}\),\s*\),\s*$/u);
    const worldSource = readFileSync(join(BRIDGE, "api", "world.ts"), "utf8");
    const builder = worldSource.slice(worldSource.indexOf("export function buildApiWorld("));
    expect(builder).toMatch(/^export function buildApiWorld\(deps: ApiWorldDeps\): ApiWorld \{\s*return narrowWorld\(\{/u);
    expect(builder).toContain("} satisfies ApiWorld);");
    // The bus goes in as its two reads, never the bus itself.
    expect(builder).toContain("bus: { since: (cursor) => deps.bus.since(cursor), waitFor: (after, ms, signal) => deps.bus.waitFor(after, ms, signal) }");
  });
});

/** The write names a spy world carries, on itself and on the objects it hands out. Each throws. */
type WriteName = "sendKeys" | "sendText" | "typeInto" | "answer" | "answerAsk" | "start" | "stop" | "close" | "setSettings" | "settings" | "markSeen" | "post" | "publish" | "subscribe" | "enqueue" | "remove";
type Writers = Readonly<Record<WriteName, () => never>>;

interface SpyWorld {
  readonly world: ApiWorld & Writers;
  /** The bus the world hands out, with its write methods. */
  readonly bus: ApiWorld["bus"] & Writers;
  /** Every pane source the world handed out, with its write methods. */
  readonly handed: (PaneSource & Writers)[];
  /** Every read call, by member name. */
  readonly reads: string[];
  /** Every write call, as `<object>.<name>`: must stay empty. */
  readonly writes: string[];
  /** The test's own publish on the bus behind the world, to end a wait. */
  readonly emit: () => void;
}

/** A world over the fixture: every member a spy; write methods hung on it and on what it hands out, each throwing. */
function spyWorld(): SpyWorld {
  const reads: string[] = [];
  const writes: string[] = [];
  const writers = (owner: string) => {
    const make =
      (name: WriteName) =>
      (): never => {
        writes.push(`${owner}.${name}`);
        throw new Error(`a write was called: ${owner}.${name}`);
      };
    return {
      sendKeys: make("sendKeys"),
      sendText: make("sendText"),
      typeInto: make("typeInto"),
      answer: make("answer"),
      answerAsk: make("answerAsk"),
      start: make("start"),
      stop: make("stop"),
      close: make("close"),
      setSettings: make("setSettings"),
      settings: make("settings"),
      markSeen: make("markSeen"),
      post: make("post"),
      publish: make("publish"),
      subscribe: make("subscribe"),
      enqueue: make("enqueue"),
      remove: make("remove"),
    } satisfies Writers;
  };
  const w = world();
  w.screens.set(keyOf("main", "w1:p1"), { ok: true, text: "$ ls\nREADME.md", truncated: false });
  w.bus.publish({ type: "turn.end", session: idOf(MACHINE, "w1:p1", "k3f9") });
  const base = depsOf(w);
  const realBus = w.bus;
  const handed: (PaneSource & Writers)[] = [];
  const bus = Object.assign(
    {
      since: (cursor: string | undefined) => {
        reads.push("bus.since");
        return realBus.since(cursor);
      },
      waitFor: (after: string | undefined, ms: number, signal?: AbortSignal) => {
        reads.push("bus.waitFor");
        return realBus.waitFor(after, ms, signal);
      },
    },
    writers("bus"),
  );
  const hill = Object.assign({ list: () => ({ open: base.hillOpen() ?? [] }) }, writers("hill"));
  const accounts = Object.assign({ body: () => base.accountsBody() }, writers("accounts"));
  const watch = Object.assign({ census: () => ({ ts: 1000, machines: base.machines().map((source) => source.row) }) }, writers("watch"));
  const mux = Object.assign({ readGrid: (muxSession: string, paneId: string, lines: number) => base.readScreen(muxSession, paneId, lines) }, writers("mux"));
  const spied: ApiWorld = {
    version: () => {
      reads.push("version");
      return "9.9.9-test";
    },
    machine: () => {
      reads.push("machine");
      return base.machine();
    },
    panes: () => {
      reads.push("panes");
      const out = base.panes().map((source) => Object.assign({ muxSession: source.muxSession, pane: Object.assign({}, source.pane, writers("pane")) }, writers("source")));
      handed.push(...out);
      return out;
    },
    instanceOf: (muxSession, paneId) => {
      reads.push("instanceOf");
      return base.instanceOf(muxSession, paneId);
    },
    bus,
    paneAccount: (muxSession, pane) => {
      reads.push("paneAccount");
      return base.paneAccount(muxSession, pane);
    },
    accountsBody: () => {
      reads.push("accountsBody");
      return accounts.body();
    },
    draftState: (muxSession, paneId) => {
      reads.push("draftState");
      return base.draftState(muxSession, paneId);
    },
    readScreen: (muxSession, paneId, lines) => {
      reads.push("readScreen");
      return mux.readGrid(muxSession, paneId, lines);
    },
    hillOpen: () => {
      reads.push("hillOpen");
      return hill.list().open;
    },
    machines: () => {
      reads.push("machines");
      return watch.census().machines.map((row) => ({ row: Object.assign({}, row, writers("machine")), member: undefined }));
    },
    defaultLines: base.defaultLines,
  };
  const emit = (): void => {
    realBus.publish({ type: "session.status", session: idOf(MACHINE, "w1:p1", "k3f9"), data: { state: "working" } });
  };
  return { world: Object.assign(spied, writers("world")), bus, handed, reads, writes, emit };
}

/** Valid arguments for every operation: the compiler makes this list every name. */
function validArgs() {
  const session = idOf(MACHINE, "w1:p1", "k3f9");
  return { hello: { token: "A".repeat(43) }, sessions: {}, brief: { session }, read: { session, lines: 10 }, accounts: {}, "hill.list": {}, machines: {}, events: { after: "-", wait: 0 } } satisfies Record<OperationName, JsonObject>;
}

function spyCtx(): OperationContext {
  return { signal: new AbortController().signal, offered: [...OPERATION_NAMES], standing: () => true, claimWait: () => () => undefined };
}

describe("the spies: no operation calls a write, even one reachable at run time", () => {
  for (const [how, narrowed] of [
    ["the world as passed, its write methods reachable", false],
    ["the world narrowed, as bridge/index.ts passes it", true],
  ] as const) {
    test(`every operation, with valid arguments, on ${how}`, async () => {
      const spy = spyWorld();
      const table = apiTable(narrowed ? narrowWorld(spy.world) : spy.world);
      expect([...table.keys()]).toEqual([...OPERATION_NAMES]);
      const args = validArgs();
      for (const name of OPERATION_NAMES) {
        const result = await table.get(name)!.run(args[name], spyCtx());
        expect({ name, ok: result.ok }).toEqual({ name, ok: true });
      }
      // An events wait that ends on an event, too.
      const head = spy.world.bus.since(undefined).next;
      const waiting = table.get("events")!.run({ after: head, wait: 5 }, spyCtx());
      setTimeout(spy.emit, 10);
      const ended = await waiting;
      const events = ended.ok ? ended.answer.events : undefined;
      expect(Array.isArray(events) ? events.length : -1).toBe(1);
      expect(spy.writes).toEqual([]);
      // The operations held objects with write methods on them, and called none.
      expect(spy.handed.length).toBeGreaterThan(0);
      // Not vacuous: the operations did read the world.
      for (const member of ["version", "machine", "panes", "instanceOf", "bus.since", "bus.waitFor", "paneAccount", "accountsBody", "draftState", "readScreen", "hillOpen", "machines"]) expect(spy.reads).toContain(member);
    });
  }

  test("the spies are armed: a write method on the world or on an object it hands out throws and is recorded", () => {
    const spy = spyWorld();
    expect(() => spy.world.sendKeys()).toThrow("a write was called: world.sendKeys");
    spy.world.panes();
    expect(() => spy.handed[0]!.markSeen()).toThrow("source.markSeen");
    expect(() => spy.bus.publish()).toThrow("bus.publish");
    expect(spy.writes).toEqual(["world.sendKeys", "source.markSeen", "bus.publish"]);
  });
});
