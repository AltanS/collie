import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { coerceSessionTitles, SESSION_TITLES_FILE, SESSION_TITLES_MAX, SessionTitleStore, type RememberedTitles } from "./session-titles-store.ts";

// The title tracker's memory across a restart: bounded, owner-only, and without the agent's title under
// COLLIE_REDACT. Each test writes into its own temp state folder.

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-session-titles-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const kept = (person: string | undefined, agent: string | undefined, at: number): RememberedTitles => {
  const titles: RememberedTitles["titles"] = {};
  if (person !== undefined) titles.person = person;
  if (agent !== undefined) titles.agent = agent;
  return { titles, at };
};

describe("SessionTitleStore", () => {
  test("round-trips through disk, owner-only, and no file means no names", async () => {
    const stateDir = await tempDir();
    const store = new SessionTitleStore({ stateDir });
    expect((await store.load()).size).toBe(0);
    await store.save(new Map([["s1", kept("migrate lodge", "Lodge migration", 1)]]));
    expect((await new SessionTitleStore({ stateDir }).load()).get("s1")).toEqual(kept("migrate lodge", "Lodge migration", 1));
    if (process.platform !== "win32") expect((await stat(join(stateDir, SESSION_TITLES_FILE))).mode & 0o777).toBe(0o600);
    expect(await readdir(stateDir)).toEqual([SESSION_TITLES_FILE]);
  });

  test(`keeps the newest ${String(SESSION_TITLES_MAX)} sessions`, async () => {
    const stateDir = await tempDir();
    const all = new Map<string, RememberedTitles>();
    for (let i = 0; i < SESSION_TITLES_MAX + 10; i++) all.set(`s${String(i)}`, kept(`name ${String(i)}`, undefined, i));
    await new SessionTitleStore({ stateDir }).save(all);
    const back = await new SessionTitleStore({ stateDir }).load();
    expect(back.size).toBe(SESSION_TITLES_MAX);
    expect(back.has("s0")).toBe(false);
    expect(back.has(`s${String(SESSION_TITLES_MAX + 9)}`)).toBe(true);
  });

  test("with COLLIE_REDACT on, only the person's name reaches the disk", async () => {
    const stateDir = await tempDir();
    await new SessionTitleStore({ stateDir, redact: true }).save(new Map([["s1", kept("lead", "Rotate the deploy key", 1)], ["s2", kept(undefined, "Agent only", 1)]]));
    const text = await Bun.file(join(stateDir, SESSION_TITLES_FILE)).text();
    expect(text).not.toContain("Rotate");
    expect(text).not.toContain("Agent only");
    expect((await new SessionTitleStore({ stateDir }).load()).get("s1")).toEqual(kept("lead", undefined, 1));
  });
});

describe("coerceSessionTitles", () => {
  test("drops a row that is not one and cleans each name again", () => {
    const out = coerceSessionTitles({
      version: 1,
      sessions: { s1: { person: " a​ name ", at: 3 }, s2: { person: "x" }, s3: { at: 1 }, s4: "nope", "": { person: "y", at: 1 } },
    });
    expect([...out]).toEqual([["s1", kept("a name", undefined, 3)]]);
    expect(coerceSessionTitles([]).size).toBe(0);
    expect(coerceSessionTitles(null).size).toBe(0);
  });
});
