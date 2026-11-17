import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parseFacts, parseManifest, type TrickFacts, type TrickManifest } from "../../web/src/lib/tricks/schema.ts";
import { VALUE_WRITES_SEEN_MAX } from "../../web/src/lib/tricks/limits.ts";
import type { JsonValue } from "../json.ts";
import { powersOfDir } from "./approved.ts";
import { trickCodeHash } from "./code-hash.ts";
import { asksForChange, asksForLines } from "./version-card.ts";
import { TRICKS_DIR, trickStateDir } from "./paths.ts";
import type { RunOutcome, RunSpec } from "./run.ts";
import { TRICKS_ROUTE_RIGHTS, tricksValueRoute } from "./routes.ts";
import { TRICKS_OFF_LINE, TRICKS_WINDOWS_LINE } from "../../web/src/lib/tricks/schema.ts";
import { TricksService, VALUES_ON_LEAD, type TricksServiceDeps, type ValueAnswer } from "./service.ts";
import { withSwitch, writeSwitches, type Switches } from "./switches.ts";
import { stateEntries } from "../crew/standby-tricks-lead.ts";
import { fieldsWire, parseValuesFile, SeenWrites, TrickValues, valuesPath, withValues } from "./values.ts";

// `[[field]]` on the bridge (contract 3): the store, the write route, the facts and what never carries a value.

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-tricks-values-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const HOST = "lodge";
const R1 = "1f0c1d2e-3b4a-4c5d-8e6f-708192a3b4c5";
const R2 = "2f0c1d2e-3b4a-4c5d-8e6f-708192a3b4c5";
const R3 = "3f0c1d2e-3b4a-4c5d-8e6f-708192a3b4c5";
/** The value the tests watch for in every place a value must never reach. */
const SECRET = "lodge-workshop-private-value";
const MANIFEST = `id = "legs"
name = "Browser leg"
run = "./legs.sh"
every = "30s"
places = ["belt"]
contract = 3

[[field]]
key = "repo"
kind = "text"
label = "Repository"
required = true

[[field]]
key = "rows"
kind = "number"
label = "Rows"
min = 1
max = 50
default = 10
`;
const BELT = JSON.stringify({ v: 3, asOf: "2026-11-17T09:00:00Z", parts: [{ at: "belt", id: "belt", mark: { label: "ok", intent: "x" } }] });

function manifestOf(text: string): TrickManifest {
  // SAFETY: `Bun.TOML.parse` answers with a parsed document; `parseManifest` checks it.
  const parsed = parseManifest(Bun.TOML.parse(text) as JsonValue);
  if (parsed.manifest === undefined) throw new Error(JSON.stringify(parsed.refusals));
  return parsed.manifest;
}

interface Rig {
  configDir: string;
  stateDir: string;
  service: TricksService;
  specs: RunSpec[];
  audit: { action: string; detail: Record<string, string> }[];
  warnings: string[];
  clock: { t: number };
}

async function rig(extra: Partial<TricksServiceDeps> = {}, on = true): Promise<Rig> {
  const root = await tempDir();
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const dir = join(configDir, TRICKS_DIR, "legs");
  await mkdir(dir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(dir, "trick.toml"), MANIFEST);
  await writeFile(join(dir, "legs.sh"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
  if (on) {
    const code = await trickCodeHash(dir);
    const switches: Switches = withSwitch({ on: new Map() }, "legs", true, "2026-11-17T09:00:00Z", code.ok ? code.hash : null, await powersOfDir(dir, "legs"));
    await writeSwitches(stateDir, switches);
  }
  const specs: RunSpec[] = [];
  const audit: Rig["audit"] = [];
  const warnings: string[] = [];
  const clock = { t: Date.parse("2026-11-17T09:00:00Z") };
  const service = new TricksService({
    configDir,
    stateDir,
    memberId: HOST,
    world: (memberId) => ({ machine: "lodge", sessions: [], spaces: [], memberId }),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    now: () => clock.t,
    warn: (line) => warnings.push(line),
    audit: (entry) => audit.push(entry),
    // Tricks as a whole switched on (feature-switch.ts), so a changed value can run the trick.
    feature: { on: () => true },
    revBase: 1000,
    run: async (spec): Promise<RunOutcome> => {
      specs.push(spec);
      return { kind: "exited", code: 0, stdout: BELT, stderr: "", ms: 5 };
    },
    ...extra,
  });
  return { configDir, stateDir, service, specs, audit, warnings, clock };
}

async function tick(r: Rig, ms = 1000): Promise<void> {
  r.clock.t += ms;
  r.service.noteWatched();
  await r.service.refresh(true);
  await r.service.tick();
}

function receipt(answer: ValueAnswer) {
  if (answer.status !== 200) throw new Error(`answered ${String(answer.status)}: ${JSON.stringify(answer.body)}`);
  return answer.body;
}

function factsOf(spec: RunSpec | undefined): TrickFacts {
  const parsed = parseFacts(JSON.parse(spec?.stdin ?? "null"));
  if (parsed.facts === undefined) throw new Error(JSON.stringify(parsed.refusals));
  return parsed.facts;
}

describe("values.json", () => {
  test("lives in the trick's state folder under .collie/, mode 0600 in a 0700 folder, written whole through a temp file", async () => {
    const stateDir = await tempDir();
    const store = new TrickValues(stateDir);
    store.write("legs", { repo: "lodge/workshop" });
    const path = valuesPath(stateDir, "legs");
    expect(path).toBe(join(trickStateDir(stateDir, "legs"), ".collie", "values.json"));
    // A file mode is POSIX; Windows keeps the folder private by its access list, and the rest of the test runs there.
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    }
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ v: 1, values: { repo: "lodge/workshop" } });
    store.write("legs", { repo: "lodge/other" });
    // No temp file is left beside it.
    expect(await readdir(dirname(path))).toEqual(["values.json"]);
    expect(store.read("legs")).toEqual({ values: { repo: "lodge/other" }, unread: false });
  });

  test("a missing file reads empty; a bad file reads empty and says so", async () => {
    const stateDir = await tempDir();
    const store = new TrickValues(stateDir);
    expect(store.read("legs")).toEqual({ values: {}, unread: false });
    await mkdir(dirname(valuesPath(stateDir, "legs")), { recursive: true });
    for (const bad of ["not json", "[]", '{"v":2,"values":{}}', '{"v":1,"values":{"Bad Key":"x"}}', '{"v":1,"values":{"repo":["x"]}}']) {
      await writeFile(valuesPath(stateDir, "legs"), bad);
      expect(new TrickValues(stateDir).read("legs"), bad).toEqual({ values: {}, unread: true });
      expect(parseValuesFile(bad), bad).toBeNull();
    }
  });

  test("review G point 3: a .collie that is a symlink is refused, read and written; the target is never touched", async () => {
    const stateDir = await tempDir();
    const target = await tempDir();
    const folder = dirname(valuesPath(stateDir, "legs"));
    await mkdir(dirname(folder), { recursive: true });
    await chmod(target, 0o755);
    await symlink(target, folder);
    const store = new TrickValues(stateDir);
    expect(() => store.write("legs", { repo: SECRET })).toThrow(/not a real folder/u);
    expect(await readdir(target)).toEqual([]);
    if (process.platform !== "win32") expect((await stat(target)).mode & 0o777).toBe(0o755);
    // A values file the link holds is not read either.
    await writeFile(join(target, "values.json"), JSON.stringify({ v: 1, values: { repo: SECRET } }));
    expect(store.read("legs")).toEqual({ values: {}, unread: true });
  });

  test("review G point 3: through the route a symlinked .collie answers write-failed and the value is nowhere", async () => {
    const r = await rig();
    const target = await tempDir();
    const folder = dirname(valuesPath(r.stateDir, "legs"));
    await mkdir(dirname(folder), { recursive: true });
    await symlink(target, folder);
    const answer = await r.service.setValue(HOST, "legs", { rid: R1, key: "repo", value: SECRET });
    expect(answer).toMatchObject({ status: 409, body: { error: "write-failed" } });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(await readdir(target)).toEqual([]);
    expect(r.audit).toEqual([]);
  });

  test("review G point 7: a hand-edited file that breaks a field's rule reads that field as unset, and the row says Needs setup", async () => {
    const stateDir = await tempDir();
    await mkdir(dirname(valuesPath(stateDir, "legs")), { recursive: true });
    const manifest = manifestOf(MANIFEST);
    // A number past its max, and a text with a line break: each reads as unset for its own field.
    await writeFile(valuesPath(stateDir, "legs"), JSON.stringify({ v: 1, values: { repo: "one\ntwo", rows: 99 } }));
    const stored = new TrickValues(stateDir).read("legs");
    expect(fieldsWire(manifest, stored)).toEqual({ fields: manifest.fields, needsSetup: true });
    expect(withValues({ contract: 3, trigger: { kind: "timer" }, trick: { id: "legs", dir: "/d", state: "/s" }, host: HOST, memberId: HOST, sessions: [], spaces: [] }, manifest, stored).values).toEqual({ rows: 10 });
    // A good field beside a bad one stays.
    await writeFile(valuesPath(stateDir, "legs"), JSON.stringify({ v: 1, values: { repo: "lodge/workshop", rows: 99 } }));
    expect(fieldsWire(manifest, new TrickValues(stateDir).read("legs"))).toEqual({ fields: manifest.fields, values: { repo: "lodge/workshop" } });
  });

  test("review G point 7: __proto__ as a key is refused by the file reader and by the route", async () => {
    expect(parseValuesFile('{"v":1,"values":{"__proto__":"x"}}')).toBeNull();
    const r = await rig();
    expect(await r.service.setValue(HOST, "legs", { rid: R1, key: "__proto__", value: "x" })).toEqual({ status: 400, body: { error: "value-invalid" } });
    expect(await Bun.file(valuesPath(r.stateDir, "legs")).exists()).toBe(false);
    expect("x" in {}).toBe(false);
  });

  test("the row carries the fields, the values kept, Needs setup, and the unread flag", () => {
    const manifest = manifestOf(MANIFEST);
    expect(fieldsWire(manifest, { values: {}, unread: false })).toEqual({ fields: manifest.fields, needsSetup: true });
    expect(fieldsWire(manifest, { values: { repo: "lodge/workshop", rows: 99 }, unread: false })).toEqual({ fields: manifest.fields, values: { repo: "lodge/workshop" } });
    expect(fieldsWire(manifest, { values: {}, unread: true })).toMatchObject({ needsSetup: true, valuesUnread: true });
    expect(fieldsWire(manifestOf(MANIFEST.split("[[field]]")[0]!), { values: { repo: "x" }, unread: false })).toEqual({});
  });

  test("the facts carry each field's value now, and a trick with no fields gets its facts as before", () => {
    const manifest = manifestOf(MANIFEST);
    const facts = { contract: 3, trigger: { kind: "timer" }, trick: { id: "legs", dir: "/home/dev/legs", state: "/home/dev/state" }, host: HOST, memberId: HOST, sessions: [], spaces: [] } satisfies TrickFacts;
    expect(withValues(facts, manifest, { values: { repo: "lodge/workshop" }, unread: false }).values).toEqual({ repo: "lodge/workshop", rows: 10 });
    expect(withValues(facts, manifestOf(MANIFEST.split("[[field]]")[0]!), { values: { repo: "x" }, unread: false })).toBe(facts);
  });

  test("the seen-id store forgets the oldest past its bound", () => {
    const seen = new SeenWrites<number>(3);
    for (const [i, rid] of ["a", "b", "c", "d"].entries()) seen.remember(rid, "d", i);
    expect(seen.size).toBe(3);
    expect(seen.get("a")).toBeUndefined();
    expect(seen.get("d")?.answer).toBe(3);
    expect(VALUE_WRITES_SEEN_MAX).toBe(256);
  });
});

describe("the write route", () => {
  test("is gated at the write level", () => {
    expect(TRICKS_ROUTE_RIGHTS.value).toBe("write");
  });

  test("answers a receipt, writes once for one id, refuses the same id with another payload", async () => {
    const r = await rig();
    const first = receipt(await r.service.setValue(HOST, "legs", { rid: R1, key: "repo", value: SECRET }));
    expect(first).toMatchObject({ rid: R1, code: "ok", key: "repo", changed: true });
    expect(first.info.values).toEqual({ repo: SECRET });
    expect(first.info.needsSetup).toBeUndefined();
    const mtime = (await stat(valuesPath(r.stateDir, "legs"))).mtimeMs;
    // The same id and payload: the first receipt again, no second write, no second audit line.
    expect(receipt(await r.service.setValue(HOST, "legs", { rid: R1, key: "repo", value: SECRET }))).toEqual(first);
    expect((await stat(valuesPath(r.stateDir, "legs"))).mtimeMs).toBe(mtime);
    expect(r.audit).toHaveLength(1);
    expect(await r.service.setValue(HOST, "legs", { rid: R1, key: "repo", value: "lodge/other" })).toEqual({ status: 409, body: { error: "request-id-reused", rid: R1 } });
  });

  test("a value write while tricks are off as a whole answers 409 tricks-off and writes nothing", async () => {
    const r = await rig({ feature: { on: () => false } });
    const answer = await r.service.setValue(HOST, "legs", { rid: R1, key: "repo", value: SECRET });
    expect(answer).toEqual({ status: 409, body: { error: "tricks-off", message: TRICKS_OFF_LINE } });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(await Bun.file(valuesPath(r.stateDir, "legs")).exists()).toBe(false);
    expect(r.audit).toEqual([]);
  });

  test("refuses a bad value with a code and a sentence, an unknown field, a bad shape, an unknown trick", async () => {
    const r = await rig();
    const rows = await r.service.setValue(HOST, "legs", { rid: R1, key: "rows", value: 99 });
    expect(rows).toMatchObject({ status: 400, body: { error: "value-refused", code: "range" } });
    const line = await r.service.setValue(HOST, "legs", { rid: R2, key: "repo", value: `${SECRET}\nmore` });
    expect(line).toMatchObject({ status: 400, body: { error: "value-refused", code: "text" } });
    expect(JSON.stringify(line)).not.toContain(SECRET);
    expect(await r.service.setValue(HOST, "legs", { rid: R3, key: "nope", value: "x" })).toMatchObject({ status: 400, body: { code: "unknown-field" } });
    expect(await r.service.setValue(HOST, "legs", { rid: "not-a-uuid", key: "repo", value: "x" })).toEqual({ status: 400, body: { error: "value-invalid" } });
    expect(await r.service.setValue(HOST, "ghost", { rid: R3, key: "repo", value: "x" })).toEqual({ status: 404, body: { error: "unknown-trick" } });
    expect(await r.service.setValue("workshop", "legs", { rid: R3, key: "repo", value: "x" })).toEqual({ status: 404, body: { error: "unknown-host" } });
    // Nothing was written by a refusal.
    expect(r.audit).toEqual([]);
    const match = /^\/api\/tricks\/([^/]+)\/([^/]+)\/value$/.exec(`/api/tricks/${HOST}/legs/value`);
    if (match === null) throw new Error("the route did not match");
    const route = async (body: JsonValue) => await tricksValueRoute(r.service, match, body);
    expect(await route({ rid: R1, key: "repo" })).toEqual({ status: 400, body: { error: "value-invalid" } });
    expect(await route({ rid: R1, key: "repo", value: "x", extra: 1 })).toEqual({ status: 400, body: { error: "value-invalid" } });
    expect(await route({ rid: R1, key: "repo", value: { x: 1 } })).toEqual({ status: 400, body: { error: "value-invalid" } });
    expect(receipt(await route({ rid: R1, key: "repo", value: "lodge/workshop" })).changed).toBe(true);
  });

  test("writes one audit line with the trick and the field, never the value; no log line holds it", async () => {
    const r = await rig();
    receipt(await r.service.setValue(HOST, "legs", { rid: R1, key: "repo", value: SECRET }));
    expect(r.audit).toEqual([{ action: "trick.value", detail: { trick: "legs", field: "repo", by: "phone" } }]);
    await tick(r);
    expect(JSON.stringify(r.audit)).not.toContain(SECRET);
    expect(r.warnings.join("\n")).not.toContain(SECRET);
  });

  test("a changed value asks nothing again and runs the trick once, with the values in its facts and never on its command line or in its environment", async () => {
    const r = await rig();
    await tick(r);
    const before = r.specs.length;
    expect(factsOf(r.specs.at(-1)).values).toEqual({ rows: 10 });
    receipt(await r.service.setValue(HOST, "legs", { rid: R1, key: "repo", value: SECRET }));
    await tick(r);
    expect(r.specs.length).toBe(before + 1);
    const spec = r.specs.at(-1);
    expect(factsOf(spec).values).toEqual({ repo: SECRET, rows: 10 });
    expect(spec?.command).not.toContain(SECRET);
    expect(JSON.stringify(spec?.env)).not.toContain(SECRET);
    // The same value again changes nothing and starts no run.
    expect(receipt(await r.service.setValue(HOST, "legs", { rid: R2, key: "repo", value: SECRET })).changed).toBe(false);
    await tick(r);
    expect(r.specs.length).toBe(before + 1);
    // Clearing (null, or an empty text) goes back to Needs setup.
    expect(receipt(await r.service.setValue(HOST, "legs", { rid: R3, key: "repo", value: "" })).info.needsSetup).toBe(true);
  });

  test("A7: a run of writes restarts the trick ONCE, a second after the last write, with the last value", async () => {
    const r = await rig();
    await tick(r);
    const before = r.specs.length;
    const rids = ["a", "b", "c", "d", "e"].map((c) => `${c}f0c1d2e-3b4a-4c5d-8e6f-708192a3b4c5`);
    for (const [i, rid] of rids.entries()) {
      receipt(await r.service.setValue(HOST, "legs", { rid, key: "repo", value: `lodge/${String(i)}` }));
      // A tick between the writes, each less than a second after the last: no run yet.
      r.clock.t += 400;
      r.service.noteWatched();
      await r.service.tick();
    }
    expect(r.specs.length).toBe(before);
    // One second after the last write (400 ms are gone): one run, never five.
    r.clock.t += 700;
    r.service.noteWatched();
    await r.service.tick();
    expect(r.specs.length).toBe(before + 1);
    expect(factsOf(r.specs.at(-1)).values).toEqual({ repo: "lodge/4", rows: 10 });
    expect(factsOf(r.specs.at(-1)).trigger).toEqual({ kind: "start" });
    r.clock.t += 5000;
    r.service.noteWatched();
    await r.service.tick();
    // Later runs are the trick's own timer, not a restart a write left behind: at most one more in 5 s.
    expect(r.specs.length).toBeLessThanOrEqual(before + 2);
  });

  test("A7: a value write reads the one trick, not the whole folder", async () => {
    const r = await rig();
    await tick(r);
    // A trick added at the terminal after the last scan: a full scan would list it, a one-trick read does not.
    const dir = join(r.configDir, TRICKS_DIR, "fresh");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "trick.toml"), 'id = "fresh"\nname = "Fresh"\nplaces = ["belt"]\n');
    receipt(await r.service.setValue(HOST, "legs", { rid: R1, key: "repo", value: "lodge/workshop" }));
    expect((await r.service.reply(undefined)).tricks.map((trick) => trick.id)).toEqual(["legs"]);
    // The next scan finds it, as ever.
    await r.service.refresh(true);
    expect((await r.service.reply(undefined)).tricks.map((trick) => trick.id).toSorted()).toEqual(["fresh", "legs"]);
    // A write to a trick the service does not hold yet takes the whole scan, so it is found, not a 404.
    const late = join(r.configDir, TRICKS_DIR, "late");
    await mkdir(late, { recursive: true });
    await writeFile(join(late, "trick.toml"), 'id = "late"\nname = "Late"\nrun = "./x.sh"\nplaces = ["belt"]\ncontract = 3\n[[field]]\nkey = "x"\nkind = "text"\nlabel = "X"\n');
    expect(receipt(await r.service.setValue(HOST, "late", { rid: R2, key: "x", value: "y" })).changed).toBe(true);
  });

  test("A7: the seen request ids are bounded at the service: past the cap the oldest is forgotten and writes again", async () => {
    const r = await rig();
    const rid = (n: number): string => `${n.toString(16).padStart(8, "0")}-3b4a-4c5d-8e6f-708192a3b4c5`;
    receipt(await r.service.setValue(HOST, "legs", { rid: rid(0), key: "rows", value: 1 }));
    // The same id and payload is answered from memory.
    expect(receipt(await r.service.setValue(HOST, "legs", { rid: rid(0), key: "rows", value: 1 })).changed).toBe(true);
    for (let n = 1; n <= VALUE_WRITES_SEEN_MAX; n += 1) receipt(await r.service.setValue(HOST, "legs", { rid: rid(n), key: "rows", value: (n % 40) + 2 }));
    // rid(0) is the oldest and is out: the same id with another payload is a new write, not a 409.
    expect(await r.service.setValue(HOST, "legs", { rid: rid(0), key: "rows", value: 7 })).toMatchObject({ status: 200 });
    // A recent id is still held: another payload under it is refused.
    expect(await r.service.setValue(HOST, "legs", { rid: rid(VALUE_WRITES_SEEN_MAX), key: "rows", value: 49 })).toEqual({ status: 409, body: { error: "request-id-reused", rid: rid(VALUE_WRITES_SEEN_MAX) } });
  });

  test("review G point 7: a value write while the trick is off stores the value and starts no run", async () => {
    const r = await rig({}, false);
    await tick(r);
    const before = r.specs.length;
    expect(receipt(await r.service.setValue(HOST, "legs", { rid: R1, key: "repo", value: "lodge/workshop" })).changed).toBe(true);
    await tick(r);
    await tick(r);
    expect(r.specs.length).toBe(before);
    expect(r.specs).toEqual([]);
  });

  test("review G point 7: a value write while tricks are off as a whole starts no run and stores nothing", async () => {
    let featureOn = true;
    const r = await rig({ feature: { on: () => featureOn } });
    await tick(r);
    const before = r.specs.length;
    featureOn = false;
    expect(await r.service.setValue(HOST, "legs", { rid: R1, key: "repo", value: SECRET })).toEqual({ status: 409, body: { error: "tricks-off", message: TRICKS_OFF_LINE } });
    await tick(r);
    expect(r.specs.length).toBe(before);
    expect(await Bun.file(valuesPath(r.stateDir, "legs")).exists()).toBe(false);
  });

  test("review G point 7: a value write while the Windows gate is closed answers windows, writes nothing and starts no run", async () => {
    const r = await rig({ platform: "win32" });
    await tick(r);
    const answer = await r.service.setValue(HOST, "legs", { rid: R1, key: "repo", value: SECRET });
    expect(answer).toEqual({ status: 409, body: { error: "windows", message: TRICKS_WINDOWS_LINE } });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    await tick(r);
    expect(r.specs).toEqual([]);
    expect(await Bun.file(valuesPath(r.stateDir, "legs")).exists()).toBe(false);
    expect(r.audit).toEqual([]);
  });

  test("on a crew member the values live on the lead: refused, nothing written", async () => {
    const r = await rig({ runsOn: () => ({ lead: "workshop" }) });
    expect(await r.service.setValue(HOST, "legs", { rid: R1, key: "repo", value: "x" })).toEqual({ status: 409, body: { error: "not-here", message: VALUES_ON_LEAD } });
    await expect(stat(valuesPath(r.stateDir, "legs"))).rejects.toThrow();
  });

});

describe("approval and cards", () => {
  test("the code hash moves when a field changes, so a changed field asks again", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "trick.toml"), MANIFEST);
    await writeFile(join(dir, "legs.sh"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
    const one = await trickCodeHash(dir);
    await writeFile(join(dir, "trick.toml"), MANIFEST.replace('label = "Rows"', 'label = "Lines"'));
    const two = await trickCodeHash(dir);
    expect(one.ok && two.ok && one.hash !== two.hash).toBe(true);
  });

  test("a card names the fields by label, and the version card only when they changed", () => {
    const manifest = manifestOf(MANIFEST);
    expect(asksForLines(manifest)).toEqual([{ kind: "para", text: "Asks you for: Repository, Rows." }]);
    expect(asksForLines(manifestOf(MANIFEST.split("[[field]]")[0]!))).toEqual([]);
    expect(asksForChange(manifest, manifest)).toEqual([]);
    expect(asksForChange(manifestOf(MANIFEST.split("[[field]]")[0]!), manifest)).toEqual([{ kind: "para", text: "Asks you for: Repository, Rows." }]);
  });

  test("in a crew the values stay on the lead: the deputy carry skips them, and carries the program's own notes", async () => {
    const stateDir = await tempDir();
    new TrickValues(stateDir).write("legs", { repo: SECRET });
    await writeFile(join(trickStateDir(stateDir, "legs"), "values.json"), "{}");
    const carried = await stateEntries(stateDir, join(stateDir, "no-copy"), "legs");
    expect(carried.map((entry) => entry.rel)).toEqual(["state/values.json"]);
  });

  test("removing the trick's state folder removes its values", async () => {
    const stateDir = await tempDir();
    new TrickValues(stateDir).write("legs", { repo: "x" });
    await rm(trickStateDir(stateDir, "legs"), { recursive: true, force: true });
    expect(new TrickValues(stateDir).read("legs")).toEqual({ values: {}, unread: false });
  });
});
