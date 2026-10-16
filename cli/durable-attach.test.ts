import { describe, expect, test } from "bun:test";

import { HOST, hostFor, type Host } from "../bridge/host.ts";
import type { JsonValue } from "../bridge/json.ts";
import { testToken } from "../bridge/mux/durable/fixture.ts";
import {
  ATTACH_USAGE,
  cmdDurable,
  cmdDurableAttach,
  cmdDurableDetach,
  cmdDurableList,
  SOURCES_FILE,
  WINDOWS_SOCKET_REFUSAL,
  type DurableAttachDeps,
} from "./durable-attach.ts";
import { capture, CONFIG, context, fakeExec, fakeFiles, type FakeFiles } from "./fakes.ts";
import { EXIT } from "./io.ts";
import type { Environment } from "./context.ts";

// `collie durable attach | detach | list` over fakes. No test here reaches a service manager: the
// restart is a spy, and the one test that passes `--restart` proves the spy ran and nothing else did.

const FILE = `${CONFIG}/${SOURCES_FILE}`;
const SOCKET = "/run/user/1000/desk/app.sock";

interface Harness {
  deps: DurableAttachDeps;
  io: ReturnType<typeof capture>;
  files: FakeFiles;
  restarts: number[];
  fetched: string[];
}

// The harness pins a POSIX host unless a test names another: the socket tests below are about the
// entry, and on a Windows machine the real host would refuse every `--socket`.
function harness(
  env: Environment = {},
  seed: Record<string, string> = {},
  answer: (url: string) => Response | Error = () => new Response("{}"),
  host: Host = hostFor("linux"),
): Harness {
  const files = fakeFiles(seed);
  const io = capture();
  const restarts: number[] = [];
  const fetched: string[] = [];
  const deps: DurableAttachDeps = {
    ctx: context(env),
    io,
    files,
    host,
    exec: fakeExec({ absent: ["tailscale"] }),
    restart: async () => {
      restarts.push(1);
      return EXIT.OK;
    },
    fetch: async (url) => {
      fetched.push(url);
      const r = answer(url);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { deps, io, files, restarts, fetched };
}

// SAFETY: JSON.parse output is a JsonValue by construction.
const stored = (h: Harness): JsonValue => JSON.parse(h.files.read(FILE) ?? "null") as JsonValue;
const everything = (h: Harness): string => [...h.io.stdout, ...h.io.stderr].join("\n");

describe("durable attach", () => {
  test("a socket program is written at mode 0600 and the restart is left to the operator", async () => {
    const h = harness();
    expect(await cmdDurableAttach(h.deps, ["desk", "--socket", SOCKET])).toBe(EXIT.OK);
    expect(stored(h)).toEqual([{ name: "desk", kind: "durable", socket: SOCKET }]);
    expect(h.files.entries.get(FILE)?.mode).toBe(0o600);
    expect(everything(h)).toContain("restart to apply");
    expect(h.restarts).toEqual([]);
  });

  test("--restart calls the restart seam once, and without it nothing restarts", async () => {
    const h = harness();
    expect(await cmdDurableAttach(h.deps, ["desk", `--socket=${SOCKET}`, "--restart"])).toBe(EXIT.OK);
    expect(h.restarts).toEqual([1]);
    expect(everything(h)).not.toContain("restart to apply");
  });

  test("a url program reads its token from the named variable and stores it in the file only", async () => {
    const token = testToken();
    const h = harness({ DESK_TOKEN: token });
    const code = await cmdDurableAttach(h.deps, ["edge", "--url", "https://member.example.workers.dev/", "--token-env", "DESK_TOKEN"]);
    expect(code).toBe(EXIT.OK);
    expect(stored(h)).toEqual([{ name: "edge", kind: "durable", url: "https://member.example.workers.dev", token }]);
    expect(h.files.entries.get(FILE)?.mode).toBe(0o600);
    expect(everything(h)).not.toContain(token);
  });

  test("on a Windows host a socket is refused with the sentence that names --url, exit 2, and nothing is written", async () => {
    const h = harness({}, {}, undefined, hostFor("win32"));
    expect(await cmdDurableAttach(h.deps, ["desk", "--socket", "C:\\run\\desk.sock"])).toBe(EXIT.USAGE);
    expect(h.io.stderr.join("\n")).toBe(`error: ${WINDOWS_SOCKET_REFUSAL}`);
    expect(WINDOWS_SOCKET_REFUSAL).toBe("a private socket needs Unix user ids; on Windows use --url <https://...> --token-env VAR");
    expect(h.files.entries.size).toBe(0);
    expect(h.restarts).toEqual([]);
  });

  test("on a Windows host a url program is written as anywhere", async () => {
    const token = testToken();
    const h = harness({ DESK_TOKEN: token }, {}, undefined, hostFor("win32"));
    expect(await cmdDurableAttach(h.deps, ["edge", "--url", "https://member.example.workers.dev", "--token-env", "DESK_TOKEN"])).toBe(EXIT.OK);
    expect(stored(h)).toEqual([{ name: "edge", kind: "durable", url: "https://member.example.workers.dev", token }]);
  });

  test("on this machine's own host a socket is refused on Windows and written elsewhere", async () => {
    const h = harness({}, {}, undefined, HOST);
    const code = await cmdDurableAttach(h.deps, ["desk", "--socket", SOCKET]);
    if (HOST.platform === "win32") {
      expect(code).toBe(EXIT.USAGE);
      expect(h.io.stderr.join("\n")).toBe(`error: ${WINDOWS_SOCKET_REFUSAL}`);
      expect(h.files.entries.size).toBe(0);
    } else {
      expect(code).toBe(EXIT.OK);
      expect(stored(h)).toEqual([{ name: "desk", kind: "durable", socket: SOCKET }]);
    }
  });

  test("a second attach under the same name replaces the entry and keeps the others", async () => {
    const h = harness();
    await cmdDurableAttach(h.deps, ["desk", "--socket", SOCKET]);
    await cmdDurableAttach(h.deps, ["other", "--socket", "/run/user/1000/other.sock"]);
    await cmdDurableAttach(h.deps, ["desk", "--socket", "/run/user/1000/desk2.sock"]);
    expect(stored(h)).toEqual([
      { name: "other", kind: "durable", socket: "/run/user/1000/other.sock" },
      { name: "desk", kind: "durable", socket: "/run/user/1000/desk2.sock" },
    ]);
    expect(h.io.stdout.join("\n")).toContain("updated desk");
  });

  test("no temp file is left behind", async () => {
    const h = harness();
    await cmdDurableAttach(h.deps, ["desk", "--socket", SOCKET]);
    expect([...h.files.entries.keys()]).toEqual([FILE]);
  });

  describe("validation names the field and writes nothing", () => {
    const token = testToken();
    const cases: [string, string[], string, Environment][] = [
      ["a bad name", ["Desk", "--socket", SOCKET], "name", {}],
      ["a name that is too long", ["a".repeat(33), "--socket", SOCKET], "name", {}],
      ["a name that starts with a hyphen", ["-desk", "--socket", SOCKET], "name -desk", {}],
      ["neither socket nor url", ["desk"], "--socket or --url", {}],
      ["both socket and url", ["desk", "--socket", SOCKET, "--url", "https://x.example"], "--socket or --url", {}],
      ["a relative socket", ["desk", "--socket", "app.sock"], "--socket must be an absolute path", {}],
      ["a token with a socket", ["desk", "--socket", SOCKET, "--token-env", "T"], "--token-env", { T: token }],
      ["a url with no token variable", ["edge", "--url", "https://x.example"], "--token-env", {}],
      ["an unset token variable", ["edge", "--url", "https://x.example", "--token-env", "NOPE"], "NOPE", {}],
      ["plain http to another host", ["edge", "--url", "http://example.com:80", "--token-env", "T"], "--url uses plain http", { T: token }],
      ["a short token", ["edge", "--url", "https://x.example", "--token-env", "T"], "the token in T is 5 bytes", { T: "short" }],
      ["an unknown flag", ["desk", "--socket", SOCKET, "--token", "x"], "unknown flag --token", {}],
      ["a flag without its value", ["desk", "--socket"], "--socket needs a value", {}],
      ["two names", ["a", "b", "--socket", SOCKET], "one name", {}],
    ];
    for (const [label, args, field, env] of cases) {
      test(label, async () => {
        const h = harness(env);
        expect(await cmdDurableAttach(h.deps, args)).toBe(EXIT.USAGE);
        expect(h.io.stderr.join("\n")).toContain(field);
        expect(h.files.entries.size).toBe(0);
        expect(h.restarts).toEqual([]);
      });
    }
  });

  test("a file that is not valid JSON is not overwritten", async () => {
    const h = harness({}, { [FILE]: "{ not json" });
    expect(await cmdDurableAttach(h.deps, ["desk", "--socket", SOCKET])).toBe(EXIT.FAIL);
    expect(h.files.read(FILE)).toBe("{ not json");
    expect(h.io.stderr.join("\n")).toContain("not valid JSON");
  });

  test("a file with a bad entry is not overwritten, and the error names the field", async () => {
    const bad = JSON.stringify([{ name: "desk", kind: "durable", url: "https://x.example" }]);
    const h = harness({}, { [FILE]: bad });
    expect(await cmdDurableAttach(h.deps, ["other", "--socket", SOCKET])).toBe(EXIT.FAIL);
    expect(h.files.read(FILE)).toBe(bad);
    expect(h.io.stderr.join("\n")).toContain("url needs a token");
  });

  test("the usage line is printed with a usage error", async () => {
    const h = harness();
    await cmdDurableAttach(h.deps, []);
    expect(h.io.stderr.join("\n")).toContain(ATTACH_USAGE);
  });
});

describe("durable detach", () => {
  const seed = JSON.stringify([
    { name: "desk", kind: "durable", socket: SOCKET },
    { name: "edge", kind: "durable", url: "https://x.example", token: "t".repeat(40) },
  ]);

  test("removes one entry and keeps the other, at mode 0600", async () => {
    const h = harness({}, { [FILE]: seed });
    expect(await cmdDurableDetach(h.deps, ["desk"])).toBe(EXIT.OK);
    expect(stored(h)).toEqual([{ name: "edge", kind: "durable", url: "https://x.example", token: "t".repeat(40) }]);
    expect(h.files.entries.get(FILE)?.mode).toBe(0o600);
    expect(h.restarts).toEqual([]);
    expect(everything(h)).toContain("restart to apply");
  });

  test("an unknown name is a state error and changes nothing", async () => {
    const h = harness({}, { [FILE]: seed });
    expect(await cmdDurableDetach(h.deps, ["nope"])).toBe(EXIT.STATE);
    expect(h.files.read(FILE)).toBe(seed);
  });

  test("--restart calls the seam", async () => {
    const h = harness({}, { [FILE]: seed });
    expect(await cmdDurableDetach(h.deps, ["desk", "--restart"])).toBe(EXIT.OK);
    expect(h.restarts).toEqual([1]);
  });

  test("no name is a usage error", async () => {
    const h = harness({}, { [FILE]: seed });
    expect(await cmdDurableDetach(h.deps, [])).toBe(EXIT.USAGE);
  });
});

describe("durable list", () => {
  const token = testToken();
  const seed = JSON.stringify([
    { name: "desk", kind: "durable", socket: SOCKET },
    { name: "edge", kind: "durable", url: "https://x.example", token },
  ]);

  test("prints each program with the state the bridge gives it, and never the token", async () => {
    const h = harness({}, { [FILE]: seed }, (url) => (url.includes("session=desk") ? new Response("{}") : new Response("", { status: 404 })));
    expect(await cmdDurableList(h.deps)).toBe(EXIT.OK);
    const out = h.io.stdout.join("\n");
    expect(out).toContain(`desk  socket ${SOCKET}  loaded`);
    expect(out).toContain("edge  url https://x.example (token set)  not loaded (restart to apply)");
    expect(everything(h)).not.toContain(token);
    expect(h.fetched[0]).toBe("http://127.0.0.1:8787/api/config?session=desk");
  });

  test("a bridge that does not answer is said so", async () => {
    const h = harness({}, { [FILE]: seed }, () => new Error("ECONNREFUSED"));
    await cmdDurableList(h.deps);
    expect(h.io.stdout.join("\n")).toContain("bridge not answering");
  });

  test("with programs off the entries print as usual and the last line says so", async () => {
    const h = harness({ COLLIE_PROGRAMS: "off" }, { [FILE]: seed }, (url) => (url.includes("session=desk") ? new Response("{}") : new Response("", { status: 404 })));
    expect(await cmdDurableList(h.deps)).toBe(EXIT.OK);
    expect(h.io.stdout.at(-1)).toBe("durable agents are off (COLLIE_PROGRAMS=off)");
    expect(h.io.stdout.join("\n")).toContain(`desk  socket ${SOCKET}  loaded`);
    const plain = harness({}, { [FILE]: seed }, () => new Response("{}"));
    await cmdDurableList(plain.deps);
    expect(plain.io.stdout.join("\n")).not.toContain("durable agents are off");
  });

  test("an empty or missing file says so", async () => {
    const h = harness();
    expect(await cmdDurableList(h.deps)).toBe(EXIT.OK);
    expect(h.io.stdout.join("\n")).toContain("no durable agents attached");
    expect(h.fetched).toEqual([]);
  });
});

describe("durable (bare)", () => {
  test("a bare or misspelt verb prints the three usages and exits 2", async () => {
    for (const args of [[], ["nonsense"]]) {
      const h = harness();
      expect(await cmdDurable(h.deps, args)).toBe(EXIT.USAGE);
      expect(h.io.stderr.join("\n")).toContain("collie durable list");
    }
  });
});
