import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseTrickDocumentText } from "../../web/src/lib/tricks/schema.ts";
import { powersOfDir } from "./approved.ts";
import { trickCodeHash } from "./code-hash.ts";
import { TRICKS_DIR } from "./paths.ts";
import type { RunOutcome, RunSpec } from "./run.ts";
import { TricksService, type TricksServiceDeps } from "./service.ts";
import { withSwitch, writeSwitches, type Switches } from "./switches.ts";

// THE DOCUMENT AN OLD HELPER PRINTS (ADR 0179). A trick written with a helper before v11 prints the key `decisions` on
// EVERY run, an empty list when it asked nothing. These cases take the document from the real helper text (the v8
// fixture, whose `document()` writes `decisions` the way v9 and v10 do) run as a program, and feed it through the
// document reader and the service: an empty list says nothing and the trick keeps running; a list with asks in it puts
// the one `dropped` note on the row, and no ask is posted.

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-tricks-v10-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const T0 = Date.parse("2026-11-08T09:00:00Z");
const HOST = "lodge";
const MANIFEST = 'id = "legs"\nname = "Browser leg"\nrun = "./legs.sh"\nevery = "30s"\nplaces = ["belt", "session"]\n';
const LINE = '"decisions" is "asks" now, so the asks listed under it are not shown. Update the helper with: collie trick helper legs.';

const MAIN = `import { run } from "./trick.ts";
run((t) => {
  t.belt({ label: "1" });
  if (process.env.WITH_ASK === "1") t.decide({ key: "a", title: "Rerun the leg?", summary: "Case 8 failed.", options: [{ intent: "rerun", label: "Rerun" }] });
});
`;

/** The stdout of the real helper text, run as a trick program with these facts. */
async function printed(withAsk: boolean): Promise<string> {
  const dir = await tempDir();
  await writeFile(join(dir, "trick.ts"), await readFile(new URL("./fixtures/helper-v8.txt", import.meta.url), "utf8"));
  await writeFile(join(dir, "main.ts"), MAIN);
  const facts = { contract: 1, trigger: { kind: "timer" }, trick: { id: "legs", dir, state: join(dir, "state") }, host: "desk", memberId: HOST, sessions: [], spaces: [] };
  const child = Bun.spawn([process.execPath, "main.ts"], { cwd: dir, env: { ...process.env, WITH_ASK: withAsk ? "1" : "0" }, stdin: new Blob([JSON.stringify(facts)]), stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(code).toBe(0);
  return out;
}

async function serviceRan(stdout: string) {
  const root = await tempDir();
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const dir = join(configDir, TRICKS_DIR, "legs");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "trick.toml"), MANIFEST);
  await writeFile(join(dir, "legs.sh"), "#!/bin/sh\n", { mode: 0o755 });
  const code = await trickCodeHash(dir);
  let switches: Switches = { on: new Map() };
  switches = withSwitch(switches, "legs", true, "2026-11-08T09:00:00Z", code.ok ? code.hash : null, await powersOfDir(dir, "legs"));
  await writeSwitches(stateDir, switches);
  const clock = { t: T0 };
  const posted: string[][] = [];
  const deps: TricksServiceDeps = {
    configDir,
    stateDir,
    feature: { on: () => true },
    memberId: HOST,
    world: (memberId) => ({ machine: "desk", sessions: [{ id: `${memberId}:w6X:3`, memberId, sessionId: `${memberId}:w6X:3`, paneId: "w6X:3", host: "desk", name: "composer", agent: "claude", status: "working" }], spaces: [] }),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    now: () => clock.t,
    warn: () => undefined,
    revBase: 1000,
    run: (spec: RunSpec): Promise<RunOutcome> => {
      void spec;
      return Promise.resolve({ kind: "exited", code: 0, stdout, stderr: "", ms: 5 });
    },
    decisions: {
      sync: (_trick, run) => {
        posted.push(run.decisions.map((d) => d.key));
        return [];
      },
      off: () => {},
      prune: () => {},
      seenOf: () => undefined,
    },
  };
  const service = new TricksService(deps);
  service.noteWatched();
  await service.refresh(true);
  await service.tick();
  await service.idle();
  const reply = await service.reply(undefined);
  return { posted, reply, row: reply.tricks[0] };
}

describe("the document a v10 helper prints", () => {
  test("the real helper prints the key `decisions` with an empty list when nothing was asked", async () => {
    const doc: unknown = JSON.parse(await printed(false));
    expect(doc).toMatchObject({ v: 1, decisions: [] });
  });

  test("the document reader: an empty `decisions` list is no `dropped` note and no refusal (only the `ignored` line of check and dev)", async () => {
    const parsed = parseTrickDocumentText(await printed(false), { declared: ["belt", "session"], contract: 1, decidesReply: false, draftsSession: false });
    expect(parsed.documentRefused).toBe(false);
    expect(parsed.notes.map((note) => [note.code, note.path])).toEqual([["ignored", "/decisions"]]);
    expect(parsed.refusals).toEqual([]);
    expect(parsed.decisions).toEqual([]);
  });

  test("the service: the trick keeps running and its row holds no `dropped` note", async () => {
    const { posted, reply, row } = await serviceRan(await printed(false));
    expect(row?.state).toBe("ok");
    expect(row?.refusals).toBeUndefined();
    expect(reply.present).toEqual(["lodge/legs/belt"]);
    expect(posted).toEqual([]);
  });

  test("with asks in the list the row holds the one note, with the trick's id, and no ask is posted", async () => {
    const stdout = await printed(true);
    expect(JSON.parse(stdout)).toMatchObject({ decisions: [{ key: "a" }] });
    const { posted, reply, row } = await serviceRan(stdout);
    expect(row?.state).toBe("ok");
    expect(row?.refusals?.map((x) => [x.code, x.path, x.reason])).toEqual([["dropped", "/decisions", LINE]]);
    expect(reply.present).toEqual(["lodge/legs/belt"]);
    expect(posted).toEqual([]);
  });
});
