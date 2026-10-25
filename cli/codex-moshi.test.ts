import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "../bridge/json.ts";
import { brokerPermission } from "./codex-broker.ts";
import { CAPABILITY_FILE, capabilityPath, capabilityTemplate, capabilityVerdict, KNOWN_INCOMPATIBLE, MOSHI_ENTRY_COMMAND, moshiArgvOf, moshiNow, moshiVerdict, passThrough, spawnProvider } from "./codex-moshi.ts";
import { fakeFiles, type FakeFiles } from "./fakes.ts";

// The gate decides whether the broker may run Moshi beside Collie, and the answer must follow the
// INSTALLED Moshi: a record made against another build proves nothing about this one.

const MOSHI = "/opt/homebrew/bin/moshi";
const REAL_V1 = "/opt/homebrew/Cellar/moshi/1.0.0/bin/moshi";
const REAL_V2 = "/opt/homebrew/Cellar/moshi/1.1.0/bin/moshi";
const sha = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");

function moshiHost(version: "v1" | "v2" = "v1"): FakeFiles {
  const real = version === "v1" ? REAL_V1 : REAL_V2;
  const files = fakeFiles({ [real]: `moshi binary ${version}` });
  files.realPaths.set(MOSHI, real);
  files.entries.set(MOSHI, { text: `moshi binary ${version}` });
  return files;
}

interface ProofBody {
  kind: string;
  remoteWithdrawn: JsonValue;
  observer: string;
  observedAt: string;
  detail: string;
}

function record(over: Record<string, JsonValue> = {}): string {
  return JSON.stringify({
    schema: 1,
    provider: "moshi",
    command: MOSHI_ENTRY_COMMAND,
    executable: REAL_V1,
    digest: sha("moshi binary v1"),
    cancel: { method: "sigterm", graceMs: 3000 },
    proof: { kind: "runtime-withdrawal", remoteWithdrawn: true, observer: "root", observedAt: "2026-10-25T18:00:00Z", detail: "Cancelled the broker's loser on a phone; the pending prompt left the phone within 2 s." },
    ...over,
  });
}

describe("moshiArgvOf", () => {
  test("takes the exact entry apart without a shell", () => {
    expect(moshiArgvOf(MOSHI_ENTRY_COMMAND)).toEqual([MOSHI, "codex-hook"]);
  });

  test("answers null for anything that is not that exact shape", () => {
    for (const other of ["moshi codex-hook", `${MOSHI_ENTRY_COMMAND} --extra`, `'${MOSHI}' codex-hook && true`, "'a'b' codex-hook", ""]) {
      expect(moshiArgvOf(other)).toBeNull();
    }
  });
});

describe("capabilityVerdict: a proof counts only for the Moshi it was made on", () => {
  test("a complete proof for the installed Moshi enables the broker, with the recorded cancellation method", () => {
    const files = moshiHost();
    const verdict = capabilityVerdict(record(), MOSHI_ENTRY_COMMAND, moshiNow(files, MOSHI_ENTRY_COMMAND));
    expect(verdict).toMatchObject({ ok: true, capability: { executable: REAL_V1, cancel: { method: "sigterm", graceMs: 3000 }, observer: "root" } });
  });

  test("no record, a record that is not JSON and a record of another schema refuse", () => {
    const now = moshiNow(moshiHost(), MOSHI_ENTRY_COMMAND);
    expect(capabilityVerdict(null, MOSHI_ENTRY_COMMAND, now)).toMatchObject({ ok: false });
    expect(capabilityVerdict("{nope", MOSHI_ENTRY_COMMAND, now)).toMatchObject({ ok: false });
    expect(capabilityVerdict(record({ schema: 2 }), MOSHI_ENTRY_COMMAND, now)).toMatchObject({ ok: false });
    expect(capabilityVerdict(record({ provider: "other" }), MOSHI_ENTRY_COMMAND, now)).toMatchObject({ ok: false });
  });

  test("a Moshi that updated (a new digest, a new Cellar path) is a different provider: the proof is void", () => {
    const upgraded = moshiNow(moshiHost("v2"), MOSHI_ENTRY_COMMAND);
    const verdict = capabilityVerdict(record(), MOSHI_ENTRY_COMMAND, upgraded);
    expect(verdict).toMatchObject({ ok: false });
    // Same path, new bytes: the digest alone voids it.
    const samePath = capabilityVerdict(record({ executable: REAL_V2 }), MOSHI_ENTRY_COMMAND, upgraded);
    expect(samePath).toMatchObject({ ok: false, reason: expect.stringContaining("changed") });
  });

  test("evidence that is not a runtime observation of the remote withdrawal does not count", () => {
    const now = moshiNow(moshiHost(), MOSHI_ENTRY_COMMAND);
    const proof = (over: Partial<ProofBody>): string => record({ proof: { kind: "runtime-withdrawal", remoteWithdrawn: true, observer: "root", observedAt: "2026-10-25T18:00:00Z", detail: "x".repeat(40), ...over } });
    for (const weak of [{ kind: "symbol-present" }, { kind: "exit-status" }, { remoteWithdrawn: false }, { remoteWithdrawn: "yes" }, { observer: "" }, { observedAt: "soon" }, { detail: "ok" }]) {
      expect(capabilityVerdict(proof(weak), MOSHI_ENTRY_COMMAND, now)).toMatchObject({ ok: false });
    }
  });

  test("a cancellation method the broker cannot send, or a grace outside 0.5 to 5 s, refuses", () => {
    const now = moshiNow(moshiHost(), MOSHI_ENTRY_COMMAND);
    for (const cancel of [{ method: "sigkill", graceMs: 3000 }, { method: "sigterm", graceMs: 100 }, { method: "sigterm", graceMs: 60_000 }, { method: "sigterm" }]) {
      expect(capabilityVerdict(record({ cancel }), MOSHI_ENTRY_COMMAND, now)).toMatchObject({ ok: false });
    }
  });

  test("a proof for another entry command, or about a Moshi that is not installed, refuses", () => {
    const now = moshiNow(moshiHost(), MOSHI_ENTRY_COMMAND);
    expect(capabilityVerdict(record({ command: "'/usr/local/bin/moshi' codex-hook" }), MOSHI_ENTRY_COMMAND, now)).toMatchObject({ ok: false });
    expect(capabilityVerdict(record(), MOSHI_ENTRY_COMMAND, null)).toMatchObject({ ok: false });
    expect(moshiNow(fakeFiles(), MOSHI_ENTRY_COMMAND)).toBeNull();
  });

  test("moshi-hook 0.4.37 is refused whatever a record says: its hook never decides and its card is not withdrawn", () => {
    const known = KNOWN_INCOMPATIBLE[0]!;
    const verdict = capabilityVerdict(record({ digest: known.digest }), MOSHI_ENTRY_COMMAND, { executable: REAL_V1, digest: known.digest });
    expect(verdict).toEqual({ ok: false, reason: known.reason });
    expect(known.reason).toContain("never returns an allow or deny");
    expect(known.reason).toContain("#595");
  });

  test("the template for the installed Moshi is refused until an observer says what was seen", () => {
    const now = moshiNow(moshiHost(), MOSHI_ENTRY_COMMAND);
    const template = capabilityTemplate(MOSHI_ENTRY_COMMAND, now!, { method: "sigterm", graceMs: 3000 });
    expect(capabilityVerdict(template, MOSHI_ENTRY_COMMAND, now)).toMatchObject({ ok: false, reason: expect.stringContaining("not a runtime observation") });
    const filled = JSON.parse(template);
    filled.proof = { kind: "runtime-withdrawal", remoteWithdrawn: true, observer: "root", observedAt: "2026-10-25T18:00:00Z", detail: "Cancelled it on the Mac and the prompt left the phone within 2 s." };
    expect(capabilityVerdict(JSON.stringify(filled), MOSHI_ENTRY_COMMAND, now)).toMatchObject({ ok: true });
  });

  test("moshiVerdict reads the record from Collie's config dir", () => {
    const files = moshiHost();
    expect(moshiVerdict(files, "/cfg", MOSHI_ENTRY_COMMAND)).toMatchObject({ ok: false });
    files.write(capabilityPath("/cfg"), record());
    expect(capabilityPath("/cfg")).toBe(join("/cfg", CAPABILITY_FILE));
    expect(moshiVerdict(files, "/cfg", MOSHI_ENTRY_COMMAND)).toMatchObject({ ok: true });
  });
});

// The real child-process half, against stand-in providers (no Moshi, no network): what the broker relies
// on is that cancel() reaches a real process and tells "ended when asked" from "had to be killed".
describe("spawnProvider: a real process", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-provider-"));
  const sh = (script: string): string[] => ["/bin/sh", "-c", script];
  const env = { PATH: process.env.PATH, FLAG: join(dir, "withdrawn") };

  test("gets the payload byte for byte and its stdout comes back whole", async () => {
    const payload = '{"cwd":"/x","tool_input":{"command":"echo  \\"héllo\\"  \\n"},"n":1e3}';
    const run = spawnProvider(sh("cat"), payload, null, env);
    expect(await run.settled).toEqual({ exitCode: 0, stdout: payload });
    expect(await run.cancel(500)).toBe("already-ended");
  });

  test("cancel with the recorded signal reaches the provider, which withdraws and exits: `exited`", async () => {
    const run = spawnProvider(sh('trap \'echo withdrawn > "$FLAG"; exit 0\' TERM; cat >/dev/null; while :; do sleep 0.05; done'), "{}", { method: "sigterm", graceMs: 2000 }, env);
    await Bun.sleep(300);
    expect(await run.cancel(2000)).toBe("exited");
    expect(readFileSync(env.FLAG, "utf8")).toBe("withdrawn\n");
    expect(await run.settled).toMatchObject({ exitCode: 0 });
  });

  test("a provider that ignores the request is killed after the grace, and that is said", async () => {
    const run = spawnProvider(sh('trap "" TERM; cat >/dev/null; while :; do sleep 0.05; done'), "{}", { method: "sigterm", graceMs: 300 }, env);
    await Bun.sleep(300);
    expect(await run.cancel(300)).toBe("killed");
  });

  test("the broker over real processes: a Collie answer first withdraws the provider before it prints", async () => {
    rmSync(env.FLAG, { force: true });
    const provider = spawnProvider(sh('trap \'echo withdrawn > "$FLAG"; exit 0\' TERM; cat >/dev/null; while :; do sleep 0.05; done'), "{}", { method: "sigterm", graceMs: 2000 }, env);
    await Bun.sleep(300);
    const result = await brokerPermission({
      startProvider: () => provider,
      startHold: () => ({ settled: Promise.resolve("deny"), cancel: () => {} }),
      after: (ms, run) => {
        const handle = setTimeout(run, ms);
        return () => clearTimeout(handle);
      },
      denyMessage: "no",
    });
    expect(result).toMatchObject({ decision: "deny", winner: "collie", providerCancel: "exited" });
    expect(existsSync(env.FLAG)).toBe(true);
  });

  test("passThrough returns Moshi's own exit code", async () => {
    expect(await passThrough(sh("cat >/dev/null; exit 0"), "{}", env)).toBe(0);
    expect(await passThrough(sh("cat >/dev/null; exit 3"), "{}", env)).toBe(3);
  });

  test("cleanup", () => {
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
  });
});
