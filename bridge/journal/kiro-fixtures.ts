// Shared test fixtures for the Kiro journal tests. Not a test file itself (so `bun test` does not
// collect it) and not imported by any production path: it exists so the source, discovery and route
// tests build a V3 session folder the same way, from the checked-in files in fixtures/kiro.

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
import { pluginRoot } from "../root.ts";
import { asRecord } from "./cache-probe.ts";
import type { ProcessIdentityProbe } from "./types.ts";

/** A process probe that can say nothing about any pid, so Kiro discovery finds nothing. */
export const NO_PROCESS_IDENTITY: ProcessIdentityProbe = { identify: () => Promise.resolve(null) };

/** The checked-in sessions kiro-cli 2.32.0 saved: session.json, messages.jsonl and subagent.jsonl (README.md). */
export const KIRO_FIXTURES = join(pluginRoot(), "bridge", "journal", "fixtures", "kiro");

/** A bucket folder name in the 16-hex shape kiro-cli 2.32.0 writes. */
export const KIRO_BUCKET = "f59dfd564fb1cb64";

const sandboxes: string[] = [];

/** A fresh temporary folder, at its real path, removed by {@link removeKiroSandboxes}. */
export async function kiroSandbox(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "collie-kiro-")));
  sandboxes.push(dir);
  return dir;
}

/** Remove every folder {@link kiroSandbox} made; call it from `afterEach`. */
export async function removeKiroSandboxes(): Promise<void> {
  for (const dir of sandboxes.splice(0)) await rm(dir, { recursive: true, force: true });
}

/** The text of one checked-in fixture file, such as `messages.jsonl` or `denial.jsonl`. */
export function readKiroFixture(name: string): Promise<string> {
  return readFile(join(KIRO_FIXTURES, name), "utf8");
}

/**
 * Write the session folder `<root>/<bucket>/<id>`: the checked-in session.json with its `id` set to
 * `id`, and a messages.jsonl holding `log`. Returns the log's path.
 */
export async function writeKiroSession(root: string, log: string, id: string, bucket = KIRO_BUCKET): Promise<string> {
  const dir = join(root, bucket, id);
  await mkdir(dir, { recursive: true });
  // SAFETY: JSON.parse returns JSON values; asRecord checks the object boundary.
  const metadata: JsonObject = { ...asRecord(JSON.parse(await readKiroFixture("session.json")) as JsonValue), id };
  await writeFile(join(dir, "session.json"), JSON.stringify(metadata));
  const path = join(dir, "messages.jsonl");
  await writeFile(path, log);
  return path;
}

/** Mark a session folder as held by `pid` since `takenAt` (epoch ms), as the V3 TUI's `.lock` does. */
export async function writeKiroLock(folder: string, pid: number, takenAt: number): Promise<void> {
  await writeFile(join(folder, ".lock"), JSON.stringify({ pid, started_at: new Date(takenAt).toISOString() }));
}
