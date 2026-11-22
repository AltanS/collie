import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SESSION_FILE_LABEL as OMP_LABEL } from "../../omp-extension/collie-session-label.ts";
import {
  activate,
  SESSION_FILE_LABEL as PI_LABEL,
  type ExtensionApi,
  type LabelState,
  type SessionContext,
  type SessionEvent,
} from "../../pi-extension/collie-session-label.ts";
import { PiTranscriptSource } from "./pi.ts";

// The key is written by the copied extension file and built again as `<harness>.session_file` by the
// reader (`labelledSession` in `pi.ts`). A rename on either side would stop the feature with no error,
// so this file feeds the reader exactly what the extension writes.

const ONE = "019f4665-7df0-7540-a64f-7068335f2101";
const OLD = "019f4665-7df0-7540-a64f-7068335f2103";
const CWD = "/srv/proj";
const FOLDER = "--srv-proj--";

const sessionRow = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-15T10:00:00.000Z", cwd: CWD });

/** Two logs of one folder, the neighbour's the newest: what a folder walk would wrongly answer. */
async function twoLogs() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "collie-pi-label-")));
  const piRoot = join(base, "pi-sessions");
  const log = async (id: string, stamp: string, age: number) => {
    const path = join(piRoot, FOLDER, `${stamp}_${id}.jsonl`);
    await mkdir(join(piRoot, FOLDER), { recursive: true });
    await Bun.write(path, `${sessionRow(id)}\n`);
    const when = new Date(Date.now() - age * 1000);
    await utimes(path, when, when);
    return path;
  };
  const mine = await log(OLD, "2026-11-15T10-00-00-000Z", 86_400);
  const theirs = await log(ONE, "2026-11-15T11-00-00-000Z", 5);
  const src = new PiTranscriptSource(piRoot, { home: join(base, "home"), tmp: join(base, "tmp") });
  return { base, mine, theirs, src };
}

/** What the extension runs for a `session_start` in a pi whose session file is `file`: the label key and value. */
async function writtenFor(file: string): Promise<Record<string, string>> {
  const calls: (readonly string[])[] = [];
  const handlers: ((event: SessionEvent | undefined, ctx: SessionContext | undefined) => Promise<void> | void)[] = [];
  const api: ExtensionApi = {
    on(event, handler) {
      if (event === "session_start") handlers.push(handler);
    },
  };
  const store = new Map<string, LabelState>();
  activate(api, { HC_TERMINAL_ID: "tie-t1" }, (args) => {
    calls.push(args);
    return Promise.resolve(true);
  }, store);
  for (const handler of handlers) handler(undefined, { hasUI: true, mode: "tui", sessionManager: { getSessionFile: () => file } });
  await store.get("tie-t1")?.queue;
  expect(calls).toHaveLength(1);
  const [verb, terminal, pair] = calls[0] ?? [];
  expect([verb, terminal]).toEqual(["label", "tie-t1"]);
  const at = (pair ?? "").indexOf("=");
  return { [(pair ?? "").slice(0, at)]: (pair ?? "").slice(at + 1) };
}

describe("the pi extension and the journal reader agree on the label", () => {
  test("the keys are the ones the reader builds for each harness", () => {
    expect(PI_LABEL).toBe("pi.session_file");
    expect(OMP_LABEL).toBe("omp.session_file");
  });

  test("a pi pane's path, in pi's session-file shape and as the extension writes it, picks that pane's own log", async () => {
    const { base, mine, theirs, src } = await twoLogs();
    const pi = (labels: Record<string, string>) => ({ processes: [{ argv: ["pi"] }], labels, shared: true as const });
    expect(await src.discoverSession(CWD, pi(await writtenFor(mine)))).toEqual({ kind: "id", value: OLD });
    expect(await src.discoverSession(CWD, pi(await writtenFor(theirs)))).toEqual({ kind: "id", value: ONE });
    // The same file under the other harness's key names nothing for a pi pane: the key decides.
    expect(await src.discoverSession(CWD, pi({ [OMP_LABEL]: mine }))).toBeNull();
    // A shared folder with no label names nothing: the label is what tells the two panes apart.
    expect(await src.discoverSession(CWD, { processes: [{ argv: ["pi"] }], shared: true })).toBeNull();
    await rm(base, { recursive: true, force: true });
  });

  test("an omp pane reads the omp key, which the omp extension writes", async () => {
    const { base, mine, src } = await twoLogs();
    const omp = (labels: Record<string, string>) => ({ processes: [{ argv: ["omp"] }], labels, shared: true as const });
    expect(await src.discoverSession(CWD, omp({ [OMP_LABEL]: mine }))).toEqual({ kind: "id", value: OLD });
    expect(await src.discoverSession(CWD, omp({ [PI_LABEL]: mine }))).toBeNull();
    await rm(base, { recursive: true, force: true });
  });
});
