import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { capture, context } from "./fakes.ts";
import { EXIT } from "./io.ts";
import { cmdPush, cmdPushForget, cmdPushList, cmdPushTest, type PushDeps } from "./push.ts";

// `collie push {list,forget,test}` against a THROWAWAY state dir. Unlike the other verb suites this
// one cannot run on fakes alone: the subscription store has exactly one reader and one writer, and
// they live in `bridge/push.ts` on real files (that single-parser rule is the point — a fake store
// here would be the second parser). So the seam moved is the state DIRECTORY, and the developer's
// own `push-subscriptions.json` is never in reach.
//
// The verbs resolve that directory through `loadConfig()`, i.e. `process.env` — which is also why
// every test restores the environment afterwards.

const dirs: string[] = [];
async function tempState(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-push-cli-"));
  dirs.push(dir);
  return dir;
}

const ENV_KEYS = [
  "HERDR_PLUGIN_STATE_DIR",
  "COLLIE_STATE_DIR",
  "COLLIE_VAPID_PUBLIC",
  "COLLIE_VAPID_PRIVATE",
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  // A VAPID keypair in the developer's own shell would turn the "push is disabled" assertion into a
  // real send attempt against this host's real subscriptions.
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** The verbs' deps over a real, throwaway state dir and a capturing terminal. */
function deps(stateDir: string): PushDeps & ReturnType<typeof capture> {
  const io = capture();
  return { ctx: context({ COLLIE_STATE_DIR: stateDir }, { stateDir }), io, ...io };
}

const storeFile = (dir: string): string => join(dir, "push-subscriptions.json");

const row = (endpoint: string, extra: Record<string, unknown> = {}) => ({
  endpoint,
  keys: { p256dh: "p", auth: "a" },
  ...extra,
});

async function seed(dir: string, rows: unknown[]): Promise<void> {
  await writeFile(storeFile(dir), JSON.stringify(rows, null, 2));
}

const endpointsOn = async (dir: string): Promise<string[]> =>
  (JSON.parse(await readFile(storeFile(dir), "utf8")) as { endpoint: string }[]).map((r) => r.endpoint);

const APPLE = "https://web.push.apple.com/12345aBcDeF67890";
const FCM = "https://fcm.googleapis.com/fcm/send/ZZZyyyXXXwww";

describe("push list", () => {
  test("an empty store is a friendly line and an OK exit — and materialises nothing", async () => {
    const dir = await tempState();
    const d = deps(dir);

    expect(await cmdPushList(d)).toBe(EXIT.OK);
    expect(d.stdout.join("\n")).toContain("no subscribed devices");
    expect(d.stdout.join("\n")).toContain(storeFile(dir));
    expect(await stat(storeFile(dir)).catch(() => null)).toBeNull();
  });

  test("one line per row: index, service host, day, user agent, endpoint tail", async () => {
    const dir = await tempState();
    await seed(dir, [
      row(APPLE, { createdAt: "2026-07-02T09:11:00.000Z", userAgent: "Mozilla/5.0 (iPhone)" }),
      row(FCM),
    ]);
    const d = deps(dir);

    expect(await cmdPushList(d)).toBe(EXIT.OK);
    expect(d.stdout).toHaveLength(2);
    expect(d.stdout[0]).toContain("web.push.apple.com");
    expect(d.stdout[0]).toContain("2026-07-02");
    expect(d.stdout[0]).toContain("Mozilla/5.0 (iPhone)");
    // The tail is what makes two rows from the same service tellable apart — and retypable.
    expect(d.stdout[0]).toContain(`…${APPLE.slice(-12)}`);
    // A row from before the metadata existed prints, it just has nothing to say.
    expect(d.stdout[1]).toContain("fcm.googleapis.com");
    expect(d.stdout[1]).toContain("?");
  });

  test("the sending credential never reaches the terminal", async () => {
    const dir = await tempState();
    await seed(dir, [row(APPLE, { userAgent: "iPhone" })]);
    const d = deps(dir);

    await cmdPushList(d);
    expect(d.stdout.join("\n")).not.toContain("p256dh");
    expect(d.stdout.join("\n")).not.toContain("auth");
  });

  test("listing reads — it never rewrites the file it was asked about", async () => {
    const dir = await tempState();
    await seed(dir, [row(APPLE)]);
    const before = await readFile(storeFile(dir), "utf8");

    expect(await cmdPushList(deps(dir))).toBe(EXIT.OK);
    expect(await readFile(storeFile(dir), "utf8")).toBe(before);
  });
});

describe("push forget", () => {
  test("a substring drops every row that contains it, and says how many", async () => {
    const dir = await tempState();
    await seed(dir, [row(APPLE), row(`${APPLE}-second`), row(FCM)]);
    const d = deps(dir);

    expect(await cmdPushForget(d, ["apple.com"])).toBe(EXIT.OK);
    expect(d.stdout.join("\n")).toContain("forgot 2 subscription(s)");
    expect(await endpointsOn(dir)).toEqual([FCM]);
  });

  test("the tail `push list` prints is enough to name one row", async () => {
    const dir = await tempState();
    await seed(dir, [row(APPLE), row(FCM)]);

    expect(await cmdPushForget(deps(dir), ["ZZZyyyXXXwww"])).toBe(EXIT.OK);
    expect(await endpointsOn(dir)).toEqual([APPLE]);
  });

  test("`--all` empties the store", async () => {
    const dir = await tempState();
    await seed(dir, [row(APPLE), row(FCM)]);

    expect(await cmdPushForget(deps(dir), ["--all"])).toBe(EXIT.OK);
    expect(await endpointsOn(dir)).toEqual([]);
  });

  test("a substring nobody matches fails loudly and changes nothing", async () => {
    const dir = await tempState();
    await seed(dir, [row(APPLE)]);
    const d = deps(dir);

    expect(await cmdPushForget(d, ["nonsense"])).toBe(EXIT.FAIL);
    expect(d.stderr.join("\n")).toContain("no subscription matches `nonsense`");
    expect(d.stdout).toEqual([]);
    expect(await endpointsOn(dir)).toEqual([APPLE]);
  });

  test("`--all` on an empty store is not a failure — there was nothing to fail at", async () => {
    const dir = await tempState();
    const d = deps(dir);

    expect(await cmdPushForget(d, ["--all"])).toBe(EXIT.OK);
    expect(d.stdout.join("\n")).toContain("nothing to forget");
    expect(await stat(storeFile(dir)).catch(() => null)).toBeNull();
  });

  test("no argument is a usage error, not an accidental `--all`", async () => {
    const dir = await tempState();
    await seed(dir, [row(APPLE)]);
    const d = deps(dir);

    expect(await cmdPushForget(d, [])).toBe(EXIT.FAIL);
    expect(d.stderr.join("\n")).toContain("usage: collie push forget");
    expect(await endpointsOn(dir)).toEqual([APPLE]);
  });
});

describe("push with no VAPID configured", () => {
  // The whole reason `list` and `forget` don't go through `init()`: a broken or absent push setup is
  // exactly the state an operator is in when they come to clean the store up.
  test("list and forget work; only `test` needs a live sender", async () => {
    const dir = await tempState();
    await seed(dir, [row(APPLE)]);

    expect(await cmdPushList(deps(dir))).toBe(EXIT.OK);
    expect(await cmdPushForget(deps(dir), ["--all"])).toBe(EXIT.OK);

    const d = deps(dir);
    expect(await cmdPushTest(d, [])).toBe(EXIT.FAIL);
    expect(d.stderr.join("\n")).toContain("push is disabled");
  });
});

describe("the parent verb", () => {
  test("bare `push` prints the sub-verbs and exits 2", async () => {
    const d = deps(await tempState());
    expect(await cmdPush(d, [])).toBe(EXIT.USAGE);
    const err = d.stderr.join("\n");
    expect(err).toContain("usage: collie push {list|forget|keys|test}");
    for (const sub of ["list", "forget", "keys", "test"]) expect(err).toContain(sub);
    expect(err).not.toContain("unknown push subcommand");
  });

  test("a misspelt sub-verb is named before the usage block", async () => {
    const d = deps(await tempState());
    expect(await cmdPush(d, ["lsit"])).toBe(EXIT.USAGE);
    expect(d.stderr.join("\n")).toContain("unknown push subcommand `lsit`");
  });

  test("each sub-verb routes, arguments intact", async () => {
    const dir = await tempState();
    await seed(dir, [row(APPLE), row(FCM)]);

    expect(await cmdPush(deps(dir), ["list"])).toBe(EXIT.OK);
    // `forget` reached with its argument, not with the sub-verb name in front of it.
    expect(await cmdPush(deps(dir), ["forget", "apple.com"])).toBe(EXIT.OK);
    expect(await endpointsOn(dir)).toEqual([FCM]);
  });
});
